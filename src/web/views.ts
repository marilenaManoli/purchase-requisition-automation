import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import { ClerkOverridesSchema, overriddenFields, type ClerkOverrides } from "../checks/overrides.ts";
import { findUnverifiedValues } from "../extract/evidence.ts";
import { ExtractionSchema, type Extraction } from "../extract/schema.ts";
import { buildChain } from "../approval/chain.ts";
import { currentStep } from "../workflow/approvals.ts";
import { auditTrail, type AuditEvent } from "../workflow/audit.ts";
import { requisitionNumber } from "../workflow/duplicates.ts";
import type { State } from "../workflow/states.ts";

// Read-only view data for the templates. Routes stay thin and templates only
// display: every decision about what to show is made here, in testable code.

export interface InboxRow {
  id: number;
  number: string;
  state: State;
  receivedAt: string;
  fromEmail: string | null;
  subject: string | null;
  supplierName: string | null;
  netTotal: number | null;
  currency: string | null;
  netTotalChf: number | null;
  band: number | null;
  blockingIssues: number;
  waitingForId: string | null; // approver id, if pending
  waitingFor: string | null; // approver name, if pending
}

export function inboxRows(db: Db, ref: ReferenceData, filter: { state?: string; waitingFor?: string }): InboxRow[] {
  const rows = db.prepare(
    `SELECT r.id, r.state, r.created_at, r.net_total, r.currency, r.net_total_chf, r.band, r.supplier_id,
            e.from_email, e.subject, e.received_at,
            (SELECT COUNT(*) FROM issues i WHERE i.requisition_id = r.id AND i.severity = 'blocks_approval' AND i.resolved_at IS NULL) AS blocking
     FROM requisitions r JOIN emails e ON e.id = r.email_id
     ORDER BY r.id DESC`,
  ).all() as {
    id: number; state: State; created_at: string; net_total: number | null; currency: string | null; net_total_chf: number | null;
    band: number | null; supplier_id: string | null; from_email: string | null; subject: string | null; received_at: string; blocking: number;
  }[];

  return rows
    .map((r) => {
      const step = r.state === "pending_approval" ? currentStep(db, r.id) : undefined;
      return {
        id: r.id,
        number: requisitionNumber(r.id, r.created_at),
        state: r.state,
        receivedAt: r.received_at,
        fromEmail: r.from_email,
        subject: r.subject,
        supplierName: ref.suppliers.find((s) => s.id === r.supplier_id)?.name ?? null,
        netTotal: r.net_total,
        currency: r.currency,
        netTotalChf: r.net_total_chf,
        band: r.band,
        blockingIssues: r.blocking,
        waitingForId: step?.approver_employee_id ?? null,
        waitingFor: step ? employeeName(ref, step.approver_employee_id) : null,
      };
    })
    .filter((r) => !filter.state || r.state === filter.state)
    .filter((r) => !filter.waitingFor || r.waitingForId === filter.waitingFor);
}

// --- Detail page -----------------------------------------------------------

export type FieldStatus = "verified" | "unverified" | "clerk" | "suggested" | "not established";

export interface FieldRow {
  label: string;
  established: string | null; // what the system uses
  claim: string | null; // what the model read
  evidence: string | null; // the quote it gave
  status: FieldStatus;
}

export interface LineRow {
  position: number;
  description: string;
  itemCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  pricePer: number | null;
  amount: number | null;
  evidence: string | null;
}

export interface StepRow {
  round: number;
  position: number;
  roles: string;
  approver: string;
  status: string;
  decidedAt: string | null;
  comment: string | null;
  isCurrent: boolean;
}

