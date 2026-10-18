import type { Db } from "../db/db.ts";
import { nowIso, writeAudit, type Actor } from "./audit.ts";
import { canTransition, type State } from "./states.ts";

// The only way a requisition's state changes. Checks the move is allowed,
// updates the state and writes the audit row: all or nothing.

export class InvalidTransitionError extends Error {
  constructor(id: number, from: State, to: State) {
    super(`Requisition ${id} cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function getState(db: Db, requisitionId: number): State {
  const row = db.prepare(`SELECT state FROM requisitions WHERE id = ?`).get(requisitionId) as { state: State } | undefined;
  if (!row) throw new Error(`Requisition ${requisitionId} does not exist`);
  return row.state;
}

/**
 * Moves a requisition to `to`. Call it inside a db.transaction when it is part
 * of a larger change; on its own it still runs as one transaction.
 * (better-sqlite3 nests transactions safely using savepoints.)
 */
export function transition(db: Db, requisitionId: number, to: State, actor: Actor, reason: string): void {
  db.transaction(() => {
    const from = getState(db, requisitionId);
    if (!canTransition(from, to)) throw new InvalidTransitionError(requisitionId, from, to);
    db.prepare(`UPDATE requisitions SET state = ?, updated_at = ? WHERE id = ?`).run(to, nowIso(), requisitionId);
    writeAudit(db, requisitionId, actor, from, to, reason);
  })();
}
