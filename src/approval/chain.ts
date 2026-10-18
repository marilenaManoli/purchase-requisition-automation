import { issue, type Issue } from "../checks/issues.ts";
import type { ApprovalBand, ApproverRole, ReferenceData } from "../db/queries.ts";

// Brief §4: who approves, in which order. A pure function of the established
// values and the master data: no state, no database writes, no LLM.
//
//   1. band  = first band whose upper limit ≥ net CHF (assumption 1)
//   2. roles = that band's roles, in order
//   3. each role → one employee (CC owner, department head, or the
//      company-wide holder without deputy_for)
//   4. the requester never approves: their step passes to the next step held by
//      someone else; if there is none, the step stays WITHOUT an approver and
//      the clerk must assign one
//   5. consecutive steps held by the same person collapse into one

export interface ChainStep {
  position: number; // 1 approves first
  roles: ApproverRole[]; // several after a collapse or a self-approval pass
  approverEmployeeId: string | null; // null = the clerk must assign an approver
}

export interface ChainResult {
  band: number | null;
  steps: ChainStep[]; // empty if no chain could be built
  issues: Issue[];
}

/** Assumption 1: the first band whose upper limit is ≥ the amount (1000.50 → band 2). */
export function findBand(netChf: number, bands: ApprovalBand[]): ApprovalBand | undefined {
  return [...bands].sort((a, b) => a.band - b.band).find((b) => b.toChf === null || netChf <= b.toChf);
}

export function buildChain(
  netChf: number,
  costCenterCode: string,
  requesterEmployeeId: string | null,
  ref: ReferenceData,
): ChainResult {
  const band = findBand(netChf, ref.approvalBands);
  const costCenter = ref.costCenters.find((c) => c.code === costCenterCode);
  if (band === undefined || costCenter === undefined) {
    // runChecks has already validated both; reaching this is a programming error.
    throw new Error(`buildChain called without a valid band or cost centre (${netChf}, ${costCenterCode})`);
  }

  // 3. Resolve each role to a person.
  const issues: Issue[] = [];
  let steps: Omit<ChainStep, "position">[] = band.roles.map((role) => {
    const resolved = resolveRole(role, costCenter.owner_employee_id, costCenter.department_code, ref);
    if (resolved.issue) issues.push(resolved.issue);
    return { roles: [role], approverEmployeeId: resolved.employeeId };
  });

  // 4. The requester never approves their own requisition.
  if (requesterEmployeeId !== null) {
    steps = passOnRequesterSteps(steps, requesterEmployeeId, issues);
  }

  // 5. Collapse consecutive steps held by the same person.
  steps = collapseConsecutive(steps);

  if (steps.some((s) => s.approverEmployeeId === null)) {
    issues.push(issue("APPROVER_NEEDED", "blocks_approval", null,
      "At least one approval step has no eligible approver. The clerk must assign one before approval can start."));
  }
  return { band: band.band, steps: steps.map((s, i) => ({ ...s, position: i + 1 })), issues };
}

function resolveRole(
  role: ApproverRole,
  ownerId: string,
  departmentCode: string,
  ref: ReferenceData,
): { employeeId: string | null; issue?: Issue } {
  switch (role) {
    case "cost_center_owner":
      return { employeeId: ownerId };
    case "department_head": {
      const dept = ref.departments.find((d) => d.code === departmentCode);
      return dept
        ? { employeeId: dept.head_employee_id }
        : { employeeId: null, issue: issue("APPROVER_NOT_FOUND", "blocks_approval", null, `Department ${departmentCode} has no head in the master data.`) };
    }
    case "finance":
    case "cfo":
    case "ceo": {
      // Company-wide role: the holder WITHOUT deputy_for approves (brief §4.2).
      const holders = ref.employees.filter((e) => e.role === role && e.deputy_for === null);
      if (holders.length === 1) return { employeeId: holders[0]?.id ?? null };
      return {
        employeeId: null,
        issue: holders.length === 0
          ? issue("APPROVER_NOT_FOUND", "blocks_approval", null, `No employee holds the role ${role}.`)
          : issue("APPROVER_AMBIGUOUS", "blocks_approval", null, `Several employees hold the role ${role} without being a deputy.`),
      };
    }
  }
}

/**
 * Brief §4.4: a step held by the requester passes to the next step held by
 * someone else, who then approves both roles. If no such step follows, the step
 * stays in place without an approver: it is never skipped.
 */
function passOnRequesterSteps(
  steps: Omit<ChainStep, "position">[],
  requesterId: string,
  issues: Issue[],
): Omit<ChainStep, "position">[] {
  const result: Omit<ChainStep, "position">[] = [];
  let carried: ApproverRole[] = []; // roles waiting for the next eligible approver

  for (const step of steps) {
    if (step.approverEmployeeId === requesterId) {
      carried.push(...step.roles);
      continue;
    }
    if (carried.length > 0) {
      issues.push(issue("SELF_APPROVAL_REASSIGNED", "warning", null,
        `The requester holds the role(s) ${carried.join(", ")}; that step passes to the next approver (${step.approverEmployeeId}).`));
    }
    result.push({ roles: [...carried, ...step.roles], approverEmployeeId: step.approverEmployeeId });
    carried = [];
  }

  if (carried.length > 0) {
    // Nobody after the requester: keep the step, but with no approver.
    result.push({ roles: carried, approverEmployeeId: null });
  }
  return result;
}

/** Consecutive steps with the same approver become one; repeats further apart stay separate. */
function collapseConsecutive(steps: Omit<ChainStep, "position">[]): Omit<ChainStep, "position">[] {
  const result: Omit<ChainStep, "position">[] = [];
  for (const step of steps) {
    const previous = result.at(-1);
    if (previous && step.approverEmployeeId !== null && previous.approverEmployeeId === step.approverEmployeeId) {
      previous.roles.push(...step.roles);
    } else {
      result.push({ roles: [...step.roles], approverEmployeeId: step.approverEmployeeId });
    }
  }
  return result;
}
