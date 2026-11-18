import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = ["001-control-plane.sql", "002-user-registration.sql", "003-hosted-workbench.sql", "004-hosted-receipt-components.sql"];

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(filename) {
  if (filename !== ":memory:") {
    filename = resolve(filename);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  transaction(db, () => {
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    if (version > migrations.length) throw new Error("Database requires a newer control plane.");
    for (let i = version; i < migrations.length; i++) {
      db.exec(readFileSync(new URL(`./migrations/${migrations[i]}`, import.meta.url), "utf8"));
      db.exec(`PRAGMA user_version = ${i + 1}`);
    }
  });
  return db;
}
