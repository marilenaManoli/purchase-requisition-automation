import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { checkSeveralCostCenters } from "../src/checks/costCenter.ts";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { auditTrail } from "../src/workflow/audit.ts";
import { submitForApproval } from "../src/workflow/clerk.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { createSupplierForRequisition } from "../src/workflow/suppliers.ts";
import { getState } from "../src/workflow/transitions.ts";
import { email25, FakeLlm } from "./fixtures.ts";

let db: Db;
let ref: ReferenceData;
let id: number; // email 25, but the model named an unknown supplier ("Stahlhandel Wyss AG", as in email 08)
beforeEach(async () => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
  const x = email25();
  x.supplier_name = { value: "Stahlhandel Wyss AG", evidence: null };
  x.supplier_vat_id = { value: null, evidence: null };
  id = await processEmail(db, readFileSync("data/emails/email_25.eml"), null, new FakeLlm(JSON.stringify(x)), ref);
});
const form = { name: "Stahlhandel Wyss AG", vatId: "CHE-123.456.789 MWST", country: "ch", currency: "CHF", paymentTermsDays: "30" };

describe("creating an unknown supplier (brief §6: 'the option to create it')", () => {
  it("creates it only when the clerk submits the form, then uses it and re-checks", async () => {
    expect(getState(db, id)).toBe("needs_review");
    const newId = await createSupplierForRequisition(db, id, "clerk", form, ref);

    expect(newId).toBe("SUP-026");
    expect(db.prepare(`SELECT name, vat_id, country, status FROM suppliers WHERE id = ?`).get(newId))
      .toEqual({ name: "Stahlhandel Wyss AG", vat_id: "CHE-123.456.789 MWST", country: "CH", status: "active" });
    expect(db.prepare(`SELECT supplier_id FROM requisitions WHERE id = ?`).get(id)).toEqual({ supplier_id: "SUP-026" });
    expect(auditTrail(db, id).map((a) => a.reason).join("\n")).toContain('Clerk created supplier SUP-026 "Stahlhandel Wyss AG"');

    submitForApproval(db, id, "clerk", ref); // nothing else blocks email 25
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("refuses to create a second record for an existing supplier (by VAT ID or name)", async () => {
    await expect(createSupplierForRequisition(db, id, "clerk", { ...form, name: "Something", vatId: "DE 667.788.990" }, ref))
      .rejects.toThrow("SUP-011 TechnoPlast Kunststoffe GmbH already exists");
    await expect(createSupplierForRequisition(db, id, "clerk", { ...form, name: "Hydraulik Zentrale", vatId: "" }, ref))
      .rejects.toThrow("SUP-008");
  });

  it("validates the form", async () => {
    await expect(createSupplierForRequisition(db, id, "clerk", { ...form, country: "Switzerland" }, ref)).rejects.toThrow("country");
    await expect(createSupplierForRequisition(db, id, "clerk", { ...form, currency: "JPY" }, ref)).rejects.toThrow("Unsupported currency");
  });

  it("allows a supplier without VAT ID (like SUP-019 Werkstatt Huber)", async () => {
    await createSupplierForRequisition(db, id, "clerk", { ...form, vatId: "" }, ref);
    expect(db.prepare(`SELECT vat_id FROM suppliers WHERE id = 'SUP-026'`).get()).toEqual({ vat_id: null });
  });
});

describe("several cost centres in one email (found in the rehearsal)", () => {
  it("blocks approval and names the codes", () => {
    const issues = checkSeveralCostCenters("Half of it should go on CC-3001 and half on cc 5001.");
    expect(issues.map((i) => [i.code, i.severity])).toEqual([["SEVERAL_COST_CENTERS", "blocks_approval"]]);
    expect(issues[0]?.message).toContain("CC-3001, CC-5001");
  });

  it("is quiet for one code, even if repeated, and ignores look-alikes such as item codes", () => {
    expect(checkSeveralCostCenters("Kostenstelle CC-1003. Bitte auf CC-1003 buchen.")).toEqual([]);
    expect(checkSeveralCostCenters("Kostenstelle CC-1004, Artikel SK-12, Auftrag VB-2026-14")).toEqual([]);
  });
});
