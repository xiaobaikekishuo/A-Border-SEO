import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup } from "node:sqlite";
import { configureAdmin } from "./admin-auth.mjs";
import { openDatabase } from "./db.mjs";

const [action, value] = process.argv.slice(2);
const database = process.env.ABORDER_CONTROL_DB ?? "data/control.sqlite";
try {
  if (action === "init-key" && value) {
    const path = resolve(value);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
  } else if (action === "public-key" && value) {
    process.stdout.write(createPublicKey(readFileSync(value)).export({ type: "spki", format: "pem" }));
  } else if (action === "init-admin" && value) {
    if (process.stdin.isTTY && !process.env.ABORDER_ADMIN_PASSWORD_FILE) throw new Error("Pipe a password from a protected file or set ABORDER_ADMIN_PASSWORD_FILE.");
    const password = readFileSync(process.env.ABORDER_ADMIN_PASSWORD_FILE ?? 0, "utf8").replace(/\r?\n$/, "");
    const db = openDatabase(database);
    try { configureAdmin(db, value, password); } finally { db.close(); }
    console.log("Administrator password configured. Previous sessions were cleared.");
  } else if (action === "backup" && value) {
    const path = resolve(value);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Reserve a new file with restrictive permissions. Existing backups survive.
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const db = openDatabase(database);
    try { await backup(db, path); } finally { db.close(); }
    console.log("Consistent SQLite backup created.");
  } else {
    throw new Error("Usage: cli.mjs init-key <new-file> | public-key <key-file> | init-admin <username> | backup <new-file>");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
