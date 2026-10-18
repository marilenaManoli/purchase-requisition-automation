I'm building my solution to the BLP Digital internship take-home challenge in this
repo. Read `CLAUDE.md` and `data/CHALLENGE_BRIEF.md` fully before writing any code.
The decisions, rules, test cases and assumptions in CLAUDE.md are already agreed.

## How we work together

I have to be able to explain every line of this project in the final interview
("the AI wrote it" is not an acceptable answer), so I want to learn while we build.
Work in small steps. For each step:

1. **Say what you're about to build and why** in a few sentences, before writing code.
2. **Build only that step.** Keep it small enough that I can review it in about 15 minutes.
3. **Show me how to run and check it** (the exact commands, and what I should see).
4. **Explain it**: walk through each file you created or changed, the key design
   choices, and the alternatives you rejected.
5. **Ask me 3–4 questions**, then wait for my answers:
   - 1–2 to check I understand the code (e.g. "what happens if…", "why does this
     function return X instead of throwing?");
   - 1–2 the interviewer is likely to ask about this part (e.g. "why SQLite?",
     "what if the LLM returns garbage?", "how would this scale to 500 a day?").
   Give me feedback on my answers: what was right, what was missing, and a
   better phrasing if mine was weak.
6. **Stop.** I review, run it, and commit myself. Suggest a commit message, but
   never run `git commit` or `git push` yourself.

Other rules:
- Don't jump ahead to later steps, and don't build things not asked for in the brief.
- If something in the brief is ambiguous, tell me, propose an assumption, and
  add it to the README's Assumptions section once I agree.
- Prefer simple, readable code over clever code. I'm refreshing my TypeScript,
  so point out TypeScript features as you use them.
- Write tests alongside the code, not at the end.
- Never put secrets or personal data in code, logs or commits.

## The steps

- **0. Setup:** check Node (need ≥ 22) and Ollama (`ollama --version`, pull
  `qwen2.5:7b`). Create `package.json` (scripts: `dev`, `seed`, `test`,
  `run-all`), `tsconfig.json`, vitest config, `.gitignore` (node_modules, .env,
  *.db), `.env.example`, a README skeleton (Setup · Run · Architecture ·
  Assumptions · Left out · Next steps · Use of AI tools), and the folder layout
  from CLAUDE.md. Copy the challenge files into `data/`.
- **1. Database:** `schema.sql` for master data and app tables (emails,
  requisitions, line_items, issues, approval_steps, audit_events); `seed.ts`
  loads `master_data.json`; a test that checks row counts and the band table.
- **2. Ingestion:** parse `.eml` (plain text, HTML, attachments) and PDF text into
  one `SourceDocument`; a script prints a short summary for all 48 emails.
- **3. LLM extraction:** zod schema, prompt, `LlmClient` interface + Ollama
  implementation, validation with one retry, evidence-quote check; save outputs
  for all 48 emails to compare later.
- **4. Checks:** supplier matching, cost centre, line maths with `price_per`,
  net vs gross, FX; findings become issues with severity.
- **5. Approval chain:** pure function plus tests for band edges, collapse,
  self-approval, the deputy rule, and the "no one left" case.
- **6. Workflow:** states, allowed transitions, audit log, duplicate/correction
  linking, chain restart after a corrected rejection.
- **7. Web UI:** inbox with states, detail page (extracted fields, evidence,
  issues, chain), edit form, approve/reject as a chosen user, workflow view,
  upload .eml.
- **8. Ordering:** send approved requisitions to the mock ERP with an
  idempotency key; handle 422 and warnings; move to `ordered`.
- **9. Full run:** `npm run run-all` processes every sample email and prints an
  outcome table (state + reasons); compare with the test cases in CLAUDE.md and fix gaps.
- **10. Hand-in:** finish README and PRODUCTION.md (ECB rates, auth/SSO,
  notifications, queue + workers for 10× volume, monitoring, privacy, hosted vs
  local model), then help me plan the 5–10 minute video.

Start with step 0. Before creating anything, check my Node and Ollama versions
and tell me what you found.
