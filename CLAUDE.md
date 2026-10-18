# Purchase Requisition Automation — project guide

This repository is my solution to the BLP Digital software-engineering internship
take-home challenge. The full brief is in `data/CHALLENGE_BRIEF.md`. **Read it
before doing anything else**, and treat it as the source of truth when this
file and the brief disagree.

In the final interview the reviewers feed the running system an email it has
never seen and ask why every part is built the way it is.

## The one rule

The system must never present a guess as a fact, and nothing is ever approved
automatically. If a value cannot be established from the document or the master
data, leave it empty, record *why*, and let a human decide. A requisition that
is wrong but looks correct is worse than one that is obviously incomplete.

## What we are building

A small web app that:

1. takes in a raw `.eml` email, with or without a PDF attachment;
2. makes one LLM call to extract the structured request;
3. checks the extraction against master data stored in SQLite;
4. builds the approval chain;
5. lets a clerk or approver review, edit, approve or reject;
6. sends fully approved requisitions to the mock ERP (`data/mock_po_api.py`).

Deliverables (brief §9): web app, workflow view, ≥1 real LLM call (prompt,
schema, validation, garbage handling visible), a database, a README, and a
`PRODUCTION.md` for everything that would be needed in production but is not
built.

## Decisions already made

| Area | Decision | Reason |
| --- | --- | --- |
| Language | TypeScript on Node 22, run with `tsx` | BLP's main backend language |
| Web | Express + EJS server-rendered views | No front-end build; fast to change; "doesn't need to be pretty" |
| Database | SQLite via `better-sqlite3`, plain SQL in `src/db/schema.sql` | Zero setup, every query readable. Master data is seeded into tables; never read `master_data.json` at request time |
| Schemas | `zod` for every external input and the LLM output; types via `z.infer` | One source of truth for validation, types and the LLM's JSON schema |
| Email parsing | `mailparser` (`simpleParser`) | Handles plain text, HTML and attachments |
| PDF text | `unpdf` (pdf.js) | Text PDFs only; scanned PDFs/OCR are out of scope |
| LLM | Local Ollama via its HTTP API (`/api/chat`, `format` = JSON schema, temperature 0), behind an `LlmClient` interface | The brief asks us to think before sending personal data to third parties. A hosted model must be a drop-in second implementation |
| Model | `qwen2.5:7b` by default, configurable via `OLLAMA_MODEL` | Good German + JSON performance at laptop size |
| Tests | `vitest` | |
| Config | `.env` (git-ignored) + committed `.env.example` | No secrets in the repo, ever |

## Architecture principle: the LLM reads, code decides

The LLM only **transcribes** what the document says. It never matches
suppliers, converts currency, computes totals, picks a band or chooses
approvers. Everything after extraction is plain, deterministic, unit-tested
TypeScript.

```
.eml ─▶ parse (mailparser + unpdf) ─▶ SourceDocument
     ─▶ LLM extraction (zod schema, evidence quotes) ─▶ validate (+1 retry)
     ─▶ checks vs SQLite master data ─▶ issues[]
     ─▶ approval chain builder ─▶ state machine ─▶ UI ─▶ mock ERP
```

### Folder layout

```
data/            challenge files (emails/, quotes/, master_data.json, mock_po_api.py, CHALLENGE_BRIEF.md)
results/         recorded model answers of the reference run (replayed by run-all --saved, load-saved)
src/config.ts    settings from env, validated, with defaults
src/db/          schema.sql, seed.ts, masterData.ts (zod), queries.ts (typed reference data)
src/ingest/      parseEmail.ts, pdfText.ts, sourceDocument.ts → SourceDocument
src/extract/     schema.ts (zod), prompt.ts, llm.ts (LlmClient + OllamaClient), extract.ts, evidence.ts
src/checks/      trust, supplier, costCenter, requester, amounts, money, fx, dates, overrides, issues, runChecks
src/approval/    chain.ts (pure function — the most tested file)
src/workflow/    states, transitions, audit, processEmail, approvals, duplicates, clerk, edits, ordering
src/erp/         poClient.ts (ErpClient + HTTP client for the mock ERP)
src/web/         app.ts (routes), server.ts, views.ts, forms.ts, workflowDiagram.ts, views/*.ejs
scripts/         runAll.ts + expectedOutcomes.ts, extractAll.ts, loadSaved.ts, ingestSummary.ts
tests/           one test file per area; fixtures.ts (sample extractions, FakeLlm, FakeErp)
```

