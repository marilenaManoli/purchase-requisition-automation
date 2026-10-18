import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { buildChain, findBand } from "../src/approval/chain.ts";
import { blocksApproval } from "../src/checks/issues.ts";
import { applySchema, openDb } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";

// Names used below (from master_data.json):
//   EMP-101 Hans Meier      owner CC-1001 (OPS)
//   EMP-501 Andrea Roth     owner CC-1004 AND head of OPS
//   EMP-701 Daniela Huber   finance (EMP-702 Thomas Egger is her deputy)
//   EMP-801 Roger Studer    cfo
//   EMP-901 Beatrice Fischer ceo
//   EMP-110 Tobias Weber    requester only
let ref: ReferenceData;
beforeAll(() => {
  const db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
});

/** The chain as [approver, roles] pairs: short and readable in assertions. */
const summary = (r: ReturnType<typeof buildChain>) => r.steps.map((s) => [s.approverEmployeeId, s.roles.join("+")]);

describe("findBand (assumption 1: each band starts just above the previous limit)", () => {
  it.each([
    [999, 1], // email 12
    [1000, 1], // email 13
    [1000.5, 2], // the gap between 1,000 and 1,001
    [1001, 2], // email 14
    [9700, 2], // email 05: net, not gross 10,485.70
    [10000, 2],
    [10000.01, 3],
    [10057, 3], // email 15
    [49920, 3], // email 17
    [250000, 4],
    [250000.01, 5],
    [285000, 5], // email 20
    [299200, 5], // email 19
  ])("CHF %d → band %d", (chf, band) => {
    expect(findBand(chf, ref.approvalBands)?.band).toBe(band);
  });
});

describe("buildChain", () => {
  it("builds the band-2 chain: cost-centre owner, then department head", () => {
    const r = buildChain(2400, "CC-1001", "EMP-110", ref); // Tobias requests on Hans's cost centre
    expect(r.band).toBe(2);
    expect(summary(r)).toEqual([
      ["EMP-101", "cost_center_owner"],
      ["EMP-501", "department_head"],
    ]);
    expect(r.issues).toEqual([]);
  });

  it("collapses consecutive steps held by one person (email 17: CC-1004, Andrea is owner and OPS head)", () => {
    const r = buildChain(49920, "CC-1004", "EMP-104", ref);
    expect(summary(r)).toEqual([
      ["EMP-501", "cost_center_owner+department_head"],
      ["EMP-701", "finance"],
    ]);
  });

  it("picks the Finance holder who is not a deputy (Daniela, not Thomas)", () => {
    const r = buildChain(20000, "CC-2001", "EMP-210", ref);
    expect(r.steps.find((s) => s.roles.includes("finance"))?.approverEmployeeId).toBe("EMP-701");
  });

  it("ignores instructions in the email: the full chain applies (email 50, CHF 62,000, 'CFO approved verbally')", () => {
    const r = buildChain(62000, "CC-1004", "EMP-110", ref);
    expect(r.band).toBe(4);
    expect(summary(r)).toEqual([
      ["EMP-501", "cost_center_owner+department_head"],
      ["EMP-701", "finance"],
      ["EMP-801", "cfo"],
    ]);
  });

  it("builds all five steps for the top band (email 19)", () => {
    const r = buildChain(299200, "CC-1003", "EMP-111", ref);
    expect(r.steps.map((s) => s.roles.join("+"))).toEqual(["cost_center_owner", "department_head", "finance", "cfo", "ceo"]);
    expect(r.steps.at(-1)?.approverEmployeeId).toBe("EMP-901");
  });

  it("passes the requester's step to the next approver (email 21: Hans requests on his own CC-1001)", () => {
    const r = buildChain(2400, "CC-1001", "EMP-101", ref);
    expect(summary(r)).toEqual([["EMP-501", "cost_center_owner+department_head"]]);
    // Never silently: the clerk can see why Andrea approves both roles.
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([["SELF_APPROVAL_REASSIGNED", "warning"]]);
    expect(blocksApproval(r.issues)).toBe(false);
  });

  it("asks the clerk to assign an approver when nobody else is left (email 23: Andrea requests on CC-1004)", () => {
    const r = buildChain(3200, "CC-1004", "EMP-501", ref);
    expect(summary(r)).toEqual([[null, "cost_center_owner+department_head"]]); // the step is kept, not skipped
    expect(r.issues.map((i) => i.code)).toEqual(["APPROVER_NEEDED"]);
    expect(blocksApproval(r.issues)).toBe(true);
  });

  it("applies the rule at any seniority: the CEO can't approve her own band-5 request", () => {
    const r = buildChain(300000, "CC-3001", "EMP-901", ref);
    expect(r.steps.at(-1)).toMatchObject({ roles: ["ceo"], approverEmployeeId: null });
    expect(r.issues.map((i) => i.code)).toContain("APPROVER_NEEDED");
  });

  it("passes a requester's middle step forward, not backward (Daniela requests at band 4)", () => {
    const r = buildChain(60000, "CC-2001", "EMP-701", ref);
    expect(summary(r)).toEqual([
      ["EMP-201", "cost_center_owner"],
      ["EMP-502", "department_head"],
      ["EMP-801", "finance+cfo"], // the CFO takes over Finance: the next distinct role
    ]);
  });

  it("does not collapse repeats that are not consecutive", () => {
    // A test-only variant of the master data: Daniela (Finance) also owns CC-2001.
    const variant: ReferenceData = {
      ...ref, // spread: copy every field, then override one
      costCenters: ref.costCenters.map((c) => (c.code === "CC-2001" ? { ...c, owner_employee_id: "EMP-701" } : c)),
    };
    const r = buildChain(20000, "CC-2001", "EMP-210", variant);
    expect(summary(r)).toEqual([
      ["EMP-701", "cost_center_owner"],
      ["EMP-502", "department_head"],
      ["EMP-701", "finance"], // Daniela approves again: someone else is in between
    ]);
  });

  it("does not run the self-approval rule for an unknown requester", () => {
    const r = buildChain(2400, "CC-1001", null, ref);
    expect(r.steps).toHaveLength(2);
    expect(r.issues).toEqual([]);
  });

  it("numbers the steps from 1 in approval order", () => {
    expect(buildChain(62000, "CC-1004", "EMP-110", ref).steps.map((s) => s.position)).toEqual([1, 2, 3]);
  });
});
