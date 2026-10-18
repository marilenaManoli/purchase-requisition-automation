import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import type { SourceDocument } from "../src/ingest/sourceDocument.ts";
import { ApprovalError, approve, currentStep, reject } from "../src/workflow/approvals.ts";
import { reopenRejected, resolveIssue, submitForApproval } from "../src/workflow/clerk.ts";
import { findRelations, normaliseSubject, requisitionNumber } from "../src/workflow/duplicates.ts";
import { ingestEmail, processEmail } from "../src/workflow/processEmail.ts";
import { getState } from "../src/workflow/transitions.ts";
import { email23, email25, emptyExtraction, FakeLlm } from "./fixtures.ts";

const eml = (name: string) => readFileSync(`data/emails/${name}`);
const nothing = () => new FakeLlm(JSON.stringify(emptyExtraction()));

let db: Db;
let ref: ReferenceData;
beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
});

const row = (id: number) => db.prepare(`SELECT related_requisition_id, relation FROM requisitions WHERE id = ?`).get(id);
const openIssues = (id: number) =>
  (db.prepare(`SELECT id, code FROM issues WHERE requisition_id = ? AND resolved_at IS NULL ORDER BY id`).all(id) as { id: number; code: string }[]);
const has = (id: number, code: string) => openIssues(id).some((i) => i.code === code);

describe("helpers", () => {
  it("formats and normalises", () => {
    expect(requisitionNumber(7, "2026-10-18T09:00:00Z")).toBe("PR-2026-0007");
    expect(normaliseSubject("AW: Fwd:  Bestellung Lager fuer Linie A")).toBe("bestellung lager fuer linie a");
  });
});

describe("findRelations (inside processEmail)", () => {
  it("links a resend to the original as a suspected duplicate (01 → 29)", async () => {
    const first = await processEmail(db, eml("email_01_clean_with_pdf.eml"), null, nothing(), ref);
    const resend = await processEmail(db, eml("email_29.eml"), null, nothing(), ref);

    expect(row(resend)).toEqual({ related_requisition_id: first, relation: "duplicate" });
    expect(has(resend, "DUPLICATE_SUSPECTED")).toBe(true);
    expect(row(first)).toEqual({ related_requisition_id: null, relation: null }); // the original is untouched
  });

  it("flags a correction without a reference and only suggests the sender's last request (email 30)", async () => {
    const earlier = await processEmail(db, eml("email_25.eml"), null, new FakeLlm(JSON.stringify(email25())), ref); // Miriam, 14 May
    const correction = await processEmail(db, eml("email_30.eml"), null, nothing(), ref); // Miriam, 15 May

    expect(row(correction)).toEqual({ related_requisition_id: null, relation: null }); // suggested, not linked
    const msg = (db.prepare(`SELECT message FROM issues WHERE requisition_id = ? AND code = 'CORRECTION_WITHOUT_REFERENCE'`).get(correction) as { message: string }).message;
    expect(msg).toContain(requisitionNumber(earlier, new Date().toISOString()));
    expect(msg).toContain("only a suggestion");
  });

  it("blocks a reference to a requisition number that doesn't exist (email 39: PR-2026-0412)", async () => {
    const id = await processEmail(db, eml("email_39.eml"), null, nothing(), ref);
    expect(has(id, "REFERENCED_REQUISITION_NOT_FOUND")).toBe(true);
    expect(getState(db, id)).toBe("needs_review");
  });

  describe("direct rules", () => {
    const doc = (fromEmail: string, subject: string, body = "Bitte bestellen."): SourceDocument => ({
      messageId: null, fromName: null, fromEmail, subject, sentAt: "2026-05-15T08:00:00.000Z",
      body, bodyFormat: "text", attachments: [], warnings: [],
    });
    let earlier: number;
    beforeEach(async () => {
      earlier = await ingestEmail(db, eml("email_25.eml"), null); // Miriam, sent 14 May
      db.prepare(`UPDATE requisitions SET supplier_id = 'SUP-011', net_total = 3150 WHERE id = ?`).run(earlier);
    });
    // A second, later requisition (its own email: one email, one requisition). The rules
    // only look at the `doc` passed in and at requisitions created before it.
    const later = () => ingestEmail(db, eml("email_30.eml"), null);

    it("treats same sender + same supplier + same amount as a duplicate, even with another subject", async () => {
      const r = findRelations(db, await later(), doc("miriam.frick@customer.com", "Clips again"), { supplierId: "SUP-011", netTotal: 3150 });
      expect(r).toMatchObject({ relatedId: earlier, relation: "duplicate" });
    });

    it("does not link requests from a different sender", async () => {
      const r = findRelations(db, await later(), doc("tobias.weber@customer.com", "Clips again"), { supplierId: "SUP-011", netTotal: 3150 });
      expect(r).toEqual({ relatedId: null, relation: null, issues: [] });
    });

    it("links an existing requisition number as a reference, or as a correction when the email says so", async () => {
      const number = requisitionNumber(earlier, new Date().toISOString());
      const asRef = findRelations(db, await later(), doc("x@customer.com", `Wie ${number}`), { supplierId: null, netTotal: null });
      expect(asRef).toMatchObject({ relatedId: earlier, relation: "reference" });
      const asFix = findRelations(db, await later(), doc("x@customer.com", `Korrektur zu ${number}`), { supplierId: null, netTotal: null });
      expect(asFix).toMatchObject({ relatedId: earlier, relation: "correction" });
      expect(asFix.issues[0]?.severity).toBe("blocks_approval");
    });
  });
});

