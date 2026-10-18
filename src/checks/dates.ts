import type { SourceDocument } from "../ingest/sourceDocument.ts";
import { issue, type Issue } from "./issues.ts";

// Brief §6: a missing delivery date blocks the ORDER (the ERP requires one),
// not the approval, and it's the normal case. Vague wording ("Ende Mai") is
// not a date: the clerk supplies one. Dates are compared with the email's own
// date, not "today", so a re-run gives the same result.

const day = (isoDateTime: string) => isoDateTime.slice(0, 10); // "2026-05-14T08:12:00Z" → "2026-05-14"

export function checkDeliveryDate(
  iso: string | null,
  text: string | null,
  unverified: boolean,
  sentAt: string | null,
): { date: string | null; issues: Issue[] } {
  if (iso === null) {
    if (unverified) return { date: null, issues: [] }; // already reported as unverified (blocks_order)
    const message = text
      ? `"${text}" is not an exact date. The clerk must enter a delivery date before ordering.`
      : "No delivery date is stated. The clerk must enter one before ordering.";
    return { date: null, issues: [issue("DELIVERY_DATE_MISSING", "blocks_order", "requested_delivery", message)] };
  }
  // ISO dates (YYYY-MM-DD) compare correctly as plain strings.
  if (sentAt !== null && iso < day(sentAt)) {
    return { date: iso, issues: [issue("DELIVERY_DATE_IN_PAST", "warning", "requested_delivery",
      `The requested delivery date ${iso} is before the email was sent.`)] };
  }
  return { date: iso, issues: [] };
}

export function checkQuoteValidity(validUntil: string | null, sentAt: string | null): Issue[] {
  if (validUntil === null || sentAt === null || validUntil >= day(sentAt)) return [];
  return [issue("QUOTE_EXPIRED", "warning", "quote_valid_until",
    `The quote was valid until ${validUntil}, before the request was sent; prices may have changed.`)];
}

// "anbei", "im Anhang", "attached", "[Attachment: …]"
const MENTIONS_ATTACHMENT = /\[attachment:|\banbei\b|\bim anhang\b|\battached\b|\bangeh(ä|ae)ngt/i;

/** Email 01: the body refers to an attachment, but the email has none. */
export function checkMissingAttachment(doc: SourceDocument): Issue[] {
  if (doc.attachments.length > 0 || !MENTIONS_ATTACHMENT.test(doc.body)) return [];
  return [issue("ATTACHMENT_MISSING", "blocks_approval", null,
    "The email refers to an attachment, but none is attached. The referenced document may hold the items and prices.")];
}
