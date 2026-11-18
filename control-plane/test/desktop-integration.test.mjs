import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedClient } from "../../desktop/managed-client.mjs";
import * as protocol from "../../source/lib/managed/protocol.mjs";
import { configureAdmin } from "../admin-auth.mjs";
import { openDatabase } from "../db.mjs";
import { createControlPlane } from "../server.mjs";

const features = { jobs: true, codex: true, manus: true, geo: true };
const productId = "a-border-seo";

test("the shipped desktop policy client registers and reports to a real SQLite management service", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-control-integration-"));
  const db = openDatabase(path.join(directory, "fixture.sqlite"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let now = 1_790_000_000;
  const serverConfig = { origin: "http://127.0.0.1", secure: false, leaseSeconds: 900, kid: "fixture", privateKey };
  configureAdmin(db, "integration", "isolated-fixture-password-83");
  const server = createControlPlane({ db, config: serverConfig, clock: () => now,
    verifyRelease: async version => { assert.equal(version, "1.4.0"); } });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  serverConfig.origin += ":" + server.address().port;
  const origin = serverConfig.origin;
  const config = protocol.validateConfig({ serverUrl: origin, issuer: origin, productId,
    keys: { fixture: publicKey.export({ type: "spki", format: "pem" }) } }, { allowHttpLoopback: true });
  let closed = false;
  try {
    const request = (pathname, payload, headers = {}) => fetch(origin + pathname, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(payload),
    });
    const login = await request("/admin/login", { username: "integration", password: "isolated-fixture-password-83" });
    assert.equal(login.status, 200);
    const { csrf } = await login.json();
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const admin = async (action, payload) => {
      const response = await request("/admin/api/" + action,
        { productId, reason: "Isolated desktop integration", ...payload }, { Cookie: cookie, "X-CSRF-Token": csrf });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    let hostedVersion = "1.3.0";
    let rejectSuccess = false;
    const createClient = (name, desktopVersion = "1.3.0") => new ManagedClient({
      protocol, config, file: path.join(directory, name + ".json"), dataRoot: path.join(directory, name),
      desktopVersion, versions: () => ({ backendVersion: hostedVersion }),
      fetcher: (url, options) => {
        if (rejectSuccess && JSON.parse(options.body).code === "update_verified") return new Response(null, { status: 503 });
        return fetch(url, options);
      },
      seal: async value => Buffer.from(value).toString("base64"), open: async value => Buffer.from(value, "base64").toString(),
      onChange() {}, time: () => now,
    });
    const previousClients = [];
    for (const label of ["isolated-a", "isolated-b"]) {
      const account = await admin("accounts", { label, enabled: true, expiresAt: null, deviceLimit: 1, features });
      const { code } = await admin("activation", { accountId: account.id });
      const client = createClient(label);
      await client.activate(code);
      assert.equal(client.snapshot().decision.allowed, true);
      previousClients.push(client);
    }
    const [older] = previousClients;
    // Two isolated application profiles reuse the actual persisted identity on
    // restart. Windows installer/signature checks are exercised by release CI.
    await admin("releases", { version: "1.4.0", channel: "stable", percent: 100, group: "",
      minimumDesktopVersion: null, minimumBackendVersion: null, deadline: null, notes: "Fixture release", paused: false });
    await older.poll({ force: true });
    await older.report("upgrading", "update_installer_started", "1.4.0");
    const health = () => ({ hosted: true, backendVersion: hostedVersion, issue: null, services: { app: "healthy" } });
    const automatic = createClient("isolated-a", "1.4.0");
    const manual = createClient("isolated-b", "1.4.0");
    await Promise.all([automatic.poll({ force: true }), manual.poll({ force: true })]);
    assert.equal(await automatic.observeHostedUpdate(health()), false);
    hostedVersion = "1.4.0";
    assert.equal(await manual.observeHostedUpdate({ ...health(), issue: "hosted_workspace_unavailable" }), false);
    assert.equal(await older.observeHostedUpdate(health()), false);
    assert.equal(await automatic.observeHostedUpdate(health()), true);
    rejectSuccess = true;
    assert.equal(await manual.observeHostedUpdate(health()), false);
    const restarted = createClient("isolated-b", "1.4.0");
    assert.equal(restarted.identity.pendingUpdate?.code, "update_verified");
    rejectSuccess = false;
    assert.equal(await restarted.observeHostedUpdate(health()), true);
    assert.equal(await createClient("isolated-b", "1.4.0").observeHostedUpdate(health()), true);
    const rollout = await fetch(origin + "/admin/api/state", { headers: { Cookie: cookie } }).then(r => r.json());
    assert.equal(rollout.summary.upgrades.succeeded, 2);
    assert.ok(rollout.devices.every(device => device.desktopVersion === "1.4.0" && device.backendVersion === "1.4.0"));
    // Continue the policy scenarios with the current sequences on disk.
    const clients = [automatic, restarted];
    const [first, second] = clients;
    await admin("devices", { installationId: first.snapshot().installationId, group: "test", enabled: false });
    now += 5;
    await Promise.all(clients.map(client => client.poll({ force: true })));
    assert.equal(first.snapshot().decision.reason, "device_disabled");
    assert.equal(second.snapshot().decision.allowed, true);
    await admin("policy", { scope: "product", scopeId: "", disabled: false, maintenance: true,
      startAt: null, endAt: null, message: "fixture maintenance", features });
    await second.poll({ force: true });
    assert.equal(second.snapshot().decision.reason, "maintenance");
    await second.report("draining", "maintenance");
    await second.report("effective", "maintenance");
    const overview = await fetch(origin + "/admin/api/state", { headers: { Cookie: cookie } }).then(response => response.json());
    assert.equal(overview.devices.find(device => device.installationId === second.snapshot().installationId).receiptStatus, "effective");
    await admin("policy", { scope: "product", scopeId: "", disabled: false, maintenance: false,
      startAt: null, endAt: null, message: "", features });
    await Promise.all(clients.map(client => client.poll({ force: true })));
    assert.equal(first.snapshot().decision.reason, "device_disabled");
    assert.equal(second.snapshot().decision.allowed, true);
    const expiry = second.snapshot().expiresAt;
    await new Promise(resolve => server.close(resolve));
    closed = true;
    await second.poll({ force: true });
    assert.equal(second.snapshot().connection, "offline");
    assert.equal(createClient("isolated-b").snapshot().expiresAt, expiry);
    now = expiry;
    assert.equal(createClient("isolated-b").snapshot().decision.reason, "lease_expired");
  } finally {
    if (!closed) await new Promise(resolve => server.close(resolve));
    db.close();
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-control-integration-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
