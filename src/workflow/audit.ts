import type { Db } from "../db/db.ts";
import type { State } from "./states.ts";

// Who did what, when, and why. Rows are only ever inserted, never changed.
// Callers write them inside the same transaction as the change they describe,
// so a change without its audit row can't exist.

/** Who acted: an employee id, "clerk" (no real login, assumption 5), or "system". */
export type Actor = string;

export function nowIso(): string {
  return new Date().toISOString();
}

export function writeAudit(
  db: Db,
  requisitionId: number,
  actor: Actor,
  fromState: State | null,
  toState: State,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO audit_events (requisition_id, at, actor, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(requisitionId, nowIso(), actor, fromState, toState, reason);
}

export interface AuditEvent {
  at: string;
  actor: string;
  from_state: State | null;
  to_state: State;
  reason: string | null;
}

export function auditTrail(db: Db, requisitionId: number): AuditEvent[] {
  return db
    .prepare(`SELECT at, actor, from_state, to_state, reason FROM audit_events WHERE requisition_id = ? ORDER BY id`)
    .all(requisitionId) as AuditEvent[];
}
