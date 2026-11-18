import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("starts the HTTP service through a versioned-release directory symlink", { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-entrypoint-"));
  const current = path.join(directory, "current");
  let linked = false;
  let child;
  let exited;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    if (linked) unlinkSync(current);
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-entrypoint-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  try {
    symlinkSync(fileURLToPath(new URL("../../", import.meta.url)), current, process.platform === "win32" ? "junction" : "dir");
    linked = true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Directory links are unavailable in this environment.");
      return;
    }
    throw error;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(directory, "signing.pem");
  writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  const internalReservation = createServer();
  await new Promise(resolve => internalReservation.listen(0, "127.0.0.1", resolve));
  const internalPort = internalReservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await new Promise(resolve => internalReservation.close(resolve));
  const internalSecret = randomBytes(32).toString("base64url");
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(current, "control-plane", "server.mjs")], {
    env: {
      ...process.env,
      ABORDER_CONTROL_ORIGIN: origin,
      ABORDER_CONTROL_ISSUER: "https://original-management.example.test",
      ABORDER_CONTROL_ALLOW_HTTP_LOOPBACK: "1",
      ABORDER_CONTROL_BIND: "127.0.0.1",
      ABORDER_CONTROL_PORT: String(port),
      ABORDER_CONTROL_SIGNING_KEY_FILE: keyFile,
      ABORDER_CONTROL_SIGNING_KID: "entrypoint-test",
      ABORDER_CONTROL_LEASE_SECONDS: "900",
      ABORDER_CONTROL_DB: path.join(directory, "control.sqlite"),
      ABORDER_CONTROL_INTERNAL_BIND: "127.0.0.1",
      ABORDER_CONTROL_INTERNAL_PORT: String(internalPort),
      ABORDER_CONTROL_INTERNAL_SECRET: internalSecret,
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  exited = new Promise(resolve => child.once("close", resolve));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("control plane listening")) resolve();
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Server exited before listening (${code}): ${stderr}`)));
  });
  const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const internalResponse = await fetch(`http://127.0.0.1:${internalPort}/internal/v1/workbench/account-policy`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + internalSecret },
    body: JSON.stringify({ productId: "a-border-seo", accountId: "missing-account-fixture", backendVersion: "1.5.0" }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(internalResponse.status, 404);
  assert.deepEqual(await internalResponse.json(), { error: "account_not_found" });
});