describe("clerk actions", () => {
  it("lets the clerk assign an approver when nobody else is left (email 23)", async () => {
    const id = await processEmail(db, eml("email_23.eml"), null, new FakeLlm(JSON.stringify(email23())), ref);
    expect(getState(db, id)).toBe("needs_review");
    expect(has(id, "APPROVER_NEEDED")).toBe(true);

    expect(() => submitForApproval(db, id, "clerk", ref)).toThrow("needs an approver");
    expect(() => submitForApproval(db, id, "clerk", ref, { 1: "EMP-501" })).toThrow("requester cannot be assigned");

    submitForApproval(db, id, "clerk", ref, { 1: "EMP-701" });
    expect(getState(db, id)).toBe("pending_approval");
    expect(currentStep(db, id)?.approver_employee_id).toBe("EMP-701");
    expect(has(id, "APPROVER_NEEDED")).toBe(false); // resolved by the assignment
  });

  it("refuses to submit while a blocking issue is open; resolving one needs a note", async () => {
    const first = await processEmail(db, eml("email_01_clean_with_pdf.eml"), null, nothing(), ref);
    const resend = await processEmail(db, eml("email_29.eml"), null, new FakeLlm(JSON.stringify(email25())), ref);
    expect(() => submitForApproval(db, resend, "clerk", ref)).toThrow(ApprovalError);

    expect(() => resolveIssue(db, openIssues(resend)[0]!.id, "clerk", " ")).toThrow("needs a note");
    for (const i of openIssues(resend).filter((i) => i.code !== "DELIVERY_DATE_MISSING")) {
      resolveIssue(db, i.id, "clerk", `Checked against ${first}`);
    }
    // Resolving an issue doesn't invent the missing value: the fixture's values don't
    // verify against email 29, so no amount is established and submission is still refused,
    // now for that reason. (Entering the value is the clerk edit in 6c.)
    expect(() => submitForApproval(db, resend, "clerk", ref)).toThrow("amount and cost centre must be established");
  });

  it("restarts at step 1 in a new round after a corrected rejection, keeping the old round", async () => {
    const id = await processEmail(db, eml("email_25.eml"), null, new FakeLlm(JSON.stringify(email25())), ref);
    approve(db, id, "EMP-103"); // step 1 done
    reject(db, id, "EMP-501", "Quantity too high"); // stopped at step 2

    reopenRejected(db, id, "clerk", "Requester confirmed the quantity");
    expect(getState(db, id)).toBe("needs_review");
    submitForApproval(db, id, "clerk", ref);

    const steps = db.prepare(`SELECT round, position, status FROM approval_steps WHERE requisition_id = ? ORDER BY round, position`).all(id);
    expect(steps).toEqual([
      { round: 1, position: 1, status: "approved" },
      { round: 1, position: 2, status: "rejected" },
      { round: 2, position: 1, status: "waiting" }, // starts again from the beginning
      { round: 2, position: 2, status: "waiting" },
    ]);
    expect(currentStep(db, id)).toMatchObject({ round: 2, position: 1, approver_employee_id: "EMP-103" });
  });
});
