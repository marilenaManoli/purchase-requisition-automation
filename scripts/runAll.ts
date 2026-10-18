// `npm run run-all [-- --saved] [-- --saved-dir=out/extractions]`
// Puts every sample email through the full pipeline (ingestion → LLM → checks →
// chain → routing) in a fresh in-memory database, prints one line per email and
// compares it with scripts/expectedOutcomes.ts.
//   default:  calls the real LLM (Ollama), about 30–60 s per email
//   --saved:  replays the recorded answers of the reference run in results/ (seconds);
//             --saved-dir=out/extractions replays your own latest `npm run extract-all`
// The table holds ids, states, amounts and issue codes only: no names, addresses
// or email text. A copy is written to out/run-all.txt.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { applySchema, openDb } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData } from "../src/db/queries.ts";
import { OllamaClient, type LlmClient } from "../src/extract/llm.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { EXPECTED, type Expected } from "./expectedOutcomes.ts";

const dirArg = process.argv.find((a) => a.startsWith("--saved-dir="));
const saved = process.argv.includes("--saved") || dirArg !== undefined;
const savedDir = dirArg?.split("=")[1] ?? "results/extractions";

class ReplayLlm implements LlmClient {
  readonly name = "replay";
  constructor(private readonly answer: string) {}
  async chat(): Promise<string> {
    return this.answer;
  }
}
const live = new OllamaClient(config.OLLAMA_URL, config.OLLAMA_MODEL);
function llmFor(file: string): LlmClient | null {
  if (!saved) return live;
  const path = join(savedDir, file.replace(/\.eml$/, ".json"));
  if (!existsSync(path)) return null;
  const raw = (JSON.parse(readFileSync(path, "utf8")) as { outcome: { rawOutput: string | null } }).outcome.rawOutput;
  return raw === null ? null : new ReplayLlm(raw);
}

const db = openDb(":memory:");
applySchema(db);
seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
const ref = loadReferenceData(db);

interface Outcome {
  state: string;
  band: number | null;
  netChf: number | null;
  supplier: string | null;
  approvers: string[];
  issues: { code: string; severity: string }[];
}

function outcomeOf(id: number): Outcome {
  const r = db.prepare(`SELECT state, band, net_total_chf, supplier_id, approval_round FROM requisitions WHERE id = ?`).get(id) as
    { state: string; band: number | null; net_total_chf: number | null; supplier_id: string | null; approval_round: number };
  const approvers = (db.prepare(`SELECT approver_employee_id AS a FROM approval_steps WHERE requisition_id = ? AND round = ? ORDER BY position`)
    .all(id, r.approval_round) as { a: string | null }[]).map((s) => s.a ?? "?");
  const issues = db.prepare(`SELECT code, severity FROM issues WHERE requisition_id = ? AND resolved_at IS NULL`).all(id) as { code: string; severity: string }[];
  return { state: r.state, band: r.band, netChf: r.net_total_chf, supplier: r.supplier_id, approvers, issues };
}

/** Every way the outcome differs from the expectation (empty = as expected). */
function differences(o: Outcome, e: Expected): string[] {
  const d: string[] = [];
  if (o.state !== e.state) d.push(`state ${o.state} (expected ${e.state})`);
  if (e.band !== undefined && o.band !== e.band) d.push(`band ${o.band ?? "–"} (expected ${e.band})`);
  if (e.netChf !== undefined && (o.netChf === null || Math.abs(o.netChf - e.netChf) > 0.01)) d.push(`CHF ${o.netChf ?? "–"} (expected ${e.netChf})`);
  if (e.supplier !== undefined && o.supplier !== e.supplier) d.push(`supplier ${o.supplier ?? "–"} (expected ${e.supplier})`);
  if (e.approvers !== undefined && o.approvers.join(">") !== e.approvers.join(">")) d.push(`chain ${o.approvers.join(">") || "–"} (expected ${e.approvers.join(">")})`);
  for (const code of e.issues ?? []) if (!o.issues.some((i) => i.code === code)) d.push(`missing issue ${code}`);
  return d;
}

const lines: string[] = [];
const out = (s: string) => {
  console.log(s);
  lines.push(s);
};
out(`run-all (${saved ? `replaying saved LLM answers from ${savedDir}` : `live LLM: ${live.name}`}) — ${new Date().toISOString()}\n`);
out(`${"email".padEnd(6)} ${"state".padEnd(17)} band ${"CHF".padStart(11)}  ${"supplier".padEnd(8)} ${"chain".padEnd(24)} verdict  blocking reasons / differences`);

let met = 0;
let checked = 0;
const states: Record<string, number> = {};

for (const file of readdirSync("data/emails").filter((f) => f.endsWith(".eml")).sort()) {
  const n = file.slice(6, 8);
  const llm = llmFor(file);
  if (llm === null) {
    out(`${n.padEnd(6)} (no recorded answer in ${savedDir})`);
    continue;
  }
  const id = await processEmail(db, readFileSync(join("data/emails", file)), file, llm, ref);
  const o = outcomeOf(id);
  states[o.state] = (states[o.state] ?? 0) + 1;

  const expected = EXPECTED[n];
  const diff = expected ? differences(o, expected) : [];
  if (expected) {
    checked++;
    if (diff.length === 0) met++;
  }
  const verdict = !expected ? "  –  " : diff.length === 0 ? " ok  " : " DIFF";
  const blocking = [...new Set(o.issues.filter((i) => i.severity === "blocks_approval").map((i) => i.code))].join(" ");
  out(`${n.padEnd(6)} ${o.state.padEnd(17)} ${String(o.band ?? "–").padStart(4)} ${(o.netChf === null ? "–" : o.netChf.toFixed(2)).padStart(11)}  ` +
    `${(o.supplier ?? "–").padEnd(8)} ${(o.approvers.join(">") || "–").padEnd(24)} ${verdict}  ${diff.length ? diff.join("; ") : blocking}`);
}

out(`\nStates: ${JSON.stringify(states)}`);
out(`Expectations met: ${met} of ${checked} emails with a stated expectation.`);
mkdirSync("out", { recursive: true });
writeFileSync("out/run-all.txt", lines.join("\n") + "\n");
