import type { Db } from "../db/db.ts";
import { nowIso, writeAudit, type Actor } from "./audit.ts";
import { getState, transition } from "./transitions.ts";

// Brief §4.3: approvals are sequential; the next approver is only asked once
// the previous one has approved, and a rejection stops the chain immediately.

/** A business-rule refusal (wrong person, missing reason…), shown to the user as is. */
export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface StepRow {
  id: number;
  round: number;
  position: number;
  roles: string;
  approver_employee_id: string | null;
  status: "waiting" | "approved" | "rejected";
}

/** The first waiting step of the current round, or undefined if none is left. */
export function currentStep(db: Db, requisitionId: number): StepRow | undefined {
  return db.prepare(
    `SELECT s.id, s.round, s.position, s.roles, s.approver_employee_id, s.status
     FROM approval_steps s JOIN requisitions r ON r.id = s.requisition_id
     WHERE s.requisition_id = ? AND s.round = r.approval_round AND s.status = 'waiting'
     ORDER BY s.position LIMIT 1`,
  ).get(requisitionId) as StepRow | undefined;
}

function requesterOf(db: Db, requisitionId: number): string | null {
  return (db.prepare(`SELECT requester_employee_id AS r FROM requisitions WHERE id = ?`).get(requisitionId) as { r: string | null }).r;
}

/** The current step's approver approves it; after the last step the requisition is approved. */
export function approve(db: Db, requisitionId: number, actor: Actor, comment: string | null = null): void {
  db.transaction(() => {
    const step = requireCurrentStep(db, requisitionId, actor);
    // Defence in depth: the chain builder already guarantees this, but the rule is absolute.
    if (actor === requesterOf(db, requisitionId)) throw new ApprovalError("A requester can never approve their own requisition.");

    db.prepare(`UPDATE approval_steps SET status = 'approved', decided_at = ?, comment = ? WHERE id = ?`).run(nowIso(), comment, step.id);
    writeAudit(db, requisitionId, actor, "pending_approval", "pending_approval",
      `Approved step ${step.position} (${step.roles})${comment ? `: ${comment}` : ""}`);

    if (currentStep(db, requisitionId) === undefined) {
      transition(db, requisitionId, "approved", actor, "All approval steps approved");
    }
  })();
}

/**
 * Rejects with a mandatory reason. During approval only the current approver
 * may reject; a clerk may reject a requisition waiting in needs_review.
 */
export function reject(db: Db, requisitionId: number, actor: Actor, reason: string): void {
  if (reason.trim() === "") throw new ApprovalError("A rejection needs a reason.");
  db.transaction(() => {
    const state = getState(db, requisitionId);
    if (state === "pending_approval") {
      const step = requireCurrentStep(db, requisitionId, actor);
      db.prepare(`UPDATE approval_steps SET status = 'rejected', decided_at = ?, comment = ? WHERE id = ?`).run(nowIso(), reason, step.id);
    } else if (state !== "needs_review") {
      throw new ApprovalError(`A requisition in state ${state} cannot be rejected.`);
    }
    db.prepare(`UPDATE requisitions SET rejection_reason = ? WHERE id = ?`).run(reason, requisitionId);
    transition(db, requisitionId, "rejected", actor, `Rejected: ${reason}`);
  })();
}

function requireCurrentStep(db: Db, requisitionId: number, actor: Actor): StepRow {
  const state = getState(db, requisitionId);
  if (state !== "pending_approval") throw new ApprovalError(`Requisition ${requisitionId} is not awaiting approval (state: ${state}).`);
  const step = currentStep(db, requisitionId);
  if (step === undefined) throw new ApprovalError(`Requisition ${requisitionId} has no open approval step.`);
  if (step.approver_employee_id === null) throw new ApprovalError(`Step ${step.position} has no approver yet; the clerk must assign one.`);
  if (step.approver_employee_id !== actor) {
    throw new ApprovalError(`Step ${step.position} is waiting for ${step.approver_employee_id}, not ${actor}.`);
  }
  return step;
}
