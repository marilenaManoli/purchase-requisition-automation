// `npm run ingest-summary`: parses every sample email and prints one line each.
// Only structure is printed (formats, sizes, file names), no names, addresses
// or body text, following the "no personal data in logs" rule.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEmail } from "../src/ingest/parseEmail.ts";

const dir = process.argv[2] ?? "data/emails";
const files = readdirSync(dir).filter((f) => f.endsWith(".eml")).sort();

let withPdf = 0;
let withWarnings = 0;

for (const file of files) {
  const doc = await parseEmail(readFileSync(join(dir, file)));

  const attachments = doc.attachments.map((a) =>
    a.text !== null ? `${a.filename} (${a.pages}p, ${a.text.length} chars)` : `${a.filename} [${a.problem}]`,
  );
  if (doc.attachments.some((a) => a.text !== null)) withPdf++;
  if (doc.warnings.length > 0) withWarnings++;

  console.log(
    [
      file.padEnd(32),
      `${doc.bodyFormat.padEnd(4)} ${String(doc.body.length).padStart(5)} chars`,
      attachments.join(", ") || "-",
      ...doc.warnings.map((w) => `WARNING: ${w}`),
    ].join(" | "),
  );
}

console.log(`\n${files.length} emails parsed, ${withPdf} with readable PDF text, ${withWarnings} with warnings.`);
