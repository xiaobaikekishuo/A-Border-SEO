import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { authenticateHosted, hostedStatus, hostedWorkerEnvironment, HostedWorker, revokeHostedSession, validateHostedConfig } from "../hosted-runtime.mjs";

const raw = { schemaVersion: 1, productId: "a-border-seo", workspaceOrigin: "https://aborder.tuitehao.shop" };
const config = validateHostedConfig(raw);
const metadata = { productId: "a-border-seo", installationId: "device-a", accountId: "account-a", desktopVersion: "1.5.0" };
const token = "test_device_token_".padEnd(48, "x");

test("only bundled trusted HTTPS origin is accepted; HTTP loopback is explicit test opt-in", () => {
  assert.equal(config.workspaceOrigin, raw.workspaceOrigin);
  for (const workspaceOrigin of ["https://evil.example", "http://aborder.tuitehao.shop", "https://aborder.tuitehao.shop/other",
    "https://aborder.tuitehao.shop:9443", "https://user@aborder.tuitehao.shop", "https://aborder.tuitehao.shop/?x=1", "https://aborder.nxitek.cn"]) {
    assert.throws(() => validateHostedConfig({ ...raw, workspaceOrigin }), /invalid_hosted_config/);
  }
  assert.throws(() => validateHostedConfig({ ...raw, workspaceOrigin: "http://localhost:9999" }));
  assert.equal(validateHostedConfig({ ...raw, workspaceOrigin: "http://localhost:9999" }, { allowHttpLoopback: true }).workspaceOrigin, "http://localhost:9999");
});

test("device token exchanges directly for an HttpOnly session without entering request URL or body", async () => {
  let calls = 0;
  await authenticateHosted(config, metadata, token, async (url, request) => {
    calls++;
    assert.equal(url, raw.workspaceOrigin + "/api/hosted/session");
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "include");
    assert.equal(request.headers.Authorization, "Bearer " + token);
    assert.deepEqual(JSON.parse(request.body), metadata);
    assert.equal(request.body.includes(token), false);
    return Response.json({ ok: true, hostedMode: true });
  });
  assert.equal(calls, 1);
  await assert.rejects(authenticateHosted(config, metadata, token, async () => Response.json({ ok: true })), /workspace_login_failed/);
  await assert.rejects(authenticateHosted(config, metadata, token, async () => new Response("", { status: 401 })), /user_login_required/);
});

test("server health never manufactures local Docker services or a successful unavailable backend", async () => {
  const worker = { phase: "waiting_login", available: true, signedIn: false };
  const valid = await hostedStatus(config, worker, async () => Response.json({ status: "ok", hostedMode: true, version: "1.5.0" }));
  assert.equal(valid.services.app, "healthy");
  assert.equal(valid.services.db, undefined);
  assert.equal(valid.codex.configured, false);
  for (const body of [{ status: "ok", version: "1.5.0" }, { status: "error", hostedMode: true, version: "1.5.0" }]) {
    const failed = await hostedStatus(config, worker, async () => Response.json(body));
    assert.equal(failed.issue, "hosted_workspace_unavailable");
    assert.equal(failed.services.app, "unavailable");
  }
});

test("logout revokes only the authenticated device and cannot report remote success during an outage", async () => {
  await revokeHostedSession(config, metadata, token, async (url, options) => {
    assert.equal(url, config.workspaceOrigin + "/api/hosted/session");
    assert.equal(options.method, "DELETE"); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), metadata);
    return Response.json({ ok: true });
  });
  await assert.rejects(revokeHostedSession(config, metadata, token, async () => { throw new Error("offline"); }), /workspace_logout_unconfirmed/);
  await assert.rejects(revokeHostedSession(config, metadata, token, async () => Response.json({ ok: false })), /workspace_logout_unconfirmed/);
});

test("worker environment has scoped device identity and excludes inherited secrets", () => {
  const env = hostedWorkerEnvironment(config, metadata, token, path.resolve("test-runtime"), { PATH: "test-bin", OPENAI_API_KEY: "secret", DATABASE_URL: "secret", LOCAL_CONTENT_WORKER_TOKEN: "wrong" });
  assert.equal(env.LOCAL_CONTENT_WORKER_TOKEN, token);
  assert.equal(env.ABORDER_INSTALLATION_ID, metadata.installationId);
  assert.equal(env.ABORDER_DESKTOP_VERSION, metadata.desktopVersion);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("native worker restricts child state, isolates account login directories and stops on logout", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-hosted-worker-"));
  let child, forkOptions;
  const manager = new HostedWorker({ directory, entry: "test-worker.mjs", fork: (_entry, _args, options) => {
    forkOptions = options;
    child = new EventEmitter();
    child.postMessage = message => { assert.equal(message.type, "stop"); queueMicrotask(() => child.emit("exit", 0)); };
    child.kill = () => child.emit("exit", 0);
    return child;
  } });
  try {
    await manager.start(config, metadata, token);
    assert.equal(forkOptions.env.ABORDER_CODEX_HOME, path.join(directory, metadata.accountId, "codex"));
    child.emit("message", { type: "worker-state", phase: "running", available: true, signedIn: true, error: token, token });
    assert.deepEqual(manager.snapshot(), { phase: "running", available: true, signedIn: true, error: null });
    assert.equal(JSON.stringify(manager.snapshot()).includes(token), false);
    await Promise.all([manager.stop(), manager.stop()]);
    assert.equal(manager.process, null);
    assert.equal(manager.snapshot().phase, "stopped");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
