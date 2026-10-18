import type { ReferenceData } from "../db/queries.ts";
import type { UnverifiedValue } from "../extract/evidence.ts";
import type { ExtractionOutcome } from "../extract/extract.ts";
import type { Extraction } from "../extract/schema.ts";
import type { SourceDocument } from "../ingest/sourceDocument.ts";
import { checkAmounts, type StatedTotal } from "./amounts.ts";
import { checkCostCenter } from "./costCenter.ts";
import { checkDeliveryDate, checkMissingAttachment, checkQuoteValidity } from "./dates.ts";
import { convertToChf } from "./fx.ts";
import { issue, type Issue } from "./issues.ts";
import { editsFigures, overriddenFields, type ClerkOverrides } from "./overrides.ts";
import { findRequester } from "./requester.ts";
import { matchSupplier, type SupplierMatch } from "./supplier.ts";
import { isTrusted, trusted, unverifiedIssues } from "./trust.ts";

// Runs every check on one extraction and returns what has been ESTABLISHED
// (null = not established) plus every issue found. Pure: no database writes,
// no LLM calls, so it can be re-run any time, e.g. after a clerk's correction.
//
// Clerk overrides (6c) replace the model's value for a field and count as
// trusted, but pass through the same rules: a blocked supplier still blocks.

export interface CheckedLine {
  description: string;
  itemCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  pricePer: number | null;
  amount: number | null; // computed and cross-checked
}

export interface CheckResult {
  requesterEmployeeId: string | null;
  supplierId: string | null;
  supplierMatchedBy: "vat" | "name" | "clerk" | null;
  costCenterCode: string | null;
  costCenterSuggestions: string[];
  currency: string | null;
  netTotal: number | null; // original currency; decides nothing until converted
  vatAmount: number | null;
  grossTotal: number | null;
  fxRate: number | null;
  netTotalChf: number | null; // decides the approval band (step 5)
  requestedDeliveryDate: string | null;
  lines: CheckedLine[];
  issues: Issue[];
}

