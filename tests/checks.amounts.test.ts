import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { checkAmounts, classifyTotal, lineAmount, type LineInput } from "../src/checks/amounts.ts";
import { checkDeliveryDate, checkMissingAttachment, checkQuoteValidity } from "../src/checks/dates.ts";
import { convertToChf } from "../src/checks/fx.ts";
import { blocksApproval } from "../src/checks/issues.ts";
import { round2, sameAmount } from "../src/checks/money.ts";
import { issuesForFailedExtraction, runChecks } from "../src/checks/runChecks.ts";
import { applySchema, openDb } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { parseEmail } from "../src/ingest/parseEmail.ts";
import type { SourceDocument } from "../src/ingest/sourceDocument.ts";
import { email25 } from "./fixtures.ts";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const line = (quantity: number | null, unitPrice: number | null, lineTotal: number | null = null, pricePer: number | null = null): LineInput =>
  ({ quantity, unitPrice, pricePer, lineTotal, untrusted: false });
const total = (value: number, evidence: string) => ({ value, evidence });

describe("money helpers", () => {
  it("rounds to cents without float surprises", () => {
    expect(round2(940 * 1.13)).toBe(1062.2); // 1062.1999999999998 before rounding
    expect(round2(1.005)).toBe(1.01);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameAmount(4380, 4830)).toBe(false);
  });
});

describe("lineAmount", () => {
  it("respects price_per (email 25: 15,000 pcs at EUR 21.00 per 100 = 3,150, not 315,000)", () => {
    expect(lineAmount(line(15000, 21, 3150, 100), 1)).toEqual({ amount: 3150, issues: [] });
  });

  it("blocks a line whose stated total doesn't match qty × price", () => {
    const r = lineAmount(line(15000, 21, 315000, 100), 1);
    expect(r.amount).toBeNull();
    expect(codes(r.issues)).toEqual(["LINE_TOTAL_MISMATCH"]);
  });

  it("blocks a line without a price and suggests the clerk may confirm 0 (email 34)", () => {
    const r = lineAmount(line(1, null), 3);
    expect(codes(r.issues)).toEqual(["LINE_PRICE_MISSING"]);
    expect(r.issues[0]?.message).toContain("confirm a price of 0");
  });

  it("stays silent on an untrusted line (already reported as unverified)", () => {
    expect(lineAmount({ ...line(1, 10), untrusted: true }, 1)).toEqual({ amount: null, issues: [] });
  });
});

describe("classifyTotal reads the label from the evidence, not from the model's field", () => {
  it.each([
    ["Zwischensumme: 9,700.00 CHF", "net"],
    ["Subtotal: 4,380.00 EUR", "net"],
    ["Total excl. VAT: 1,000.00", "net"], // net is checked before gross
    ["Total inkl. MwSt: 10,485.70 CHF", "gross"],
    ["Total: 4,830.00 EUR", "unlabelled"],
    ["so CHF 999.00 in total", "unlabelled"], // email 12: the model had put this in net_total
  ])("%s → %s", (evidence, expected) => {
    expect(classifyTotal(evidence)).toBe(expected);
  });
});

