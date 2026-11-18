#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insist, paths, units } from "./common.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--run") {
  console.log("Usage: sudo node server/deploy/install.mjs --run");
  console.log("Creates the service identity/directories and installs units; does not install PostgreSQL, modify env, start services or migrate data.");
  process.exit(process.argv.length > 2 ? 1 : 0);
}
insist(process.platform === "linux" && process.getuid() === 0 && process.versions.node.split(".")[0] === "24", "Run as root using Linux Node 24.");
function run(command, args) { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
let exists = false;
try { run("id", ["-u", "aborder-server"]); exists = true; } catch { /* Create only the dedicated account. */ }
if (!exists) run("useradd", ["--system", "--user-group", "--home-dir", paths.data, "--no-create-home", "--shell", "/usr/sbin/nologin", "aborder-server"]);
const uid = Number(run("id", ["-u", "aborder-server"]));
const gid = Number(run("id", ["-g", "aborder-server"]));
insist(uid > 0 && gid > 0 && /:(?:\/usr)?\/sbin\/nologin$/.test(run("getent", ["passwd", "aborder-server"])), "Existing service account must be unprivileged with no login shell.");
for (const [directory, mode, owner] of [[paths.root, 0o755, false], [paths.releases, 0o755, false],
  [path.dirname(paths.env), 0o700, false], [paths.backups, 0o700, false], [paths.data, 0o700, true],
  [path.dirname(paths.cache), 0o755, false], [paths.cache, 0o700, true]]) {
  fs.mkdirSync(directory, { recursive: true, mode });
  insist(fs.realpathSync(directory) === directory, "Refusing an unexpected service directory symlink.");
  fs.chownSync(directory, owner ? uid : 0, owner ? gid : 0);
  fs.chmodSync(directory, mode);
}
const directory = fileURLToPath(new URL("./", import.meta.url));
for (const unit of [...units, "aborder-server-backup.service", "aborder-server-backup.timer"]) {
  const target = path.join("/etc/systemd/system", unit);
  if (fs.existsSync(target)) insist(fs.readFileSync(target, "utf8") === fs.readFileSync(path.join(directory, unit), "utf8"),
    "Existing systemd unit differs; review it before replacing.");
  else fs.copyFileSync(path.join(directory, unit), target);
  fs.chmodSync(target, 0o644);
}
run("systemctl", ["daemon-reload"]);
console.log("Service directories and units prepared. Create the private environment and existing PostgreSQL 16 database before deployment.");
