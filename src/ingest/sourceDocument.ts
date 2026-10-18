// The one shape every incoming email is turned into, whatever its format.

export interface SourceAttachment {
  filename: string;
  contentType: string;
  /** Extracted text, or null if the attachment could not be or was not read. */
  text: string | null;
  pages: number | null;
  /** Why `text` is null. */
  problem: string | null;
}

export interface SourceDocument {
  messageId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  /** Date header as ISO-8601, or null if missing/unparseable. */
  sentAt: string | null;
  /** Plain-text body; HTML bodies are converted. */
  body: string;
  bodyFormat: "text" | "html" | "none";
  attachments: SourceAttachment[];
  /** Ingestion-level problems, e.g. "no readable content". Facts, not judgements. */
  warnings: string[];
}

/**
 * The exact text the LLM reads. Evidence quotes from the LLM are later checked
 * against this same string, so what the model sees and what we verify are identical.
 */
export function renderSourceText(doc: SourceDocument): string {
  const parts: string[] = [
    `From: ${formatSender(doc)}`,
    `Subject: ${doc.subject ?? ""}`,
    `Date: ${doc.sentAt ?? ""}`,
    "",
    "--- EMAIL BODY ---",
    doc.body,
  ];

  doc.attachments.forEach((a, i) => {
    parts.push("", `--- ATTACHMENT ${i + 1}: ${a.filename} (${a.contentType}) ---`);
    parts.push(a.text ?? `[not readable: ${a.problem}]`);
  });

  return parts.join("\n");
}

function formatSender(doc: SourceDocument): string {
  if (doc.fromName && doc.fromEmail) return `${doc.fromName} <${doc.fromEmail}>`;
  return doc.fromEmail ?? doc.fromName ?? "";
}