describe("checkAmounts", () => {
  it("uses net, not gross, and accepts consistent figures (email 05)", () => {
    const r = checkAmounts({
      lines: [line(1, 7450, 7450), line(2, 1125, 2250)],
      totals: [total(9700, "Zwischensumme: 9,700.00 CHF"), total(10485.7, "Total inkl. MwSt: 10,485.70 CHF")],
      vatAmount: 785.7,
    });
    expect(r).toMatchObject({ net: 9700, vat: 785.7, gross: 10485.7, issues: [] });
  });

  it("blocks when the total contradicts the lines (email 24: 4,380 vs 4,830)", () => {
    const r = checkAmounts({
      lines: [line(600, 2.3, 1380), line(200, 15, 3000)],
      totals: [total(4380, "Subtotal: 4,380.00 EUR"), total(4830, "Total: 4,830.00 EUR")],
      vatAmount: null,
    });
    expect(r.net).toBeNull(); // never route on a contradicted figure
    expect(codes(r.issues)).toEqual(["AMOUNT_CONTRADICTION"]);
    expect(r.issues[0]?.message).toContain("4830");
  });

  it("blocks when the lines don't add up to the stated net", () => {
    const r = checkAmounts({ lines: [line(1, 100)], totals: [total(150, "Netto: 150.00")], vatAmount: null });
    expect(r.net).toBeNull();
    expect(codes(r.issues)).toEqual(["AMOUNT_CONTRADICTION"]);
  });

  it("blocks when net + VAT ≠ gross", () => {
    const r = checkAmounts({
      lines: [line(1, 1000)],
      totals: [total(1000, "Subtotal 1,000.00"), total(1100, "Total incl. VAT 1,100.00")],
      vatAmount: 81,
    });
    expect(codes(r.issues)).toEqual(["AMOUNT_CONTRADICTION"]);
  });

  it("includes a negative discount line (email 35: net EUR 5,600)", () => {
    const r = checkAmounts({
      lines: [line(4000, 1.2, 4800), line(2000, 0.85, 1700), line(1, -900, -900)],
      totals: [total(5600, "Zwischensumme: 5,600.00 EUR")],
      vatAmount: 0,
    });
    expect(r).toMatchObject({ net: 5600, issues: [] });
  });

  it("includes a freight line (email 36: net USD 9,740)", () => {
    const r = checkAmounts({
      lines: [line(25000, 0.28, 7000), line(30000, 0.07, 2100), line(1, 640, 640)],
      totals: [total(9740, "Subtotal: 9,740.00 USD")],
      vatAmount: 0,
    });
    expect(r.net).toBe(9740);
  });

  it("treats lines + an unlabelled total as net, with a warning (email 12: 3 × 333 = 999, assumption 7)", () => {
    const r = checkAmounts({ lines: [line(3, 333)], totals: [total(999, "so CHF 999.00 in total")], vatAmount: null });
    expect(r.net).toBe(999);
    expect(codes(r.issues)).toEqual(["VAT_STATUS_NOT_STATED"]);
    expect(blocksApproval(r.issues)).toBe(false);
  });

  it("does not establish an amount when a line has no price (email 34)", () => {
    const r = checkAmounts({ lines: [line(200, 12, 2400), line(1, null)], totals: [total(2400, "Subtotal: 2,400.00 CHF")], vatAmount: 0 });
    expect(r.net).toBeNull();
    expect(codes(r.issues)).toEqual(["LINE_PRICE_MISSING"]);
  });

  it("blocks when there are no line items at all (email 30: a correction without items)", () => {
    const r = checkAmounts({ lines: [], totals: [], vatAmount: null });
    expect(r.net).toBeNull();
    expect(codes(r.issues)).toEqual(["NO_LINE_ITEMS"]);
  });
});

describe("convertToChf (CLAUDE.md band test cases)", () => {
  const rates = new Map([["CHF", 1], ["EUR", 0.96], ["USD", 0.88], ["GBP", 1.13]]);
  it.each([
    [940, "GBP", 1062.2], // email 07 → band 2
    [8900, "GBP", 10057], // 15 → band 3
    [10400, "EUR", 9984], // 16 → band 2
    [52000, "EUR", 49920], // 17 → band 3
    [340000, "USD", 299200], // 19 → band 5
    [999, "CHF", 999], // 12
  ])("%d %s → CHF %d", (net, currency, chf) => {
    expect(convertToChf(net, currency, false, rates)).toEqual({ rate: rates.get(currency), netChf: chf, issues: [] });
  });

  it("blocks an unsupported or missing currency", () => {
    expect(codes(convertToChf(100, "JPY", false, rates).issues)).toEqual(["CURRENCY_UNSUPPORTED"]);
    expect(codes(convertToChf(100, null, false, rates).issues)).toEqual(["CURRENCY_MISSING"]);
    expect(convertToChf(100, null, true, rates).issues).toEqual([]); // unverified: reported elsewhere
  });
});

