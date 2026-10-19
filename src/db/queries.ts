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

export interface DepartmentRow {
  code: string;
  name: string;
  head_employee_id: string;
}

export type ApproverRole = "cost_center_owner" | "department_head" | "finance" | "cfo" | "ceo";

export interface ApprovalBand {
  band: number; // 1..5, ascending by amount
  fromChf: number; // for display only
  toChf: number | null; // null = no upper limit
  roles: ApproverRole[]; // in approval order
}

export interface ReferenceData {
  suppliers: SupplierRow[];
  costCenters: CostCenterRow[];
  departments: DepartmentRow[];
  employees: EmployeeRow[];
  fxRatesToChf: Map<string, number>;
  approvalBands: ApprovalBand[];
  glAccounts: { code: string; name: string }[];
}

export function loadReferenceData(db: Db): ReferenceData {
  const fxRows = db.prepare(`SELECT currency, rate_to_chf FROM fx_rates`).all() as { currency: string; rate_to_chf: number }[];
  return {
    suppliers: db.prepare(`SELECT id, name, vat_id, default_currency, status FROM suppliers ORDER BY id`).all() as SupplierRow[],
    costCenters: db.prepare(`SELECT code, name, owner_employee_id, department_code FROM cost_centers ORDER BY code`).all() as CostCenterRow[],
    departments: db.prepare(`SELECT code, name, head_employee_id FROM departments ORDER BY code`).all() as DepartmentRow[],
    employees: db.prepare(`SELECT id, name, email, role, deputy_for, default_cost_center FROM employees ORDER BY id`).all() as EmployeeRow[],
    fxRatesToChf: new Map(fxRows.map((r) => [r.currency, r.rate_to_chf])),
    approvalBands: loadApprovalBands(db),
    glAccounts: db.prepare(`SELECT code, name FROM gl_accounts ORDER BY code`).all() as { code: string; name: string }[],
  };
}

function loadApprovalBands(db: Db): ApprovalBand[] {
  const bands = db.prepare(`SELECT band, from_chf, to_chf FROM approval_bands ORDER BY band`).all() as
    { band: number; from_chf: number; to_chf: number | null }[];
  const roles = db.prepare(`SELECT band, role FROM approval_band_roles ORDER BY band, position`).all() as
    { band: number; role: ApproverRole }[];
  return bands.map((b) => ({
    band: b.band,
    fromChf: b.from_chf,
    toChf: b.to_chf,
    roles: roles.filter((r) => r.band === b.band).map((r) => r.role),
  }));
}