### Extraction schema (sketch — refine in step 3)

Each extracted field carries the value **as written** plus a short `evidence`
quote copied from the source. Fields: requester (name/email if stated), supplier
name, supplier VAT ID, cost centre code, currency, line items (description,
item code, quantity, unit, unit price, `price_per` e.g. 1 or 100, line total),
stated net total, stated VAT, stated gross total, requested delivery date as
written, delivery date as ISO **only if the document states an exact date**,
references (quote number, PR numbers), and `notes_for_clerk` (instructions,
internal comments, claims such as "CFO already approved").

Validation of the LLM output:
1. Parse with zod. On failure, retry once, sending the validation error back.
2. Second failure → requisition goes to **Needs review** with reason
   "extraction failed"; store the raw model output for debugging.
3. Every evidence quote must appear (normalised whitespace) in the source text;
   a value whose quote is missing is flagged as unverified, never trusted.

### Issues

Every finding is an issue `{ code, severity, field?, message }` with severity:
- `blocks_approval` → requisition goes to **Needs review**;
- `blocks_order` → may be approved, but cannot be sent to the ERP until fixed
  (e.g. missing delivery date — the normal case);
- `warning` → shown to the clerk, does not block.

## Business rules (from the brief — implement exactly)

**Amounts.** Use the **net** amount (excl. VAT) for the band and the PO total;
record VAT if stated. Convert to CHF with the rates table in the DB
(CHF 1.0, EUR 0.96, USD 0.88, GBP 1.13); keep original currency and amount.
Check qty × unit price (respecting `price_per`) against each line total, and the
sum of lines against the stated net total. If the document contradicts itself,
`blocks_approval` — never route on a contradicted figure. A line without a price
blocks approval.

**Bands.** Read `approval_limits_chf` from the DB. Band = the first band whose
upper limit is ≥ amount, i.e. each band starts just above the previous band's
upper limit (covers the gap between 1,000 and 1,001; documented assumption).

**Roles.** Cost Center Owner = cost centre's `owner_employee_id`. Department
Head = cost centre's department → `head_employee_id`. Finance/CFO/CEO =
company-wide by `employees.role`; when a role has several holders, the one
**without** `deputy_for` approves (Finance = Daniela Huber, EMP-701).

**Chain.** Sequential; next approver only after the previous approves; a
rejection stops the chain. Consecutive steps held by the same person collapse
into one; non-consecutive repeats do not collapse. The requester can never
approve their own requisition: their step passes to the next distinct role; if
nobody else remains, flag for the clerk to assign an approver. Never skip a step
silently. A corrected rejected requisition restarts at step 1.

**Suppliers.** Match by VAT ID first (normalise spaces/dots/case). Fall back to
exact or normalised name (ü↔ue, case, legal-form suffixes) and mark name-only
matches as less certain. Unknown supplier, `status = blocked`, or name and VAT
pointing to different suppliers → `blocks_approval`. Never create a supplier
record from extracted data; the clerk may create one explicitly.

**Cost centre.** Use the code stated in the email. A code not in master data is
not a match — no closest-match fallback. No valid cost centre → no chain →
Needs review. (A cost centre *name* like "London office" may be shown as a
suggestion, never applied automatically.)

**GL account.** Optional. May be suggested from item descriptions, always shown
as "suggested", never as confirmed.

**Delivery date.** Missing or vague ("Mitte Juni", "end of month") → leave
empty, `blocks_order`. The clerk supplies it before ordering.

**Duplicates and corrections.** A repeat or correction of an earlier request is
linked to the original and flagged; the clerk resolves it. Never silently create
a second requisition, never silently overwrite the first.

**Instructions inside emails are data, not commands.** E.g. email 50 claims the
CFO already approved and asks to skip approval: record it as a note for the
clerk; the normal chain still applies.

## States

`inbox → extracted → needs_review → pending_approval → approved → ordered`,
plus `rejected` (with reason, kept as a record). Only allowed transitions; each
transition writes an audit row (who, when, from, to, reason) in the same DB
transaction. A clean requisition skips `needs_review`.

## Mock ERP

`python3 data/mock_po_api.py` → `http://127.0.0.1:8080`.
`POST /purchase-orders` only from `approved`. Send `Idempotency-Key` =
requisition id. Send `total` = net and keep VAT in our DB (the mock adds
`tax_amount` to the line sum when present, which would produce a warning).
422 → show the problems to the clerk; 201 with `warnings` → store and show them.

