import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { findUnverifiedValues, isApproximate, numbersIn } from "../src/extract/evidence.ts";
import { extractRequisition, parseModelOutput } from "../src/extract/extract.ts";
import { extractionJsonSchema } from "../src/extract/schema.ts";
import { parseEmail } from "../src/ingest/parseEmail.ts";
import { renderSourceText, type SourceDocument } from "../src/ingest/sourceDocument.ts";
import { email25, FakeLlm } from "./fixtures.ts";

let doc25: SourceDocument;
let source25: string;
beforeAll(async () => {
  doc25 = await parseEmail(readFileSync("data/emails/email_25.eml"));
  source25 = renderSourceText(doc25);
});

describe("extractRequisition", () => {
  it("accepts a valid answer on the first attempt", async () => {
    const llm = new FakeLlm(JSON.stringify(email25()));
    const out = await extractRequisition(doc25, llm);

    expect(out).toMatchObject({ ok: true, attempts: 1, unverified: [] });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[1]?.content).toContain("Offert-Nr.: TP-26-0884"); // the model saw the PDF text
  });

  it("retries once with the validation error, then accepts", async () => {
    const llm = new FakeLlm("Sure! Here is the JSON you asked for:", JSON.stringify(email25()));
    const out = await extractRequisition(doc25, llm);

    expect(out).toMatchObject({ ok: true, attempts: 2 });
    const retry = llm.calls[1] ?? [];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: "Sure! Here is the JSON you asked for:" });
    expect(retry.at(-1)?.content).toContain("not valid JSON");
  });

  it("gives up after two invalid answers and keeps the raw output", async () => {
    const wrongType = { ...email25(), line_items: [{ ...email25().line_items[0], quantity: "ten" }] };
    const llm = new FakeLlm("{ broken", JSON.stringify(wrongType));
    const out = await extractRequisition(doc25, llm);

    expect(out.ok).toBe(false);
    if (out.ok) return; // narrows the type for TypeScript
    expect(out.kind).toBe("invalid_output");
    expect(out.attempts).toBe(2);
    expect(out.message).toContain("line_items[0].quantity");
    expect(out.rawOutput).toBe(JSON.stringify(wrongType));
  });

  it("does not retry when the LLM server is unreachable", async () => {
    const llm = new FakeLlm(new Error("connect ECONNREFUSED"));
    const out = await extractRequisition(doc25, llm);

    expect(out).toMatchObject({ ok: false, kind: "llm_unavailable", attempts: 1 });
    expect(llm.calls).toHaveLength(1);
  });

  it("does not call the LLM when there is nothing to read", async () => {
    const empty = await parseEmail(Buffer.from(""));
    const llm = new FakeLlm();
    const out = await extractRequisition(empty, llm);

    expect(out).toMatchObject({ ok: false, kind: "no_content", attempts: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects an ISO date that is not YYYY-MM-DD", () => {
    const bad = { ...email25(), quote_valid_until: { text: "12.06.2026", iso: "12.06.2026", evidence: "Gültig bis: 12.06.2026" } };
    const result = parseModelOutput(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });
});

describe("findUnverifiedValues", () => {
  it("finds nothing wrong with a faithful extraction", () => {
    expect(findUnverifiedValues(email25(), source25)).toEqual([]);
  });

  it("flags a quote that does not appear in the source (invented evidence)", () => {
    const x = email25();
    x.cost_center_code = { value: "CC-1002", evidence: "Kostenstelle CC-1002" };
    expect(findUnverifiedValues(x, source25)).toEqual([{ field: "cost_center_code", reason: "quote_not_in_source" }]);
  });

  it("flags a misread number even though its quote is real (315,000 vs 3,150)", () => {
    const x = email25();
    x.net_total = { value: 315000, evidence: "Zwischensumme: 3,150.00 EUR" };
    expect(findUnverifiedValues(x, source25)).toEqual([{ field: "net_total", reason: "value_not_in_quote" }]);
  });

  it("flags a line total the model computed instead of copying", () => {
    const x = email25();
    const line = x.line_items[0]!; // `!` asserts "not undefined": we built this array ourselves
    line.line_total = 315000; // 15000 × 21, ignoring "per 100"
    expect(findUnverifiedValues(x, source25)).toEqual([{ field: "line_items[0].line_total", reason: "value_not_in_quote" }]);
  });

  it("tolerates a table header in front of a row (seen in real model output)", () => {
    const x = email25();
    x.line_items[0]!.evidence =
      "# Beschreibung Menge Einheit Einzelpreis\n1 Kunststoffclip KC-8, schwarz\nArt.-Nr. KC-8-SW 15000 Stk 21.00 / 100 3,150.00";
    expect(findUnverifiedValues(x, source25)).toEqual([]);
  });

  it("flags values stitched together from different places in the document", () => {
    const x = email25();
    // A real description line plus a real number line from elsewhere (the totals block).
    x.line_items[0]!.evidence = "1 Kunststoffclip KC-8, schwarz\nTotal: 3,150.00 EUR";
    x.line_items[0]!.quantity = 3150;
    x.line_items[0]!.unit_price = null;
    x.line_items[0]!.price_per = null;
    x.line_items[0]!.item_code = null;
    x.line_items[0]!.unit = null;
    x.line_items[0]!.line_total = null;
    // Each line exists in the source, but no single passage holds description AND quantity,
    // so one of the two is reported (whichever passage is checked as the best match).
    const problems = findUnverifiedValues(x, source25);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toBe("value_not_in_quote");
  });

  it("flags a value without any evidence", () => {
    const x = email25();
    x.supplier_vat_id = { value: "DE667788990", evidence: null };
    expect(findUnverifiedValues(x, source25)).toEqual([{ field: "supplier_vat_id", reason: "missing_evidence" }]);
  });

  it("flags an exact date the document does not state", () => {
    const x = email25();
    x.requested_delivery = { text: "bis Ende Mai", iso: "2026-05-31", evidence: "Lieferung bis Ende Mai" };
    expect(findUnverifiedValues(x, source25)).toEqual([{ field: "requested_delivery.iso", reason: "value_not_in_quote" }]);
  });

  it("flags an approximate quantity given as a number (email 28: 'roughly ten')", () => {
    const source = "Could you order roughly ten inductive proximity sensors from Sensorik Nord";
    const x = email25();
    x.line_items = [{
      description: "inductive proximity sensors", item_code: null, quantity: 10, unit: null,
      unit_price: null, price_per: null, line_total: null, evidence: "order roughly ten inductive proximity sensors",
    }];
    const problems = findUnverifiedValues(x, source).filter((p) => p.field.startsWith("line_items"));
    expect(problems).toEqual([{ field: "line_items[0].quantity", reason: "value_not_in_quote" }]);
  });
});

describe("numbersIn", () => {
  it.each([
    ["Total CHF 3'200.00", 3200], // Swiss
    ["Total: 3,150.00 EUR", 3150], // English
    ["Summe 1.234,50 EUR", 1234.5], // German
    ["21.00 / 100", 100],
    ["Rabatt -900.00", -900],
    ["Rabatt −900.00", -900], // Unicode minus sign
  ])("reads %s as containing %d", (text, expected) => {
    expect(numbersIn(text)).toContain(expected);
  });

  it("accepts both readings of an ambiguous notation", () => {
    expect(numbersIn("1.000")).toEqual(expect.arrayContaining([1, 1000]));
  });

  it("does not treat the hyphen in a code as a minus sign", () => {
    expect(numbersIn("Kostenstelle CC-1003")).toContain(1003);
    expect(numbersIn("Kostenstelle CC-1003")).not.toContain(-1003);
  });
});

describe("JSON schema sent to the model", () => {
  it("requires every field, so the model can't silently omit one", () => {
    const schema = extractionJsonSchema as { required?: string[]; properties?: object };
    expect(schema.required).toEqual(Object.keys(schema.properties ?? {}));
    expect(schema.required).toContain("notes_for_clerk");
  });
});

describe("found in the rehearsal with unseen emails", () => {
  it("ignores a list bullet the model put in front of a quote", () => {
    const x = email25();
    x.cost_center_code = { value: "CC-1003", evidence: "- Kostenstelle CC-1003" };
    expect(findUnverifiedValues(x, source25)).toEqual([]);
  });

  it.each([
    ["bitte ca. 50 Stk O-Ring-Dichtungen bestellen", 50, true],
    ["kosten so um die 4 EUR das Stück", 4, true],
    ["around EUR 5,000 in total", 5000, true],
    ["roughly 120 m of cable", 120, true],
    ["~ 30 pcs", 30, true],
    ["4 pcs digital torque wrench, EUR 610.00 each", 610, false],
    ["Question about the order: 12 pcs", 12, false], // "about" not directly before the number
    ["Rabatt -900.00", -900, false],
  ])("isApproximate(%s, %d) = %s", (quote, value, expected) => {
    expect(isApproximate(value, quote)).toBe(expected);
  });
});
