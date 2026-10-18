# Purchase Requisition Automation

Turns purchase-request emails (plain text, HTML, PDF attachments; German and
English) into structured requisitions, checks them against master data, builds
the approval chain, lets a human review and approve, and sends approved
requisitions to the (mock) ERP.

The guiding rule: **the system never presents a guess as a fact, and nothing is
approved automatically.** Anything that cannot be established from the document
or the master data is left empty, with the reason recorded, for a human to decide.

## Setup

Requirements: Node.js ≥ 22.9 (developed on 25), Python 3 (for the mock ERP),
[Ollama](https://ollama.com).

```bash
npm install
cp .env.example .env
ollama pull qwen2.5:7b
npm run seed            # creates the SQLite database from data/master_data.json
```

## Run

Three processes, each in its own terminal:

```bash
ollama serve                    # local LLM on :11434 (skip if the Ollama app is running)
python3 data/mock_po_api.py     # mock ERP on :8080
npm run dev                     # web app on http://localhost:3000
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (no Ollama or ERP needed) |
| `npm run typecheck` | TypeScript type check |
| `npm run ingest-summary` | Parses every sample email and prints its format and attachments (no LLM) |
| `npm run extract-all` | Runs the real LLM extraction on every sample email and saves the answers in `out/` |
| `npm run load-saved` | Puts every sample email through the pipeline, replaying the saved answers (seconds, no LLM) |
| `npm run run-all` | Processes every sample email and prints an outcome table |

## Architecture

_To be completed._ Principle: **the LLM reads, code decides.** The model only
transcribes what the document says (with evidence quotes); supplier matching,
currency conversion, totals, bands and approvers are deterministic, tested code.

```
.eml ─▶ parse ─▶ LLM extraction ─▶ validate ─▶ master-data checks ─▶ approval chain ─▶ review UI ─▶ mock ERP
```

## Assumptions

Where the brief was ambiguous:

1. **Band boundaries.** Each band starts just above the previous band's upper
   limit, so CHF 1,000.50 falls in band 2 (the brief's table leaves a gap
   between 1,000 and 1,001).
2. **Requester** is the sender of the email that asks for the order (in a
   forwarded thread, the person forwarding with the request).
3. **Free-of-charge lines** are flagged; a unit price of 0 is suggested and only
   applied after the clerk confirms it.
4. **Local LLM by default** (Ollama) so personal data in emails never leaves the
   machine; a hosted model can be plugged in behind the same interface.
5. **No real authentication.** An "act as" user switcher stands in for login.
6. **Requester's default cost centre is a suggestion only.** Some employees have
   a `default_cost_center` in the master data. When an email states no cost
   centre, it may be shown to the clerk as a suggestion, but it is never applied
   automatically: the cost centre must come from the email or from the clerk.

7. **A total without a VAT label is treated as net.** Many requests state only
   "Total CHF 3'200.00". Such an amount is used as the net amount and the clerk
   sees a "VAT status not stated" warning. Whether a stated total is net or gross
   is read by code from the label in its evidence quote ("Zwischensumme", "excl.
   VAT" → net; "inkl. MwSt", "brutto" → gross), not taken from the model's choice
   of field. A total that matches neither net nor net + VAT blocks approval.

8. **A quantity without a unit means pieces.** "3 office chairs" states a count but no
   unit, and the ERP requires one. Such a line gets the unit "pcs" and the clerk sees a
   "unit assumed" warning. A unit the document states (kg, m, Satz) is always used.

The `rules` block in `master_data.json` (self-approval forbidden, duplicate roles
collapse, approvals sequential) is not stored in the database. These rules are
mandated by the brief and enforced in code; a stored flag that the code ignored
would be misleading.

## Left out

Deliberately not built (see `PRODUCTION.md` for how each would be done):

- Live exchange rates: production would use the daily ECB reference rates; this
  build uses the fixed table from the master data.
- Real ERP connection, real authentication / SSO, email delivery and notifications.
- Scanned PDFs / OCR, images, Word, Excel; languages other than German and English.
- Approver holiday cover (deputies), multi-tenancy.

## Next steps

_To be completed._

## Use of AI tools

_To be completed._