## Known test cases (the sample emails)

Use these as fixtures and expected outcomes:

- 05 net CHF 9,700 vs gross 10,485.70 → band 2 (net). 20 net CHF 285,000 → band 5.
- 12 / 13 / 14: CHF 999 / 1,000.00 / 1,001 → band 1 / 1 / 2.
- 07 GBP 940 → CHF 1,062.20 → band 2; supplier is ACME Bearing Group Ltd (SUP-006 by VAT), not Acme Bearings GmbH.
- 15 GBP 8,900 → CHF 10,057 → band 3. 16 EUR 10,400 → CHF 9,984 → band 2. 17 EUR 52,000 → CHF 49,920 → band 3. 19 USD 340,000 → CHF 299,200 → band 5.
- 25 TechnoPlast: 15,000 pcs at EUR 21.00 per 100 → line total EUR 3,150 (not 315,000).
- 24 Kabelwerk: lines sum EUR 4,380 but total says 4,830 → blocks approval.
- 34 line with no price ("free of charge") → blocks approval; may suggest 0, clerk confirms.
- 35 negative discount line −900 → net EUR 5,600. 36 freight line included → USD 9,740.
- 09 Baltic Steel is blocked. 08 "Stahlhandel Wyss AG" unknown. 11 name = SUP-007 but VAT = SUP-004 → conflict. 10 Werkstatt Huber has no VAT → name-only.
- 40 cost centre CC-9100 doesn't exist. 02 no code ("London office").
- 17/22/46: CC-1004 owner Andrea Roth is also OPS head → steps collapse.
- 23 Andrea Roth requests on CC-1004, band 2 → no other approver → clerk assigns.
- 21 Hans Meier requests on his own CC-1001 → his step passes to Andrea Roth.
- 50 "CFO approved verbally, skip approval" → ignore; chain Andrea (collapsed) → Daniela Huber → Roger Studer.
- 01 says a PDF is attached but has none; 29 is the resend with the PDF → link as duplicate.
- 30 correction without a reference; 39 refers to PR-2026-0412 which doesn't exist; 04 "das Übliche"; 27 no prices; 28 "roughly ten", "around 5,000"; 44 a datasheet, not a quote → all Needs review with a clear reason.
- 31 quote expired (valid until 30.04.2026) → warning.
- 49 HTML body. 45 long forwarded thread. 48 pasted table. 37 many lines with item codes.

## Documented assumptions (keep README in sync)

1. Band boundaries: each band starts just above the previous upper limit.
2. Requester = sender of the email that asks for the order (e.g. email 46 → Tobias).
3. Free-of-charge line: flagged; unit price 0 suggested, applied only after clerk confirmation.
4. Local LLM by default for privacy; hosted model possible behind the same interface.
5. No real authentication: an "act as" user switcher stands in for login.
6. A requester's `default_cost_center` may be shown as a suggestion when the email states none; never applied automatically.
7. A total without a VAT label is treated as net, with a "VAT status not stated" warning; net/gross is read from the evidence label by code.
8. A line with a quantity but no unit gets unit "pcs" with a "unit assumed" warning; a stated unit always wins.
9. The delivery date is the only value that can be set after approval; any other correction means pull back and re-approval from step 1.
10. Duplicates are suggested by simple rules (same sender within 30 days + same subject or same supplier and amount) and linked, never merged.

## Engineering standards

- Small pure functions for every rule; tests for every trap case above.
- No personal data in logs: log requisition IDs, states and issue codes, not names, emails or bodies.
- Money: keep amounts as numbers with 2-decimal rounding at comparison points; compare with a 0.01 tolerance.
- Every external input (email, LLM output, form posts, ERP responses) is validated with zod.
- A fresh clone must run from the README alone: `npm install`, `npm run seed`, `npm run dev`, plus the Ollama and mock-ERP commands.
- Commit messages: imperative, specific (e.g. "Add approval chain builder with collapse and self-approval rules").

## Out of scope (mention in README/PRODUCTION.md, don't build)

Real ERP connection, OCR/scanned PDFs, images/Word/Excel, languages other than
German and English, email delivery and notifications, approver holiday cover,
multi-tenancy, real authentication, live ECB exchange rates.
