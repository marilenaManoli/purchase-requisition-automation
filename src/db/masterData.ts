import { z } from "zod";
import type { Db } from "./db.ts";

// ---------------------------------------------------------------------------
// Shape of data/master_data.json. It is an external input, so it is validated
// before anything touches the database: a typo in the file fails the seed with
// a clear message instead of producing half-loaded tables.
// ---------------------------------------------------------------------------

const ApproverRole = z.enum(["cost_center_owner", "department_head", "finance", "cfo", "ceo"]);
const EmployeeRole = z.enum([...ApproverRole.options, "requester_only"]);

const MasterDataSchema = z.object({
  _meta: z.object({
    // z.record: an object used as a dictionary, here { "EUR": 0.96, ... }
    fx_rates_to_chf: z.record(z.string().length(3), z.number().positive()),
  }),
  suppliers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      vat_id: z.string().nullable(),
      country: z.string(),
      default_currency: z.string(),
      payment_terms_days: z.number().int(),
      preferred: z.boolean(),
      status: z.enum(["active", "blocked"]),
    }),
  ),
  cost_centers: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      owner_employee_id: z.string(),
      department: z.string(),
    }),
  ),
  departments: z.array(
    z.object({ code: z.string(), name: z.string(), head_employee_id: z.string() }),
  ),
  employees: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      role: EmployeeRole,
      deputy_for: z.string().optional(),
      default_cost_center: z.string().optional(),
    }),
  ),
  gl_accounts: z.array(z.object({ code: z.string(), name: z.string() })),
  approval_limits_chf: z
    .array(
      z.object({
        from: z.number().nonnegative(),
        to: z.number().positive().nullable(),
        required_roles: z.array(ApproverRole).min(1),
      }),
    )
    .min(1),
});

// z.infer derives the TypeScript type from the schema: one source of truth.
export type MasterData = z.infer<typeof MasterDataSchema>;

/** Validates parsed JSON; throws a ZodError listing every problem found. */
export function parseMasterData(json: unknown): MasterData {
  return MasterDataSchema.parse(json);
}

/**
 * Inserts all master data into an empty database, in one transaction:
 * either everything is loaded or nothing is.
 */
export function seedMasterData(db: Db, data: MasterData): void {
  // Bands are numbered by ascending amount, so sort instead of trusting file order.
  const bands = [...data.approval_limits_chf].sort((a, b) => a.from - b.from);

  const insertEmployee = db.prepare(
    `INSERT INTO employees (id, name, email, role, deputy_for, default_cost_center)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertDepartment = db.prepare(
    `INSERT INTO departments (code, name, head_employee_id) VALUES (?, ?, ?)`,
  );
  const insertCostCenter = db.prepare(
    `INSERT INTO cost_centers (code, name, owner_employee_id, department_code) VALUES (?, ?, ?, ?)`,
  );
  const insertSupplier = db.prepare(
    `INSERT INTO suppliers (id, name, vat_id, country, default_currency, payment_terms_days, preferred, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGl = db.prepare(`INSERT INTO gl_accounts (code, name) VALUES (?, ?)`);
  const insertFx = db.prepare(`INSERT INTO fx_rates (currency, rate_to_chf) VALUES (?, ?)`);
  const insertBand = db.prepare(`INSERT INTO approval_bands (band, from_chf, to_chf) VALUES (?, ?, ?)`);
  const insertBandRole = db.prepare(
    `INSERT INTO approval_band_roles (band, position, role) VALUES (?, ?, ?)`,
  );

  // db.transaction wraps the function in BEGIN/COMMIT; any thrown error rolls back.
  const load = db.transaction(() => {
    // Employees first: departments and cost centres reference them.
    for (const e of data.employees) {
      // `?? null`: SQLite has no "undefined", so a missing optional field becomes NULL.
      insertEmployee.run(e.id, e.name, e.email, e.role, e.deputy_for ?? null, e.default_cost_center ?? null);
    }
    for (const d of data.departments) {
      insertDepartment.run(d.code, d.name, d.head_employee_id);
    }
    for (const c of data.cost_centers) {
      insertCostCenter.run(c.code, c.name, c.owner_employee_id, c.department);
    }
    for (const s of data.suppliers) {
      insertSupplier.run(
        s.id, s.name, s.vat_id, s.country, s.default_currency,
        s.payment_terms_days, s.preferred ? 1 : 0, s.status,
      );
    }
    for (const g of data.gl_accounts) {
      insertGl.run(g.code, g.name);
    }
    // Object.entries turns { EUR: 0.96 } into [["EUR", 0.96]].
    for (const [currency, rate] of Object.entries(data._meta.fx_rates_to_chf)) {
      insertFx.run(currency, rate);
    }
    bands.forEach((b, i) => {
      const band = i + 1;
      insertBand.run(band, b.from, b.to);
      b.required_roles.forEach((role, j) => insertBandRole.run(band, j + 1, role));
    });
  });

  load();
}
