import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const dir = dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.INTAKE_DB || process.env.SCM_DB || join(dir, "data", "intake.db");
mkdirSync(dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS intake_journal (
    id TEXT PRIMARY KEY,
    received_on TEXT NOT NULL,
    supplier TEXT NOT NULL,
    doc_kind TEXT NOT NULL,
    doc_no TEXT NOT NULL,
    product TEXT NOT NULL,
    qty REAL NOT NULL,
    unit TEXT NOT NULL,
    lot TEXT NOT NULL,
    expiry TEXT NOT NULL DEFAULT '',
    temp TEXT NOT NULL DEFAULT '',
    look TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS record_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '',
    after_json TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS record_log_record ON record_log (table_name, record_id);
`);

function addCol(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
addCol("intake_journal", "voided", "INTEGER NOT NULL DEFAULT 0");
addCol("intake_journal", "void_reason", "TEXT NOT NULL DEFAULT ''");
addCol("intake_journal", "voided_by", "TEXT NOT NULL DEFAULT ''");
addCol("intake_journal", "voided_at", "TEXT NOT NULL DEFAULT ''");
addCol("intake_journal", "note", "TEXT NOT NULL DEFAULT ''");
addCol("intake_journal", "warning", "TEXT NOT NULL DEFAULT ''");

export function query(sql, params = []) { return db.prepare(sql).all(...params); }
export function get(sql, params = []) { return db.prepare(sql).get(...params); }
export function run(sql, params = []) { return db.prepare(sql).run(...params); }
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to undo */ }
    throw err;
  }
}
export function closeDb() { db.close(); }
export { db };
