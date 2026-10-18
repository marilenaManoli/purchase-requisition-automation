import type { Db } from "./db.ts";

// Typed views of the master-data tables, loaded once per pipeline run. The
// tables are small (≤ 33 rows each), so plain arrays are simpler than a query
// per lookup, and the checks stay pure functions over these arrays.
//
// The `as` casts are safe here: these rows come from our own STRICT tables,
// whose types and CHECK constraints the database already enforces. (External
// inputs are different: those go through zod.)

export interface SupplierRow {
  id: string;
  name: string;
  vat_id: string | null;
  default_currency: string;
  status: "active" | "blocked";
}

export interface CostCenterRow {
  code: string;
  name: string;
  owner_employee_id: string;
  department_code: string;
}

export interface EmployeeRow {
  id: string;
  name: string;
  email: string;
  role: string;
  deputy_for: string | null;
  default_cost_center: string | null;
}

export interface ReferenceData {
  suppliers: SupplierRow[];
  costCenters: CostCenterRow[];
  employees: EmployeeRow[];
  fxRatesToChf: Map<string, number>;
}

export function loadReferenceData(db: Db): ReferenceData {
  const fxRows = db.prepare(`SELECT currency, rate_to_chf FROM fx_rates`).all() as { currency: string; rate_to_chf: number }[];
  return {
    suppliers: db.prepare(`SELECT id, name, vat_id, default_currency, status FROM suppliers ORDER BY id`).all() as SupplierRow[],
    costCenters: db.prepare(`SELECT code, name, owner_employee_id, department_code FROM cost_centers ORDER BY code`).all() as CostCenterRow[],
    employees: db.prepare(`SELECT id, name, email, role, deputy_for, default_cost_center FROM employees ORDER BY id`).all() as EmployeeRow[],
    fxRatesToChf: new Map(fxRows.map((r) => [r.currency, r.rate_to_chf])),
  };
}
