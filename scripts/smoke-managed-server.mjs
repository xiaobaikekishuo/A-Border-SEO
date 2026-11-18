import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ManagedClient } from "../desktop/managed-client.mjs";
import * as protocol from "../source/lib/managed/protocol.mjs";

// This opt-in deployment check creates two clearly labelled, short-lived test
// accounts. It only mutates those accounts/devices, and revokes them afterwards.
// It does not claim local application/worker execution or send effective receipts.
const args = process.argv.slice(2);
if (args[0] !== "--run") {
  console.log("Usage: node scripts/smoke-managed-server.mjs --run [deployment-directory]");
  process.exit(0);
}
const directory = path.resolve(args[1] ?? "reports/deployment-aborder");
const config = protocol.validateConfig(JSON.parse(readFileSync(path.join(directory, "management-config.json"), "utf8").replace(/^\uFEFF/, "")));
const credentials = JSON.parse(readFileSync(path.join(directory, "admin-credentials.json"), "utf8").replace(/^\uFEFF/, ""));
const origin = config.serverUrl;
const productId = config.productId;
const version = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")).version;
const run = new Date().toISOString().replace(/[:.]/g, "-");
const fixtureDirectory = path.join(directory, "smoke-" + run);
mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
const features = Object.fromEntries(protocol.managedFeatures.map(name => [name, true]));
const accounts = [];
const clients = [];
const ownedAccounts = new Set();
const ownedDevices = new Set();
const report = { origin, startedAt: new Date().toISOString(), pass: false, checks: [], accounts: [], devices: [], cleanup: [],
  scope: "Actual desktop ManagedClient module through public HTTPS; no installed desktop GUI or business workers run by this script.",
  simulated: ["Network failure injected into fixture HTTP transport", "Lease expiry advances only the fixture clock"],
};
const check = name => { report.checks.push(name); console.log("PASS " + name); };
let csrf;
let cookie;
let offline = false;
let simulatedNow = null;
const now = () => simulatedNow ?? Math.floor(Date.now() / 1000);
// Fixture identities are encrypted with a per-run in-memory AES key. Their
// credentials cannot be reopened in another process; cleanup revokes devices.
const fixtureKey = randomBytes(32);
const seal = async value => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fixtureKey, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};
const open = async value => {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", fixtureKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
};
const createClient = label => new ManagedClient({
  protocol, config, file: path.join(fixtureDirectory, label + ".json"),
  dataRoot: path.join(fixtureDirectory, label), desktopVersion: version,
  versions: () => ({ backendVersion: null }), seal, open, onChange() {}, time: now,
  fetcher: (url, options) => offline ? Promise.reject(new Error("fixture_network_unavailable")) : fetch(url, options),
});
async function post(route, body, headers = {}) {
  return fetch(origin + route, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
    headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(body) });
}
async function admin(action, body) {
  // Never permit this smoke test to modify an existing account or global policy.
  if (action === "accounts") assert.ok(!body.id || ownedAccounts.has(body.id));
  else if (action === "activation") assert.ok(ownedAccounts.has(body.accountId));
  else if (action === "devices") assert.ok(ownedDevices.has(body.installationId));
  else if (action === "policy") assert.ok(body.scope === "account" && ownedAccounts.has(body.scopeId));
  else throw new Error("smoke_action_not_permitted");
  const response = await post("/admin/api/" + action, { productId,
    reason: "Deployment smoke verification " + run, ...body }, { Cookie: cookie, "X-CSRF-Token": csrf });
  const data = await response.json();
  assert.equal(response.status, 200, action + ": " + (data.error ?? "unexpected_status"));
  return data;
}
async function overview() {
  const response = await fetch(origin + "/admin/api/state?productId=" + encodeURIComponent(productId), {
    redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function pollAll() {
  await Promise.all(clients.map(client => client.poll({ force: true })));
  for (const client of clients) assert.equal(client.snapshot().connection, "online");
}
const accountPolicy = (account, changes = {}) => admin("policy", {
  scope: "account", scopeId: account.id, disabled: false, maintenance: false,
  startAt: null, endAt: null, message: "", features, ...changes,
});
try {
  const health = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(12_000), redirect: "error" });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const denied = await fetch(origin + "/admin/api/state", { signal: AbortSignal.timeout(12_000), redirect: "error" });
  assert.equal(denied.status, 401);
  check("Public HTTPS health and unauthenticated admin denial");
  const login = await post("/admin/login", credentials);
  assert.equal(login.status, 200);
  ({ csrf } = await login.json());
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  const invalidCsrf = await post("/admin/api/accounts", {}, { Cookie: cookie });
  assert.equal(invalidCsrf.status, 403);
  check("Administrator login, secure cookie and CSRF denial");

  for (const label of ["deployment-smoke-a", "deployment-smoke-b"]) {
    const account = await admin("accounts", { label: label + " " + run, enabled: true,
      expiresAt: now() + 3600, deviceLimit: 1, features });
    accounts.push(account);
    ownedAccounts.add(account.id);
    report.accounts.push({ id: account.id, label: account.label });
    const activation = await admin("activation", { accountId: account.id });
    const client = createClient(label);
    clients.push(client);
    await client.activate(activation.code);
    ownedDevices.add(client.snapshot().installationId);
    report.devices.push({ installationId: client.snapshot().installationId, accountId: account.id });
    assert.equal(client.snapshot().connection, "online");
    assert.equal(client.snapshot().decision.allowed, true);
    const sequence = client.identity.sequence;
    await client.activate(activation.code);
    assert.ok(client.identity.sequence > sequence);
    const extra = createClient(label + "-unbound");
    await assert.rejects(extra.activate(activation.code), /invalid_activation/);
    const cappedActivation = await admin("activation", { accountId: account.id });
    await assert.rejects(extra.activate(cappedActivation.code), /device_limit_reached/);
  }
  check("Two accounts, signed activation, same-device retry, cross-device reuse denial and binding limit");
  const [first, second] = clients;
  const firstId = first.snapshot().installationId;
  const initial = await overview();
  for (const client of clients) {
    const device = initial.devices.find(device => device.installationId === client.snapshot().installationId);
    assert.equal(device.receiptStatus, "received");
    assert.equal(device.desktopVersion, version);
    assert.equal(device.backendVersion, null);
    assert.ok(device.lastSeenAt >= now() - 30);
  }
  check("Online/device version visibility and received receipts; backend version honestly unknown");
  await admin("devices", { installationId: firstId, group: "deployment-smoke", enabled: false });
  await pollAll();
  assert.equal(first.snapshot().decision.reason, "device_disabled");
  assert.equal(second.snapshot().decision.allowed, true);
  await admin("devices", { installationId: firstId, group: "deployment-smoke", enabled: true });
  await pollAll();
  assert.equal(first.snapshot().decision.allowed, true);
  check("Per-device disable and recovery with other account unaffected");

  await admin("accounts", { ...accounts[0], enabled: false });
  await pollAll();
  assert.equal(first.snapshot().decision.reason, "account_disabled");
  assert.equal(second.snapshot().decision.allowed, true);
  await admin("accounts", { ...accounts[0], enabled: true });
  await pollAll();
  assert.equal(first.snapshot().decision.allowed, true);
  check("Account disable and recovery with other account unaffected");

  await accountPolicy(accounts[0], { maintenance: true, message: "Isolated deployment verification" });
  await pollAll();
  assert.equal(first.snapshot().decision.reason, "maintenance");
  assert.equal(first.snapshot().decision.maintenanceMessage, "Isolated deployment verification");
  assert.equal(second.snapshot().decision.allowed, true);
  await accountPolicy(accounts[0]);
  await pollAll();
  assert.equal(first.snapshot().decision.allowed, true);
  check("Account maintenance notice and recovery with other account unaffected");

  const blockedFeatures = Object.fromEntries(protocol.managedFeatures.map(name => [name, false]));
  await accountPolicy(accounts[0], { features: blockedFeatures });
  await pollAll();
  assert.equal(first.snapshot().decision.allowed, true);
  assert.deepEqual(first.snapshot().decision.features, blockedFeatures);
  assert.deepEqual(second.snapshot().decision.features, features);
  await accountPolicy(accounts[0]);
  await pollAll();
  assert.deepEqual(first.snapshot().decision.features, features);
  check("All account feature flags restrict and recover independently");

  await admin("accounts", { ...accounts[0], expiresAt: now() - 1 });
  await pollAll();
  assert.equal(first.snapshot().decision.reason, "entitlement_expired");
  assert.equal(second.snapshot().decision.allowed, true);
  await admin("accounts", accounts[0]);
  await pollAll();
  assert.equal(first.snapshot().decision.allowed, true);
  check("Authorization deadline and renewal");

  const expiry = second.snapshot().expiresAt;
  offline = true;
  await second.poll({ force: true });
  assert.equal(second.snapshot().connection, "offline");
  assert.equal(second.snapshot().decision.allowed, true);
  const restarted = createClient("deployment-smoke-b");
  assert.equal(restarted.snapshot().expiresAt, expiry);
  simulatedNow = expiry;
  assert.equal(restarted.snapshot().decision.reason, "lease_expired");
  assert.equal(createClient("deployment-smoke-b").snapshot().decision.reason, "lease_expired");
  check("Injected outage uses existing lease; fixture restart cannot extend expiry");
  simulatedNow = null;
  offline = false;
  await pollAll();
  assert.equal(second.snapshot().decision.allowed, true);
  check("HTTPS reconnection renews the signed authorization");
  report.pass = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
  console.error("FAIL " + error.name + ": " + error.message);
} finally {
  offline = false;
  simulatedNow = null;
  // The test owns only identities in these sets; no account or product-wide
  // cleanup is permitted. Retain the audit trail and revoke the fixture access.
  for (const client of clients) {
    const installationId = client.snapshot().installationId;
    if (!ownedDevices.has(installationId)) continue;
    try {
      await admin("devices", { installationId, group: "deployment-smoke", enabled: false, unbind: true });
      await client.poll({ force: true });
      assert.equal(client.snapshot().connection, "online");
      assert.equal(client.snapshot().decision.reason, "device_disabled");
      report.cleanup.push({ installationId, revoked: true });
    } catch (error) {
      report.cleanup.push({ installationId, revoked: false, error: error.message });
      report.pass = false;
      process.exitCode = 1;
    }
  }
  for (const account of accounts) {
    try {
      await accountPolicy(account);
      await admin("accounts", { ...account, enabled: false, expiresAt: now() });
      report.cleanup.push({ accountId: account.id, disabled: true });
    } catch (error) {
      report.cleanup.push({ accountId: account.id, disabled: false, error: error.message });
      report.pass = false;
      process.exitCode = 1;
    }
  }
  if (cookie && csrf) {
    try { await post("/admin/logout", {}, { Cookie: cookie, "X-CSRF-Token": csrf }); } catch {}
  }
  fixtureKey.fill(0);
  report.finishedAt = new Date().toISOString();
  const reportFile = path.join(directory, "smoke-result-" + run + ".json");
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log("Result: " + reportFile);
  console.log("Passed: " + report.pass + "; checks: " + report.checks.length);
}
