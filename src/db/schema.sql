-- Schema for the purchase requisition app.
--
-- Conventions:
--   * STRICT tables: SQLite rejects values of the wrong type (e.g. text in a REAL column).
--   * Money is REAL, rounded to 2 decimals at comparison points (see CLAUDE.md).
--   * Dates/times are ISO-8601 TEXT ('2026-10-18', '2026-10-18T09:30:00.000Z').
--   * Booleans are INTEGER 0/1.
--   * Foreign keys are only enforced because db.ts runs PRAGMA foreign_keys = ON.

-- ===========================================================================
-- Master data (loaded from data/master_data.json by `npm run seed`)
-- ===========================================================================

CREATE TABLE employees (
  id                  TEXT PRIMARY KEY,                -- 'EMP-101'
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  role                TEXT NOT NULL CHECK (role IN (
                        'cost_center_owner', 'department_head', 'finance',
                        'cfo', 'ceo', 'requester_only')),
  -- Stand-in for another employee; stand-ins never approve (brief §4.2).
  -- DEFERRABLE: checked at COMMIT, so insert order inside the seed doesn't matter.
  deputy_for          TEXT REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED,
  -- Only informational: the cost centre always comes from the email (CLAUDE.md).
  default_cost_center TEXT REFERENCES cost_centers(code) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE departments (
  code             TEXT PRIMARY KEY,                   -- 'OPS'
  name             TEXT NOT NULL,
  head_employee_id TEXT NOT NULL REFERENCES employees(id)
) STRICT;

CREATE TABLE cost_centers (
  code              TEXT PRIMARY KEY,                  -- 'CC-1001'
  name              TEXT NOT NULL,
  owner_employee_id TEXT NOT NULL REFERENCES employees(id),
  department_code   TEXT NOT NULL REFERENCES departments(code)
) STRICT;

CREATE TABLE suppliers (
  id                 TEXT PRIMARY KEY,                 -- 'SUP-001'
  name               TEXT NOT NULL,
  vat_id             TEXT,                             -- as written in master data; NULL for SUP-019
  country            TEXT NOT NULL,
  default_currency   TEXT NOT NULL,
  payment_terms_days INTEGER NOT NULL,
  preferred          INTEGER NOT NULL CHECK (preferred IN (0, 1)),
  status             TEXT NOT NULL CHECK (status IN ('active', 'blocked'))
) STRICT;

CREATE TABLE gl_accounts (
  code TEXT PRIMARY KEY,                               -- '5100'
  name TEXT NOT NULL
) STRICT;

CREATE TABLE fx_rates (
  currency    TEXT PRIMARY KEY,                        -- 'EUR'
  rate_to_chf REAL NOT NULL CHECK (rate_to_chf > 0)
) STRICT;

-- One row per band, numbered 1..5 in ascending order of amount.
-- Band lookup (step 5) uses only to_chf: the first band with to_chf >= amount,
-- or the band with to_chf NULL (no upper limit). from_chf is kept for display.
CREATE TABLE approval_bands (
  band     INTEGER PRIMARY KEY,
  from_chf REAL NOT NULL,
  to_chf   REAL                                        -- NULL = no upper limit
) STRICT;

-- The ordered roles each band requires. position 1 approves first.
CREATE TABLE approval_band_roles (
  band     INTEGER NOT NULL REFERENCES approval_bands(band),
  position INTEGER NOT NULL,
  role     TEXT NOT NULL CHECK (role IN (
             'cost_center_owner', 'department_head', 'finance', 'cfo', 'ceo')),
  PRIMARY KEY (band, position)
) STRICT;

-- ===========================================================================
-- App data (filled by the pipeline from step 2 on; refined as we go)
-- ===========================================================================

-- One row per received .eml file. The raw file is kept so any extraction can
-- be re-run or audited against exactly what arrived.
CREATE TABLE emails (
  id          INTEGER PRIMARY KEY,
  filename    TEXT,                                    -- original file name, if uploaded as a file
  message_id  TEXT,                                    -- Message-ID header
  from_email  TEXT,
  subject     TEXT,
  sent_at     TEXT,                                    -- Date header
  raw         BLOB NOT NULL,                           -- the .eml bytes, unchanged
  source_text TEXT,                                    -- body + PDF text the LLM saw (step 2)
  received_at TEXT NOT NULL
) STRICT;

-- One requisition per email (brief §5). Two kinds of columns:
--   * extraction_json: what the document SAYS (LLM output, with evidence quotes);
--   * the other columns: what we have ESTABLISHED (validated against master
--     data or confirmed by the clerk). NULL means "not established".
CREATE TABLE requisitions (
  id                      INTEGER PRIMARY KEY,
  email_id                INTEGER NOT NULL UNIQUE REFERENCES emails(id),
  state                   TEXT NOT NULL CHECK (state IN (
                            'inbox', 'extracted', 'needs_review', 'pending_approval',
                            'approved', 'ordered', 'rejected')),
  requester_employee_id   TEXT REFERENCES employees(id),
  supplier_id             TEXT REFERENCES suppliers(id),
  cost_center_code        TEXT REFERENCES cost_centers(code),
  gl_account_code         TEXT REFERENCES gl_accounts(code),  -- confirmed by the clerk
  gl_account_suggested    TEXT REFERENCES gl_accounts(code),  -- suggestion only
  gl_suggestion_reason    TEXT,                        -- why it was suggested
  currency                TEXT REFERENCES fx_rates(currency),
  net_total               REAL,                        -- original currency, excl. VAT
  vat_amount              REAL,
  gross_total             REAL,
  net_total_chf           REAL,                        -- decides the band
  band                    INTEGER REFERENCES approval_bands(band),
  requested_delivery_date TEXT,                        -- 'YYYY-MM-DD' or NULL
  approval_round          INTEGER NOT NULL DEFAULT 1,  -- +1 when a corrected rejection restarts the chain
  related_requisition_id  INTEGER REFERENCES requisitions(id),
  relation                TEXT CHECK (relation IN ('duplicate', 'correction', 'reference')),
  rejection_reason        TEXT,
  erp_po_number           TEXT,
  erp_warnings_json       TEXT,
  extraction_json         TEXT,                        -- validated LLM output
  extraction_raw          TEXT,                        -- raw model output, kept for debugging failures
  clerk_overrides_json    TEXT,                        -- values a clerk entered; they replace the model's claim (6c)
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
) STRICT;

CREATE TABLE line_items (
  id             INTEGER PRIMARY KEY,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  description    TEXT NOT NULL,
  item_code      TEXT,
  quantity       REAL,
  unit           TEXT,
  unit_price     REAL,                                 -- NULL = no price stated (blocks approval)
  price_per      REAL NOT NULL DEFAULT 1,              -- 100 for "EUR 21.00 per 100 pcs"
  line_total     REAL,
  UNIQUE (requisition_id, position)
) STRICT;

CREATE TABLE issues (
  id             INTEGER PRIMARY KEY,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,                        -- e.g. 'SUPPLIER_BLOCKED'
  severity       TEXT NOT NULL CHECK (severity IN ('blocks_approval', 'blocks_order', 'warning')),
  field          TEXT,
  message        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,                                 -- actor: employee id or 'clerk'
  resolution     TEXT                                  -- the clerk's note
) STRICT;

-- The approval chain. Old rounds are kept, so a restart never erases history.
CREATE TABLE approval_steps (
  id                   INTEGER PRIMARY KEY,
  requisition_id       INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  round                INTEGER NOT NULL,
  position             INTEGER NOT NULL,               -- 1 approves first
  roles                TEXT NOT NULL,                  -- e.g. 'cost_center_owner,department_head' when collapsed
  approver_employee_id TEXT REFERENCES employees(id),  -- NULL = clerk must assign one
  status               TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved', 'rejected')),
  decided_at           TEXT,
  comment              TEXT,
  UNIQUE (requisition_id, round, position)
) STRICT;

-- Every state change, written in the same transaction as the change itself.
CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
  at             TEXT NOT NULL,
  actor          TEXT NOT NULL,                        -- employee id or 'system'
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  reason         TEXT
) STRICT;

CREATE INDEX idx_requisitions_state ON requisitions(state);
CREATE INDEX idx_issues_requisition ON issues(requisition_id);
CREATE INDEX idx_steps_requisition ON approval_steps(requisition_id, round);
CREATE INDEX idx_audit_requisition ON audit_events(requisition_id);
