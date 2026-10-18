// `npm run seed`: rebuilds the database from scratch and loads the master data.
// This deletes all requisitions too. It's meant for a fresh demo state.
import { readFileSync, rmSync } from "node:fs";
import { config } from "../config.ts";
import { applySchema, openDb } from "./db.ts";
import { parseMasterData, seedMasterData } from "./masterData.ts";

const MASTER_DATA_PATH = new URL("../../data/master_data.json", import.meta.url);

// Remove the old database and its WAL side files, if any.
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(config.DB_PATH + suffix, { force: true });
}

const data = parseMasterData(JSON.parse(readFileSync(MASTER_DATA_PATH, "utf8")));
const db = openDb(config.DB_PATH);
applySchema(db);
seedMasterData(db, data);

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

console.log(`Seeded ${config.DB_PATH}`);
for (const table of ["suppliers", "cost_centers", "departments", "employees", "gl_accounts", "fx_rates", "approval_bands"]) {
  console.log(`  ${table.padEnd(15)} ${count(table)}`);
}
db.close();