describe("dates", () => {
  const sent = "2026-05-14T08:12:00.000Z";

  it("blocks the order, not the approval, when the date is vague", () => {
    const r = checkDeliveryDate(null, "bis Ende Mai", false, sent);
    expect(r.date).toBeNull();
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([["DELIVERY_DATE_MISSING", "blocks_order"]]);
    expect(r.issues[0]?.message).toContain('"bis Ende Mai"');
  });

  it("accepts an exact date and warns if it is before the email", () => {
    expect(checkDeliveryDate("2026-06-30", "bis 30.06.2026", false, sent)).toEqual({ date: "2026-06-30", issues: [] });
    expect(codes(checkDeliveryDate("2026-05-01", "01.05.2026", false, sent).issues)).toEqual(["DELIVERY_DATE_IN_PAST"]);
  });

  it("warns about an expired quote (email 31: valid until 30.04.2026, sent 14.05.2026)", () => {
    expect(codes(checkQuoteValidity("2026-04-30", sent))).toEqual(["QUOTE_EXPIRED"]);
    expect(checkQuoteValidity("2026-06-12", sent)).toEqual([]);
  });
});

describe("whole pipeline of checks", () => {
  let ref: ReferenceData;
  let doc25: SourceDocument;
  beforeAll(async () => {
    const db = openDb(":memory:");
    applySchema(db);
    seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
    ref = loadReferenceData(db);
    doc25 = await parseEmail(readFileSync("data/emails/email_25.eml"));
  });

  it("establishes everything for a clean quote (email 25); only the vague date blocks the order", () => {
    const r = runChecks(doc25, email25(), [], ref);
    expect(r).toMatchObject({
      requesterEmployeeId: "EMP-111",
      supplierId: "SUP-011",
      supplierMatchedBy: "vat",
      costCenterCode: "CC-1003",
      currency: "EUR",
      netTotal: 3150,
      vatAmount: 0,
      fxRate: 0.96,
      netTotalChf: 3024,
      requestedDeliveryDate: null,
    });
    expect(r.lines[0]).toMatchObject({ quantity: 15000, unitPrice: 21, pricePer: 100, amount: 3150 });
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([["DELIVERY_DATE_MISSING", "blocks_order"]]);
  });

  it("never uses an unverified value: the cost centre is dropped and the reason recorded", () => {
    const r = runChecks(doc25, email25(), [{ field: "cost_center_code", reason: "quote_not_in_source" }], ref);
    expect(r.costCenterCode).toBeNull();
    expect(codes(r.issues)).toEqual(["UNVERIFIED_VALUE", "DELIVERY_DATE_MISSING"]); // no duplicate "missing"
    expect(blocksApproval(r.issues)).toBe(true);
  });

  it("does not store an unverified line value as established", () => {
    const r = runChecks(doc25, email25(), [{ field: "line_items[0].quantity", reason: "value_not_in_quote" }], ref);
    expect(r.lines[0]?.quantity).toBeNull();
    expect(r.netTotal).toBeNull(); // the line can't be totalled, so neither can the requisition
  });

  it("ignores a line total the document doesn't state, and still totals the line (emails 46, 50)", () => {
    const r = runChecks(doc25, email25(), [{ field: "line_items[0].line_total", reason: "value_not_in_quote" }], ref);
    expect(r.netTotal).toBe(3150); // qty × price / price_per, computed by code
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
      ["UNVERIFIED_VALUE", "warning"],
      ["DELIVERY_DATE_MISSING", "blocks_order"],
    ]);
  });

  it("flags an email that mentions an attachment it doesn't have (email 01)", async () => {
    const doc01 = await parseEmail(readFileSync("data/emails/email_01_clean_with_pdf.eml"));
    expect(codes(checkMissingAttachment(doc01))).toEqual(["ATTACHMENT_MISSING"]);
    expect(checkMissingAttachment(doc25)).toEqual([]);
  });

  it("turns a failed extraction into one blocking issue, but not an unavailable LLM", () => {
    expect(codes(issuesForFailedExtraction({ ok: false, kind: "invalid_output", message: "", attempts: 2, rawOutput: "x" }))).toEqual(["EXTRACTION_FAILED"]);
    expect(issuesForFailedExtraction({ ok: false, kind: "llm_unavailable", message: "", attempts: 1, rawOutput: null })).toEqual([]);
  });
});
