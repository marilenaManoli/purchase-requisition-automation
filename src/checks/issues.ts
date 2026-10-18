// Every finding about a requisition is an Issue. Severity decides what it blocks:
//   blocks_approval → requisition goes to Needs review; no approval chain starts
//   blocks_order    → may be approved, but can't be sent to the ERP until fixed
//   warning         → shown to the clerk, blocks nothing
export type Severity = "blocks_approval" | "blocks_order" | "warning";

// A union of string literals: a typo like "SUPLIER_BLOCKED" is a compile error.
export type IssueCode =
  | "UNVERIFIED_VALUE"
  | "REQUESTER_UNKNOWN"
  | "SUPPLIER_MISSING"
  | "SUPPLIER_UNKNOWN"
  | "SUPPLIER_VAT_UNKNOWN"
  | "SUPPLIER_AMBIGUOUS"
  | "SUPPLIER_CONFLICT"
  | "SUPPLIER_NAME_ONLY"
  | "SUPPLIER_BLOCKED"
  | "COST_CENTER_MISSING"
  | "COST_CENTER_UNKNOWN"
  | "NO_LINE_ITEMS"
  | "LINE_PRICE_MISSING"
  | "LINE_QUANTITY_MISSING"
  | "LINE_TOTAL_MISMATCH"
  | "AMOUNT_CONTRADICTION"
  | "AMOUNT_MISSING"
  | "AMOUNT_NOT_POSITIVE"
  | "VAT_STATUS_NOT_STATED"
  | "CURRENCY_MISSING"
  | "CURRENCY_UNSUPPORTED"
  | "DELIVERY_DATE_MISSING"
  | "DELIVERY_DATE_IN_PAST"
  | "QUOTE_EXPIRED"
  | "ATTACHMENT_MISSING"
  | "EXTRACTION_FAILED"
  | "NO_READABLE_CONTENT"
  | "APPROVER_NOT_FOUND"
  | "APPROVER_AMBIGUOUS"
  | "SELF_APPROVAL_REASSIGNED"
  | "APPROVER_NEEDED"
  | "DUPLICATE_SUSPECTED"
  | "CORRECTION_SUSPECTED"
  | "CORRECTION_WITHOUT_REFERENCE"
  | "REFERENCED_REQUISITION"
  | "REFERENCED_REQUISITION_NOT_FOUND";

export interface Issue {
  code: IssueCode;
  severity: Severity;
  field: string | null; // which extracted field it concerns, if any
  message: string; // for the clerk; logs use `code` only (no personal data)
}

export function issue(code: IssueCode, severity: Severity, field: string | null, message: string): Issue {
  return { code, severity, field, message };
}

export function blocksApproval(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "blocks_approval");
}
