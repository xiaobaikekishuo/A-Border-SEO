import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { evaluateLease, verifyLease } from "../../source/lib/managed/protocol.mjs";
import { configureAdmin } from "../admin-auth.mjs";
import { openDatabase } from "../db.mjs";
import { featureDefaults, RequestError } from "../model.mjs";
import { createControlPlane } from "../server.mjs";

const productId = "a-border-seo";
const otherProduct = "another-product";
const loginPassword = "test-only passphrase for administrator";
const bodyFor = (installationId, product = productId) => ({
  productId: product, installationId, desktopVersion: "1.2.0", backendVersion: "1.2.0", platform: "win32-x64",
});

async function fixture(t) {
  const db = openDatabase(":memory:");
  configureAdmin(db, "administrator", loginPassword);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let now = 1_800_000_000;
  const config = { origin: "http://127.0.0.1", secure: false, leaseSeconds: 900, kid: "test", privateKey };
  const server = createControlPlane({
    db, config, clock: () => now, verifyRelease: async version => {
      if (version !== "2.0.0") throw new RequestError(422, "release_assets_unavailable");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close(error => {
    db.close();
    if (error) reject(error); else resolve();
  })));

  const request = async (route, body, options = {}) => {
    const headers = { ...options.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(config.origin + route, {
      method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
  };
  const login = await request("/admin/login", { username: "administrator", password: loginPassword }, {
    headers: { Origin: config.origin },
  });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
  const headers = { Origin: config.origin, Cookie: login.cookie.split(";")[0], "X-CSRF-Token": login.data.csrf };
  const admin = (route, body) => request("/admin/api/" + route, body === undefined ? undefined : { reason: "test action", ...body }, { headers });
  const account = async (label, product = productId, extra = {}) => {
    const reply = await admin("accounts", { productId: product, label, enabled: true, expiresAt: null, deviceLimit: 1,
      features: featureDefaults, ...extra });
    assert.equal(reply.status, 200);
    return reply.data;
  };
  const code = async (accountId, product = productId, extra = {}) => {
    const reply = await admin("activation", { productId: product, accountId, ...extra });
    assert.equal(reply.status, 200);
    return reply.data.code;
  };
  const enroll = async (accountId, product = productId, id = randomUUID()) => {
    const activation = await code(accountId, product);
    const requestBody = bodyFor(id, product);
    const reply = await request("/v1/activate", { ...requestBody, code: activation });
    assert.equal(reply.status, 200);
    return { body: requestBody, token: reply.data.deviceToken, accountId, activation, lease: reply.data.lease };
  };
  const claims = (device, lease, at = now) => verifyLease(lease, {
    config: { issuer: config.origin, productId: device.body.productId,
      keys: { test: publicKey.export({ format: "pem", type: "spki" }) } },
    installationId: device.body.installationId, accountId: device.accountId, now: at,
  });
  const client = (route, device, body = {}) => request("/v1/" + route, { ...device.body, ...body },
    { headers: { Authorization: "Bearer " + device.token } });
  const lease = async device => {
    const reply = await client("lease", device);
    assert.equal(reply.status, 200);
    return claims(device, reply.data.lease);
  };
  const policy = body => admin("policy", { productId, scope: "product", scopeId: "", disabled: false, maintenance: false,
    startAt: null, endAt: null, message: "", features: featureDefaults, ...body });
  return { db, request, admin, account, code, enroll, claims, client, lease, policy, headers,
    time: () => now, advance: seconds => { now += seconds; } };
}

test("canonicalizes the documented admin URL without redirecting to query-supplied destinations", async t => {
  const f = await fixture(t);
  const response = await fetch(f.headers.Origin + "/admin/?next=https://invalid.example", { redirect: "manual" });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/admin");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await fetch(f.headers.Origin + "/admin/");
  assert.equal(page.status, 200);
  assert.equal(page.url, f.headers.Origin + "/admin");
  assert.match(page.headers.get("content-type"), /^text\/html/);
});

test("registration requires approval, isolates accounts and binds signed device sessions with capacity limits", async t => {
  const f = await fixture(t);
  const metadata = bodyFor(randomUUID());
  const credentials = { username: "Customer_100", password: "fixture-pass-123" };
  const signup = await f.request("/v1/user/register", { ...metadata, ...credentials });
  assert.equal(signup.status, 200);
  assert.equal(signup.data.approval, "pending");
  assert.equal(signup.data.username, "customer_100");
  assert.equal(signup.data.lease, undefined);
  const accountId = signup.data.accountId;
  const login = (extra = {}) => f.request("/v1/user/login", { ...metadata, ...credentials, ...extra });
  assert.equal((await login()).data.error, "account_pending");
  assert.equal((await login({ password: "not-the-password" })).data.error, "invalid_user_credentials");
  assert.equal((await f.request("/v1/user/register", { ...metadata, ...credentials })).data.error, "username_taken");
  let state = (await f.admin("state")).data;
  let account = state.accounts.find(row => row.id === accountId);
  assert.equal(account.enabled, false);
  assert.equal(account.approval, "pending");
  assert.equal(account.deviceLimit, 1);
  assert.equal(state.devices.length, 0);
  assert.equal((await f.admin("activation", { productId, accountId })).data.error, "account_unavailable");
  assert(!JSON.stringify(state).includes(credentials.password));
  assert(!JSON.stringify(state).includes("password_hash"));
  account = (await f.admin("accounts", { productId, ...account, enabled: true })).data;
  assert.equal(account.approval, "approved");
  const accepted = await login();
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.data.user, { username: "customer_100" });
  const device = { body: metadata, token: accepted.data.deviceToken, accountId };
  assert.equal(evaluateLease(f.claims(device, accepted.data.lease), { ...metadata, now: f.time() }).allowed, true);
  const rotated = await login();
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.deviceToken, device.token);
  assert.equal((await f.client("lease", device)).status, 401);
  device.token = rotated.data.deviceToken;
  assert.equal((await login({ installationId: randomUUID() })).data.error, "device_limit_reached");
  const foreign = await f.account("Foreign account");
  const foreignDevice = await f.enroll(foreign.id);
  assert.equal((await login({ installationId: foreignDevice.body.installationId })).data.error, "installation_already_bound");
  await f.admin("devices", { productId, installationId: metadata.installationId, enabled: false, group: "" });
  assert.equal((await login()).data.error, "device_disabled");
  await f.admin("devices", { productId, installationId: metadata.installationId, enabled: true, group: "" });
  await f.admin("accounts", { productId, ...account, enabled: false });
  assert.equal((await login()).data.error, "account_disabled");
  assert.equal((await f.lease(device)).policy.accountDisabled, true);
  await f.admin("accounts", { productId, ...account, enabled: true, expiresAt: f.time() });
  assert.equal((await login()).data.error, "account_expired");
});

test("registration links an existing activation only with bound device proof and immediately requires approval", async t => {
  const f = await fixture(t);
  const account = await f.account("Existing installation");
  const device = await f.enroll(account.id);
  const body = { ...device.body, username: "legacy-owner", password: "fixture-existing-456" };
  assert.equal((await f.request("/v1/user/register", body)).data.error, "device_authentication_failed");
  const signup = await f.request("/v1/user/register", body, { headers: { Authorization: "Bearer " + device.token } });
  assert.equal(signup.status, 200);
  assert.equal(signup.data.accountId, account.id);
  assert.equal((await f.lease(device)).policy.accountDisabled, true);
  const duplicate = await f.request("/v1/user/register", { ...body, username: "another-owner" },
    { headers: { Authorization: "Bearer " + device.token } });
  assert.equal(duplicate.data.error, "account_already_registered");
  const state = (await f.admin("state")).data;
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].approval, "pending");
  await f.admin("accounts", { productId, ...account, enabled: true });
  const signedIn = await f.request("/v1/user/login", body);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.accountId, account.id);
  assert.equal((await f.client("lease", device)).status, 401);
  const binding = (await f.admin("state")).data.devices[0];
  assert.equal(binding.accountId, account.id);
  assert.equal(binding.installationId, device.body.installationId);
});

