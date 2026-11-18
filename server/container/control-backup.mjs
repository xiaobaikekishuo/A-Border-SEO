import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

process.umask(0o077);
const command = process.argv[2], argument = process.argv[3];
const file = "/data/control.sqlite";
const insist = (ok, message) => { if (!ok) throw new Error(message); };
const hash = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
function inspect(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    insist(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "Control database integrity check failed.");
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally { db.close(); }
}
function inspectImportSnapshot(filename) {
  // An online backup can retain journal_mode=WAL even with no sidecars.
  // SQLite may need to create shm/wal when opening it, which is impossible on
  // the read-only /import bind. Inspect a private copy, never ignore live WAL.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aborder-control-import-"));
  const copy = path.join(directory, "control.sqlite");
  let db;
  try {
    fs.copyFileSync(filename, copy);
    fs.chmodSync(copy, 0o600);
    db = new DatabaseSync(copy);
    insist(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "Control snapshot integrity check failed.");
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally {
    if (db) db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(copy + suffix, { force: true });
    fs.rmdirSync(directory);
  }
}
try {
  if (command === "import") {
    insist(fs.readdirSync("/data").length === 0, "Control volume must be completely empty; never overwrite existing identities.");
    insist(/^[a-f0-9]{64}$/.test(argument || "") && hash("/import/control.sqlite") === argument, "Control snapshot checksum mismatch.");
    inspectImportSnapshot("/import/control.sqlite");
    fs.copyFileSync("/import/control.sqlite", file);
    fs.chownSync("/data", 10001, 10001);
    fs.chmodSync("/data", 0o700);
    fs.chownSync(file, 10001, 10001);
    fs.chmodSync(file, 0o600);
    console.log("Existing control identity snapshot imported without changing issuer or key.");
  } else if (command === "init-cache") {
    fs.chownSync("/cache", 10001, 10001);
    fs.chmodSync("/cache", 0o700);
    console.log("Dedicated application cache permissions prepared.");
  } else if (command === "schema") console.log(inspect(file));
  else if (command === "check") {
    const maximum = fs.readdirSync("/app/control-plane/migrations").filter(name => /^\d+-.*\.sql$/.test(name)).length;
    insist(inspect(file) <= maximum, "This control image cannot read the migrated control database.");
    console.log("Control schema compatibility verified.");
  } else if (command === "backup") {
    insist(/^[A-Za-z0-9_-]{1,80}$/.test(argument || ""), "Invalid backup identifier.");
    const target = path.join("/backups", argument);
    insist(fs.realpathSync(target) === target && !fs.existsSync(path.join(target, "control.sqlite")), "Use a new private backup destination.");
    const db = new DatabaseSync(file, { readOnly: true });
    try { await backup(db, path.join(target, "control.sqlite")); } finally { db.close(); }
    const schema = inspect(path.join(target, "control.sqlite"));
    fs.writeFileSync(path.join(target, "control-backup.json"), JSON.stringify({ v: 1, schema,
      sha256: hash(path.join(target, "control.sqlite")) }) + "\n", { mode: 0o600 });
    console.log("Consistent control snapshot verified without executing any migration.");
  } else throw new Error("Unknown control snapshot operation.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
