#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseSettings, insist, loadEnvironment, paths, privateFile, sha256, units, validateMigrations, verifyBundle } from "./common.mjs";
import { restorePreviousRelease, startReleaseServices } from "./lifecycle.mjs";

const args = process.argv.slice(2);
const command = args[0];
if (!args.includes("--run") || !["deploy", "rollback", "backup", "restore"].includes(command)) {
  console.log("Usage (root, Linux): node manage.mjs deploy ARCHIVE SHA256 --run");
  console.log("  node manage.mjs rollback /opt/aborder-server/releases/RELEASE --run");
  console.log("  node manage.mjs backup --run");
  console.log("  node manage.mjs restore BACKUP_DIRECTORY aborder_restore_NAME --run");
  process.exit(args.length ? 1 : 0);
}
insist(process.platform === "linux" && process.getuid() === 0, "Run as root on the target Linux host.");
process.umask(0o077);
const values = args.slice(1).filter(value => value !== "--run");
insist(values.length === ({ deploy: 2, rollback: 1, backup: 0, restore: 2 })[command], "Unexpected command arguments.");
for (const directory of [paths.root, paths.releases, paths.backups]) {
  insist(fs.realpathSync(directory) === directory && fs.statSync(directory).uid === 0, "Prepare canonical root-owned service directories first.");
}
fs.mkdirSync(paths.lock, { mode: 0o700 });
fs.writeFileSync(path.join(paths.lock, "pid"), String(process.pid), { mode: 0o600 });
let logFile;
function run(program, argv, env = {}, allowFailure = false) {
  try {
    return execFileSync(program, argv, { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (logFile) fs.appendFileSync(logFile, `${path.basename(program)} failed\n${error.stdout || ""}\n${error.stderr || ""}\n`, { mode: 0o600 });
    if (allowFailure) return null;
    throw new Error(`${path.basename(program)} failed; inspect the private operation log.`);
  }
}
function pgProgram(env, name) {
  const directory = env.ABORDER_PG_BIN || "/usr/lib/postgresql/16/bin";
  insist(path.isAbsolute(directory) && !directory.includes("\n"), "Invalid PostgreSQL client path.");
  return path.join(directory, name);
}
function withDatabase(env, fn, database) {
  const connection = databaseSettings(env);
  const filename = path.join(paths.backups, `.pgpass-${process.pid}-${randomBytes(6).toString("hex")}`);
  const escape = value => String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  fs.writeFileSync(filename, [connection.host, connection.port, database || connection.database, connection.user, connection.password]
    .map(escape).join(":") + "\n", { mode: 0o600, flag: "wx" });
  try { return fn({ PGHOST: connection.host, PGPORT: connection.port, PGUSER: connection.user,
    PGDATABASE: database || connection.database, PGPASSFILE: filename, PGCONNECT_TIMEOUT: "10", PGSSLMODE: "disable" }); }
  finally { fs.unlinkSync(filename); }
}
function sql(env, query, database) {
  return withDatabase(env, pg => run(pgProgram(env, "psql"), ["-X", "-q", "-A", "-t", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", query], pg), database);
}
function checkDatabase(env) {
  insist(/^pg_dump \(PostgreSQL\) 16\./.test(run(pgProgram(env, "pg_dump"), ["--version"])), "PostgreSQL 16 client tools are required.");
  const version = Number(sql(env, "SHOW server_version_num"));
  insist(version >= 160000 && version < 170000, "The business database must run PostgreSQL 16.");
  return version;
}
function ledger(env, database) {
  if (sql(env, "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL", database) !== "t") return [];
  return JSON.parse(sql(env, `SELECT COALESCE(json_agg(t ORDER BY t.name, t.checksum), '[]'::json) FROM
    (SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS "rolledBack" FROM public."_prisma_migrations") t`, database));
}
function currentRelease() {
  try {
    insist(fs.lstatSync(paths.current).isSymbolicLink(), "Current release pointer must be a symlink.");
    const release = fs.realpathSync(paths.current);
    insist(path.dirname(release) === paths.releases, "Current release escaped its managed directory.");
    return release;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function newBackup(env, label = "backup") {
  const destination = path.join(paths.backups, new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex"));
  fs.mkdirSync(destination, { mode: 0o700 });
  logFile = path.join(destination, "operation.log");
  fs.writeFileSync(logFile, label + "\n", { mode: 0o600 });
  const serverVersion = checkDatabase(env);
  const databaseBytes = Number(sql(env, "SELECT pg_database_size(current_database())"));
  const storage = fs.statfsSync(paths.backups);
  insist(Number.isFinite(databaseBytes) && Number(storage.bavail) * Number(storage.bsize) >= Math.max(256 * 1024 * 1024, databaseBytes * 1.5),
    "Insufficient free backup disk space; do not start a database migration.");
  const dump = path.join(destination, "database.dump");
  withDatabase(env, pg => run(pgProgram(env, "pg_dump"), ["--no-password", "--format=custom", "--no-owner", "--no-acl", "--file", dump], pg));
  run(pgProgram(env, "pg_restore"), ["--list", dump]);
  fs.copyFileSync(paths.env, path.join(destination, "server.env"));
  fs.chmodSync(path.join(destination, "server.env"), 0o600);
  const manifest = { v: 1, createdAt: new Date().toISOString(), database: databaseSettings(env).database,
    postgresVersion: serverVersion, release: currentRelease(), migrations: ledger(env),
    dumpSha256: sha256(dump), environmentSha256: sha256(path.join(destination, "server.env")) };
  fs.writeFileSync(path.join(destination, "backup.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(destination, "COMPLETE"), "Verified custom-format dump and private environment backup.\n", { mode: 0o600 });
  console.log("Backup verified: " + destination);
  return destination;
}
function setRelease(release) {
  const temporary = path.join(paths.root, "current.next-" + randomBytes(5).toString("hex"));
  currentRelease(); // reject an unexpected regular file or escaped pointer
  fs.symlinkSync(release, temporary);
  fs.renameSync(temporary, paths.current);
}
function stop() { run("systemctl", ["stop", units[1]]); run("systemctl", ["stop", units[0]]); }
async function checkControl(env, version) {
  try {
    const response = await fetch(new URL("/internal/v1/workbench/account-policy", env.ABORDER_CONTROL_INTERNAL_URL), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.ABORDER_CONTROL_INTERNAL_SECRET },
      body: JSON.stringify({ productId: "a-border-seo", accountId: "deployment-probe-" + randomBytes(16).toString("hex"), backendVersion: version }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    insist(response.status === 404 && body.error === "account_not_found", "Internal management verification failed.");
  } catch { throw new Error("Internal management API/secret is not ready; deployment stopped before service shutdown."); }
}
async function healthy(version) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:18330/api/health", { signal: AbortSignal.timeout(3000), redirect: "error" });
      const body = await response.json();
      if (response.ok && body.status === "ok" && body.version === version && body.hostedMode === true) return;
    } catch { /* Poll only the local business service. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("New application did not pass local health/version validation.");
}
async function healthyWorker(since) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pid = run("systemctl", ["show", "--property=MainPID", "--value", units[1]]);
    if (/^[1-9]\d*$/.test(pid)) {
      try {
        const stamp = fs.statSync(`/proc/${pid}/root/tmp/worker-alive`).mtimeMs;
        if (stamp >= since - 1000 && Date.now() - stamp < 40_000) return;
      } catch { /* PrivateTmp health file may not exist during startup. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Worker did not confirm database health.");
}
async function start(release, active = [true, true]) {
  await startReleaseServices(release, active, {
    verifyRelease: verifyBundle,
    resetFailed: selected => run("systemctl", ["reset-failed", ...selected], {}, true),
    startUnit: unit => run("systemctl", ["start", unit]),
    checkApp: healthy,
    checkWorker: healthyWorker,
  });
}
function attachCache(release) {
  const cache = path.join(release, "app/.next/cache");
  if (fs.existsSync(cache)) insist(fs.lstatSync(cache).isSymbolicLink() && fs.readlinkSync(cache) === paths.cache, "Unexpected release cache.");
  else fs.symlinkSync(paths.cache, cache);
}

try {
  const env = loadEnvironment();
  const environmentHash = sha256(paths.env);
  if (command === "backup") newBackup(env);
  else if (command === "restore") {
    const backup = fs.realpathSync(values[0]);
    insist(path.dirname(backup) === paths.backups && fs.existsSync(path.join(backup, "COMPLETE")), "Use a completed backup under the managed backup root.");
    const manifestFile = path.join(backup, "backup.json");
    privateFile(manifestFile);
    const saved = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const oldEnv = loadEnvironment(path.join(backup, "server.env"));
    insist(saved.v === 1 && sha256(path.join(backup, "database.dump")) === saved.dumpSha256
      && sha256(path.join(backup, "server.env")) === saved.environmentSha256, "Backup checksum validation failed.");
    const database = values[1];
    insist(/^aborder_restore_[a-z0-9_]{1,40}$/.test(database) && database !== databaseSettings(env).database,
      "Restore only into a NEW aborder_restore_* database.");
    checkDatabase(oldEnv);
    const connection = databaseSettings(oldEnv);
    // Creation requires the local PostgreSQL administrator, never elevated
    // privileges on the normal application database role.
    run("runuser", ["-u", "postgres", "--", pgProgram(oldEnv, "createdb"), "-p", connection.port,
      "--owner", connection.user, "--", database]);
    withDatabase(oldEnv, pg => run(pgProgram(oldEnv, "pg_restore"), ["--no-password", "--exit-on-error", "--no-owner", "--no-acl",
      "--dbname", database, path.join(backup, "database.dump")], pg), database);
    insist(JSON.stringify(ledger(oldEnv, database)) === JSON.stringify(saved.migrations), "Restored migration ledger mismatch.");
    console.log("Restored and verified NEW database: " + database);
    console.log("Current services and configuration were not switched. Review the saved encryption secret and release before an explicit cutover.");
  } else {
    let release;
    if (command === "deploy") {
      const archive = fs.realpathSync(values[0]);
      insist(/^[a-f0-9]{64}$/.test(values[1]) && sha256(archive) === values[1], "Archive checksum mismatch.");
      release = path.join(paths.releases, "bundle-" + values[1].slice(0, 20));
      if (!fs.existsSync(release)) run("python3", [fileURLToPath(new URL("extract-safe.py", import.meta.url)), archive, release]);
    } else {
      release = fs.realpathSync(values[0]);
      insist(path.dirname(release) === paths.releases, "Rollback target must be an immutable managed release.");
    }
    const manifest = verifyBundle(release);
    checkDatabase(env);
    await checkControl(env, manifest.version);
    const before = ledger(env);
    validateMigrations(before, manifest.migrations, command === "rollback");
    const previous = currentRelease();
    if (previous) verifyBundle(previous);
    attachCache(release);
    const active = units.map(unit => run("systemctl", ["is-active", unit], {}, true) === "active");
    let backup;
    let migrationStarted = false;
    try {
      stop();
      backup = newBackup(env, command + " " + manifest.version);
      insist(sha256(paths.env) === environmentHash, "Configuration changed during deployment; review before migrating.");
      if (command === "deploy") {
        migrationStarted = true;
        run("runuser", ["-u", "aborder-server", "--", "/usr/bin/node", path.join(release, "app/node_modules/prisma/build/index.js"),
          "migrate", "deploy", "--schema", path.join(release, "app/prisma/schema.prisma")],
        { ...env, HOME: paths.data, NODE_ENV: "production" });
      }
      validateMigrations(ledger(env), manifest.migrations, true);
      setRelease(release);
      await start(release);
      insist(sha256(paths.env) === environmentHash, "Configuration changed during deployment; verification failed.");
      run("systemctl", ["enable", ...units, "aborder-server-backup.timer"]);
      run("systemctl", ["start", "aborder-server-backup.timer"]);
      console.log(`Hosted release ${manifest.version} passed application and worker checks. Backup: ${backup}`);
    } catch (error) {
      if (backup) stop();
      if (backup) console.error("Recovery backup: " + backup);
      let restored;
      try {
        restored = await restorePreviousRelease({ previous, active, environmentHash, beforeMigrations: before, migrationStarted,
          readEnvironmentHash: () => sha256(paths.env), readMigrations: () => ledger(env),
          switchRelease: setRelease, startRelease: start });
      } catch (recoveryError) {
        stop();
        throw recoveryError;
      }
      if (restored) {
        console.error("Deployment failed; unchanged database and configuration permitted restoration of the prior running services.");
      } else {
        console.error("Deployment failed; services remain stopped. Database/configuration were not overwritten.");
      }
      throw error;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.unlinkSync(path.join(paths.lock, "pid"));
  fs.rmdirSync(paths.lock);
}
