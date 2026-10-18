import { buildChain } from "../approval/chain.ts";
import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import { ApprovalError } from "./approvals.ts";
import { nowIso, writeAudit, type Actor } from "./audit.ts";
import { saveApprovalSteps } from "./processEmail.ts";
import { getState, transition } from "./transitions.ts";

// What the clerk does with a requisition in needs_review: resolve issues,
// assign an approver where the chain has nobody (email 23), send it into
// approval, and bring back a corrected rejection. Editing extracted fields
// and re-running the checks is 6c.

/** Marks an issue as dealt with. The note is required: the audit must say why. */
export function resolveIssue(db: Db, issueId: number, actor: Actor, note: string): void {
  if (note.trim() === "") throw new ApprovalError("Resolving an issue needs a note.");
  db.transaction(() => {
    const row = db.prepare(`SELECT requisition_id AS id, code, resolved_at FROM issues WHERE id = ?`).get(issueId) as
      { id: number; code: string; resolved_at: string | null } | undefined;
    if (!row) throw new ApprovalError(`Issue ${issueId} does not exist.`);
    if (row.resolved_at !== null) throw new ApprovalError(`Issue ${issueId} is already resolved.`);
    db.prepare(`UPDATE issues SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`).run(nowIso(), actor, note, issueId);
    const state = getState(db, row.id);
    writeAudit(db, row.id, actor, state, state, `Resolved ${row.code}: ${note}`);
  })();
}

/**
 * Sends a reviewed requisition into approval. Builds the chain from the
 * established values; a step without an approver must be assigned by the
 * clerk (`assignments`: step position → employee id). If the requisition was
 * in approval before (a corrected rejection), a new round starts at step 1 and
 * the old round is kept as history.
 */
export function submitForApproval(
  db: Db,
  id: number,
  actor: Actor,
  ref: ReferenceData,
  assignments: Record<number, string> = {}, // Record<K, V>: an object used as a map
): void {
  db.transaction(() => {
    if (getState(db, id) !== "needs_review") throw new ApprovalError("Only a requisition in needs_review can be submitted.");

    const open = db.prepare(
      `SELECT DISTINCT code FROM issues
       WHERE requisition_id = ? AND severity = 'blocks_approval' AND resolved_at IS NULL AND code <> 'APPROVER_NEEDED'`,
    ).all(id) as { code: string }[];
    if (open.length > 0) throw new ApprovalError(`Resolve these issues first: ${open.map((o) => o.code).join(", ")}.`);

    const r = db.prepare(`SELECT net_total_chf, cost_center_code, requester_employee_id, approval_round FROM requisitions WHERE id = ?`).get(id) as
      { net_total_chf: number | null; cost_center_code: string | null; requester_employee_id: string | null; approval_round: number };
    if (r.net_total_chf === null || r.cost_center_code === null) {
      throw new ApprovalError("The amount and cost centre must be established before approval.");
    }

    const chain = buildChain(r.net_total_chf, r.cost_center_code, r.requester_employee_id, ref);
    const steps = chain.steps.map((s) => {
      if (s.approverEmployeeId !== null) return s;
      const assigned = assignments[s.position];
      if (assigned === undefined) throw new ApprovalError(`Step ${s.position} (${s.roles.join(", ")}) needs an approver.`);
      if (!ref.employees.some((e) => e.id === assigned)) throw new ApprovalError(`Unknown employee ${assigned}.`);
      if (assigned === r.requester_employee_id) throw new ApprovalError("The requester cannot be assigned as an approver.");
      return { ...s, approverEmployeeId: assigned };
    });

    const hadSteps = (db.prepare(`SELECT COUNT(*) AS n FROM approval_steps WHERE requisition_id = ?`).get(id) as { n: number }).n > 0;
    const round = hadSteps ? r.approval_round + 1 : r.approval_round;
    db.prepare(`UPDATE requisitions SET approval_round = ?, band = ?, updated_at = ? WHERE id = ?`).run(round, chain.band, nowIso(), id);
    saveApprovalSteps(db, id, round, steps);
    db.prepare(`UPDATE issues SET resolved_at = ?, resolved_by = ?, resolution = 'Approver assigned by clerk'
                WHERE requisition_id = ? AND code = 'APPROVER_NEEDED' AND resolved_at IS NULL`).run(nowIso(), actor, id);

    const assignedText = Object.entries(assignments).map(([pos, emp]) => `step ${pos} → ${emp}`).join(", ");
    transition(db, id, "pending_approval", actor,
      `Submitted for approval (round ${round}${hadSteps ? ", restarting at step 1" : ""})${assignedText ? `; assigned ${assignedText}` : ""}`);
  })();
}

/** Brings a rejected requisition back for correction. The next submit restarts the chain at step 1. */
export function reopenRejected(db: Db, id: number, actor: Actor, note: string): void {
  if (note.trim() === "") throw new ApprovalError("Reopening needs a note saying what was corrected.");
  transition(db, id, "needs_review", actor, `Reopened after rejection: ${note}`);
}
