import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { checkCostCenter } from "../src/checks/costCenter.ts";
import { blocksApproval } from "../src/checks/issues.ts";
import { findRequester } from "../src/checks/requester.ts";
import { matchSupplier, normaliseCompanyName, normaliseVatId } from "../src/checks/supplier.ts";
import { isTrusted, trusted, unverifiedIssues } from "../src/checks/trust.ts";
import { applySchema, openDb } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";

// The real master data, loaded the same way the app does.
let ref: ReferenceData;
beforeAll(() => {
  const db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("normalisation", () => {
  it.each([
    ["CHE-101.234.567 MWST", "CHE101234567"],
    ["che 101 234 567", "CHE101234567"],
    ["DE 123.456.789", "DE123456789"],
  ])("VAT ID %s → %s", (input, expected) => {
    expect(normaliseVatId(input)).toBe(expected);
  });

  it.each([
    ["Acme Bearings GmbH", "acme bearings"],
    ["ACME Bearing Group Ltd", "acme bearing group"], // a different supplier stays different
    ["Müller Industriebedarf", "mueller industriebedarf"],
    ["Baltic Steel Trading OÜ", "baltic steel trading"],
    ["Global Fastener Supply Inc.", "global fastener supply"],
  ])("company name %s → %s", (input, expected) => {
    expect(normaliseCompanyName(input)).toBe(expected);
  });
});

describe("matchSupplier", () => {
  it("matches by VAT ID first (email 07: ACME Bearing Group, not Acme Bearings)", () => {
    const m = matchSupplier("ACME Bearing Group Ltd", "GB887766554", false, ref.suppliers);
    expect(m).toEqual({ supplierId: "SUP-006", matchedBy: "vat", issues: [] });
  });

  it("matches a Swiss VAT ID written differently", () => {
    const m = matchSupplier(null, "CHE101234567", false, ref.suppliers);
    expect(m.supplierId).toBe("SUP-002");
  });

  it("lets the VAT ID win when the name is just spelled differently", () => {
    const m = matchSupplier("TechnoPlast", "DE667788990", false, ref.suppliers);
    expect(m).toMatchObject({ supplierId: "SUP-011", matchedBy: "vat", issues: [] });
  });

  it("flags a conflict when name and VAT ID point at different suppliers (email 11)", () => {
    const m = matchSupplier("Mueller Industriebedarf AG", "DE445566778", false, ref.suppliers);
    expect(m.supplierId).toBeNull();
    expect(codes(m.issues)).toEqual(["SUPPLIER_CONFLICT"]);
    expect(m.issues[0]?.message).toContain("SUP-007");
    expect(m.issues[0]?.message).toContain("SUP-004");
  });

  it("blocks a blocked supplier but still identifies it (email 09)", () => {
    const m = matchSupplier("Baltic Steel Trading OÜ", "EE101234567", false, ref.suppliers);
    expect(m.supplierId).toBe("SUP-018");
    expect(codes(m.issues)).toEqual(["SUPPLIER_BLOCKED"]);
    expect(blocksApproval(m.issues)).toBe(true);
  });

  it("matches by name only with a warning when there is no VAT ID (email 10)", () => {
    const m = matchSupplier("Werkstatt Huber", null, false, ref.suppliers);
    expect(m).toMatchObject({ supplierId: "SUP-019", matchedBy: "name" });
    expect(codes(m.issues)).toEqual(["SUPPLIER_NAME_ONLY"]);
    expect(blocksApproval(m.issues)).toBe(false);
  });

  it("matches a name without its legal form (email 46: 'Hydraulik Zentrale')", () => {
    expect(matchSupplier("Hydraulik Zentrale", null, false, ref.suppliers).supplierId).toBe("SUP-008");
  });

  it("never invents a supplier for an unknown name (email 08)", () => {
    const m = matchSupplier("Stahlhandel Wyss AG", null, false, ref.suppliers);
    expect(m.supplierId).toBeNull();
    expect(codes(m.issues)).toEqual(["SUPPLIER_UNKNOWN"]);
  });

  it("does not match a VAT ID that is not in the master data, even if the name matches", () => {
    const m = matchSupplier("Acme Bearings GmbH", "DE000000000", false, ref.suppliers);
    expect(m.supplierId).toBeNull();
    expect(codes(m.issues)).toEqual(["SUPPLIER_VAT_UNKNOWN"]);
    expect(m.issues[0]?.message).toContain("SUP-001");
  });

  it("reports a missing supplier, but not twice when the value was unverified", () => {
    expect(codes(matchSupplier(null, null, false, ref.suppliers).issues)).toEqual(["SUPPLIER_MISSING"]);
    expect(matchSupplier(null, null, true, ref.suppliers).issues).toEqual([]);
  });
});

describe("checkCostCenter", () => {
  it("accepts a code from the master data, ignoring case and spaces only", () => {
    expect(checkCostCenter(" cc-1002", null, false, null, ref.costCenters)).toEqual({ code: "CC-1002", suggestions: [], issues: [] });
  });

  it("does not fall back to a similar code (email 40: CC-9100)", () => {
    const c = checkCostCenter("CC-9100", null, false, null, ref.costCenters);
    expect(c.code).toBeNull();
    expect(c.suggestions).toEqual([]);
    expect(codes(c.issues)).toEqual(["COST_CENTER_UNKNOWN"]);
  });

  it("suggests, but never applies, a cost centre from a name (email 02: 'London office')", () => {
    const c = checkCostCenter(null, "London office", false, null, ref.costCenters);
    expect(c.code).toBeNull();
    expect(c.suggestions).toEqual(["CC-3002"]);
    expect(codes(c.issues)).toEqual(["COST_CENTER_MISSING"]);
    expect(c.issues[0]?.message).toContain("CC-3002");
  });

  it("treats a 'code' that doesn't look like one as a name (final run, email 02)", () => {
    const c = checkCostCenter("London office", null, false, null, ref.costCenters);
    expect(c.code).toBeNull();
    expect(c.suggestions).toEqual(["CC-3002"]);
    expect(codes(c.issues)).toEqual(["COST_CENTER_MISSING"]);
    // A code-shaped value that isn't in the master data is still "unknown", never a suggestion.
    expect(codes(checkCostCenter("CC-9100", null, false, null, ref.costCenters).issues)).toEqual(["COST_CENTER_UNKNOWN"]);
  });

  it("offers the requester's default cost centre as a suggestion only (assumption 6)", () => {
    const c = checkCostCenter(null, null, false, "CC-1001", ref.costCenters);
    expect(c.code).toBeNull();
    expect(c.suggestions).toEqual(["CC-1001"]);
    expect(blocksApproval(c.issues)).toBe(true);
  });
});

describe("findRequester", () => {
  it("finds the employee by the sender address (case-insensitive)", () => {
    expect(findRequester("Tobias.Weber@customer.com", ref.employees)).toEqual({
      employeeId: "EMP-110",
      defaultCostCenter: "CC-1001",
      issues: [],
    });
  });

  it("warns about a sender who is not an employee", () => {
    const r = findRequester("someone@example.com", ref.employees);
    expect(r.employeeId).toBeNull();
    expect(codes(r.issues)).toEqual(["REQUESTER_UNKNOWN"]);
  });
});

describe("trust", () => {
  const unverified = [
    { field: "line_items[1]", reason: "quote_not_in_source" as const },
    { field: "requested_delivery.iso", reason: "value_not_in_quote" as const },
  ];

  it("treats a field as untrusted when it or its parent is unverified", () => {
    expect(isTrusted("line_items[1].unit_price", unverified)).toBe(false);
    expect(isTrusted("line_items[10].unit_price", unverified)).toBe(true); // [1] is not a prefix of [10]
    expect(isTrusted("requested_delivery.iso", unverified)).toBe(false);
    expect(isTrusted("requested_delivery.text", unverified)).toBe(true);
    expect(trusted("line_items[1].quantity", 20, unverified)).toBeNull();
  });

  it("gives unverified values a severity that matches what they feed into", () => {
    expect(unverifiedIssues(unverified).map((i) => [i.field, i.severity])).toEqual([
      ["line_items[1]", "blocks_approval"],
      ["requested_delivery.iso", "blocks_order"],
    ]);
  });
});