test("registration validates input and authentication budgets do not trust forwarded IP headers", async t => {
  const f = await fixture(t);
  const meta = bodyFor(randomUUID());
  assert.equal((await f.request("/v1/user/register", { ...meta, username: "valid_user", password: "short" })).data.error, "invalid_registration");
  assert.equal((await f.request("/v1/user/register", { ...meta, username: "bad name", password: "fixture-pass-123" })).data.error, "invalid_registration");
  for (let index = 0; index < 12; index++) {
    const reply = await f.request("/v1/user/login", { ...meta, username: "nonexistent", password: "wrong-password" },
      { headers: { "X-Forwarded-For": `192.0.2.${index}` } });
    assert.equal(reply.status, 401);
  }
  assert.equal((await f.request("/v1/user/login", { ...meta, username: "nonexistent", password: "wrong-password" })).status, 429);
});

test("scopes policy across devices and products, supports capacity, expiry, maintenance and explicit reactivation", async t => {
  const f = await fixture(t);
  const aliceAccount = await f.account("Alice");
  const bobAccount = await f.account("Bob");
  assert.equal((await f.admin("products", { id: otherProduct, name: "Another product" })).status, 200);
  const isolatedAccount = await f.account("Other product identity", otherProduct);
  const alice = await f.enroll(aliceAccount.id);
  const bob = await f.enroll(bobAccount.id);
  const other = await f.enroll(isolatedAccount.id, otherProduct, alice.body.installationId);
  const first = f.claims(alice, alice.lease);
  assert.equal(first.exp - first.iat, 900);
  assert.equal(evaluateLease(first, { ...alice.body, now: first.exp }).reason, "lease_expired");
  assert.throws(() => f.claims(bob, alice.lease), /invalid_lease_binding/);
  assert.equal((await f.client("lease", alice, { productId: otherProduct })).status, 401);
  assert.equal((await f.client("lease", alice, { installationId: bob.body.installationId })).status, 401);
  assert.equal((await f.request("/admin/api/state", undefined, { headers: { Authorization: "Bearer " + alice.token } })).status, 401);
  const repeat = await f.request("/v1/activate", { ...alice.body, code: alice.activation });
  assert.equal(repeat.data.deviceToken, alice.token);
  assert.ok(f.claims(alice, repeat.data.lease).sequence > first.sequence);
  assert.equal((await f.request("/v1/activate", { ...bob.body, code: alice.activation })).status, 401);
  const overLimit = await f.code(alice.accountId);
  assert.equal((await f.request("/v1/activate", { ...bodyFor(randomUUID()), code: overLimit })).data.error, "device_limit_reached");

  assert.equal((await f.admin("accounts", { productId, ...aliceAccount, enabled: false })).status, 200);
  assert.equal((await f.lease(alice)).policy.accountDisabled, true);
  assert.equal((await f.lease(bob)).policy.accountDisabled, false);
  assert.equal((await f.lease(other)).policy.accountDisabled, false);
  assert.equal((await f.policy({ maintenance: true, startAt: f.time() + 30, endAt: f.time() + 60, message: "Planned maintenance" })).status, 200);
  assert.equal((await f.lease(bob)).exp, f.time() + 30);
  f.advance(30);
  assert.deepEqual((await f.lease(bob)).policy.maintenance, { active: true, message: "Planned maintenance" });
  assert.equal((await f.lease(other)).policy.maintenance.active, false);
  assert.equal((await f.policy({})).status, 200);
  assert.equal((await f.lease(bob)).policy.maintenance.active, false);
  assert.equal((await f.lease(alice)).policy.accountDisabled, true);
  assert.equal((await f.policy({ disabled: true })).status, 200);
  assert.equal((await f.lease(bob)).policy.productDisabled, true);
  assert.equal((await f.lease(other)).policy.productDisabled, false);
  assert.equal((await f.policy({})).status, 200);
  const deviceUpdate = { productId, installationId: bob.body.installationId, enabled: false, group: "pilot" };
  assert.equal((await f.admin("devices", deviceUpdate)).status, 200);
  assert.equal((await f.lease(bob)).policy.deviceDisabled, true);
  const repair = await f.code(bob.accountId);
  assert.equal((await f.request("/v1/activate", { ...bob.body, code: repair })).data.error, "installation_already_bound");
  assert.equal((await f.admin("devices", { ...deviceUpdate, enabled: true })).status, 200);
  const repaired = await f.request("/v1/activate", { ...bob.body, code: repair });
  assert.equal(repaired.status, 200);
  assert.notEqual(repaired.data.deviceToken, bob.token);
  assert.equal((await f.client("lease", bob)).status, 401);
  bob.token = repaired.data.deviceToken;
  assert.equal((await f.lease(bob)).policy.deviceDisabled, false);
  assert.equal((await f.admin("devices", { ...deviceUpdate, unbind: true })).status, 200);
  assert.equal((await f.lease(bob)).policy.deviceDisabled, true);
  const ordinary = await f.code(bob.accountId);
  assert.equal((await f.request("/v1/activate", { ...bob.body, code: ordinary })).data.error, "device_requires_reactivation");
  const targeted = await f.code(bob.accountId, productId, { installationId: bob.body.installationId });
  assert.equal((await f.request("/v1/activate", { ...bob.body, code: targeted })).status, 200);
  assert.equal((await f.client("lease", bob)).status, 401);
});

