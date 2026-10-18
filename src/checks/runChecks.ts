import type { ReferenceData } from "../db/queries.ts";
import { isApproximate, type UnverifiedValue } from "../extract/evidence.ts";
import type { ExtractionOutcome } from "../extract/extract.ts";
import type { Extraction } from "../extract/schema.ts";
import type { SourceDocument } from "../ingest/sourceDocument.ts";
import { checkAmounts, type StatedTotal } from "./amounts.ts";
import { checkCostCenter } from "./costCenter.ts";
import { renderSourceText } from "../ingest/sourceDocument.ts";
import { checkDeliveryDate, checkMissingAttachment, checkQuoteValidity, findValidUntilInText } from "./dates.ts";
import { convertToChf } from "./fx.ts";
import { issue, type Issue } from "./issues.ts";
import { editsFigures, overriddenFields, type ClerkOverrides } from "./overrides.ts";
import { findRequester } from "./requester.ts";
import { matchSupplier, matchSupplierInText, normaliseCompanyName, type SupplierMatch } from "./supplier.ts";
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

  const sourceText = renderSourceText(doc);
  const modelName = t("supplier_name", x.supplier_name.value);
  const modelVat = t("supplier_vat_id", x.supplier_vat_id.value);
  // Step 9 fallback: if the model gave nothing usable, code looks for a known supplier name in the email.
  const foundInText = ov.supplierId === undefined && modelName === null && modelVat === null
    ? matchSupplierInText(sourceText, x.supplier_name.value, ref.suppliers)
    : null;
  const supplier = ov.supplierId !== undefined
    ? supplierChosenByClerk(ov.supplierId, ref)
    : foundInText ?? matchSupplier(modelName, modelVat, bad("supplier_name") || bad("supplier_vat_id"), ref.suppliers);
  // An unverified supplier claim isn't used. If the supplier was established another
  // way (verified VAT ID, or found in the text) and the claim agrees with it, the
  // claim's "unverified" flag is noise, not a reason to block (email 49).
  const supplierClaimSuperseded = foundInText !== null ||
    (supplier.matchedBy === "vat" && claimAgrees(x.supplier_name.value, supplier.supplierId, ref));

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
    const quantity = pick(o.quantity, "quantity", base?.quantity);
    const statedUnit = pick(o.unit, "unit", base?.unit);
    // Assumption 8: a bare count ("3 office chairs") means counted items. The ERP needs a
    // unit, so "pcs" is used, visibly flagged. A stated unit always wins; an unverified one isn't replaced.
    const unitAssumed = statedUnit === null && quantity !== null && !bad(`${p}.unit`);
    return {
      description: o.description ?? base?.description ?? "",
      itemCode: pick(o.itemCode, "item_code", base?.item_code),
      quantity,
      unit: unitAssumed ? "pcs" : statedUnit,
      unitAssumed,
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
    ...unverifiedIssues(supplierClaimSuperseded ? unverified.filter((u) => u.field !== "supplier_name" && u.field !== "supplier_vat_id") : unverified),
    ...checkMissingAttachment(doc),
    ...requester.issues,
    ...supplier.issues,
    ...costCenter.issues,
    ...(figuresEdited
      ? [issue("TOTALS_RECALCULATED", "warning", null,
          "Line figures were changed by the clerk; the total is recalculated from the lines and the document's totals are not used.")]
      : []),
    ...amounts.issues,
    ...approximateValues(x, unverified, replaced),
    ...lines.flatMap((l, i) => (l.unitAssumed
      ? [issue("UNIT_ASSUMED", "warning", `line_items[${i}].unit`,
          `Line ${i + 1} states a quantity but no unit; it is treated as pieces (assumption 8). Correct it if that's wrong.`)]
      : [])),
    ...fx.issues,
    ...delivery.issues,
    ...quoteValidity(t("quote_valid_until.iso", x.quote_valid_until.iso), sourceText, doc.sentAt),
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

/**
 * "ca. 50 Stk", "so um die 4 EUR": the number is in the quote, so it verifies, but the
 * document itself only estimates it. Never route on an estimate: blocks approval.
 * (Values the clerk has set, or that are unverified anyway, are skipped.)
 */
function approximateValues(x: Extraction, unverified: UnverifiedValue[], replaced: Set<string>) {
  const found: { field: string; value: number }[] = [];
  const consider = (field: string, value: number | null, quote: string | null) => {
    if (value === null || quote === null || replaced.has(field) || !isTrusted(field, unverified)) return;
    if (isApproximate(value, quote)) found.push({ field, value });
  };
  for (const f of ["net_total", "gross_total", "total_unlabelled"] as const) consider(f, x[f].value, x[f].evidence);
  x.line_items.forEach((l, i) => {
    consider(`line_items[${i}].quantity`, l.quantity, l.evidence);
    consider(`line_items[${i}].unit_price`, l.unit_price, l.evidence);
  });
  return found.map((f) => issue("APPROXIMATE_VALUE", "blocks_approval", f.field,
    `The email gives ${f.field} only approximately (${f.value}, e.g. "ca.", "around"). An estimate can't be ordered; the clerk must confirm the exact figure.`));
}

/** True if an (unverified) supplier name claim names no supplier, or the same one. */
function claimAgrees(claim: string | null, supplierId: string | null, ref: ReferenceData): boolean {
  if (claim === null) return true;
  const named = ref.suppliers.filter((s) => normaliseCompanyName(s.name) === normaliseCompanyName(claim));
  return named.length === 0 || named.some((s) => s.id === supplierId);
}

/** The model's validity date if verified; otherwise a labelled date read from the text (step 9 fallback). */
function quoteValidity(modelIso: string | null, sourceText: string, sentAt: string | null) {
  if (modelIso !== null) return checkQuoteValidity(modelIso, sentAt);
  return checkQuoteValidity(findValidUntilInText(sourceText), sentAt, true);
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
