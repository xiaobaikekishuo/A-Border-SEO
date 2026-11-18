import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The original database is only read by pg_dump. No app or worker is started.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reports = path.join(root, "reports");
const sourceContainer = "aborder-seo-local-db-1";
const context = "desktop-linux";
const docker = "docker";
const mode = process.argv[2];
if (!["--snapshot", "--verify", "--compare-bundle"].includes(mode)) {
  console.log("Usage: node scripts/rehearse-hosted-migration.mjs --snapshot | --verify <private-report-directory> <server-bundle.tar.gz> | --compare-bundle <private-report-directory> <final-server-bundle.tar.gz>");
  process.exit(0);
}
const runId = mode === "--snapshot" ? Date.now().toString(36) + randomBytes(4).toString("hex") : null;
const directory = mode === "--snapshot" ? path.join(reports, "migration-rehearsal-" + runId) : path.resolve(process.argv[3] ?? "");
assert(path.dirname(directory) === reports && /^migration-rehearsal-[a-z0-9]+$/.test(path.basename(directory)), "Invalid private report directory");
const reportFile = path.join(directory, "report.json");
const dumpFile = path.join(directory, "original.dump");
let report;

function privateDirectory() {
  assert.equal(process.platform, "win32", "This snapshot workflow requires Windows private ACLs");
  mkdirSync(directory, { recursive: true });
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
  assert(/^S-1-5-[0-9-]+$/.test(sid));
  execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "pipe", windowsHide: true });
  const quoted = directory.replaceAll("'", "''");
  const access = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; @([System.IO.Directory]::GetAccessControl('${quoted}').GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) | ConvertTo-Json -Compress`],
  { encoding: "utf8", windowsHide: true }));
  assert(Array.isArray(access) && access.includes(sid) && access.includes("S-1-5-18") && access.every(value => [sid, "S-1-5-18"].includes(value)), "Private ACL verification failed");
}
privateDirectory();

function save() { writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
function check(label) { report.checks.push(label); save(); console.log("PASS " + label); }
async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
function command(args, { input, inputFile, outputFile, errorFile, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, ["--context", context, ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let settled = false;
    const sink = outputFile ? createWriteStream(outputFile, { flags: "wx", mode: 0o600 }) : null;
    if (sink) child.stdout.pipe(sink); else child.stdout.on("data", chunk => { stdout += chunk; });
    const errorSink = errorFile ? createWriteStream(errorFile, { flags: "a", mode: 0o600 }) : null;
    if (errorSink) child.stderr.pipe(errorSink); else child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); finish(new Error("isolated_database_operation_timeout")); }, timeout);
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    }
    child.once("error", () => finish(new Error("docker_unavailable")));
    child.once("exit", code => {
      if (code !== 0) return finish(new Error("isolated_database_operation_failed_" + code));
      if (sink && !sink.writableFinished) sink.once("finish", () => finish()); else finish();
    });
    sink?.once("error", () => { child.kill(); finish(new Error("private_backup_write_failed")); });
    child.stdin.on("error", () => {});
    if (inputFile) createReadStream(inputFile).pipe(child.stdin); else child.stdin.end(input);
  });
}
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';

if (mode === "--snapshot") {
  report = { v: 1, runId, sourceContainer, startedAt: new Date().toISOString(), stage: "snapshot", checks: [], cleanup: [],
    privateAcl: "current-user-and-SYSTEM-only", originalDatabaseModified: false, businessServicesStarted: false };
  save();
  try {
    assert.equal((await command(["inspect", "--format", "{{.State.Status}}", sourceContainer])).trim(), "running");
    check("Original PostgreSQL is running; private Windows ACL verified");
    const partial = dumpFile + ".partial";
    await command(["exec", sourceContainer, "sh", "-c",
      'exec pg_dump -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --format=custom --no-owner --no-acl'], { outputFile: partial });
    assert(statSync(partial).size > 1024, "Empty database backup");
    renameSync(partial, dumpFile);
    report.backup = { file: "original.dump", bytes: statSync(dumpFile).size, sha256: await hashFile(dumpFile), consistentSnapshot: "pg_dump MVCC snapshot" };
    report.stage = "snapshot_ready"; check("Read-only consistent pg_dump snapshot saved and SHA-256 recorded");
    console.log("PRIVATE_REPORT " + reportFile);
  } catch (error) {
    report.stage = "snapshot_failed"; report.error = error instanceof assert.AssertionError ? "snapshot_assertion_failed" : error.message;
    save(); console.error(report.error); process.exitCode = 1;
  }
} else if (mode === "--compare-bundle") {
  report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert(report.pass === true && report.bundle?.path && report.v === 1, "A completed rehearsal is required");
  const finalBundle = path.resolve(process.argv[4] ?? "");
  const comparison = JSON.parse(execFileSync("python", [path.join(root, "scripts/migration-bundle-fingerprint.py"), report.bundle.path, finalBundle],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }));
  assert.equal(comparison.tested.sha256, report.bundle.sha256, "Tested archive changed");
  report.finalBundleComparison = { ...comparison, checkedAt: new Date().toISOString() }; save();
  assert.equal(comparison.sameMigrationRuntime, true, "Final bundle requires a new migration rehearsal");
  check("Final bundle has the exact tested Prisma CLI dependency closure, schema, migrations and runtime requirements");
  console.log("PRIVATE_REPORT " + reportFile);
} else {
  report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert(report.v === 1 && report.sourceContainer === sourceContainer && /^[a-z0-9]+$/.test(report.runId));
  assert.equal(path.basename(directory), "migration-rehearsal-" + report.runId);
  const bundle = path.resolve(process.argv[4] ?? "");
  assert(existsSync(bundle) && path.extname(bundle) === ".gz", "A built server bundle is required");
  const project = "aborder-migration-" + report.runId;
  const dbContainer = project + "-db", migrator = project + "-migrate", network = project + "-network", volume = project + "-pgdata";
  assert([dbContainer, migrator].every(name => name !== sourceContainer));
  const label = "aborder.migration-rehearsal=" + report.runId;
  const resources = [];
  const password = randomBytes(32).toString("base64url");
  const envFile = path.join(directory, "fixture.env");
  writeFileSync(envFile, `POSTGRES_USER=fixture\nPOSTGRES_DB=fixture\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://fixture:${password}@db:5432/fixture\nCHECKPOINT_DISABLE=1\nPRISMA_HIDE_UPDATE_MESSAGE=1\n`, { mode: 0o600 });
  const psql = sql => command(["exec", "-i", dbContainer, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "fixture", "-d", "fixture"], { input: sql });
  const jsonQuery = async sql => JSON.parse((await psql(sql)).trim());
  const fingerprint = async columns => {
    const tables = Object.entries(columns).filter(([name]) => name !== "_prisma_migrations");
    const hashes = tables.map(([name, names]) => `(SELECT jsonb_build_object('table',${literal(name)},'rows',count(*),'sha256',
      encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex')) FROM
      (SELECT encode(sha256(convert_to(to_jsonb(original_row)::text,'UTF8')),'hex') AS digest FROM
      (SELECT ${names.map(identifier).join(",")} FROM ${identifier(name)}) original_row) hashed)`);
    const encryptedFields = { User: ["googleTokens"], Account: ["refresh_token", "access_token", "id_token"],
      ApiKey: ["encryptedLogin", "encryptedPassword"], ChatGptProfile: ["encryptedTokens"],
      ChatGptLoginAttempt: ["encryptedPending"], DesktopOAuthAttempt: ["code"], UserSettings: ["webhookUrl", "webhookSecret"] };
    const encrypted = Object.entries(encryptedFields).flatMap(([table, names]) => names.filter(name => columns[table]?.includes(name)).map(name =>
      `(SELECT jsonb_build_object('table',${literal(table)},'column',${literal(name)},'populated',count(${identifier(name)}),'sha256',
      encode(sha256(convert_to(COALESCE(string_agg(COALESCE(to_jsonb(${identifier(name)})::text,'null'),'' ORDER BY COALESCE(to_jsonb(${identifier(name)})::text,'null')),''),'UTF8')),'hex')) FROM ${identifier(table)})`));
    return jsonQuery(`SELECT jsonb_build_object('tables',jsonb_build_array(${hashes.join(",")}),
      'encryptedFields',jsonb_build_array(${encrypted.join(",")}),
      'identity',jsonb_build_object('managedCount',(SELECT count(*) FROM "ManagedIdentity"),
      'originalIssuerMatches',(SELECT COALESCE(bool_and(issuer='https://aborder.nxitek.cn'),false) FROM "ManagedIdentity"),
      'noOrphanOwners',NOT EXISTS(SELECT 1 FROM "ManagedIdentity" m LEFT JOIN "User" u ON m."userId"=u.id WHERE u.id IS NULL)));`);
  };
  async function cleanup() {
    for (const [kind, name] of resources.reverse()) {
      try {
        assert(name.startsWith(project + "-") && name !== sourceContainer);
        const format = kind === "container" ? '{{index .Config.Labels "aborder.migration-rehearsal"}}' : '{{index .Labels "aborder.migration-rehearsal"}}';
        assert.equal((await command([kind, "inspect", "--format", format, name])).trim(), report.runId, "Fixture ownership mismatch");
        await command(kind === "container" ? ["container", "rm", "-f", name] : [kind, "rm", name]);
        report.cleanup.push({ kind, name, removed: true });
      } catch {
        report.cleanup.push({ kind, name, removed: false }); report.pass = false;
      }
    }
    save();
  }
  report.stage = "restoring"; report.pass = false; report.fixture = { project, network, volume, dbContainer, migrator }; save();
  try {
    assert.equal(await hashFile(dumpFile), report.backup.sha256, "Backup digest changed");
    const postgresImage = (await command(["image", "inspect", "--format", "{{.Id}}", "postgres:16-alpine"])).trim();
    const runtimeImage = (await command(["image", "inspect", "--format", "{{.Id}}", "aborder-server-build-deps:1.5.0"])).trim();
    assert(/^sha256:[a-f0-9]{64}$/.test(postgresImage) && /^sha256:[a-f0-9]{64}$/.test(runtimeImage));
    report.images = { postgresImage, runtimeImage }; report.bundle = { file: path.basename(bundle), path: bundle, sha256: await hashFile(bundle) };
    resources.push(["network", network]); await command(["network", "create", "--internal", "--label", label, network]);
    resources.push(["volume", volume]); await command(["volume", "create", "--label", label, volume]);
    resources.push(["container", dbContainer]);
    await command(["run", "-d", "--pull=never", "--name", dbContainer, "--label", label, "--network", network, "--network-alias", "db",
      "--env-file", envFile, "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, postgresImage]);
    for (let attempt = 0; ; attempt++) {
      try { await psql("SELECT 1;"); break; } catch { if (attempt >= 45) throw new Error("fixture_postgres_not_ready"); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal((await command(["network", "inspect", "--format", "{{.Internal}}", network])).trim(), "true");
    await command(["exec", "-i", dbContainer, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "-U", "fixture", "-d", "fixture"], { inputFile: dumpFile });
    check("Backup restored to a fresh PostgreSQL 16 volume on an internal-only network");
    const columnRows = await jsonQuery(`SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name) ORDER BY table_name,ordinal_position)
      FROM information_schema.columns WHERE table_schema='public';`);
    const columns = {};
    for (const row of columnRows) (columns[row.table] ??= []).push(row.column);
    const baseline = await fingerprint(columns);
    assert(baseline.identity.originalIssuerMatches && baseline.identity.noOrphanOwners, "Original ownership invariant failed");
    writeFileSync(path.join(directory, "before.json"), JSON.stringify({ columns, ...baseline }, null, 2), { mode: 0o600 });
    check("Original snapshot fingerprints captured without printing account or token contents");
    report.stage = "migrating"; save();
    resources.push(["container", migrator]);
    await command(["create", "--pull=never", "--name", migrator, "--label", label, "--network", network, "--env-file", envFile,
      "--mount", `type=bind,source=${bundle},target=/input/server.tar.gz,readonly`, "--entrypoint", "sh", runtimeImage, "-c",
      "mkdir -p /fixture-release && tar -xzf /input/server.tar.gz -C /fixture-release && cd /fixture-release/app && node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma"]);
    const migrationOutput = await command(["start", "-a", migrator], { timeout: 180000, errorFile: path.join(directory, "migration-errors.log") });
    writeFileSync(path.join(directory, "migration-output.log"), migrationOutput, { mode: 0o600 });
    assert.equal((await command(["inspect", "--format", "{{.State.ExitCode}}", migrator])).trim(), "0");
    check("Final server bundle Prisma migration completed without starting business services");
    const after = await fingerprint(columns);
    writeFileSync(path.join(directory, "after.json"), JSON.stringify(after, null, 2), { mode: 0o600 });
    assert.deepEqual(after, baseline, "Original row or encrypted authorization fingerprint changed");
    check("Every original table row, ownership mapping and encrypted authorization field is unchanged");
    const schema = await jsonQuery(`SELECT jsonb_build_object('hostedDeviceTable',to_regclass('public."HostedDevice"') IS NOT NULL,
      'deviceBindings',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='hostedDeviceId'
      AND table_name IN ('Session','Job','ContentPlanJob','AiWorkbenchJob')),
      'sessionBinding',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='Session' AND column_name='hostedBinding'),
      'hostedMigrationApplied',EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261113000000_hosted_workbench' AND finished_at IS NOT NULL AND rolled_back_at IS NULL));`);
    assert.deepEqual(schema, { hostedDeviceTable: true, deviceBindings: 4, sessionBinding: 1, hostedMigrationApplied: true });
    report.schema = schema; report.preservedTables = baseline.tables.length;
    report.originalCounts = Object.fromEntries(baseline.tables.filter(row => ["User", "Site", "ManagedIdentity"].includes(row.table)).map(row => [row.table, row.rows]));
    report.encryptedFieldGroups = baseline.encryptedFields.length;
    assert.equal((await command(["inspect", "--format", "{{.State.Status}}", sourceContainer])).trim(), "running");
    report.pass = true; report.stage = "verified"; check("Hosted schema exists and original database remains running and untouched");
  } catch (error) {
    report.stage = "verification_failed"; report.error = error instanceof assert.AssertionError ? "migration_invariant_failed" : error.message;
    save(); console.error(report.error); process.exitCode = 1;
  } finally {
    await cleanup(); report.finishedAt = new Date().toISOString(); save();
    if (!report.pass) process.exitCode = 1;
    console.log("PRIVATE_REPORT " + reportFile);
  }
}
