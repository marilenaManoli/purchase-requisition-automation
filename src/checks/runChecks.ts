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
import { findRequester } from "./requester.ts";
import { matchSupplier } from "./supplier.ts";
import { isTrusted, trusted, unverifiedIssues } from "./trust.ts";

// Runs every check on one extraction and returns what has been ESTABLISHED
// (null = not established) plus every issue found. Pure: no database writes,
// no LLM calls, so it can be re-run any time, e.g. after a clerk's correction.

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
  supplierMatchedBy: "vat" | "name" | null;
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

export function runChecks(doc: SourceDocument, x: Extraction, unverified: UnverifiedValue[], ref: ReferenceData): CheckResult {
  // Shorthands: `t` = trusted value or null, `bad` = "this field failed verification".
  const t = <T>(field: string, value: T | null) => trusted(field, value, unverified);
  const bad = (field: string) => !isTrusted(field, unverified);

  const requester = findRequester(doc.fromEmail, ref.employees);

  const supplier = matchSupplier(
    t("supplier_name", x.supplier_name.value),
    t("supplier_vat_id", x.supplier_vat_id.value),
    bad("supplier_name") || bad("supplier_vat_id"),
    ref.suppliers,
  );

  const costCenter = checkCostCenter(
    t("cost_center_code", x.cost_center_code.value),
    t("cost_center_name", x.cost_center_name.value),
    bad("cost_center_code"),
    requester.defaultCostCenter,
    ref.costCenters,
  );

  // Every total the model reported, whatever field it put it in; amounts.ts reads the label itself.
  const totals: StatedTotal[] = [];
  for (const f of ["net_total", "gross_total", "total_unlabelled"] as const) {
    const { value, evidence } = x[f];
    if (value !== null && evidence !== null && !bad(f)) totals.push({ value, evidence });
  }

  const amounts = checkAmounts({
    lines: x.line_items.map((l, i) => {
      const p = `line_items[${i}]`;
      return {
        quantity: l.quantity,
        unitPrice: l.unit_price,
        pricePer: l.price_per,
        // An unverified line total is a number the document doesn't state (often the
        // model's own multiplication): ignore it; code computes qty × price anyway.
        lineTotal: t(`${p}.line_total`, l.line_total),
        // The line can only be totalled if the figures it is computed from are verified.
        untrusted: bad(`${p}.quantity`) || bad(`${p}.unit_price`) || bad(`${p}.price_per`),
      };
    }),
    totals,
    vatAmount: t("vat_amount", x.vat_amount.value),
  });

  const currency = t("currency", x.currency.value);
  const fx = convertToChf(amounts.net, currency, bad("currency"), ref.fxRatesToChf);

  const delivery = checkDeliveryDate(
    t("requested_delivery.iso", x.requested_delivery.iso),
    x.requested_delivery.text,
    bad("requested_delivery.iso"),
    doc.sentAt,
  );

  const issues = [
    ...unverifiedIssues(unverified),
    ...checkMissingAttachment(doc),
    ...requester.issues,
    ...supplier.issues,
    ...costCenter.issues,
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
    // Only trusted values; the raw claim stays in the stored extraction for the clerk to see.
    lines: x.line_items.map((l, i) => ({
      description: l.description,
      itemCode: t(`line_items[${i}].item_code`, l.item_code),
      quantity: t(`line_items[${i}].quantity`, l.quantity),
      unit: t(`line_items[${i}].unit`, l.unit),
      unitPrice: t(`line_items[${i}].unit_price`, l.unit_price),
      pricePer: t(`line_items[${i}].price_per`, l.price_per),
      amount: amounts.lineAmounts[i] ?? null,
    })),
    issues,
  };
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