test("verifies eligible release, distinguishes received/effective and prevents failed test expansion", async t => {
  const f = await fixture(t);
  const firstAccount = await f.account("Pilot");
  const secondAccount = await f.account("Stable");
  const pilot = await f.enroll(firstAccount.id);
  const stable = await f.enroll(secondAccount.id);
  assert.equal((await f.request("/admin/api/state")).status, 401);
  assert.equal((await f.request("/admin/api/policy", { productId }, {
    headers: { ...f.headers, "X-CSRF-Token": "invalid" },
  })).status, 403);
  assert.equal((await f.request("/admin/api/policy", { productId }, {
    headers: { ...f.headers, Origin: "https://invalid.example" },
  })).status, 403);
  assert.equal((await f.admin("devices", { productId, installationId: pilot.body.installationId, enabled: true, group: "pilot" })).status, 200);
  const release = { productId, version: "2.0.0", channel: "test", percent: 100, group: "pilot", minimumDesktopVersion: "2.0.0",
    minimumBackendVersion: "2.0.0", deadline: f.time() + 60, notes: "Release test", paused: false };
  assert.equal((await f.admin("releases", { ...release, version: "2.0.1" })).data.error, "release_assets_unavailable");
  assert.equal((await f.admin("releases", { ...release, minimumDesktopVersion: "2.1.0" })).data.error, "minimum_exceeds_release");
  assert.equal((await f.admin("releases", release)).status, 200);
  const early = await f.lease(pilot);
  assert.equal(early.policy.release.version, "2.0.0");
  assert.equal(early.policy.minimumDesktopVersion, null);
  assert.equal(early.exp, release.deadline);
  assert.equal((await f.lease(stable)).policy.release, null);
  f.advance(61);
  const active = await f.lease(pilot);
  assert.equal(active.policy.minimumBackendVersion, "2.0.0");
  const report = { sequence: active.sequence, revision: active.revision };
  assert.equal((await f.client("receipt", pilot, { ...report, status: "received" })).status, 200);
  assert.equal((await f.admin("state")).data.summary.receipts.received, 1);
  assert.equal((await f.client("receipt", pilot, { ...report, status: "effective", code: "update_verified" })).data.error,
    "update_not_verified");
  assert.equal((await f.client("receipt", pilot, { ...report, status: "failed", code: "update_backend_failed" })).status, 200);
  assert.equal((await f.client("receipt", pilot, { ...report, status: "received" })).status, 200);
  assert.equal((await f.admin("state")).data.summary.receipts.failed, 1);
  assert.equal((await f.admin("releases", { ...release, channel: "stable", group: "" })).data.error, "rollout_failed");
  assert.equal((await f.client("receipt", pilot, { ...report, status: "effective", code: "update_verified",
    desktopVersion: "2.0.0", backendVersion: "2.0.0" })).status, 200);
  const state = (await f.admin("state")).data;
  assert.equal(state.summary.upgrades.succeeded, 1);
  assert.deepEqual(state.releases[0].rollout, { succeeded: 1, failed: 1 });
  assert.equal(state.summary.versions.backend["2.0.0"], 1);
  assert.ok(state.audit.some(row => row.action === "device_receipt"));
  assert.ok(!JSON.stringify(state).includes(pilot.token));
  f.advance(181);
  assert.equal((await f.admin("state")).data.summary.receipts.offline, 2);
});
