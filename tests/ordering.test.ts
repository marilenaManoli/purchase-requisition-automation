import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { HttpErpClient } from "../src/erp/poClient.ts";
import { ApprovalError, approve } from "../src/workflow/approvals.ts";
import { pullBackForCorrection } from "../src/workflow/edits.ts";
import { buildPurchaseOrder, sendToErp, setDeliveryDate } from "../src/workflow/ordering.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { getState } from "../src/workflow/transitions.ts";
import { email25, FakeErp, FakeLlm } from "./fixtures.ts";

const raw25 = readFileSync("data/emails/email_25.eml");

let db: Db;
let ref: ReferenceData;
let id: number; // email 25, fully approved (no delivery date yet: "bis Ende Mai")
beforeEach(async () => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
  id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref);
  approve(db, id, "EMP-103");
  approve(db, id, "EMP-501");
});
const issues = () => (db.prepare(`SELECT code, resolved_at FROM issues WHERE requisition_id = ?`).all(id) as { code: string; resolved_at: string | null }[]);

describe("buildPurchaseOrder", () => {
  it("sends the net total and a per-unit price (the ERP has no 'per 100')", () => {
    setDeliveryDate(db, id, "clerk", "2026-05-29");
    const { order, idempotencyKey } = buildPurchaseOrder(db, id);
    expect(order).toMatchObject({
      supplier_id: "SUP-011",
      currency: "EUR",
      total: 3150, // net; VAT stays in our database
      requested_delivery_date: "2026-05-29",
      cost_centre: "CC-1003",
      line_items: [{ item_name: "Kunststoffclip KC-8, schwarz", quantity: 15000, unit_price: 0.21, unit: "Stk", item_code: "KC-8-SW" }],
    });
    expect(order).not.toHaveProperty("tax_amount");
    expect(idempotencyKey).toMatch(/^PR-\d{4}-0001@\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses to build an order without a delivery date", () => {
    expect(() => buildPurchaseOrder(db, id)).toThrow("needs a requested delivery date");
  });
});

describe("setDeliveryDate", () => {
  it("can be set after approval, is audited, and resolves the missing-date issue", () => {
    expect(issues().find((i) => i.code === "DELIVERY_DATE_MISSING")?.resolved_at).toBeNull();
    setDeliveryDate(db, id, "clerk", "2026-05-29");
    expect(getState(db, id)).toBe("approved"); // no re-approval: it doesn't change what or how much
    expect(issues().find((i) => i.code === "DELIVERY_DATE_MISSING")?.resolved_at).not.toBeNull();
  });

  it("rejects a date that isn't YYYY-MM-DD", () => {
    expect(() => setDeliveryDate(db, id, "clerk", "29.05.2026")).toThrow(ApprovalError);
  });
});

describe("sendToErp", () => {
  beforeEach(() => setDeliveryDate(db, id, "clerk", "2026-05-29"));

  it("books the order, stores the PO number and moves to ordered", async () => {
    const erp = new FakeErp({ kind: "booked", poNumber: "PO-2026-0001", warnings: ["gl_account is missing"], alreadyBooked: false });
    await sendToErp(db, id, "clerk", erp);
    expect(getState(db, id)).toBe("ordered");
    expect(db.prepare(`SELECT erp_po_number AS po FROM requisitions WHERE id = ?`).get(id)).toEqual({ po: "PO-2026-0001" });
    expect(issues().some((i) => i.code === "ERP_WARNING")).toBe(true);
  });

  it("only sends approved requisitions", async () => {
    const other = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref); // pending approval
    await expect(sendToErp(db, other, "clerk", new FakeErp())).rejects.toThrow("Only an approved requisition");
  });

  it("keeps a 422 visible, stays approved, and allows pulling back for re-approval", async () => {
    const erp = new FakeErp({ kind: "rejected", problems: ["line 1: unit is required"], warnings: [] });
    await expect(sendToErp(db, id, "clerk", erp)).rejects.toThrow("line 1: unit is required");
    expect(getState(db, id)).toBe("approved");
    expect(issues().some((i) => i.code === "ERP_REJECTED")).toBe(true);

    pullBackForCorrection(db, id, "clerk", "ERP rejected the order");
    expect(getState(db, id)).toBe("needs_review");
  });

  it("changes nothing when the ERP is unreachable, so a retry is safe", async () => {
    await expect(sendToErp(db, id, "clerk", new FakeErp(new Error("ECONNREFUSED")))).rejects.toThrow("Try again");
    expect(getState(db, id)).toBe("approved");
    const erp = new FakeErp();
    await sendToErp(db, id, "clerk", erp);
    expect(getState(db, id)).toBe("ordered");
  });
});

// Against the real mock ERP (data/mock_po_api.py), started on a free port for this test.
const hasPython = spawnSync("python3", ["--version"]).status === 0;
describe.skipIf(!hasPython)("with the real mock ERP", () => {
  let mock: ChildProcess;
  let erp: HttpErpClient;
  beforeAll(async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    mock = spawn("python3", ["data/mock_po_api.py", String(port)], { stdio: "ignore" });
    erp = new HttpErpClient(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("mock ERP did not start");
  });
  afterAll(() => mock.kill());

  it("books email 25 without a total warning, and a repeat returns the same order", async () => {
    setDeliveryDate(db, id, "clerk", "2026-05-29");
    const { order, idempotencyKey } = buildPurchaseOrder(db, id);

    const first = await erp.createPurchaseOrder(order, idempotencyKey);
    expect(first.kind).toBe("booked");
    if (first.kind !== "booked") return;
    expect(first.poNumber).toMatch(/^PO-2026-\d{4}$/);
    // 15000 × 0.21 = 3150: per-unit pricing reconciles with the total. Only gl_account is advisory-missing.
    expect(first.warnings).toEqual(["gl_account is missing; a complete purchase order carries one"]);

    const again = await erp.createPurchaseOrder(order, idempotencyKey); // same Idempotency-Key
    expect(again).toMatchObject({ kind: "booked", poNumber: first.poNumber, alreadyBooked: true });
  });

  it("returns every problem with a 422", async () => {
    setDeliveryDate(db, id, "clerk", "2026-05-29");
    const { order } = buildPurchaseOrder(db, id);
    const result = await erp.createPurchaseOrder({ ...order, line_items: [{ ...order.line_items[0]!, unit: "" }] }, "test-422");
    expect(result).toMatchObject({ kind: "rejected", problems: ["line 1: unit is required"] });
  });
});
