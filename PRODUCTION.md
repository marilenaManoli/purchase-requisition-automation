# What production would need

This prototype is built to be correct and explainable, not to run a company's
procurement. This file lists what is missing for production, in rough order of
priority, and how each would be done. Nothing here is built.

## 1. Volume: 10× today (≈ 2,000 requests a day)

The bottleneck is the LLM (30–60 s per email on a laptop), not the database
(2,000 requisitions a day is one write every 15–30 seconds).

- **Queue and workers.** Incoming emails go on a queue; extraction workers
  consume it with retries and exponential backoff when the model is unavailable.
  The prototype already has the right shape: an email waiting in `inbox` is a
  queue item, and `extractAndRoute` is the worker's job. Duplicate detection would
  then need a lock per sender, or a run after each batch.
- **Model serving.** A GPU server running the same open model, or a hosted model
  (see §4). Extraction is independent per email, so it scales horizontally.
- **Postgres instead of SQLite**, for several app instances, managed backups,
  point-in-time recovery and failover. The schema is plain SQL; the move is mostly
  mechanical (drop `STRICT`, `REAL` → `NUMERIC`). Approvals would add a row lock
  (`SELECT … FOR UPDATE`) or an optimistic check on the step's status.
- **Email intake.** Read the purchasing mailbox (IMAP / Microsoft Graph) instead of
  uploads; keep the raw `.eml` exactly as today.

## 2. Identity, permissions and security

- **Real login via SSO** (OpenID Connect, e.g. Azure AD / Entra ID). The "act as"
  switcher is one middleware that sets the actor; replacing it is local, because
  every rule downstream already works with an identity.
- **Roles**: clerk, approver, admin, read-only auditor. Clerk actions are a role,
  not "anyone without a cookie".
- **CSRF tokens** (or SameSite session cookies plus the existing same-origin check),
  secure session cookies, rate limiting, HTTPS only.
- **Audit with real identities.** The audit log already records who and why for
  every change; with SSO it records a verified person.
- Optionally **four-eyes rules** for clerk edits above an amount.

## 3. Exchange rates

Daily **ECB reference rates** (euro foreign exchange reference rates, published on
working days around 16:00 CET), stored with their date. A requisition keeps the
rate and date it was routed with, so its band never changes afterwards. Rates are
cross rates through EUR (CHF per EUR ÷ GBP per EUR). Weekends and holidays use the
last published rate.

## 4. The LLM: privacy and quality

- **Hosted vs local.** Today a local model keeps personal data on the machine. A
  hosted model would likely extract better; it needs EU data residency, zero data
  retention and a data processing agreement. It is one new class behind
  `LlmClient`; the 48-email `run-all` is the benchmark to decide on.
- **An evaluation set from real traffic.** Grow `scripts/expectedOutcomes.ts` with
  real (anonymised) cases and clerk corrections; run it in CI on every prompt or
  model change.
- **Monitoring of extraction quality**: share of unverified values per field, review
  rate, how often clerks correct each field. A rise means the model, the prompt or
  the incoming documents changed.
- **Prompt and model versions** recorded on every extraction (today: the model name).

## 5. Data

- **Supplier master from the ERP**, synced, instead of our own copy.
  Clerk-confirmed name variants become an alias table (who confirmed, when).
- **Supplier creation as a proper process** (bank details, sanctions check). New
  suppliers and changed bank details are a classic fraud route.
- **Money as decimals** (decimal library or Postgres `NUMERIC`), since unit prices
  go below a cent.
- **Retention**: delete or anonymise raw emails after the legal retention period;
  keep the audit trail.

## 6. The ERP

- A real integration (SAP, Abacus, …) behind the existing `ErpClient` interface,
  with the same rules: only from `approved`, an idempotency key, 422 problems
  shown to the clerk.
- Order status back from the ERP (confirmed, delivered, invoiced).

## 7. Operations

- **Monitoring and alerts**: queue length, extraction latency, LLM and ERP
  availability, requisitions waiting longer than N days for an approver.
- **Structured logs** with requisition ids, states and issue codes only (as today:
  no names, addresses or email text).
- **Backups and restore drills**; migrations instead of re-seeding.

## 8. Features out of scope in the brief

- **Notifications**: tell the next approver by email or Teams, with a link.
- **Holiday cover**: an absences table (employee, from, to, delegate; default: the
  `deputy_for` employee). Resolve the approver when a step becomes *active*, not when
  the chain is built. The audit says "approved by X on behalf of Y"; the
  self-approval rule applies to the delegate; long waits escalate to the clerk.
- **More formats**: `.docx` (text, so the evidence check still works); scanned
  PDFs and images via OCR, with the OCR text as the source the quotes are checked
  against and low OCR confidence raised as an issue; Excel line lists.
- **More languages**: the prompt has no language branch; mainly the label lists
  (net/gross words, "valid until") would need extending.
- **GL account suggestions that learn**: today a fixed keyword list and cost-centre
  defaults suggest an account and the clerk confirms it. With history, suggest from
  what clerks confirmed for the same supplier and similar items, and measure how often
  the suggestion is accepted.
- **Multi-tenancy**: tenant id on every row, per-tenant master data and approval
  limits.
