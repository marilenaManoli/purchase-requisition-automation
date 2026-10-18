import { buildChain } from "../approval/chain.ts";
import type { IssueCode } from "../checks/issues.ts";
import { ClerkOverridesSchema, type ClerkOverrides } from "../checks/overrides.ts";
import { runChecks } from "../checks/runChecks.ts";
import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import { findUnverifiedValues } from "../extract/evidence.ts";
import { emptyExtraction, ExtractionSchema, type Extraction } from "../extract/schema.ts";
import { parseEmail } from "../ingest/parseEmail.ts";
import { renderSourceText } from "../ingest/sourceDocument.ts";
import { ApprovalError } from "./approvals.ts";
import { writeAudit, type Actor } from "./audit.ts";
import { saveEstablishedValues, saveIssues } from "./processEmail.ts";
import { getState, transition } from "./transitions.ts";

// The clerk enters or corrects values (6c). The model's extraction is never
// modified: clerk values are stored separately as overrides, every change is
// audited with its old and new value, and the same checks then run again.

// Issues that come from steps the re-check doesn't repeat (relations, a failed
// extraction): kept until the clerk resolves them explicitly.
const KEPT_ON_RECHECK: IssueCode[] = [
  "DUPLICATE_SUSPECTED", "CORRECTION_SUSPECTED", "CORRECTION_WITHOUT_REFERENCE",
  "REFERENCED_REQUISITION", "REFERENCED_REQUISITION_NOT_FOUND", "EXTRACTION_FAILED", "NO_READABLE_CONTENT",
];

