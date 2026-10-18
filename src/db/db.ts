import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

// `import type` is erased at runtime: it is only used by the type checker.
export type Db = Database.Database;

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url);

/** Opens (or creates) a SQLite database. Pass ":memory:" in tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  // SQLite ignores REFERENCES constraints unless this is switched on, per connection.
  db.pragma("foreign_keys = ON");
  // Write-ahead log: readers don't block the writer (web server + scripts).
  db.pragma("journal_mode = WAL");
  return db;
}

/** Creates all tables. Expects an empty database. */
export function applySchema(db: Db): void {
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
}
