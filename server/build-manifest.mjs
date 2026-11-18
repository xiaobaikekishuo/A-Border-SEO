import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const { version } = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const hash = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const files = [];
function visit(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    const resolved = path.resolve(path.dirname(absolute), target);
    if (path.isAbsolute(target) || !(resolved === root || resolved.startsWith(root + path.sep))) throw new Error("Escaping bundle symlink.");
    files.push({ path: relative.split(path.sep).join("/"), link: target });
  } else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
  } else if (stat.isFile()) {
    files.push({ path: relative.split(path.sep).join("/"), sha256: hash(absolute), executable: Boolean(stat.mode & 0o111) });
  } else throw new Error("Unsupported bundle file type.");
}
visit("app");
visit("server");
const migrations = fs.readdirSync(path.join(root, "app/prisma/migrations")).sort().filter(name =>
  fs.existsSync(path.join(root, "app/prisma/migrations", name, "migration.sql"))).map(name => ({
  name, sha256: hash(path.join(root, "app/prisma/migrations", name, "migration.sql")),
}));
if (process.platform !== "linux" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("Build on Linux x64 Node 24.");
}
fs.writeFileSync(path.join(root, "server-bundle.json"), JSON.stringify({ v: 1, version,
  runtime: { platform: "linux", arch: "x64", nodeMajor: 24, glibcMinimum: process.report.getReport().header.glibcVersionRuntime,
    opensslMajor: 3, postgresMajor: 16 }, files, migrations }, null, 2) + "\n");