export interface IssueRow {
  id: number;
  code: string;
  severity: string;
  field: string | null;
  message: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface Detail {
  id: number;
  number: string;
  state: State;
  subject: string | null;
  fromEmail: string | null;
  sentAt: string | null;
  receivedAt: string;
  filename: string | null;
  requester: string | null;
  fields: FieldRow[];
  lines: LineRow[];
  issues: IssueRow[];
  steps: StepRow[];
  currentRound: number;
  notes: { note: string; evidence: string | null }[];
  related: { id: number; number: string; relation: string } | null;
  rejectionReason: string | null;
  audit: AuditEvent[];
  sourceText: string;
  extractionFailed: boolean;
  currentApproverId: string | null; // who may approve/reject right now
  requestedDeliveryDate: string | null;
  poNumber: string | null;
  erpWarnings: string[];
  requesterId: string | null;
  supplierEstablished: boolean;
  glSuggested: string | null;
  glConfirmed: string | null;
  supplierClaim: { name: string | null; vatId: string | null };
  /** For needs_review: the chain a submit would build; a null approver must be assigned. */
  proposedChain: { position: number; roles: string; approverId: string | null; approver: string }[] | null;
}

export function requisitionDetail(db: Db, ref: ReferenceData, id: number): Detail | null {
  const r = db.prepare(
    `SELECT r.*, e.subject, e.from_email, e.sent_at, e.received_at, e.filename, e.source_text
     FROM requisitions r JOIN emails e ON e.id = r.email_id WHERE r.id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;

  const str = (k: string) => (r[k] as string | null) ?? null;
  const num = (k: string) => (r[k] as number | null) ?? null;
  const sourceText = str("source_text") ?? "";
  const x: Extraction | null = r.extraction_json ? ExtractionSchema.parse(JSON.parse(r.extraction_json as string)) : null;
  const overrides: ClerkOverrides = r.clerk_overrides_json ? ClerkOverridesSchema.parse(JSON.parse(r.clerk_overrides_json as string)) : {};
  const unverified = new Set(x ? findUnverifiedValues(x, sourceText).map((u) => u.field) : []);
  const byClerk = overriddenFields(overrides);

  // Status of one row: clerk decision > failed verification > established > nothing.
  const status = (fields: string[], established: unknown): FieldStatus => {
    if (fields.some((f) => byClerk.has(f))) return "clerk";
    if (fields.some((f) => [...unverified].some((u) => u === f || u.startsWith(f + ".")))) return "unverified";
    return established === null || established === undefined ? "not established" : "verified";
  };
  const money = (n: number | null, cur: string | null) => (n === null ? null : `${formatMoney(n)}${cur ? " " + cur : ""}`);

  const supplier = ref.suppliers.find((s) => s.id === r.supplier_id);
  const costCenter = ref.costCenters.find((c) => c.code === r.cost_center_code);
  const currency = str("currency");

  const fields: FieldRow[] = [
    { label: "Supplier", established: supplier ? `${supplier.id} ${supplier.name}${supplier.status === "blocked" ? " (BLOCKED)" : ""}` : null,
      claim: x?.supplier_name.value ?? null, evidence: x?.supplier_name.evidence ?? null, status: status(["supplier_name"], supplier) },
    { label: "Supplier VAT ID", established: supplier?.vat_id ?? null,
      claim: x?.supplier_vat_id.value ?? null, evidence: x?.supplier_vat_id.evidence ?? null, status: status(["supplier_vat_id"], supplier?.vat_id ?? null) },
    { label: "Cost centre", established: costCenter ? `${costCenter.code} ${costCenter.name}` : null,
      claim: x?.cost_center_code.value ?? x?.cost_center_name.value ?? null, evidence: x?.cost_center_code.evidence ?? x?.cost_center_name.evidence ?? null,
      status: status(["cost_center_code"], costCenter) },
    { label: "Currency", established: currency, claim: x?.currency.value ?? null, evidence: x?.currency.evidence ?? null, status: status(["currency"], currency) },
    { label: "Net total", established: money(num("net_total"), currency),
      claim: x?.net_total.value !== null && x?.net_total.value !== undefined ? formatMoney(x.net_total.value) : null,
      evidence: x?.net_total.evidence ?? null, status: status(["net_total"], num("net_total")) },
    { label: "VAT", established: money(num("vat_amount"), currency), claim: x?.vat_amount.value?.toString() ?? null,
      evidence: x?.vat_amount.evidence ?? null, status: status(["vat_amount"], num("vat_amount")) },
    { label: "Gross total", established: money(num("gross_total"), currency), claim: x?.gross_total.value?.toString() ?? null,
      evidence: x?.gross_total.evidence ?? null, status: status(["gross_total"], num("gross_total")) },
    { label: "Total (VAT not stated)", established: null, claim: x?.total_unlabelled.value?.toString() ?? null,
      evidence: x?.total_unlabelled.evidence ?? null, status: status(["total_unlabelled"], null) },
    { label: "Net in CHF (decides the band)", established: money(num("net_total_chf"), "CHF"), claim: null, evidence: null,
      status: num("net_total_chf") === null ? "not established" : "verified" },
    { label: "Approval band", established: num("band")?.toString() ?? null, claim: null, evidence: null,
      status: num("band") === null ? "not established" : "verified" },
    { label: "Requested delivery date", established: str("requested_delivery_date"),
      claim: x ? [x.requested_delivery.text, x.requested_delivery.iso].filter(Boolean).join(" → ") || null : null,
      evidence: x?.requested_delivery.evidence ?? null, status: status(["requested_delivery"], str("requested_delivery_date")) },
    (() => {
      // GL account: a code-made suggestion (with its reason) until the clerk confirms one.
      const confirmed = ref.glAccounts.find((g) => g.code === r.gl_account_code);
      const suggested = ref.glAccounts.find((g) => g.code === r.gl_account_suggested);
      return {
        label: "GL account",
        established: confirmed ? `${confirmed.code} ${confirmed.name}` : null,
        claim: suggested ? `suggested: ${suggested.code} ${suggested.name}` : null,
        evidence: str("gl_suggestion_reason"),
        status: (confirmed ? "clerk" : suggested ? "suggested" : "not established") as FieldStatus,
      };
    })(),
    { label: "Quote valid until", established: null, claim: x?.quote_valid_until.iso ?? x?.quote_valid_until.text ?? null,
      evidence: x?.quote_valid_until.evidence ?? null, status: status(["quote_valid_until"], null) },
    { label: "Quote number", established: null, claim: x?.quote_number.value ?? null, evidence: x?.quote_number.evidence ?? null,
      status: status(["quote_number"], null) },
  ];

  const lines = (db.prepare(`SELECT * FROM line_items WHERE requisition_id = ? ORDER BY position`).all(id) as Record<string, unknown>[])
    .map((l) => ({
      position: l.position as number,
      description: l.description as string,
      itemCode: l.item_code as string | null,
      quantity: l.quantity as number | null,
      unit: l.unit as string | null,
      unitPrice: l.unit_price as number | null,
      pricePer: l.price_per as number | null,
      amount: l.line_total as number | null,
      evidence: x?.line_items[(l.position as number) - 1]?.evidence ?? null,
    }));

  const issues = (db.prepare(`SELECT * FROM issues WHERE requisition_id = ? ORDER BY resolved_at IS NOT NULL, id`).all(id) as Record<string, unknown>[])
    .map((i) => ({
      id: i.id as number, code: i.code as string, severity: i.severity as string, field: i.field as string | null,
      message: i.message as string, resolvedAt: i.resolved_at as string | null, resolvedBy: i.resolved_by as string | null,
      resolution: i.resolution as string | null,
    }));

  const current = currentStep(db, id);
  const steps = (db.prepare(`SELECT * FROM approval_steps WHERE requisition_id = ? ORDER BY round DESC, position`).all(id) as Record<string, unknown>[])
    .map((s) => ({
      round: s.round as number, position: s.position as number, roles: (s.roles as string).replaceAll(",", " + "),
      approver: s.approver_employee_id ? employeeName(ref, s.approver_employee_id as string) : "— (clerk must assign)",
      status: s.status as string, decidedAt: s.decided_at as string | null, comment: s.comment as string | null,
      isCurrent: r.state === "pending_approval" && current?.id === s.id,
    }));

  const relatedId = num("related_requisition_id");
  const related = relatedId === null ? null : (() => {
    const o = db.prepare(`SELECT id, created_at FROM requisitions WHERE id = ?`).get(relatedId) as { id: number; created_at: string };
    return { id: o.id, number: requisitionNumber(o.id, o.created_at), relation: str("relation") ?? "" };
  })(); // an "immediately invoked function": a small block that returns a value

  return {
    id,
    number: requisitionNumber(id, r.created_at as string),
    state: r.state as State,
    subject: str("subject"),
    fromEmail: str("from_email"),
    sentAt: str("sent_at"),
    receivedAt: r.received_at as string,
    filename: str("filename"),
    requester: r.requester_employee_id ? employeeName(ref, r.requester_employee_id as string) : null,
    fields,
    lines,
    issues,
    steps,
    currentRound: num("approval_round") ?? 1,
    notes: x?.notes_for_clerk ?? [],
    related,
    rejectionReason: str("rejection_reason"),
    audit: auditTrail(db, id),
    sourceText,
    extractionFailed: x === null,
    currentApproverId: r.state === "pending_approval" ? current?.approver_employee_id ?? null : null,
    requestedDeliveryDate: str("requested_delivery_date"),
    poNumber: str("erp_po_number"),
    erpWarnings: r.erp_warnings_json ? (JSON.parse(r.erp_warnings_json as string) as string[]) : [],
    requesterId: str("requester_employee_id"),
    supplierEstablished: supplier !== undefined,
    glSuggested: str("gl_account_suggested"),
    glConfirmed: str("gl_account_code"),
    supplierClaim: { name: x?.supplier_name.value ?? null, vatId: x?.supplier_vat_id.value ?? null },
    proposedChain: r.state === "needs_review" && num("net_total_chf") !== null && str("cost_center_code") !== null
      ? buildChain(num("net_total_chf")!, str("cost_center_code")!, str("requester_employee_id"), ref).steps.map((s) => ({
          position: s.position,
          roles: s.roles.join(" + "),
          approverId: s.approverEmployeeId,
          approver: s.approverEmployeeId ? employeeName(ref, s.approverEmployeeId) : "— must be assigned",
        }))
      : null,
  };
}

export function employeeName(ref: ReferenceData, id: string | null): string {
  if (id === null) return "—";
  const e = ref.employees.find((x) => x.id === id);
  return e ? `${e.name} (${id})` : id;
}

/** 3150 → "3,150.00" (Swiss-style apostrophes would also be fine; English keeps it unambiguous). */
export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