export async function editRequisition(db: Db, id: number, actor: Actor, input: unknown, ref: ReferenceData): Promise<void> {
  if (getState(db, id) !== "needs_review") {
    throw new ApprovalError("Only a requisition in needs_review can be edited. Pull it back from approval first.");
  }
  const parsed = ClerkOverridesSchema.safeParse(input);
  if (!parsed.success) throw new ApprovalError(`Invalid edit: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const edits = parsed.data;

  const current = loadState(db, id);
  validateAgainstMasterData(edits, current.extraction, current.overrides, ref);

  const merged: ClerkOverrides = {
    ...current.overrides,
    ...edits,
    lines: mergeLines(current.overrides.lines, edits.lines),
  };

  db.transaction(() => {
    db.prepare(`UPDATE requisitions SET clerk_overrides_json = ? WHERE id = ?`).run(JSON.stringify(merged), id);
    for (const change of describeChanges(current.overrides, edits)) {
      writeAudit(db, id, actor, "needs_review", "needs_review", change);
    }
  })();

  await recheck(db, id, ref);
}

/** Re-runs all checks with the stored extraction and the clerk's overrides, and refreshes values and issues. */
export async function recheck(db: Db, id: number, ref: ReferenceData): Promise<void> {
  const { raw } = db.prepare(`SELECT e.raw FROM emails e JOIN requisitions r ON r.email_id = e.id WHERE r.id = ?`).get(id) as { raw: Buffer };
  const doc = await parseEmail(raw); // async, so before the transaction

  db.transaction(() => {
    const { extraction, overrides } = loadState(db, id);
    const unverified = findUnverifiedValues(extraction, renderSourceText(doc)); // deterministic: same result as at extraction
    const checks = runChecks(doc, extraction, unverified, ref, overrides);
    const chain = checks.netTotalChf !== null && checks.costCenterCode !== null
      ? buildChain(checks.netTotalChf, checks.costCenterCode, checks.requesterEmployeeId, ref)
      : null;

    saveEstablishedValues(db, id, checks, chain?.band ?? null);

    // Replace the open check issues; keep resolved ones as history and never
    // raise again an issue the clerk already resolved (same code and field).
    const resolved = db.prepare(`SELECT code, field FROM issues WHERE requisition_id = ? AND resolved_at IS NOT NULL`).all(id) as { code: string; field: string | null }[];
    const placeholders = KEPT_ON_RECHECK.map(() => "?").join(",");
    db.prepare(`DELETE FROM issues WHERE requisition_id = ? AND resolved_at IS NULL AND code NOT IN (${placeholders})`).run(id, ...KEPT_ON_RECHECK);
    const fresh = [...checks.issues, ...(chain?.issues ?? [])]
      .filter((i) => !resolved.some((r) => r.code === i.code && r.field === i.field));
    saveIssues(db, id, fresh);
  })();
}

/** Takes a requisition out of approval (or back from `approved`, e.g. after an ERP rejection) so a clerk can correct it; the next submit restarts the chain at step 1. */
export function pullBackForCorrection(db: Db, id: number, actor: Actor, reason: string): void {
  if (reason.trim() === "") throw new ApprovalError("Pulling back needs a reason.");
  transition(db, id, "needs_review", actor, `Pulled back for correction: ${reason}`);
}

function loadState(db: Db, id: number): { extraction: Extraction; overrides: ClerkOverrides } {
  const row = db.prepare(`SELECT extraction_json, clerk_overrides_json FROM requisitions WHERE id = ?`).get(id) as
    { extraction_json: string | null; clerk_overrides_json: string | null };
  return {
    // Stored data is re-validated on the way in: it was valid when written, and this keeps the types honest.
    extraction: row.extraction_json ? ExtractionSchema.parse(JSON.parse(row.extraction_json)) : emptyExtraction(),
    overrides: row.clerk_overrides_json ? ClerkOverridesSchema.parse(JSON.parse(row.clerk_overrides_json)) : {},
  };
}

function validateAgainstMasterData(edits: ClerkOverrides, x: Extraction, previous: ClerkOverrides, ref: ReferenceData): void {
  if (edits.supplierId !== undefined && !ref.suppliers.some((s) => s.id === edits.supplierId)) {
    throw new ApprovalError(`Supplier ${edits.supplierId} is not in the master data. Create it first; it is never created from an edit.`);
  }
  if (edits.costCenterCode !== undefined && !ref.costCenters.some((c) => c.code === edits.costCenterCode)) {
    throw new ApprovalError(`Cost centre ${edits.costCenterCode} does not exist.`);
  }
  if (edits.currency !== undefined && !ref.fxRatesToChf.has(edits.currency)) {
    throw new ApprovalError(`No exchange rate for ${edits.currency}.`);
  }
  // A new line (past the extracted ones) needs everything the ERP requires.
  const lines = mergeLines(previous.lines, edits.lines) ?? {};
  for (const [index, l] of Object.entries(lines)) {
    if (Number(index) < x.line_items.length) continue;
    if (l.description === undefined || l.quantity === undefined || l.unit === undefined || l.unitPrice === undefined) {
      throw new ApprovalError(`New line ${Number(index) + 1} needs a description, quantity, unit and unit price.`);
    }
  }
}

function mergeLines(a: ClerkOverrides["lines"], b: ClerkOverrides["lines"]): ClerkOverrides["lines"] {
  if (!a && !b) return undefined;
  const result = { ...a };
  for (const [index, l] of Object.entries(b ?? {})) result[index] = { ...result[index], ...l };
  return result;
}

/** One audit line per changed value, with old → new. */
function describeChanges(before: ClerkOverrides, edits: ClerkOverrides): string[] {
  const show = (v: unknown) => (v === undefined ? "(model value)" : JSON.stringify(v));
  const changes: string[] = [];
  for (const key of ["supplierId", "costCenterCode", "currency", "requestedDeliveryDate"] as const) {
    if (edits[key] !== undefined && edits[key] !== before[key]) changes.push(`Clerk set ${key}: ${show(before[key])} → ${show(edits[key])}`);
  }
  for (const [index, l] of Object.entries(edits.lines ?? {})) {
    for (const [field, value] of Object.entries(l)) {
      const old = (before.lines?.[index] as Record<string, unknown> | undefined)?.[field];
      if (value !== old) changes.push(`Clerk set line ${Number(index) + 1} ${field}: ${show(old)} → ${show(value)}`);
    }
  }
  return changes;
}
