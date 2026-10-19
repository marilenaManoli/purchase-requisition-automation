import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { accountForDescription, suggestGlAccount } from "../src/checks/glAccount.ts";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { ApprovalError, approve } from "../src/workflow/approvals.ts";
import { buildPurchaseOrder, confirmGlAccount, setDeliveryDate } from "../src/workflow/ordering.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { email25, FakeLlm } from "./fixtures.ts";

const accounts = JSON.parse(readFileSync("data/master_data.json", "utf8")).gl_accounts as { code: string; name: string }[];

describe("accountForDescription", () => {
  it.each([
    ["Thrust bearing 51105", "5300"],
    ["Rillenkugellager 6204-2RS", "5300"], // German compound: main noun last
    ["Spannlager UC 206", "5300"], // a bearing, not a clamp: the end of the word wins
    ["Spannvorrichtung SV-300", "5400"],
    ["Koordinatenmessgerät KMG-900", "7400"],
    ["Load cell LC-5kN", "7400"], // multi-word keyword
    ["Freight and export packing, air", "7600"],
    ["Steuerungsmodul Typ SCX-220", null],
  ])("%s → %s", (description, code) => {
    expect(accountForDescription(description)?.code ?? null).toBe(code);
  });
});

describe("suggestGlAccount", () => {
  it("suggests from the items, with the reason", () => {
    expect(suggestGlAccount("CC-1001", ["Needle roller bearing NA4905", "Thrust bearing 51105"], accounts)).toEqual({
      code: "5300",
      reason: 'item "Needle roller bearing NA4905" contains "bearing" → 5300 Spare Parts',
    });
  });

  it("ignores a freight line when there are goods (email 36)", () => {
    expect(suggestGlAccount("CC-1002", ["Socket head cap screw M6x25", "Spring washer M6", "Freight and export packing, air"], accounts)?.code).toBe("5200");
  });

  it("needs real support: one matching item among four falls back to the cost centre (email 31)", () => {
    const s = suggestGlAccount("CC-2001", ["Linear actuator LA-300", "Rotary table RT-120", "Load cell LC-5kN with amplifier", "Control cabinet"], accounts);
    expect(s).toEqual({ code: "6100", reason: "cost centre CC-2001 usually books to 6100 R&D Hardware" });
  });

  it("makes no suggestion rather than a weak guess", () => {
    expect(suggestGlAccount("CC-1003", ["Steuerungsmodul SCX-220", "Bedienpanel BP-10"], accounts)).toBeNull();
    expect(suggestGlAccount("CC-1001", ["office chair", "27\" monitor"], accounts)).toBeNull(); // items disagree, no cost-centre default
  });
});

describe("suggested vs confirmed", () => {
  let db: Db;
  let ref: ReferenceData;
  let id: number;
  beforeEach(async () => {
    db = openDb(":memory:");
    applySchema(db);
    seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
    ref = loadReferenceData(db);
    id = await processEmail(db, readFileSync("data/emails/email_25.eml"), null, new FakeLlm(JSON.stringify(email25())), ref);
  });
  const row = () => db.prepare(`SELECT gl_account_suggested AS s, gl_account_code AS c, gl_suggestion_reason AS r FROM requisitions WHERE id = ?`).get(id);

  it("stores a suggestion with its reason, never a confirmed account", () => {
    expect(row()).toEqual({ s: "5200", c: null, r: 'item "Kunststoffclip KC-8, schwarz" contains "clip" → 5200 Production Consumables' });
  });

  it("never sends a suggestion to the ERP; only a confirmed account", () => {
    approve(db, id, "EMP-103");
    approve(db, id, "EMP-501");
    setDeliveryDate(db, id, "clerk", "2026-05-29");
    expect(buildPurchaseOrder(db, id).order).not.toHaveProperty("gl_account");

    confirmGlAccount(db, id, "clerk", "5200", ref.glAccounts); // allowed after approval, like the delivery date
    expect(buildPurchaseOrder(db, id).order.gl_account).toBe("5200");
  });

  it("only accepts accounts from the master data", () => {
    expect(() => confirmGlAccount(db, id, "clerk", "9999", ref.glAccounts)).toThrow(ApprovalError);
  });
});
