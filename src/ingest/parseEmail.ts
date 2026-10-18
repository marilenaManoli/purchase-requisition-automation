import { convert } from "html-to-text";
import { simpleParser, type Attachment } from "mailparser";
import { pdfToText } from "./pdfText.ts";
import type { SourceAttachment, SourceDocument } from "./sourceDocument.ts";

// Tables become aligned columns (email 49 puts the cost centre in a table);
// link targets and images are noise for extraction.
const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "table", format: "dataTable" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
  ],
};

/**
 * Parses a raw .eml file. Never throws on odd content: anything that cannot be
 * read is recorded in `warnings` / `problem` so a human sees it.
 */
export async function parseEmail(raw: Buffer): Promise<SourceDocument> {
  const mail = await simpleParser(raw);

  const { body, bodyFormat } = extractBody(mail.text, mail.html);
  // `Promise.all` runs the PDF extractions in parallel and waits for all of them.
  const attachments = await Promise.all(mail.attachments.map(readAttachment));

  const warnings: string[] = [];
  if (bodyFormat === "none" && attachments.every((a) => a.text === null)) {
    warnings.push("No readable content: empty body and no readable attachment");
  }

  const sender = mail.from?.value[0];
  return {
    messageId: mail.messageId ?? null,
    fromName: sender?.name || null, // `||`, not `??`: an empty name "" should also become null
    fromEmail: sender?.address?.toLowerCase() || null,
    subject: mail.subject ?? null,
    sentAt: isValidDate(mail.date) ? mail.date.toISOString() : null,
    body,
    bodyFormat,
    attachments,
    warnings,
  };
}

function extractBody(
  text: string | undefined,
  html: string | false,
): { body: string; bodyFormat: SourceDocument["bodyFormat"] } {
  // Prefer the plain-text part when the sender included one.
  if (text && text.trim() !== "") {
    return { body: normalise(text), bodyFormat: "text" };
  }
  if (html) {
    return { body: normalise(convert(html, HTML_TO_TEXT_OPTIONS)), bodyFormat: "html" };
  }
  return { body: "", bodyFormat: "none" };
}

async function readAttachment(a: Attachment): Promise<SourceAttachment> {
  const base = { filename: a.filename ?? "(unnamed)", contentType: a.contentType };

  if (a.contentType !== "application/pdf") {
    return { ...base, text: null, pages: null, problem: `Not read: ${a.contentType} attachments are out of scope` };
  }
  const result = await pdfToText(new Uint8Array(a.content));
  // Thanks to the discriminated union, TypeScript knows `text`/`pages` exist
  // only in the `ok` branch and `reason` only in the other.
  return result.ok
    ? { ...base, text: normalise(result.text), pages: result.pages, problem: null }
    : { ...base, text: null, pages: null, problem: result.reason };
}

/**
 * Windows line endings → \n; non-breaking spaces (from &nbsp;) → normal spaces,
 * otherwise "Messraum 1" here would not match the model's quote "Messraum 1";
 * trailing spaces removed; outer blank lines trimmed.
 */
function normalise(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// A "type guard": when it returns true, TypeScript narrows `d` to `Date`.
function isValidDate(d: Date | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}
