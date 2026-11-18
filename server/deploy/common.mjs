import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const paths = Object.freeze({ root: "/opt/aborder-server", releases: "/opt/aborder-server/releases",
  current: "/opt/aborder-server/current", env: "/etc/aborder-server/server.env", backups: "/var/backups/aborder-server",
  data: "/var/lib/aborder-server", cache: "/var/cache/aborder-server/next", lock: "/run/lock/aborder-server-operation" });
export const units = ["aborder-server-app.service", "aborder-server-worker.service"];
export function sha256(filename) {
  const fd = fs.openSync(filename, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let length;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, length));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
export function insist(ok, message) { if (!ok) throw new Error(message); }
export function parseEnvironment(text) {
  const result = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    insist(match && !Object.hasOwn(result, match[1]), "Invalid or duplicate environment entry.");
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error("Use simple JSON-quoted environment values."); }
      // Avoid divergent systemd/dotenv escaping semantics.
      insist(typeof value === "string" && !/[\r\n\x00\\]/.test(value), "Unsupported environment escape.");
    } else insist(!/[\s'"\\#]/.test(value), "Quote values containing whitespace or special characters.");
    result[match[1]] = value;
  }
  return result;
}
export function privateFile(filename) {
  const stat = fs.lstatSync(filename);
  insist(stat.isFile() && stat.uid === 0 && (stat.mode & 0o077) === 0, "Configuration/backup must be a root-owned private regular file.");
}
export function databaseSettings(env) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error("Invalid database configuration."); }
  insist(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.hash && (!url.searchParams.has("schema") || url.searchParams.get("schema") === "public"),
  "Database must use a literal loopback PostgreSQL address and public schema.");
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  insist(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database) && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user), "Invalid database or role name.");
  const port = Number(url.port || 5432);
  insist(Number.isInteger(port) && port > 0 && port <= 65535 && url.password, "Database credentials or port missing.");
  return { host: url.hostname.replace(/[\[\]]/g, ""), port: String(port), database, user, password: decodeURIComponent(url.password) };
}
export function loadEnvironment(filename = paths.env) {
  privateFile(filename);
  const env = parseEnvironment(fs.readFileSync(filename, "utf8"));
  insist(env.ABORDER_HOSTED === "1", "ABORDER_HOSTED=1 is required.");
  insist((env.NEXTAUTH_SECRET || env.AUTH_SECRET || "").length >= 32
    && !/REPLACE|generate-with/i.test(env.NEXTAUTH_SECRET || env.AUTH_SECRET), "Set or preserve the application encryption secret.");
  insist(/^[A-Za-z0-9_-]{43}$/.test(env.ABORDER_CONTROL_INTERNAL_SECRET || ""), "Set the dedicated internal control secret.");
  const origin = new URL(env.NEXTAUTH_URL);
  insist(origin.protocol === "https:" && origin.href === origin.origin + "/", "Set the public HTTPS application origin.");
  insist(["http://127.0.0.1:18086", "http://[::1]:18086"].includes(env.ABORDER_CONTROL_INTERNAL_URL), "Control API must use the dedicated loopback port.");
  insist(!env.NODE_OPTIONS && !env.LD_PRELOAD && !env.LD_LIBRARY_PATH, "Runtime injection overrides are not supported.");
  databaseSettings(env);
  return env;
}
export function validateMigrations(rows, expected, exact = false) {
  const names = new Map(expected.map(row => [row.name, row.sha256]));
  const applied = new Map();
  for (const row of rows) {
    if (row.rolledBack) continue;
    insist(row.finished, "An unfinished database migration requires manual recovery.");
    insist(names.get(row.name) === row.checksum, "Release does not match an applied database migration.");
    applied.set(row.name, row.checksum);
  }
  if (exact) insist(applied.size === names.size, "Program rollback requires exactly the same applied migration set.");
  return [...applied].sort(([a], [b]) => a.localeCompare(b));
}
export function verifyBundle(directory, checkRuntime = true) {
  const root = fs.realpathSync(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "server-bundle.json"), "utf8"));
  insist(manifest.v === 1 && /^\d+\.\d+\.\d+$/.test(manifest.version) && Array.isArray(manifest.files)
    && Array.isArray(manifest.migrations), "Invalid bundle manifest.");
  if (checkRuntime) {
    insist(process.platform === "linux" && process.arch === "x64" && process.versions.node.split(".")[0] === "24"
      && manifest.runtime?.platform === "linux" && manifest.runtime?.arch === "x64" && manifest.runtime?.nodeMajor === 24,
    "Linux x64 Node 24 is required.");
    const hostGlibc = process.report.getReport().header.glibcVersionRuntime;
    const version = value => String(value || "0.0").split(".").map(Number).slice(0, 2);
    const [major, minor] = version(hostGlibc), [requiredMajor, requiredMinor] = version(manifest.runtime.glibcMinimum);
    insist(hostGlibc && (major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)), "Host glibc is older than the Linux bundle.");
  }
  const expected = new Set(["server-bundle.json"]);
  for (const entry of manifest.files) {
    insist(typeof entry.path === "string" && entry.path.length > 0 && !entry.path.startsWith("/")
      && !entry.path.includes("\\") && entry.path.split("/").every(part => part && part !== "." && part !== "..")
      && !expected.has(entry.path), "Unsafe or duplicate manifest path.");
    expected.add(entry.path);
    const filename = path.join(root, entry.path);
    const stat = fs.lstatSync(filename);
    if (Object.hasOwn(entry, "link")) {
      insist(stat.isSymbolicLink() && fs.readlinkSync(filename) === entry.link
        && fs.realpathSync(filename).startsWith(root + path.sep), "Invalid bundle symlink.");
    } else insist(stat.isFile() && sha256(filename) === entry.sha256, "Bundle file checksum mismatch.");
  }
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative))) {
      const entry = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(root, entry));
      if (entry === "app/.next/cache" && stat.isSymbolicLink() && fs.readlinkSync(path.join(root, entry)) === paths.cache) continue;
      if (stat.isDirectory()) walk(entry);
      else insist(expected.has(entry), "Unexpected file in immutable release.");
    }
  }
  walk("");
  for (const required of ["app/server.js", "app/worker.cjs", "app/node_modules/prisma/build/index.js", "app/prisma/schema.prisma", "server/deploy/service.mjs"]) {
    insist(expected.has(required), "Incomplete server bundle.");
  }
  for (const migration of manifest.migrations) {
    insist(/^[A-Za-z0-9_-]+$/.test(migration.name) && /^[a-f0-9]{64}$/.test(migration.sha256)
      && sha256(path.join(root, "app/prisma/migrations", migration.name, "migration.sql")) === migration.sha256,
    "Migration manifest checksum mismatch.");
  }
  return manifest;
}
