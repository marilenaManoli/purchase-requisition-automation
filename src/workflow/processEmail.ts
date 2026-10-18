import { buildChain, type ChainStep } from "../approval/chain.ts";
import { blocksApproval, type Issue } from "../checks/issues.ts";
import { issuesForFailedExtraction, runChecks, type CheckResult } from "../checks/runChecks.ts";
import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import { extractRequisition } from "../extract/extract.ts";
import type { LlmClient } from "../extract/llm.ts";
import { parseEmail } from "../ingest/parseEmail.ts";
import { renderSourceText } from "../ingest/sourceDocument.ts";
import { nowIso, writeAudit } from "./audit.ts";
import { findRelations } from "./duplicates.ts";
import type { State } from "./states.ts";
import { getState, transition } from "./transitions.ts";

// The pipeline for one email:  .eml → inbox → (LLM) → extracted → checks →
// pending_approval or needs_review. The LLM call is async and slow, and
// better-sqlite3 transactions are synchronous, so the work is split:
//   ingestEmail       one transaction: store the email, create the requisition in `inbox`
//   extractAndRoute   LLM call with no transaction open, then one transaction for the results
// If the LLM is unreachable the requisition stays in `inbox` and extractAndRoute can
// simply be called again later: the raw email is stored, nothing is lost.

export async function processEmail(db: Db, raw: Buffer, filename: string | null, llm: LlmClient, ref: ReferenceData): Promise<number> {
  const id = await ingestEmail(db, raw, filename);
  await extractAndRoute(db, id, llm, ref);
  return id;
}

/** Stores the raw email and creates its requisition in `inbox`. Returns the requisition id. */
export async function ingestEmail(db: Db, raw: Buffer, filename: string | null): Promise<number> {
  const doc = await parseEmail(raw); // async (PDF text), so it happens before the transaction
  return db.transaction(() => {
    const now = nowIso();
    const email = db.prepare(
      `INSERT INTO emails (filename, message_id, from_email, subject, sent_at, raw, source_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filename, doc.messageId, doc.fromEmail, doc.subject, doc.sentAt, raw, renderSourceText(doc), now);
    const req = db.prepare(
      `INSERT INTO requisitions (email_id, state, created_at, updated_at) VALUES (?, 'inbox', ?, ?)`,
    ).run(email.lastInsertRowid, now, now);
    const id = Number(req.lastInsertRowid);
    writeAudit(db, id, "system", null, "inbox", `Email received${filename ? ` (${filename})` : ""}`);
    return id;
  })();
}

/** Runs extraction, checks and the chain for a requisition in `inbox`. Returns its new state. */
export async function extractAndRoute(db: Db, id: number, llm: LlmClient, ref: ReferenceData): Promise<State> {
  if (getState(db, id) !== "inbox") throw new Error(`Requisition ${id} is not in inbox`);
  const { raw } = db.prepare(`SELECT e.raw FROM emails e JOIN requisitions r ON r.email_id = e.id WHERE r.id = ?`).get(id) as { raw: Buffer };
  const doc = await parseEmail(raw); // same bytes → same document as at ingestion

  const outcome = await extractRequisition(doc, llm); // the slow part: no transaction is open

  if (!outcome.ok && outcome.kind === "llm_unavailable") {
    // Not the email's fault: record the attempt, stay in inbox, retry later.
    writeAudit(db, id, "system", "inbox", "inbox", `Extraction postponed: ${outcome.message}`);
    return "inbox";
  }

  return db.transaction((): State => {
    db.prepare(`UPDATE requisitions SET extraction_raw = ?, extraction_json = ? WHERE id = ?`)
      .run(outcome.rawOutput, outcome.ok ? JSON.stringify(outcome.extraction) : null, id);

    if (!outcome.ok) {
      saveIssues(db, id, issuesForFailedExtraction(outcome));
      transition(db, id, "needs_review", "system", outcome.message);
      return "needs_review";
    }

    transition(db, id, "extracted", "system",
      `Extracted by ${llm.name} (attempts: ${outcome.attempts}, unverified values: ${outcome.unverified.length})`);

    const checks = runChecks(doc, outcome.extraction, outcome.unverified, ref);
    // A chain can only be built from an established amount and cost centre.
    const chain = checks.netTotalChf !== null && checks.costCenterCode !== null
      ? buildChain(checks.netTotalChf, checks.costCenterCode, checks.requesterEmployeeId, ref)
      : null;
    const related = findRelations(db, id, doc, { supplierId: checks.supplierId, netTotal: checks.netTotal });
    const issues = [...checks.issues, ...(chain?.issues ?? []), ...related.issues];

    saveEstablishedValues(db, id, checks, chain?.band ?? null);
    db.prepare(`UPDATE requisitions SET related_requisition_id = ?, relation = ? WHERE id = ?`).run(related.relatedId, related.relation, id);
    saveIssues(db, id, issues);

    if (chain === null || blocksApproval(issues)) {
      const reasons = [...new Set(issues.filter((i) => i.severity === "blocks_approval").map((i) => i.code))];
      transition(db, id, "needs_review", "system", `Needs review: ${reasons.join(", ")}`);
      return "needs_review";
    }
    saveApprovalSteps(db, id, 1, chain.steps);
    transition(db, id, "pending_approval", "system", `Clean: band ${chain.band}, ${chain.steps.length} approval step(s)`);
    return "pending_approval";
  })();
}

export function saveEstablishedValues(db: Db, id: number, c: CheckResult, band: number | null): void {
  db.prepare(
    `UPDATE requisitions SET requester_employee_id = ?, supplier_id = ?, cost_center_code = ?, currency = ?,
       net_total = ?, vat_amount = ?, gross_total = ?, net_total_chf = ?, band = ?, requested_delivery_date = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(c.requesterEmployeeId, c.supplierId, c.costCenterCode, c.currency, c.netTotal, c.vatAmount, c.grossTotal,
    c.netTotalChf, band, c.requestedDeliveryDate, nowIso(), id);

  db.prepare(`DELETE FROM line_items WHERE requisition_id = ?`).run(id);
  const insertLine = db.prepare(
    `INSERT INTO line_items (requisition_id, position, description, item_code, quantity, unit, unit_price, price_per, line_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  c.lines.forEach((l, i) =>
    insertLine.run(id, i + 1, l.description, l.itemCode, l.quantity, l.unit, l.unitPrice, l.pricePer ?? 1, l.amount));
}

export function saveIssues(db: Db, id: number, issues: Issue[]): void {
  const insert = db.prepare(`INSERT INTO issues (requisition_id, code, severity, field, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const now = nowIso();
  for (const i of issues) insert.run(id, i.code, i.severity, i.field, i.message, now);
}

export function saveApprovalSteps(db: Db, id: number, round: number, steps: ChainStep[]): void {
  const insert = db.prepare(
    `INSERT INTO approval_steps (requisition_id, round, position, roles, approver_employee_id) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const s of steps) insert.run(id, round, s.position, s.roles.join(","), s.approverEmployeeId);
}
