import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("expanded Compose keeps existing host ports and Docker authority isolated from the hosted project", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aborder-container-config-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("aborder-container-config-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, "config"));
  fs.copyFileSync(fileURLToPath(new URL("../container/compose.yml", import.meta.url)), path.join(directory, "compose.yml"));
  for (const name of ["application.env", "database.env", "control.env"]) fs.writeFileSync(path.join(directory, "config", name), "FIXTURE=true\n");
  const pin = "sha256:" + "a".repeat(64);
  fs.writeFileSync(path.join(directory, "pins.env"), `HOSTED_APP_IMAGE=${pin}\nHOSTED_CONTROL_IMAGE=${pin}\nHOSTED_POSTGRES_IMAGE=${pin}\n`);
  const output = execFileSync("docker", ["compose", "--project-directory", directory, "--env-file", path.join(directory, "pins.env"),
    "--profile", "tools", "-f", path.join(directory, "compose.yml"), "config", "--format", "json"],
  { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const config = JSON.parse(output);
  assert.equal(config.name, "aborder-hosted");
  assert.deepEqual(config.services.database.ports, undefined);
  assert.equal(config.services.app.network_mode, "service:control");
  assert.equal(config.services.worker.network_mode, "service:control");
  assert.deepEqual(config.services.control.ports.map(port => [port.host_ip, port.published]).sort(), [["127.0.0.1", "18085"], ["127.0.0.1", "18330"]]);
  assert.equal(config.services.control.environment.ABORDER_CONTROL_INTERNAL_BIND, "127.0.0.1");
  assert.notEqual(config.networks.business.internal, true);
  assert.ok(config.services.app.mem_limit <= 768 * 1024 * 1024);
  assert.ok(config.services.worker.mem_limit <= 1024 * 1024 * 1024);
  assert.ok(config.services.database.mem_limit <= 512 * 1024 * 1024);
  for (const name of ["control", "app", "worker", "tooling", "control-tools"]) {
    const mounts = config.services[name].tmpfs;
    assert.ok(Array.isArray(mounts), `${name} tmpfs must be an array`);
    assert.equal(mounts.length, 1, `${name} must not split tmpfs options into separate mounts`);
    assert.equal(typeof mounts[0], "string");
    assert.match(mounts[0], /^\/tmp:rw,nosuid,nodev,size=(64|128)m$/, `${name} must preserve the absolute /tmp path and complete options`);
  }
  for (const service of Object.values(config.services)) {
    assert.notEqual(service.privileged, true);
    assert.notEqual(service.network_mode, "host");
    assert.equal((service.volumes || []).some(volume => String(volume.source).includes("docker.sock")), false);
  }
  for (const volume of Object.values(config.volumes)) assert.notEqual(volume.external, true);
  for (const name of ["app", "worker"]) {
    assert.equal(config.services[name].read_only, true);
    assert.deepEqual(config.services[name].cap_drop, ["ALL"]);
  }
});
