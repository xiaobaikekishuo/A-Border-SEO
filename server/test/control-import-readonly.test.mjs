import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("control import validates a WAL-mode snapshot from an actually read-only bind without modifying the source", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aborder-readonly-import-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("aborder-readonly-import-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const imported = path.join(root, "import"), data = path.join(root, "data");
  fs.mkdirSync(imported); fs.mkdirSync(data);
  const filename = path.join(imported, "control.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=4; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('preserve-snapshot');");
  db.close();
  assert.deepEqual(fs.readdirSync(imported), ["control.sqlite"]);
  const original = fs.readFileSync(filename);
  // SQLite header offsets 18/19 contain write/read format 2 for WAL mode.
  assert.equal(original[18], 2); assert.equal(original[19], 2);
  const digest = createHash("sha256").update(original).digest("hex");
  const script = fileURLToPath(new URL("../container/control-backup.mjs", import.meta.url));
  const slash = value => value.replaceAll("\\", "/");
  const common = ["--context", "desktop-linux", "run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--memory", "256m", "--cpus", "0.5",
    "--mount", `type=bind,src=${slash(imported)},dst=/import,readonly`,
    "--mount", `type=bind,src=${slash(data)},dst=/data`,
    "--mount", `type=bind,src=${slash(script)},dst=/tools/control-backup.mjs,readonly`,
    "--entrypoint", "node", "node:24-bookworm-slim"];
  const run = args => execFileSync("docker", [...common, ...args], { encoding: "utf8", timeout: 30_000,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  run(["--input-type=module", "-e", `import fs from 'node:fs';
    try { fs.writeFileSync('/import/must-not-write', 'test'); process.exit(2); }
    catch (error) { if (error.code !== 'EROFS') throw error; }`]);
  const result = run(["/tools/control-backup.mjs", "import", digest]);
  assert.match(result, /snapshot imported/);
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.deepEqual(fs.readdirSync(imported), ["control.sqlite"]);
  assert.equal(createHash("sha256").update(fs.readFileSync(path.join(data, "control.sqlite"))).digest("hex"), digest);
  const restored = new DatabaseSync(path.join(data, "control.sqlite"));
  try {
    assert.equal(restored.prepare("PRAGMA user_version").get().user_version, 4);
    assert.equal(restored.prepare("SELECT value FROM fixture").get().value, "preserve-snapshot");
  } finally { restored.close(); }
});
