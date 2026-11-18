import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ManagedClient } from "../desktop/managed-client.mjs";
import * as protocol from "../source/lib/managed/protocol.mjs";

// Explicit deployment check. Creates only random, labelled fixture identities,
// and leaves their audit trail disabled/revoked. Never changes product policy.
const args = process.argv.slice(2);
if (args[0] !== "--run") {
  console.log("Usage: node scripts/smoke-registration-server.mjs --run [deployment-directory]");
  process.exit(0);
}
const directory = path.resolve(args[1] ?? "reports/deployment-aborder");
const read = filename => JSON.parse(readFileSync(path.join(directory, filename), "utf8").replace(/^\uFEFF/, ""));
const config = protocol.validateConfig(read("management-config.json"));
const credentials = read("admin-credentials.json");
const origin = config.serverUrl;
const productId = config.productId;
const version = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")).version;
const run = new Date().toISOString().replace(/[:.]/g, "-");
const fixtureDirectory = path.join(directory, "registration-smoke-" + run);
mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
const key = randomBytes(32);
const accounts = new Map();
const devices = new Map();
const clients = [];
const users = [];
const report = { origin, startedAt: new Date().toISOString(), pass: false, checks: [], cleanup: [],
  scope: "Actual ManagedClient registration/login module through public HTTPS, no GUI or business-worker execution asserted." };
const check = name => { report.checks.push(name); console.log("PASS " + name); };
let cookie, csrf;
const seal = async value => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};
const open = async value => {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
};
const createClient = label => new ManagedClient({ protocol, config, requireUser: true,
  file: path.join(fixtureDirectory, label + ".json"), dataRoot: path.join(fixtureDirectory, label),
  desktopVersion: version, versions: () => ({ backendVersion: null }), seal, open, onChange() {} });
const post = (route, body, headers = {}) => fetch(origin + route, { method: "POST", redirect: "error",
  signal: AbortSignal.timeout(12_000), headers: { Origin: origin, "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body) });
async function overview() {
  const response = await fetch(origin + "/admin/api/state?productId=" + encodeURIComponent(productId), {
    redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function mutate(action, body) {
  if (action === "accounts") assert(accounts.has(body.id));
  else if (action === "devices") assert(devices.has(body.installationId));
  else throw new Error("registration_smoke_action_not_permitted");
  const response = await post("/admin/api/" + action,
    { productId, reason: "Registration deployment smoke " + run, ...body }, { Cookie: cookie, "X-CSRF-Token": csrf });
  const data = await response.json();
  assert.equal(response.status, 200, data.error ?? "admin_action_failed");
  return data;
}
try {
  const response = await post("/admin/login", credentials);
  assert.equal(response.status, 200);
  csrf = (await response.json()).csrf;
  cookie = response.headers.get("set-cookie").split(";")[0];
  for (const label of ["a", "b"]) {
    const user = { username: "registration-smoke-" + label + "-" + randomBytes(9).toString("hex"), password: randomBytes(24).toString("base64url") };
    const client = createClient(label);
    clients.push(client); users.push(user);
    await client.register(user);
    assert.equal(client.snapshot().signedIn, false);
    assert.equal(client.state().lease, null);
    await assert.rejects(client.login(user), /account_pending/);
    const account = (await overview()).accounts.find(item => item.username === user.username);
    assert(account);
    accounts.set(account.id, account);
    assert.equal(account.enabled, false);
    assert.equal(account.approval, "pending");
    assert.equal(account.deviceLimit, 1);
    const approved = await mutate("accounts", { ...account, enabled: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    accounts.set(account.id, approved);
    assert.equal(approved.approval, "approved");
    await client.login(user);
    assert.equal(client.snapshot().signedIn, true);
    assert.equal(client.snapshot().decision.allowed, true);
    assert.equal(client.snapshot().user.username, user.username);
    devices.set(client.snapshot().installationId, client);
  }
  check("Two registrations remain blocked until separate administrator approval, then actual desktop login verifies signed authorization");
  const [first, second] = clients;
  const firstAccount = accounts.get(first.snapshot().accountId);
  const extra = createClient("capacity");
  await assert.rejects(extra.login(users[0]), /device_limit_reached/);
  await assert.rejects(second.login(users[0]), /installation_already_bound/);
  assert.equal(second.snapshot().user.username, users[1].username);
  assert.equal(second.snapshot().decision.allowed, true);
  check("Device capacity and cross-account installation ownership remain enforced");
  await mutate("accounts", { ...firstAccount, enabled: false });
  await first.poll({ force: true });
  assert.equal(first.snapshot().decision.reason, "account_disabled");
  await assert.rejects(first.login(users[0]), /account_disabled/);
  await second.poll({ force: true });
  assert.equal(second.snapshot().decision.allowed, true);
  await mutate("accounts", { ...firstAccount, enabled: true });
  await first.poll({ force: true });
  assert.equal(first.snapshot().decision.allowed, true);
  check("Administrator suspension and recovery affect only the intended registered account");
  const previousToken = await first.getCredential();
  const installationId = first.snapshot().installationId;
  await first.logout();
  assert.equal(first.snapshot().signedIn, false);
  assert.equal(first.state().lease, null);
  assert.equal(await first.getCredential(), null);
  assert.equal(createClient("a").snapshot().signedIn, false);
  await first.login(users[0]);
  assert.equal(first.snapshot().installationId, installationId);
  assert.equal(first.snapshot().signedIn, true);
  assert.notEqual(await first.getCredential(), previousToken);
  assert.equal((await post("/v1/lease", first.metadata(), { Authorization: "Bearer " + previousToken })).status, 401);
  check("Desktop logout removes persisted local grants; re-login preserves installation and rotates device credential");
  const state = await overview();
  for (const client of clients) {
    const device = state.devices.find(item => item.installationId === client.snapshot().installationId);
    assert.equal(device.desktopVersion, version);
    assert.equal(device.backendVersion, null);
    assert.equal(device.receiptStatus, "received");
  }
  assert(!JSON.stringify(state).includes("password_hash"));
  assert(users.every(user => !JSON.stringify(state).includes(user.password)));
  check("Admin displays registered identities and received receipts without exposing password hashes or claiming worker execution");
  report.pass = true;
} catch (error) {
  // Error messages are controlled protocol codes; never emit raw request bodies.
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
  console.error("FAIL " + error.name + ": " + error.message);
} finally {
  for (const [installationId, client] of devices) {
    try {
      await mutate("devices", { installationId, group: "registration-smoke", enabled: false, unbind: true });
      await client.poll({ force: true });
      report.cleanup.push({ installationId, revoked: true });
    } catch (error) {
      report.cleanup.push({ installationId, revoked: false, error: error.message });
      report.pass = false; process.exitCode = 1;
    }
  }
  for (const [accountId, account] of accounts) {
    try {
      await mutate("accounts", { ...account, enabled: false, expiresAt: Math.floor(Date.now() / 1000) });
      report.cleanup.push({ accountId, disabled: true });
    } catch (error) {
      report.cleanup.push({ accountId, disabled: false, error: error.message });
      report.pass = false; process.exitCode = 1;
    }
  }
  if (cookie && csrf) {
    try { await post("/admin/logout", {}, { Cookie: cookie, "X-CSRF-Token": csrf }); } catch {}
  }
  key.fill(0);
  report.finishedAt = new Date().toISOString();
  const filename = path.join(directory, "registration-smoke-result-" + run + ".json");
  writeFileSync(filename, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log("Result: " + filename);
  console.log("Passed: " + report.pass + "; checks: " + report.checks.length);
}
