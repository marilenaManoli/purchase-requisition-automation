import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { ApprovalError } from "../src/workflow/approvals.ts";
import { auditTrail } from "../src/workflow/audit.ts";
import { resolveIssue, submitForApproval } from "../src/workflow/clerk.ts";
import { editRequisition, pullBackForCorrection } from "../src/workflow/edits.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { getState } from "../src/workflow/transitions.ts";
import { email25, FakeLlm } from "./fixtures.ts";

const raw25 = readFileSync("data/emails/email_25.eml");

let db: Db;
let ref: ReferenceData;
beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
});

const req = (id: number) => db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(id) as Record<string, unknown>;
const open = (id: number) => (db.prepare(`SELECT id, code, field FROM issues WHERE requisition_id = ? AND resolved_at IS NULL ORDER BY id`).all(id) as { id: number; code: string; field: string | null }[]);
const codes = (id: number) => open(id).map((i) => i.code);

/** Email 25 processed with a modified extraction. */
async function withExtraction(change: (x: ReturnType<typeof email25>) => void): Promise<number> {
  const x = email25();
  change(x);
  return processEmail(db, raw25, null, new FakeLlm(JSON.stringify(x)), ref);
}

describe("editRequisition", () => {
  it("lets the clerk supply a missing price; the checks re-run and the requisition can be submitted", async () => {
    const id = await withExtraction((x) => { x.line_items[0]!.unit_price = null; });
    expect(codes(id)).toContain("LINE_PRICE_MISSING");

    await editRequisition(db, id, "clerk", { lines: { "0": { unitPrice: 21 } } }, ref);

    expect(codes(id)).not.toContain("LINE_PRICE_MISSING");
    expect(codes(id)).toContain("TOTALS_RECALCULATED"); // the document's totals are no longer compared
    expect(req(id)).toMatchObject({ net_total: 3150, net_total_chf: 3024, band: 2 });
    expect(auditTrail(db, id).at(-1)?.reason).toBe("Clerk set line 1 unitPrice: (model value) → 21");

    submitForApproval(db, id, "clerk", ref);
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("replaces an unverified cost centre, but only with one from the master data", async () => {
    const id = await withExtraction((x) => { x.cost_center_code = { value: "CC-9100", evidence: "Kostenstelle CC-9100" }; });
    expect(open(id).some((i) => i.code === "UNVERIFIED_VALUE" && i.field === "cost_center_code")).toBe(true);

    await expect(editRequisition(db, id, "clerk", { costCenterCode: "CC-9100" }, ref)).rejects.toThrow("does not exist");
    await editRequisition(db, id, "clerk", { costCenterCode: "cc-1003" }, ref); // formatting only is normalised

    expect(req(id).cost_center_code).toBe("CC-1003");
    expect(open(id).some((i) => i.field === "cost_center_code")).toBe(false);
  });

  it("still blocks a blocked supplier, even when the clerk picks it", async () => {
    const id = await withExtraction((x) => { x.supplier_vat_id = { value: "DE000", evidence: "fake" }; });
    await editRequisition(db, id, "clerk", { supplierId: "SUP-018" }, ref);
    expect(req(id).supplier_id).toBe("SUP-018");
    expect(codes(id)).toContain("SUPPLIER_BLOCKED");
  });

  it("never creates a supplier from an edit", async () => {
    const id = await withExtraction((x) => { x.supplier_vat_id = { value: "DE000", evidence: "fake" }; });
    await expect(editRequisition(db, id, "clerk", { supplierId: "SUP-999" }, ref)).rejects.toThrow("never created from an edit");
  });

  it("rejects malformed input (validated with zod)", async () => {
    const id = await withExtraction((x) => { x.line_items[0]!.unit_price = null; });
    await expect(editRequisition(db, id, "clerk", { lines: { "0": { quantity: -5 } } }, ref)).rejects.toThrow(ApprovalError);
    await expect(editRequisition(db, id, "clerk", { supplier: "SUP-001" }, ref)).rejects.toThrow("Invalid edit"); // unknown key
    await expect(editRequisition(db, id, "clerk", { requestedDeliveryDate: "31.05.2026" }, ref)).rejects.toThrow("Invalid edit");
  });

  it("does not raise again an issue the clerk already resolved", async () => {
    const id = await withExtraction((x) => {
      x.line_items[0]!.unit_price = null;
      x.quote_number = { value: "TP-26-0884", evidence: "invented quote" }; // a warning-level unverified value
    });
    const warning = open(id).find((i) => i.field === "quote_number")!;
    resolveIssue(db, warning.id, "clerk", "Quote number checked on the PDF");

    await editRequisition(db, id, "clerk", { lines: { "0": { unitPrice: 21 } } }, ref);
    expect(open(id).some((i) => i.field === "quote_number")).toBe(false);
  });

  it("lets the clerk fill in everything when extraction failed, adding a line", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm("garbage", "garbage"), ref);
    await expect(editRequisition(db, id, "clerk", { lines: { "0": { description: "Clips" } } }, ref))
      .rejects.toThrow("needs a description, quantity, unit and unit price");

    await editRequisition(db, id, "clerk", {
      supplierId: "SUP-011", costCenterCode: "CC-1003", currency: "EUR", requestedDeliveryDate: "2026-05-29",
      lines: { "0": { description: "Kunststoffclip KC-8", quantity: 15000, unit: "Stk", unitPrice: 21, pricePer: 100 } },
    }, ref);
    expect(req(id)).toMatchObject({ supplier_id: "SUP-011", net_total: 3150, net_total_chf: 3024, requested_delivery_date: "2026-05-29" });

    // The failed extraction stays visible until the clerk explicitly resolves it.
    expect(codes(id)).toContain("EXTRACTION_FAILED");
    expect(() => submitForApproval(db, id, "clerk", ref)).toThrow("EXTRACTION_FAILED");
    resolveIssue(db, open(id).find((i) => i.code === "EXTRACTION_FAILED")!.id, "clerk", "Entered by hand from the PDF");
    submitForApproval(db, id, "clerk", ref);
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("only edits in needs_review; a requisition in approval must be pulled back first", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref);
    await expect(editRequisition(db, id, "clerk", { requestedDeliveryDate: "2026-05-29" }, ref)).rejects.toThrow("Pull it back");

    pullBackForCorrection(db, id, "clerk", "Requester sent the delivery date");
    await editRequisition(db, id, "clerk", { requestedDeliveryDate: "2026-05-29" }, ref);
    expect(codes(id)).not.toContain("DELIVERY_DATE_MISSING");
    expect(req(id).requested_delivery_date).toBe("2026-05-29");
  });

  it("never modifies the model's extraction: the claim and the decision stay separate", async () => {
    const id = await withExtraction((x) => { x.line_items[0]!.unit_price = null; });
    const before = req(id).extraction_json;
    await editRequisition(db, id, "clerk", { lines: { "0": { unitPrice: 21 } } }, ref);
    expect(req(id).extraction_json).toBe(before);
    expect(JSON.parse(req(id).clerk_overrides_json as string)).toEqual({ lines: { "0": { unitPrice: 21 } } });
  });
});
