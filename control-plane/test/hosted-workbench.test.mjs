import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { openDatabase } from "../db.mjs";
import { configureAdmin } from "../admin-auth.mjs";
import { activate, adminMutate, adminState, featureDefaults, leaseForDevice, randomToken } from "../model.mjs";
import { createControlPlane, createInternalControlPlane, readInternalConfig } from "../server.mjs";
import { verifyLease } from "../../source/lib/managed/protocol.mjs";

const productId = "a-border-seo";
const prefix = "/internal/v1/workbench/";
async function fixture(t) {
  const db = openDatabase(":memory:");
  let now = 1_800_000_000;
  const config = { origin: "https://management.example.test", secure: true, leaseSeconds: 900,
    kid: "fixture", privateKey: generateKeyPairSync("ed25519").privateKey,
    internal: { bind: "127.0.0.1", port: 0, secret: randomToken() } };
  const internal = createInternalControlPlane({ db, config, clock: () => now });
  const external = createControlPlane({ db, config, clock: () => now });
  for (const server of [internal, external]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  t.after(async () => {
    await Promise.all([internal, external].map(server => new Promise(resolve => server.close(resolve))));
    db.close();
  });
  const request = async (action, body, options = {}) => {
    const server = options.public ? external : internal;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${prefix}${action}`, {
      method: "POST", headers: { "Content-Type": "application/json",
        ...(options.authorize === false ? {} : { Authorization: "Bearer " + config.internal.secret }), ...options.headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const mutate = (action, body, verifiedAt = null) => adminMutate(db, action,
    { productId, reason: "isolated hosted test", ...body }, "fixture-admin", now, verifiedAt);
  const account = (extra = {}) => mutate("accounts", { label: "Hosted fixture", enabled: true,
    expiresAt: null, deviceLimit: 3, features: featureDefaults, ...extra });
  const enroll = (accountId, options = {}) => {
    const product = options.productId ?? productId;
    const code = mutate("activation", { productId: product, accountId }).code;
    const body = { productId: product, accountId, installationId: options.installationId ?? randomUUID(),
      desktopVersion: "1.5.0", backendVersion: "1.5.0" };
    const result = activate(db, { ...body, code, platform: "win32-x64" }, config, now);
    return { ...body, deviceToken: result.deviceToken };
  };
  const policy = (extra = {}) => mutate("policy", { scope: "product", scopeId: "", disabled: false,
    maintenance: false, startAt: null, endAt: null, message: "", features: featureDefaults, ...extra });
  const release = (extra = {}) => mutate("releases", { version: "2.0.0", channel: "stable", percent: 100,
    group: "", minimumDesktopVersion: null, minimumBackendVersion: null, deadline: null,
    notes: "fixture release", paused: false, ...extra }, now);
  const snapshot = async device => {
    const response = await request("authenticate", device);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  };
  const binding = (device, state) => ({ productId: device.productId, accountId: device.accountId,
    installationId: device.installationId, desktopVersion: device.desktopVersion,
    backendVersion: device.backendVersion, sessionBinding: state.sessionBinding });
  return { db, config, publicUrl: `http://127.0.0.1:${external.address().port}`, request, mutate, account, enroll, policy, release, snapshot, binding,
    time: () => now, advance: seconds => { now += seconds; }, state: () => adminState(db, productId, now) };
}

test("the signed-in administrator sees the component, reason and policy revision for blocked business requests", async t => {
  const f = await fixture(t);
  const password = "isolated administrator passphrase";
  configureAdmin(f.db, "admin", password);
  const login = await fetch(f.publicUrl + "/admin/login", { method: "POST",
    headers: { Origin: f.config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  const device = f.enroll(f.account().id);
  for (const [settings, code] of [[{ scope: "device", scopeId: device.installationId, maintenance: true, message: "Database maintenance" }, "maintenance"],
    [{ scope: "device", scopeId: device.installationId, disabled: true }, "device_disabled"]]) {
    f.policy(settings);
    const policy = await f.snapshot(device);
    assert.equal(policy.reason, code);
    assert.equal((await f.request("receipt", { ticket: policy.receiptTicket, component: "http_api", status: "blocked", code })).status, 200);
    const response = await fetch(f.publicUrl + "/admin/api/state", { headers });
    assert.equal(response.status, 200);
    const row = (await response.json()).hostedReceipts.find(r => r.installationId === device.installationId && r.component === "http_api");
    assert.equal(row.code, code);
    assert.equal(row.current, true);
    assert.equal(row.revision, policy.revision);
    assert.equal(row.status, "blocked");
  }
});

test("internal listener is opt-in, has a dedicated canonical secret and permits only literal loopback binds", () => {
  assert.equal(readInternalConfig({}), null);
  assert.throws(() => readInternalConfig({ ABORDER_CONTROL_INTERNAL_PORT: "18086" }), /requires its dedicated secret/);
  assert.throws(() => readInternalConfig({ ABORDER_CONTROL_INTERNAL_SECRET: "short" }), /32-byte/);
  for (const bind of ["0.0.0.0", "::", "localhost", "192.168.1.1"]) {
    assert.throws(() => readInternalConfig({ ABORDER_CONTROL_INTERNAL_SECRET: randomToken(), ABORDER_CONTROL_INTERNAL_BIND: bind }), /loopback/);
  }
  const config = readInternalConfig({ ABORDER_CONTROL_INTERNAL_SECRET: randomToken() });
  assert.equal(config.bind, "127.0.0.1");
  assert.equal(config.port, 18086);
});

test("public port never exposes the internal API; internal port rejects browser/proxy traffic and wrong secrets", async t => {
  const f = await fixture(t);
  const device = f.enroll(f.account().id);
  assert.equal((await f.request("authenticate", device, { public: true })).status, 404);
  assert.deepEqual(await f.request("authenticate", device, { authorize: false }),
    { status: 401, data: { error: "internal_authentication_failed" } });
  assert.equal((await f.request("authenticate", device, { headers: { Authorization: "Bearer " + randomToken() } })).status, 401);
  for (const headers of [{ Origin: f.config.origin }, { Forwarded: "for=127.0.0.1" }, { "X-Forwarded-For": "127.0.0.1" },
    { "X-Forwarded-Proto": "https" }]) {
    assert.deepEqual(await f.request("authenticate", device, { headers }),
      { status: 403, data: { error: "internal_transport_rejected" } });
  }
  assert.equal((await f.request("unknown", {})).status, 404);
});

test("relocated public origin preserves the configured issuer in signed leases and hosted account identities", async t => {
  const f = await fixture(t);
  f.config.origin = "https://new-workbench.example.test";
  f.config.issuer = "https://original-management.example.test";
  const device = f.enroll(f.account().id);
  const lease = leaseForDevice(f.db, { ...device, platform: "win32-x64" }, device.deviceToken, f.config, f.time()).lease;
  const claims = verifyLease(lease, {
    config: { issuer: f.config.issuer, productId, keys: {
      fixture: createPublicKey(f.config.privateKey).export({ format: "pem", type: "spki" }),
    } }, installationId: device.installationId, accountId: device.accountId, now: f.time(),
  });
  assert.equal(claims.iss, f.config.issuer);
  assert.equal((await f.snapshot(device)).issuer, f.config.issuer);
  assert.equal((await f.request("account-policy", { productId, accountId: device.accountId, backendVersion: "1.5.0" })).data.issuer,
    f.config.issuer);
});

test("authenticate derives the owner, binds product/device/token/account and never issues a desktop lease", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const other = f.enroll(f.account().id);
  const before = f.db.prepare("SELECT sequence, last_seen_at, receipt_status FROM device WHERE installation_id = ?").get(device.installationId);
  const { accountId, ...withoutAccount } = device;
  const response = await f.request("authenticate", withoutAccount);
  assert.equal(response.status, 200);
  assert.equal(response.data.accountId, accountId);
  assert.equal(response.data.issuer, f.config.origin);
  assert.equal(response.data.allowed, true);
  assert.match(response.data.sessionBinding, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(response.data.validUntil, f.time() + 30);
  assert.equal(JSON.stringify(response.data).includes(device.deviceToken), false);
  assert.equal(Object.hasOwn(response.data, "lease"), false);
  for (const patch of [{ accountId: other.accountId }, { installationId: other.installationId },
    { productId: "other-product" }, { deviceToken: other.deviceToken }]) {
    assert.equal((await f.request("authenticate", { ...device, ...patch })).status, 401);
  }
  assert.equal((await f.request("authenticate", { ...device, backendVersion: null })).status, 400);
  assert.deepEqual(f.db.prepare("SELECT sequence, last_seen_at, receipt_status FROM device WHERE installation_id = ?").get(device.installationId), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM issued_lease").get().n, 2);
});

test("device policy reuses account/device/group policies and effective feature decisions without cross-account leakage", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const other = f.enroll(f.account().id);
  const binding = f.binding(device, await f.snapshot(device));
  f.policy({ scope: "account", scopeId: owner.id, features: { ...featureDefaults, jobs: false } });
  let current = (await f.request("device-policy", binding)).data;
  assert.equal(current.allowed, true);
  assert.equal(current.features.jobs, false);
  assert.equal((await f.snapshot(other)).features.jobs, true);
  f.mutate("devices", { installationId: device.installationId, enabled: false, group: "" });
  current = (await f.request("device-policy", binding)).data;
  assert.equal(current.reason, "device_disabled");
  assert.deepEqual(Object.values(current.features), [false, false, false, false]);
  f.mutate("devices", { installationId: device.installationId, enabled: true, group: "canary" });
  f.policy({ scope: "group", scopeId: "canary", maintenance: true, message: "Group maintenance" });
  assert.equal((await f.request("device-policy", binding)).data.maintenanceMessage, "Group maintenance");
  assert.equal((await f.snapshot(other)).allowed, true);
  assert.equal((await f.request("device-policy", { ...binding, accountId: other.accountId })).status, 401);
});

test("registered approval, entitlement expiry, account disable and product maintenance fail closed", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const query = { productId, accountId: owner.id, backendVersion: "1.5.0" };
  f.db.prepare("UPDATE account SET username = ?, approved_at = NULL WHERE id = ?").run("pending-fixture", owner.id);
  assert.equal((await f.snapshot(device)).reason, "account_disabled");
  assert.equal((await f.request("account-policy", query)).data.reason, "account_disabled");
  f.db.prepare("UPDATE account SET approved_at = ?, expires_at = ? WHERE id = ?").run(f.time(), f.time() + 5, owner.id);
  assert.equal((await f.snapshot(device)).validUntil, f.time() + 5);
  f.advance(5);
  assert.equal((await f.snapshot(device)).reason, "entitlement_expired");
  assert.equal((await f.request("account-policy", query)).data.reason, "entitlement_expired");
  f.account({ id: owner.id, enabled: false });
  assert.equal((await f.request("account-policy", query)).data.reason, "account_disabled");
  f.account({ id: owner.id, enabled: true });
  f.policy({ maintenance: true, message: "Shared maintenance" });
  assert.equal((await f.snapshot(device)).reason, "maintenance");
  assert.equal((await f.request("account-policy", query)).data.reason, "maintenance");
  f.policy({ disabled: true });
  assert.equal((await f.request("account-policy", query)).data.reason, "product_disabled");
});

test("device rollout floors use device cohorts while account jobs use only completed global backend floors", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const query = { productId, accountId: owner.id, backendVersion: "1.5.0" };
  f.mutate("devices", { installationId: device.installationId, enabled: true, group: "canary" });
  f.release({ channel: "test", group: "canary", minimumDesktopVersion: "2.0.0", minimumBackendVersion: "2.0.0" });
  assert.equal((await f.snapshot(device)).reason, "update_required");
  assert.equal((await f.request("account-policy", query)).data.allowed, true);
  f.release({ minimumDesktopVersion: "2.0.0" });
  const accountOnly = (await f.request("account-policy", query)).data;
  assert.equal(accountOnly.allowed, true);
  assert.equal(accountOnly.installationId, null);
  assert.equal(accountOnly.policy.minimumDesktopVersion, null);
  f.release({ minimumBackendVersion: "2.0.0", deadline: f.time() + 8 });
  assert.equal((await f.request("account-policy", query)).data.allowed, true);
  f.advance(8);
  assert.equal((await f.request("account-policy", query)).data.reason, "update_required");
  assert.equal((await f.request("account-policy", { ...query, backendVersion: "2.0.0" })).data.allowed, true);
  f.release({ minimumBackendVersion: "2.0.0", percent: 50 });
  assert.equal((await f.request("account-policy", query)).data.allowed, true);
});

test("account jobs have no arbitrary device or group identity and enforce account feature switches", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const query = { productId, accountId: owner.id, backendVersion: "1.5.0" };
  f.policy({ scope: "device", scopeId: device.installationId, disabled: true });
  assert.equal((await f.snapshot(device)).reason, "device_disabled");
  assert.equal((await f.request("account-policy", query)).data.allowed, true);
  f.policy({ scope: "account", scopeId: owner.id, features: { ...featureDefaults, jobs: false, codex: false } });
  const state = (await f.request("account-policy", query)).data;
  assert.equal(state.features.jobs, false);
  assert.equal(state.features.codex, false);
  assert.equal((await f.request("account-policy", { ...query, accountId: randomUUID() })).status, 404);
});

test("token rotation and revocation immediately invalidate hosted bindings and receipts, preserving unrelated devices", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const other = f.enroll(owner.id);
  const original = await f.snapshot(device);
  const binding = f.binding(device, original);
  const otherBinding = f.binding(other, await f.snapshot(other));
  assert.equal((await f.request("receipt", { component: "http_api", ticket: original.receiptTicket, status: "effective", code: "api_policy_applied" })).status, 200);
  const rotated = f.enroll(owner.id, { installationId: device.installationId });
  assert.equal((await f.request("device-policy", binding)).status, 401);
  assert.equal((await f.request("authenticate", device)).status, 401);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: original.receiptTicket, status: "effective" })).status, 401);
  assert.equal(f.state().hostedReceipts[0].current, false);
  assert.equal((await f.request("device-policy", otherBinding)).status, 200);
  const fresh = await f.snapshot(rotated);
  assert.notEqual(fresh.sessionBinding, original.sessionBinding);
  f.mutate("devices", { installationId: device.installationId, enabled: false, group: "", unbind: true });
  assert.equal((await f.request("device-policy", f.binding(rotated, fresh))).status, 401);
  assert.equal((await f.request("authenticate", rotated)).status, 401);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: fresh.receiptTicket, status: "effective" })).status, 401);
  assert.equal((await f.request("device-policy", otherBinding)).status, 200);
});

