import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("hosted deploy and rollback recover only previously running services when a backup cannot finish", () => {
  const server = path.resolve(fileURLToPath(new URL("..", import.meta.url))).replaceAll("\\", "/");
  // No Docker socket, network, host configuration or writable host mount is provided to the fixture.
  const output = execFileSync("docker", ["--context", "desktop-linux", "run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/www:rw,nosuid,nodev,size=16m", "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=4m",
    "--mount", `type=bind,src=${server},dst=/fixture,readonly`,
    "--entrypoint", "bash", "node:24-bookworm-slim", "/fixture/test/fixtures/upgrade-backup.sh"],
  { encoding: "utf8", windowsHide: true, timeout: 90000 });
  assert.match(output, /upgrade backup recovery scenarios passed/);
});
