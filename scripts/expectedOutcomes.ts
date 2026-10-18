// What each sample email SHOULD produce, taken from the test cases in CLAUDE.md
// (which come from reading the brief and the emails). `npm run run-all` compares
// the real pipeline against this, so correctness is scored, not just "verified".
// Emails without an entry (03, 06, 18, 26, 32, 33, 41, 42, 43) have no stated
// expectation and are reported without a verdict.

import type { IssueCode } from "../src/checks/issues.ts";

export interface Expected {
  state: "pending_approval" | "needs_review";
  band?: number;
  netChf?: number;
  supplier?: string;
  approvers?: string[]; // current-round chain, in order (employee ids)
  issues?: IssueCode[]; // must be among the requisition's issues (any severity)
  why: string;
}

export const EXPECTED: Record<string, Expected> = {
  "01": { state: "needs_review", issues: ["ATTACHMENT_MISSING"], why: "says a PDF is attached, but has none" },
  "02": { state: "needs_review", issues: ["COST_CENTER_MISSING"], why: "only 'London office', no code" },
  "04": { state: "needs_review", why: "'das Übliche': nothing concrete" },
  "05": { state: "pending_approval", band: 2, netChf: 9700, why: "net 9,700 decides, not gross 10,485.70" },
  "07": { state: "pending_approval", band: 2, netChf: 1062.2, supplier: "SUP-006", why: "GBP 940 → CHF 1,062.20; ACME Bearing Group by VAT ID" },
  "08": { state: "needs_review", issues: ["SUPPLIER_UNKNOWN"], why: "Stahlhandel Wyss AG is not in the master data" },
  "09": { state: "needs_review", issues: ["SUPPLIER_BLOCKED"], supplier: "SUP-018", why: "Baltic Steel is blocked" },
  "10": { state: "pending_approval", band: 1, supplier: "SUP-019", why: "Werkstatt Huber: name-only match (no VAT ID)" },
  "11": { state: "needs_review", issues: ["SUPPLIER_CONFLICT"], why: "name = SUP-007, VAT ID = SUP-004" },
  "12": { state: "pending_approval", band: 1, netChf: 999, why: "CHF 999 → band 1" },
  "13": { state: "pending_approval", band: 1, netChf: 1000, why: "CHF 1,000.00 → band 1" },
  "14": { state: "pending_approval", band: 2, netChf: 1001, why: "CHF 1,001 → band 2" },
  "15": { state: "pending_approval", band: 3, netChf: 10057, why: "GBP 8,900 → CHF 10,057" },
  "16": { state: "pending_approval", band: 2, netChf: 9984, why: "EUR 10,400 → CHF 9,984" },
  "17": { state: "pending_approval", band: 3, netChf: 49920, approvers: ["EMP-501", "EMP-701"], why: "EUR 52,000 → CHF 49,920; Andrea's two steps collapse" },
  "19": { state: "pending_approval", band: 5, netChf: 299200, why: "USD 340,000 → CHF 299,200" },
  "20": { state: "pending_approval", band: 5, netChf: 285000, why: "CHF 285,000 → band 5" },
  "21": { state: "pending_approval", approvers: ["EMP-501"], why: "Hans requests on his own CC-1001: his step passes to Andrea" },
  "22": { state: "pending_approval", approvers: ["EMP-501"], why: "CC-1004: Andrea is owner and head → one step" },
  "23": { state: "needs_review", issues: ["APPROVER_NEEDED"], why: "Andrea requests on CC-1004: nobody else left" },
  "24": { state: "needs_review", issues: ["AMOUNT_CONTRADICTION"], why: "lines 4,380 vs total 4,830" },
  "25": { state: "pending_approval", band: 2, netChf: 3024, why: "15,000 pcs at EUR 21.00 per 100 = 3,150 (not 315,000)" },
  "27": { state: "needs_review", why: "no prices" },
  "28": { state: "needs_review", why: "'roughly ten', 'around five thousand'" },
  "29": { state: "needs_review", issues: ["DUPLICATE_SUSPECTED"], why: "resend of 01 with the PDF" },
  "30": { state: "needs_review", issues: ["CORRECTION_WITHOUT_REFERENCE"], why: "correction without a reference" },
  "31": { state: "pending_approval", band: 3, netChf: 18672, issues: ["QUOTE_EXPIRED"], why: "quote valid until 30.04.2026 → warning only" },
  "34": { state: "needs_review", issues: ["LINE_PRICE_MISSING"], why: "free-of-charge line has no price" },
  "35": { state: "pending_approval", band: 2, netChf: 5376, why: "discount line −900 → net EUR 5,600" },
  "36": { state: "pending_approval", band: 2, netChf: 8571.2, why: "freight line included → USD 9,740" },
  "37": { state: "pending_approval", band: 4, netChf: 74880, why: "many lines with item codes, EUR 78,000" },
  "39": { state: "needs_review", issues: ["REFERENCED_REQUISITION_NOT_FOUND"], why: "refers to PR-2026-0412, which doesn't exist" },
  "40": { state: "needs_review", issues: ["COST_CENTER_UNKNOWN"], why: "CC-9100 doesn't exist" },
  "44": { state: "needs_review", why: "a datasheet, not a quote: no price" },
  "45": { state: "pending_approval", band: 3, netChf: 39552, why: "long forwarded thread, EUR 41,200" },
  "46": { state: "pending_approval", approvers: ["EMP-501"], why: "Tobias requests (sender), Andrea approves once" },
  "48": { state: "pending_approval", why: "pasted table" },
  "49": { state: "pending_approval", band: 3, netChf: 19080, why: "HTML body + PDF" },
  "50": { state: "pending_approval", band: 4, approvers: ["EMP-501", "EMP-701", "EMP-801"], why: "'CFO approved, skip approval' is ignored" },
};