test("hosted receipts are authenticated, policy-bound, expire and never impersonate desktop receipts", async t => {
  const f = await fixture(t);
  const owner = f.account();
  const device = f.enroll(owner.id);
  const state = await f.snapshot(device);
  const before = f.db.prepare("SELECT sequence, receipt_revision, receipt_sequence, receipt_status, receipt_at FROM device WHERE installation_id = ?")
    .get(device.installationId);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: state.receiptTicket + "x", status: "effective" })).status, 401);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: state.receiptTicket, status: "upgrading" })).status, 400);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: state.receiptTicket, status: "blocked" })).status, 409);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: state.receiptTicket, status: "effective", code: "api_policy_applied" })).status, 200);
  const accountState = (await f.request("account-policy", { productId, accountId: owner.id, backendVersion: "1.5.0" })).data;
  assert.equal((await f.request("receipt", { component: "http_api", ticket: accountState.receiptTicket, status: "effective", code: "job_policy_applied" })).status, 200);
  assert.deepEqual(f.db.prepare("SELECT sequence, receipt_revision, receipt_sequence, receipt_status, receipt_at FROM device WHERE installation_id = ?")
    .get(device.installationId), before);
  assert.equal(f.state().hostedReceipts.length, 2);
  assert.equal(f.state().summary.receipts.pending, 1);
  assert.equal(f.state().hostedReceipts.every(row => row.current), true);
  const publicState = JSON.stringify(f.state());
  for (const privateValue of [device.deviceToken, state.sessionBinding, f.config.internal.secret, "token_hash"]) {
    assert.equal(publicState.includes(privateValue), false);
  }
  f.policy({ maintenance: true, message: "Policy changed" });
  assert.deepEqual(await f.request("receipt", { component: "http_api", ticket: state.receiptTicket, status: "effective" }),
    { status: 409, data: { error: "hosted_policy_changed" } });
  const denied = await f.snapshot(device);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: denied.receiptTicket, status: "blocked", code: "maintenance" })).status, 200);
  f.advance(30);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: denied.receiptTicket, status: "blocked" })).data.error, "hosted_receipt_expired");
  assert.equal(f.state().hostedReceipts.every(row => !row.current), true);
});

