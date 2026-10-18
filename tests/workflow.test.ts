import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { ApprovalError, approve, currentStep, reject } from "../src/workflow/approvals.ts";
import { auditTrail } from "../src/workflow/audit.ts";
import { extractAndRoute, ingestEmail, processEmail } from "../src/workflow/processEmail.ts";
import { ALLOWED_TRANSITIONS, STATES } from "../src/workflow/states.ts";
import { getState, InvalidTransitionError, transition } from "../src/workflow/transitions.ts";
import { email25, FakeLlm } from "./fixtures.ts";

// Email 25 (Miriam Frick, TechnoPlast, CC-1003, EUR 3,150 → CHF 3,024, band 2).
// CC-1003 is owned by EMP-103 Daniel Kunz; OPS is headed by EMP-501 Andrea Roth.
const raw25 = readFileSync("data/emails/email_25.eml");
const good = () => JSON.stringify(email25());

let db: Db;
let ref: ReferenceData;
beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
});

const row = (id: number) => db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(id) as Record<string, unknown>;
const issueCodes = (id: number) => (db.prepare(`SELECT code FROM issues WHERE requisition_id = ? ORDER BY id`).all(id) as { code: string }[]).map((r) => r.code);
const moves = (id: number) => auditTrail(db, id).map((a) => `${a.from_state ?? "∅"}→${a.to_state}`);

describe("state machine", () => {
  it("only lists real states as targets, and ordered is final", () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(STATES).toContain(t);
    }
    expect(ALLOWED_TRANSITIONS.ordered).toEqual([]);
  });

  it("refuses a move that isn't allowed and changes nothing", async () => {
    const id = await ingestEmail(db, raw25, "email_25.eml");
    expect(() => transition(db, id, "approved", "system", "skip everything")).toThrow(InvalidTransitionError);
    expect(getState(db, id)).toBe("inbox");
    expect(moves(id)).toEqual(["∅→inbox"]); // no audit row for the refused move
  });
});

describe("processEmail", () => {
  it("routes a clean email straight to pending_approval, skipping needs_review", async () => {
    const id = await processEmail(db, raw25, "email_25.eml", new FakeLlm(good()), ref);

    expect(getState(db, id)).toBe("pending_approval");
    expect(moves(id)).toEqual(["∅→inbox", "inbox→extracted", "extracted→pending_approval"]);
    expect(row(id)).toMatchObject({
      requester_employee_id: "EMP-111",
      supplier_id: "SUP-011",
      cost_center_code: "CC-1003",
      currency: "EUR",
      net_total: 3150,
      net_total_chf: 3024,
      band: 2,
      requested_delivery_date: null,
    });
    expect(issueCodes(id)).toEqual(["DELIVERY_DATE_MISSING"]); // blocks the order later, not the approval
    const steps = db.prepare(`SELECT position, roles, approver_employee_id FROM approval_steps WHERE requisition_id = ?`).all(id);
    expect(steps).toEqual([
      { position: 1, roles: "cost_center_owner", approver_employee_id: "EMP-103" },
      { position: 2, roles: "department_head", approver_employee_id: "EMP-501" },
    ]);
  });

  it("keeps the raw email and the source text the model saw", async () => {
    const id = await processEmail(db, raw25, "email_25.eml", new FakeLlm(good()), ref);
    const email = db.prepare(`SELECT e.raw, e.source_text FROM emails e JOIN requisitions r ON r.email_id = e.id WHERE r.id = ?`).get(id) as { raw: Buffer; source_text: string };
    expect(Buffer.compare(email.raw, raw25)).toBe(0);
    expect(email.source_text).toContain("Offert-Nr.: TP-26-0884");
  });

  it("sends a requisition with a blocking issue to needs_review, with the reason, and builds no chain", async () => {
    const x = email25();
    x.cost_center_code = { value: "CC-9100", evidence: "Kostenstelle CC-9100" }; // quote not in the email
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(x)), ref);

    expect(getState(db, id)).toBe("needs_review");
    expect(auditTrail(db, id).at(-1)?.reason).toBe("Needs review: UNVERIFIED_VALUE");
    expect(row(id).cost_center_code).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM approval_steps WHERE requisition_id = ?`).get(id)).toEqual({ n: 0 });
  });

  it("sends a failed extraction to needs_review and keeps the raw model output", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm("nonsense", "still nonsense"), ref);
    expect(getState(db, id)).toBe("needs_review");
    expect(issueCodes(id)).toEqual(["EXTRACTION_FAILED"]);
    expect(row(id)).toMatchObject({ extraction_raw: "still nonsense", extraction_json: null });
  });

  it("leaves the requisition in inbox when the LLM is down, and a retry continues from there", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm(new Error("connect ECONNREFUSED")), ref);
    expect(getState(db, id)).toBe("inbox");
    expect(issueCodes(id)).toEqual([]); // not a problem with the email
    expect(auditTrail(db, id).at(-1)?.reason).toContain("Extraction postponed");

    await extractAndRoute(db, id, new FakeLlm(good()), ref);
    expect(getState(db, id)).toBe("pending_approval");
  });
});

describe("approve / reject", () => {
  let id: number;
  beforeEach(async () => {
    id = await processEmail(db, raw25, null, new FakeLlm(good()), ref);
  });

  it("walks the chain one approver at a time, in order", () => {
    expect(() => approve(db, id, "EMP-501")).toThrow(ApprovalError); // Andrea is step 2: not yet
    approve(db, id, "EMP-103");
    expect(getState(db, id)).toBe("pending_approval");
    expect(currentStep(db, id)?.approver_employee_id).toBe("EMP-501");

    approve(db, id, "EMP-501", "ok");
    expect(getState(db, id)).toBe("approved");
    expect(moves(id).slice(-3)).toEqual(["pending_approval→pending_approval", "pending_approval→pending_approval", "pending_approval→approved"]);
  });

  it("never lets the requester approve, even if they were somehow on the step", () => {
    db.prepare(`UPDATE approval_steps SET approver_employee_id = 'EMP-111' WHERE requisition_id = ? AND position = 1`).run(id);
    expect(() => approve(db, id, "EMP-111")).toThrow("never approve their own");
  });

  it("stops the chain on rejection, keeps the reason, and allows no further approval", () => {
    expect(() => reject(db, id, "EMP-103", "  ")).toThrow("needs a reason");
    reject(db, id, "EMP-103", "Wrong supplier, use the framework contract");

    expect(getState(db, id)).toBe("rejected");
    expect(row(id).rejection_reason).toBe("Wrong supplier, use the framework contract");
    expect(() => approve(db, id, "EMP-501")).toThrow(ApprovalError);
    expect(auditTrail(db, id).at(-1)).toMatchObject({ actor: "EMP-103", to_state: "rejected" });
  });

  it("only lets the current approver reject during approval", () => {
    expect(() => reject(db, id, "EMP-501", "no")).toThrow(ApprovalError);
  });

  it("lets a clerk reject a requisition waiting in needs_review", async () => {
    const other = await processEmail(db, raw25, null, new FakeLlm("x", "y"), ref);
    reject(db, other, "clerk", "Not a purchase request");
    expect(getState(db, other)).toBe("rejected");
  });
});