export function runChecks(
  doc: SourceDocument,
  x: Extraction,
  allUnverified: UnverifiedValue[],
  ref: ReferenceData,
  ov: ClerkOverrides = {},
): CheckResult {
  // A field the clerk has set is no longer "unverified": a person decided it.
  const replaced = overriddenFields(ov);
  const unverified = allUnverified.filter((u) => !replaced.has(u.field));

  // Shorthands: `t` = trusted value or null, `bad` = "this field failed verification".
  const t = <T>(field: string, value: T | null) => trusted(field, value, unverified);
  const bad = (field: string) => !isTrusted(field, unverified);

  const requester = findRequester(doc.fromEmail, ref.employees);

  const supplier = ov.supplierId !== undefined
    ? supplierChosenByClerk(ov.supplierId, ref)
    : matchSupplier(
        t("supplier_name", x.supplier_name.value),
        t("supplier_vat_id", x.supplier_vat_id.value),
        bad("supplier_name") || bad("supplier_vat_id"),
        ref.suppliers,
      );

  const costCenter = ov.costCenterCode !== undefined
    ? { code: ov.costCenterCode, suggestions: [], issues: [] } // validated against master data on edit
    : checkCostCenter(
        t("cost_center_code", x.cost_center_code.value),
        t("cost_center_name", x.cost_center_name.value),
        bad("cost_center_code"),
        requester.defaultCostCenter,
        ref.costCenters,
      );

  // Lines: the extracted ones, plus any the clerk added; each value from the clerk if set.
  const lineOverrides = ov.lines ?? {};
  const lineCount = Math.max(x.line_items.length, ...Object.keys(lineOverrides).map((k) => Number(k) + 1));
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const base = x.line_items[i];
    const o = lineOverrides[String(i)] ?? {};
    const p = `line_items[${i}]`;
    // `!== undefined` (not `??`): a clerk may deliberately set null or 0.
    const pick = <T>(clerk: T | undefined, field: string, extracted: T | null | undefined): T | null =>
      clerk !== undefined ? clerk : t(`${p}.${field}`, extracted ?? null);
    return {
      description: o.description ?? base?.description ?? "",
      itemCode: pick(o.itemCode, "item_code", base?.item_code),
      quantity: pick(o.quantity, "quantity", base?.quantity),
      unit: pick(o.unit, "unit", base?.unit),
      unitPrice: pick(o.unitPrice, "unit_price", base?.unit_price),
      pricePer: pick(o.pricePer, "price_per", base?.price_per),
      lineTotal: editsFigures(o) ? null : t(`${p}.line_total`, base?.line_total ?? null),
      untrusted: bad(`${p}.quantity`) || bad(`${p}.unit_price`) || bad(`${p}.price_per`),
      edited: editsFigures(o) || base === undefined,
    };
  });

  // If the clerk changed figures or added lines, the document's totals describe
  // other lines: they are no longer compared, and the clerk is told so.
  const figuresEdited = lines.some((l) => l.edited);
  const totals: StatedTotal[] = [];
  if (!figuresEdited) {
    for (const f of ["net_total", "gross_total", "total_unlabelled"] as const) {
      const { value, evidence } = x[f];
      if (value !== null && evidence !== null && !bad(f)) totals.push({ value, evidence });
    }
  }

  const amounts = checkAmounts({
    lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, pricePer: l.pricePer, lineTotal: l.lineTotal, untrusted: l.untrusted })),
    totals,
    vatAmount: figuresEdited ? null : t("vat_amount", x.vat_amount.value),
  });

  const currency = ov.currency ?? t("currency", x.currency.value);
  const fx = convertToChf(amounts.net, currency, bad("currency"), ref.fxRatesToChf);

  const delivery = ov.requestedDeliveryDate !== undefined
    ? checkDeliveryDate(ov.requestedDeliveryDate, null, false, doc.sentAt)
    : checkDeliveryDate(t("requested_delivery.iso", x.requested_delivery.iso), x.requested_delivery.text, bad("requested_delivery.iso"), doc.sentAt);

  const issues = [
    ...unverifiedIssues(unverified),
    ...checkMissingAttachment(doc),
    ...requester.issues,
    ...supplier.issues,
    ...costCenter.issues,
    ...(figuresEdited
      ? [issue("TOTALS_RECALCULATED", "warning", null,
          "Line figures were changed by the clerk; the total is recalculated from the lines and the document's totals are not used.")]
      : []),
    ...amounts.issues,
    ...fx.issues,
    ...delivery.issues,
    ...checkQuoteValidity(t("quote_valid_until.iso", x.quote_valid_until.iso), doc.sentAt),
  ];

  return {
    requesterEmployeeId: requester.employeeId,
    supplierId: supplier.supplierId,
    supplierMatchedBy: supplier.matchedBy,
    costCenterCode: costCenter.code,
    costCenterSuggestions: costCenter.suggestions,
    currency: fx.rate === null ? null : currency,
    netTotal: amounts.net,
    vatAmount: amounts.vat,
    grossTotal: amounts.gross,
    fxRate: fx.rate,
    netTotalChf: fx.netChf,
    requestedDeliveryDate: delivery.date,
    // Only trusted or clerk-entered values; the raw claim stays in the stored extraction.
    lines: lines.map((l, i) => ({
      description: l.description,
      itemCode: l.itemCode,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      pricePer: l.pricePer,
      amount: amounts.lineAmounts[i] ?? null,
    })),
    issues,
  };
}

/** A supplier picked by the clerk from the master data. Its status still applies. */
function supplierChosenByClerk(supplierId: string, ref: ReferenceData): Omit<SupplierMatch, "matchedBy"> & { matchedBy: "clerk" } {
  const s = ref.suppliers.find((x) => x.id === supplierId);
  if (!s) throw new Error(`Unknown supplier ${supplierId}`); // edits are validated before this point
  const issues = s.status === "blocked"
    ? [issue("SUPPLIER_BLOCKED", "blocks_approval", "supplier_name", `${s.id} ${s.name} is blocked in the master data. Nothing may be ordered from a blocked supplier.`)]
    : [];
  return { supplierId: s.id, matchedBy: "clerk", issues };
}

/** A failed extraction becomes a single blocking issue (llm_unavailable is retried instead, step 6). */
export function issuesForFailedExtraction(outcome: Extract<ExtractionOutcome, { ok: false }>): Issue[] {
  switch (outcome.kind) {
    case "no_content":
      return [issue("NO_READABLE_CONTENT", "blocks_approval", null, "The email has no readable text in the body or attachments.")];
    case "invalid_output":
      return [issue("EXTRACTION_FAILED", "blocks_approval", null, "The details could not be extracted automatically. Please enter them by hand.")];
    case "llm_unavailable":
      return [];
  }
}
