import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256, validateMigrations } from "/opt/aborder/server/deploy/common.mjs";

process.umask(0o077);
const command = process.argv[2];
const argument = process.argv[3];
const root = "/opt/aborder";
const manifest = JSON.parse(fs.readFileSync(root + "/server-bundle.json", "utf8"));
const binary = name => "/usr/lib/postgresql/16/bin/" + name;
const insist = (condition, message) => { if (!condition) throw new Error(message); };
let url;
try { url = new URL(process.env.DATABASE_URL); } catch { throw new Error("Invalid private database configuration."); }
insist(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "database" && (!url.port || url.port === "5432")
  && (!url.searchParams.has("schema") || url.searchParams.get("schema") === "public"), "Database must be this project's private database service.");
const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = url.pathname.slice(1);
insist(/^[a-z_][a-z0-9_]{0,62}$/.test(user) && database === "aborder" && password.length >= 16 && user !== "postgres", "Invalid dedicated application database configuration.");
let privateLog;
function execute(program, args, env = {}, input) {
  try { return execFileSync(program, args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (error) {
    if (privateLog) fs.appendFileSync(privateLog, `${path.basename(program)} failed\n${error.stdout || ""}\n${error.stderr || ""}\n`, { mode: 0o600 });
    throw new Error("Database operation failed; inspect the private backup operation log.");
  }
}
function connect(fn, db = database, admin = false) {
  const username = admin ? "postgres" : user;
  const secret = admin ? process.env.POSTGRES_PASSWORD : password;
  insist(typeof secret === "string" && secret.length >= 16, "Database secret is missing.");
  const pgpass = "/tmp/pgpass-" + randomBytes(12).toString("hex");
  const escape = value => value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  fs.writeFileSync(pgpass, ["database", "5432", db, username, secret].map(escape).join(":") + "\n", { mode: 0o600, flag: "wx" });
  try { return fn({ PGHOST: "database", PGPORT: "5432", PGDATABASE: db, PGUSER: username, PGPASSFILE: pgpass, PGCONNECT_TIMEOUT: "10" }); }
  finally { fs.unlinkSync(pgpass); }
}
function sql(query, db = database, admin = false) {
  return connect(env => execute(binary("psql"), ["-X", "-q", "-A", "-t", "--no-password", "-v", "ON_ERROR_STOP=1"], env, query), db, admin);
}
function ledger(db = database) {
  if (sql("SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL", db) !== "t") return [];
  return JSON.parse(sql(`SELECT COALESCE(json_agg(t ORDER BY t.name,t.checksum),'[]'::json) FROM
    (SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS "rolledBack"
    FROM public."_prisma_migrations") t`, db));
}
function destination(value) {
  insist(typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value), "Invalid backup identifier.");
  const target = path.join("/backups", value);
  insist(fs.realpathSync(target) === target && fs.statSync(target).uid === 0, "Use a private prepared backup directory.");
  privateLog = path.join(target, "database-operation.log");
  return target;
}
try {
  if (command === "bootstrap") {
    insist(process.env.POSTGRES_USER === "postgres" && process.env.POSTGRES_DB === database, "Dedicated database initialization mismatch.");
    const exists = sql(`SELECT count(*) FROM pg_roles WHERE rolname='${user}'`, "postgres", true);
    if (exists === "0") {
      insist(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'", database, true) === "0", "Never initialize over an existing business schema.");
      sql(`CREATE ROLE "${user}" LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\nALTER DATABASE "${database}" OWNER TO "${user}";`, "postgres", true);
    }
    insist(sql("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname=current_user") === "f", "Application role must remain unprivileged.");
    console.log("Dedicated application database role verified.");
  } else {
    const version = Number(sql("SHOW server_version_num"));
    insist(version >= 160000 && version < 170000, "PostgreSQL 16 is required.");
    if (command === "check-control") {
      insist(process.env.ABORDER_CONTROL_INTERNAL_URL === "http://127.0.0.1:18086", "Internal control must remain on loopback.");
      const response = await fetch("http://127.0.0.1:18086/internal/v1/workbench/account-policy", { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.ABORDER_CONTROL_INTERNAL_SECRET },
        body: JSON.stringify({ productId: "a-border-seo", accountId: "deployment-probe-" + randomBytes(16).toString("hex"), backendVersion: manifest.version }),
        signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      insist(response.status === 404 && body.error === "account_not_found", "Internal control secret/route verification failed.");
      console.log("Shared-namespace internal management API verified.");
    } else if (command === "check") {
      validateMigrations(ledger(), manifest.migrations, argument === "exact");
      console.log("Application migration compatibility verified.");
    } else if (command === "ledger") console.log(JSON.stringify(ledger()));
    else if (command === "backup") {
      const target = destination(argument);
      const storage = fs.statfsSync(target), bytes = Number(sql("SELECT pg_database_size(current_database())"));
      insist(Number(storage.bavail) * Number(storage.bsize) >= Math.max(bytes * 1.5, 256 * 1024 * 1024), "Insufficient free backup storage.");
      const file = path.join(target, "database.dump");
      insist(!fs.existsSync(file), "Backup dump already exists.");
      connect(env => execute(binary("pg_dump"), ["--format=custom", "--no-password", "--no-owner", "--no-acl", "--file", file], env));
      execute(binary("pg_restore"), ["--list", file]);
      fs.writeFileSync(path.join(target, "database-backup.json"), JSON.stringify({ v: 1, version: manifest.version,
        sha256: sha256(file), migrations: ledger(), postgresVersion: version }) + "\n", { mode: 0o600 });
      console.log("Business dump and migration history verified.");
    } else if (command === "migrate") {
      destination(argument);
      validateMigrations(ledger(), manifest.migrations);
      execute("/usr/local/bin/node", [root + "/app/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", root + "/app/prisma/schema.prisma"], process.env);
      validateMigrations(ledger(), manifest.migrations, true);
      console.log("Business migrations verified.");
    } else if (command === "restore") {
      const target = destination(argument), name = process.argv[4];
      insist(/^aborder_restore_[a-z0-9_]{1,40}$/.test(name || ""), "Restore only to a new aborder_restore_* database.");
      const saved = JSON.parse(fs.readFileSync(path.join(target, "database-backup.json"), "utf8"));
      const file = path.join(target, "database.dump");
      insist(saved.v === 1 && sha256(file) === saved.sha256, "Backup checksum mismatch.");
      // CREATE DATABASE rejects an existing name. Never clean/drop or overwrite.
      sql(`CREATE DATABASE "${name}" OWNER "${user}";`, "postgres", true);
      connect(env => execute(binary("pg_restore"), ["--exit-on-error", "--no-password", "--no-owner", "--no-acl", "--dbname", name, file], env), name);
      insist(JSON.stringify(ledger(name)) === JSON.stringify(saved.migrations), "Restored migration history mismatch.");
      console.log("Restored isolated database: " + name + "; no service/configuration cutover performed.");
    } else throw new Error("Unknown database operation.");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
