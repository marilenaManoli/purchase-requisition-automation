import { issue, type Issue } from "../checks/issues.ts";
import { sameAmount } from "../checks/money.ts";
import type { Db } from "../db/db.ts";
import type { SourceDocument } from "../ingest/sourceDocument.ts";

// Brief §5: a message that repeats or corrects an earlier request is linked to
// the original and flagged; the clerk resolves it. Nothing is merged or
// overwritten automatically. All rules here are plain code over stored data:
// a requisition number is a pattern, so code finds it, and the model can't
// invent one (3b showed it would).

export type Relation = "duplicate" | "correction" | "reference";

export interface RelationResult {
  relatedId: number | null;
  relation: Relation | null;
  issues: Issue[];
}

/** Our requisition numbers: "PR-2026-0007" for requisition 7 created in 2026. */
export function requisitionNumber(id: number, createdAt: string): string {
  return `PR-${createdAt.slice(0, 4)}-${String(id).padStart(4, "0")}`;
}

const REQUISITION_NUMBER = /\bPR-(\d{4})-(\d{4,})\b/gi;
const CORRECTION_WORDS = /\b(korrektur|korrigier\w*|berichtigung|correction|corrected|ignoriere (bitte )?mein\w* letzte\w*|ignore my (last|previous))\b/i;
const DUPLICATE_WINDOW_DAYS = 30;

/** "AW: Fwd: Bestellung  Lager" → "bestellung lager" */
export function normaliseSubject(subject: string | null): string {
  return (subject ?? "").toLowerCase().replace(/^\s*((re|aw|fwd?|wg|tr)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
}

interface EarlierRow {
  id: number;
  created_at: string;
  supplier_id: string | null;
  net_total: number | null;
  subject: string | null;
  sent_at: string | null;
}

export function findRelations(
  db: Db,
  requisitionId: number,
  doc: SourceDocument,
  established: { supplierId: string | null; netTotal: number | null },
): RelationResult {
  const text = `${doc.subject ?? ""}\n${doc.body}`;
  const isCorrection = CORRECTION_WORDS.test(text);

  // 1. An explicit requisition number wins over any heuristic.
  const [ref] = [...text.matchAll(REQUISITION_NUMBER)]; // the first number mentioned
  if (ref) {
    const number = ref[0].toUpperCase();
    const target = db.prepare(`SELECT id FROM requisitions WHERE id = ? AND substr(created_at, 1, 4) = ? AND id <> ?`)
      .get(Number(ref[2]), ref[1], requisitionId) as { id: number } | undefined;
    if (!target) {
      return none(issue("REFERENCED_REQUISITION_NOT_FOUND", "blocks_approval", null,
        `The email refers to ${number}, which does not exist. The clerk must find the original request.`));
    }
    return isCorrection
      ? linked(target.id, "correction", issue("CORRECTION_SUSPECTED", "blocks_approval", null,
          `This email corrects ${number}. The clerk decides which version stands; neither is changed automatically.`))
      : linked(target.id, "reference", issue("REFERENCED_REQUISITION", "warning", null,
          `The email refers to ${number}; check it against that requisition.`));
  }

  // 2. Earlier requisitions from the same sender within the window.
  const earlier = db.prepare(
    `SELECT r.id, r.created_at, r.supplier_id, r.net_total, e.subject, e.sent_at
     FROM requisitions r JOIN emails e ON e.id = r.email_id
     WHERE r.id < ? AND e.from_email = ? ORDER BY r.id DESC`,
  ).all(requisitionId, doc.fromEmail) as EarlierRow[];
  const recent = earlier.filter((r) => withinDays(r.sent_at, doc.sentAt, DUPLICATE_WINDOW_DAYS));

  const subject = normaliseSubject(doc.subject);
  const match = recent.find((r) =>
    (subject !== "" && normaliseSubject(r.subject) === subject) ||
    (established.supplierId !== null && r.supplier_id === established.supplierId &&
      established.netTotal !== null && r.net_total !== null && sameAmount(r.net_total, established.netTotal)),
  );
  if (match) {
    const number = requisitionNumber(match.id, match.created_at);
    return isCorrection
      ? linked(match.id, "correction", issue("CORRECTION_SUSPECTED", "blocks_approval", null,
          `This looks like a correction of ${number} (same sender). The clerk decides which version stands.`))
      : linked(match.id, "duplicate", issue("DUPLICATE_SUSPECTED", "blocks_approval", null,
          `This looks like a repeat of ${number} (same sender, same subject or same supplier and amount). The clerk decides whether it is a duplicate.`));
  }

  // 3. Correction wording but nothing to link to (email 30): suggest, never assume.
  if (isCorrection) {
    const latest = recent[0];
    const hint = latest ? ` The sender's most recent request is ${requisitionNumber(latest.id, latest.created_at)}; it is only a suggestion.` : "";
    return none(issue("CORRECTION_WITHOUT_REFERENCE", "blocks_approval", null,
      `The email says it corrects an earlier request but doesn't say which one.${hint}`));
  }
  return none();
}

function withinDays(a: string | null, b: string | null, days: number): boolean {
  if (a === null || b === null) return true; // no dates: same sender is enough to ask the clerk
  return Math.abs(Date.parse(a) - Date.parse(b)) <= days * 24 * 60 * 60 * 1000;
}

function linked(relatedId: number, relation: Relation, i: Issue): RelationResult {
  return { relatedId, relation, issues: [i] };
}

function none(...issues: Issue[]): RelationResult {
  return { relatedId: null, relation: null, issues };
}
