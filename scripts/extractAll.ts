// `npm run extract-all [-- --force] [-- 25 46 ...]`
// Runs the real LLM extraction on the sample emails and saves one JSON file per
// email in out/extractions/ (git-ignored: it contains the emails' personal data).
// Already-extracted emails are skipped unless --force, so a long run can resume.
// Only structure is printed: outcome, attempts, counts, timing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { extractRequisition } from "../src/extract/extract.ts";
import { OllamaClient } from "../src/extract/llm.ts";
import { parseEmail } from "../src/ingest/parseEmail.ts";

const EMAIL_DIR = "data/emails";
const OUT_DIR = "out/extractions";

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => /^\d+$/.test(a)).map((n) => n.padStart(2, "0")); // "5" → "05"

const files = readdirSync(EMAIL_DIR)
  .filter((f) => f.endsWith(".eml"))
  .filter((f) => only.length === 0 || only.some((n) => f.startsWith(`email_${n}`)))
  .sort();

mkdirSync(OUT_DIR, { recursive: true });
const llm = new OllamaClient(config.OLLAMA_URL, config.OLLAMA_MODEL);
console.log(`Extracting ${files.length} emails with ${llm.name}${force ? " (--force)" : ""}\n`);

for (const file of files) {
  const outPath = join(OUT_DIR, file.replace(/\.eml$/, ".json"));
  if (!force && existsSync(outPath)) {
    console.log(`${file.padEnd(32)} | skipped (already extracted)`);
    continue;
  }

  const started = Date.now();
  const outcome = await extractRequisition(await parseEmail(readFileSync(join(EMAIL_DIR, file))), llm);
  const seconds = (Date.now() - started) / 1000;

  writeFileSync(outPath, JSON.stringify({ file, model: llm.name, seconds, outcome }, null, 2));

  const summary = outcome.ok
    ? `ok      | attempts ${outcome.attempts} | ${outcome.extraction.line_items.length} lines | ` +
      `${outcome.unverified.length} unverified${outcome.unverified.length ? ": " + outcome.unverified.map((u) => u.field).join(", ") : ""}`
    : `${outcome.kind.padEnd(7)} | attempts ${outcome.attempts} | ${outcome.message.slice(0, 120)}`;
  console.log(`${file.padEnd(32)} | ${seconds.toFixed(0).padStart(4)}s | ${summary}`);
}