test("time-triggered maintenance closes receipt validity without needing a policy revision mutation", async t => {
  const f = await fixture(t);
  const device = f.enroll(f.account().id);
  f.policy({ maintenance: true, startAt: f.time() + 5, endAt: f.time() + 10, message: "Scheduled work" });
  const before = await f.snapshot(device);
  assert.equal(before.allowed, true);
  assert.equal(before.validUntil, f.time() + 5);
  f.advance(5);
  assert.equal((await f.request("receipt", { component: "http_api", ticket: before.receiptTicket, status: "effective" })).data.error, "hosted_receipt_expired");
  assert.equal((await f.snapshot(device)).reason, "maintenance");
  f.advance(5);
  assert.equal((await f.snapshot(device)).allowed, true);
});

test("component receipts cannot overwrite another executor's draining status", async t => {
  const f = await fixture(t);
  const owner = f.account(); const device = f.enroll(owner.id);
  f.policy({ maintenance: true, message: "Drain the isolated fixture" });
  const first = await f.snapshot(device);
  assert.equal((await f.request("receipt", { component: "ordinary_worker", ticket: first.receiptTicket, status: "draining" })).status, 200);
  f.advance(1);
  const second = await f.snapshot(device);
  assert.equal((await f.request("receipt", { component: "http_session", ticket: second.receiptTicket, status: "effective" })).status, 200);
  assert.equal((await f.request("receipt", { component: "content_worker", ticket: second.receiptTicket, status: "blocked" })).status, 200);
  let receipts = f.state().hostedReceipts;
  assert.equal(receipts.length, 3);
  assert.deepEqual(Object.fromEntries(receipts.map(row => [row.component, row.status])), {
    ordinary_worker: "draining", http_session: "effective", content_worker: "blocked",
  });
  assert.equal(receipts.every(row => row.current && row.installationId === device.installationId), true);
  // Freshness is scoped to a component, not the last update of any executor.
  assert.equal((await f.request("receipt", { component: "http_api", ticket: first.receiptTicket, status: "blocked" })).status, 200);
  assert.equal((await f.request("receipt", { component: "ordinary_worker", ticket: second.receiptTicket, status: "blocked" })).status, 200);
  assert.equal((await f.request("receipt", { component: "ordinary_worker", ticket: first.receiptTicket, status: "draining" })).data.error, "hosted_receipt_stale");
  receipts = f.state().hostedReceipts;
  assert.equal(receipts.find(row => row.component === "ordinary_worker").status, "blocked");
  assert.equal(receipts.find(row => row.component === "http_session").status, "effective");
  for (const component of [undefined, "legacy", "arbitrary_component"]) {
    assert.equal((await f.request("receipt", { component, ticket: second.receiptTicket, status: "effective" })).data.error, "invalid_hosted_receipt_component");
  }
  const account = (await f.request("account-policy", { productId, accountId: owner.id, backendVersion: "1.5.0" })).data;
  assert.equal((await f.request("receipt", { component: "content_worker", ticket: account.receiptTicket, status: "blocked" })).status, 400);
});
