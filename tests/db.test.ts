import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";

const rawJson = JSON.parse(readFileSync("data/master_data.json", "utf8"));

// A fresh in-memory database per test: fast, and tests can't affect each other.
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(rawJson));
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("seeded master data", () => {
  it("loads every record from master_data.json", () => {
    expect(count("suppliers")).toBe(25);
    expect(count("cost_centers")).toBe(15);
    expect(count("departments")).toBe(6);
    expect(count("employees")).toBe(33);
    expect(count("gl_accounts")).toBe(12);
    expect(count("fx_rates")).toBe(4);
    expect(count("approval_bands")).toBe(5);
  });

  it("stores the five approval bands with their ordered roles", () => {
    const bands = db
      .prepare(
        `SELECT b.band, b.from_chf, b.to_chf, group_concat(r.role, ' > ') AS roles
         FROM approval_bands b
         JOIN (SELECT * FROM approval_band_roles ORDER BY band, position) r ON r.band = b.band
         GROUP BY b.band ORDER BY b.band`,
      )
      .all();

    expect(bands).toEqual([
      { band: 1, from_chf: 0, to_chf: 1000, roles: "cost_center_owner" },
      { band: 2, from_chf: 1001, to_chf: 10000, roles: "cost_center_owner > department_head" },
      { band: 3, from_chf: 10001, to_chf: 50000, roles: "cost_center_owner > department_head > finance" },
      { band: 4, from_chf: 50001, to_chf: 250000, roles: "cost_center_owner > department_head > finance > cfo" },
      { band: 5, from_chf: 250001, to_chf: null, roles: "cost_center_owner > department_head > finance > cfo > ceo" },
    ]);
  });

  it("stores the fixed exchange rates", () => {
    const rates = db.prepare(`SELECT currency, rate_to_chf FROM fx_rates ORDER BY currency`).all();
    expect(rates).toEqual([
      { currency: "CHF", rate_to_chf: 1 },
      { currency: "EUR", rate_to_chf: 0.96 },
      { currency: "GBP", rate_to_chf: 1.13 },
      { currency: "USD", rate_to_chf: 0.88 },
    ]);
  });

  it("keeps the facts the business rules depend on", () => {
    // The one blocked supplier (email 09).
    expect(db.prepare(`SELECT id FROM suppliers WHERE status = 'blocked'`).all()).toEqual([{ id: "SUP-018" }]);
    // Supplier without VAT ID (email 10, name-only match).
    expect(db.prepare(`SELECT vat_id FROM suppliers WHERE id = 'SUP-019'`).get()).toEqual({ vat_id: null });
    // Finance has two holders; only Thomas Egger is a deputy.
    expect(db.prepare(`SELECT id, deputy_for FROM employees WHERE role = 'finance' ORDER BY id`).all()).toEqual([
      { id: "EMP-701", deputy_for: null },
      { id: "EMP-702", deputy_for: "EMP-701" },
    ]);
  });
});

describe("database integrity", () => {
  it("enforces foreign keys", () => {
    expect(() =>
      db.prepare(`INSERT INTO cost_centers VALUES ('CC-9100', 'Ghost', 'EMP-999', 'OPS')`).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects values of the wrong type (STRICT tables)", () => {
    expect(() => db.prepare(`INSERT INTO fx_rates VALUES ('JPY', 'cheap')`).run()).toThrow();
  });

  it("rejects a state that is not in the workflow", () => {
    db.prepare(`INSERT INTO emails (id, raw, received_at) VALUES (1, x'00', '2026-10-18')`).run();
    expect(() =>
      db.prepare(
        `INSERT INTO requisitions (email_id, state, created_at, updated_at)
         VALUES (1, 'auto_approved', '2026-10-18', '2026-10-18')`,
      ).run(),
    ).toThrow(/CHECK/);
  });
});

describe("master data validation", () => {
  it("rejects a file with an unknown role", () => {
    const broken = structuredClone(rawJson);
    broken.employees[0].role = "boss";
    expect(() => parseMasterData(broken)).toThrow();
  });

  it("loads nothing if any insert fails (transaction rollback)", () => {
    const broken = parseMasterData(structuredClone(rawJson));
    broken.cost_centers.push({ code: "CC-9999", name: "Bad", owner_employee_id: "EMP-999", department: "OPS" });

    const fresh = openDb(":memory:");
    applySchema(fresh);
    expect(() => seedMasterData(fresh, broken)).toThrow(/FOREIGN KEY/);
    expect((fresh.prepare(`SELECT COUNT(*) AS n FROM employees`).get() as { n: number }).n).toBe(0);
  });
});
