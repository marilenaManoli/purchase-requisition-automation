// `npm run load-saved [-- out/extractions]`: puts every sample email through the
// real pipeline, but instead of calling Ollama it replays recorded model answers:
// by default the reference run in results/, or a folder written by
// `npm run extract-all`. Seconds instead of ~40 minutes: for a quick demo.
// Run `npm run seed` first for a clean database. Prints only ids and states.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { loadReferenceData } from "../src/db/queries.ts";
import type { LlmClient } from "../src/extract/llm.ts";
import { processEmail } from "../src/workflow/processEmail.ts";

const SAVED = process.argv[2] ?? "results/extractions";
if (!existsSync(SAVED)) {
  console.error(`No recorded answers in ${SAVED}.`);
  process.exit(1);
}

/** An LlmClient that always gives the same, previously recorded answer. */
class ReplayLlm implements LlmClient {
  readonly name: string;
  constructor(private readonly answer: string, model: string) { // `private readonly` in the constructor declares and sets a field
    this.name = `replay:${model}`;
  }
  async chat(): Promise<string> {
    return this.answer;
  }
}

const db = openDb(config.DB_PATH);
const ref = loadReferenceData(db);
const counts: Record<string, number> = {};

for (const file of readdirSync("data/emails").filter((f) => f.endsWith(".eml")).sort()) {
  const saved = join(SAVED, file.replace(/\.eml$/, ".json"));
  if (!existsSync(saved)) continue;
  const { model, outcome } = JSON.parse(readFileSync(saved, "utf8")) as { model: string; outcome: { rawOutput: string | null } };
  if (outcome.rawOutput === null) continue; // nothing recorded (e.g. LLM was down)

  const id = await processEmail(db, readFileSync(join("data/emails", file)), file, new ReplayLlm(outcome.rawOutput, model), ref);
  const { state } = db.prepare(`SELECT state FROM requisitions WHERE id = ?`).get(id) as { state: string };
  counts[state] = (counts[state] ?? 0) + 1;
  console.log(`${String(id).padStart(3)}  ${file.padEnd(32)} ${state}`);
}
console.log("\n", counts);
