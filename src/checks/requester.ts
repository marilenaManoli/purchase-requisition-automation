import type { EmployeeRow } from "../db/queries.ts";
import { issue, type Issue } from "./issues.ts";

// Assumption 2: the requester is the sender of the email. That comes from the
// From header, parsed by code, not from the model. The requester matters for
// the self-approval rule, so an unknown sender is surfaced to the clerk.

export interface RequesterCheck {
  employeeId: string | null;
  defaultCostCenter: string | null;
  issues: Issue[];
}

export function findRequester(fromEmail: string | null, employees: EmployeeRow[]): RequesterCheck {
  const employee = fromEmail === null ? undefined : employees.find((e) => e.email === fromEmail.toLowerCase());
  if (employee !== undefined) {
    return { employeeId: employee.id, defaultCostCenter: employee.default_cost_center, issues: [] };
  }
  return {
    employeeId: null,
    defaultCostCenter: null,
    issues: [issue("REQUESTER_UNKNOWN", "warning", null,
      "The sender is not in the employee master data; the clerk should confirm who is requesting this.")],
  };
}
