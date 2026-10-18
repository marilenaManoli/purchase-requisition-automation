import type { UnverifiedValue } from "../extract/evidence.ts";
import { issue, type Issue, type Severity } from "./issues.ts";

// Values the evidence check could not verify are never used by later checks.
// This module answers "may I use this field?" and turns each unverified value
// into an issue whose severity depends on what the field is used for.

/** True unless the field, or a field containing it, was reported unverified. */
export function isTrusted(field: string, unverified: UnverifiedValue[]): boolean {
  // "line_items[1].unit_price" is untrusted if "line_items[1].unit_price" OR "line_items[1]" is listed.
  return !unverified.some((u) => field === u.field || field.startsWith(u.field + ".") || field.startsWith(u.field + "["));
}

/** Returns the value if trusted, otherwise null ("not established"). */
export function trusted<T>(field: string, value: T | null, unverified: UnverifiedValue[]): T | null {
  return isTrusted(field, unverified) ? value : null;
}

// What an unverified value blocks depends on what the field feeds into.
function severityFor(field: string): Severity {
  const top = field.split(/[.[]/)[0] ?? field; // "line_items[1].unit_price" → "line_items"
  switch (top) {
    case "supplier_name":
    case "supplier_vat_id":
    case "cost_center_code":
    case "currency":
    case "net_total":
    case "vat_amount":
    case "gross_total":
    case "total_unlabelled":
    case "line_items":
      return "blocks_approval"; // feeds matching, amounts or routing
    case "requested_delivery":
      return "blocks_order"; // same as a missing delivery date
    default:
      return "warning"; // requester name, quote number, notes…: informational
  }
}

const REASON_TEXT: Record<UnverifiedValue["reason"], string> = {
  missing_evidence: "the model gave no quote for it",
  quote_not_in_source: "its quote does not appear in the email",
  value_not_in_quote: "the value cannot be read from its quote",
};

export function unverifiedIssues(unverified: UnverifiedValue[]): Issue[] {
  return unverified.map((u) =>
    issue(
      "UNVERIFIED_VALUE",
      severityFor(u.field),
      u.field,
      `Extracted ${u.field} could not be verified (${REASON_TEXT[u.reason]}); it is not used until a clerk confirms it.`,
    ),
  );
}
