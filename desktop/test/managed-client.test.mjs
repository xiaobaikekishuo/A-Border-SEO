import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedClient } from "../managed-client.mjs";
import * as protocol from "../../source/lib/managed/protocol.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const nextKeys = generateKeyPairSync("ed25519");
const config = protocol.validateConfig({
  serverUrl: "https://control.example.org",
  issuer: "https://control.example.org",
  productId: "a-border-seo",
  keys: { first: publicKey.export({ type: "spki", format: "pem" }),
    next: nextKeys.publicKey.export({ type: "spki", format: "pem" }) },
});

const basePolicy = () => ({
  productDisabled: false, accountDisabled: false, deviceDisabled: false, entitlementExpiresAt: null,
  maintenance: { active: false, message: "" },
  features: { jobs: true, codex: true, manus: true, geo: true },
  minimumDesktopVersion: null, minimumBackendVersion: null, release: null,
});

function claims(metadata, { accountId = "account-A", now = 1000, revision = 1, sequence = 1, policy = basePolicy() } = {}) {
  return { v: 1, iss: config.issuer, aud: protocol.audience, productId: config.productId,
    installationId: metadata.installationId, accountId, iat: now, exp: now + 900, sequence, revision, policy };
}

test("keys rotate through the pinned ring, while wrong bindings, signatures and unknown keys fail", () => {
  const metadata = { installationId: "install-1" };
  const value = claims(metadata);
  const options = { config, installationId: metadata.installationId, accountId: value.accountId, now: 1000 };
  const token = protocol.signLease(value, "next", nextKeys.privateKey);
  assert.deepEqual(protocol.verifyLease(token, options), value);
  assert.throws(() => protocol.verifyLease(token, { ...options, installationId: "install-2" }), /invalid_lease_binding/);
  assert.throws(() => protocol.verifyLease(token, { ...options, config: { ...config, productId: "another-product" } }), /invalid_lease_binding/);
  assert.throws(() => protocol.verifyLease(token, { ...options, now: 1900 }), /lease_expired/);
  assert.throws(() => protocol.verifyLease(protocol.signLease(value, "next", privateKey), options), /invalid_lease_signature/);
  assert.throws(() => protocol.verifyLease(protocol.signLease(value, "retired", privateKey), options), /invalid_lease_key/);
});

test("a relocated client connects to the new origin while preserving its signed issuer identity", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-moved-origin-test-"));
  const moved = protocol.validateConfig({ ...config, serverUrl: "https://new-workbench.example.org" });
  const origins = [];
  const fetcher = async (url, init) => {
    origins.push(new URL(url).origin);
    const metadata = JSON.parse(init.body);
    if (new URL(url).pathname === "/v1/receipt") return new Response(null, { status: 204 });
    return Response.json({ accountId: "account-A", deviceToken: "a".repeat(43),
      lease: protocol.signLease(claims(metadata), "first", privateKey) });
  };
  try {
    const client = new ManagedClient({ protocol, config: moved, file: path.join(directory, "identity.json"),
      dataRoot: path.join(directory, "data"), desktopVersion: "1.5.0", versions: () => ({ backendVersion: "1.5.0" }),
      seal: async value => Buffer.from(value).toString("base64"), open: async value => Buffer.from(value, "base64").toString("utf8"),
      onChange() {}, fetcher, time: () => 1000, random: () => 0 });
    await client.activate("fixture-migration");
    assert.equal(client.snapshot().decision.allowed, true);
    assert.equal(moved.issuer, config.issuer);
    assert.equal(origins.length, 2);
    assert.ok(origins.every(origin => origin === moved.serverUrl));
    const stored = JSON.parse(readFileSync(path.join(directory, "data", "private", "managed", "config.json"), "utf8"));
    assert.equal(stored.issuer, config.issuer);
    assert.equal(stored.serverUrl, moved.serverUrl);
  } finally {
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-moved-origin-test-") && existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("both version minima and all restrictive scopes apply independently", () => {
  const value = claims({ installationId: "install-1" });
  const at = { desktopVersion: "1.3.0", backendVersion: "1.3.0", now: 1000 };
  value.policy.minimumBackendVersion = "1.3.1";
  assert.equal(protocol.evaluateLease(value, at).reason, "update_required");
  value.policy.minimumBackendVersion = null;
  value.policy.minimumDesktopVersion = "1.3.1";
  assert.equal(protocol.evaluateLease(value, at).reason, "update_required");
  value.policy.minimumDesktopVersion = null;
  value.policy.maintenance.active = true;
  value.policy.deviceDisabled = true;
  assert.equal(protocol.evaluateLease(value, at).reason, "device_disabled");
  value.policy.maintenance.active = false;
  assert.equal(protocol.evaluateLease(value, at).reason, "device_disabled");
  value.policy.deviceDisabled = false;
  value.policy.features.codex = false;
  assert.equal(protocol.evaluateLease(value, at).features.codex, false);
});

test("two clients remain isolated across outage, signed suspension, replay and restart", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-managed-test-"));
  let now = 1000;
  let down = false;
  let suspend = false;
  let replay = null;
  let assigned = false;
  let receiptUnavailable = false;
  const devices = new Map();
  const receipts = [];
  const fetcher = async (url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(init.redirect, "error");
    if (down) return Response.json({}, { status: 503 });
    const endpoint = new URL(url).pathname;
    if (endpoint === "/v1/activate") {
      const accountId = request.code.endsWith("A") ? "account-A" : "account-B";
      devices.set(request.installationId, { accountId, sequence: 0 });
    }
    const device = devices.get(request.installationId);
    const deviceToken = (device.accountId.endsWith("A") ? "a" : "b").repeat(43);
    if (endpoint !== "/v1/activate") assert.equal(init.headers.Authorization, "Bearer " + deviceToken);
    if (endpoint === "/v1/receipt") {
      assert.equal(request.deviceToken, undefined);
      if (receiptUnavailable) return Response.json({}, { status: 503 });
      receipts.push(request);
      return new Response(null, { status: 204 });
    }
    if (replay && device.accountId === "account-A") return Response.json({ lease: replay });
    const policy = basePolicy();
    policy.accountDisabled = suspend && device.accountId === "account-A";
    if (assigned && device.accountId === "account-A") policy.release = { version: "1.3.1", notes: "", deadline: null };
    const lease = protocol.signLease(claims(request, {
      now, accountId: device.accountId, sequence: ++device.sequence, revision: suspend ? 2 : 1, policy,
    }), "first", privateKey);
    if (endpoint === "/v1/activate") return Response.json({ lease, deviceToken, accountId: device.accountId });
    return Response.json({ lease });
  };
  const client = name => new ManagedClient({
    protocol, config, file: path.join(directory, `${name}-identity.json`), dataRoot: path.join(directory, name),
    desktopVersion: "1.3.0", versions: () => ({ backendVersion: "1.3.0" }),
    seal: async value => Buffer.from(value).toString("base64"),
    open: async value => Buffer.from(value, "base64").toString("utf8"),
    onChange() {}, fetcher, time: () => now, random: () => 0,
  });
  try {
    const a = client("A");
    const b = client("B");
    await a.activate("fixture-A");
    await b.activate("fixture-B");
    const original = a.identity.lease;
    assert.equal(a.snapshot().decision.allowed, true);
    assert.equal(b.snapshot().decision.allowed, true);
    const projected = JSON.parse(readFileSync(path.join(directory, "A", "private", "managed", "state.json")));
    assert.equal(projected.lease, original);
    assert.equal(projected.sealedCredential, undefined);
    assert.equal(receipts.length, 2);
    assigned = true;
    await a.poll({ force: true });
    receiptUnavailable = true;
    await a.report("failed", "update_download_failed", "1.3.1");
    assert.equal(client("A").identity.pendingUpdate.code, "update_download_failed");
    receiptUnavailable = false;
    await a.poll({ force: true });
    assert.equal(a.identity.pendingUpdate, null);
    assert.equal(receipts.at(-1).code, "update_download_failed");
    now = 1100;
    down = true;
    await a.poll({ force: true });
    assert.equal(a.snapshot().connection, "offline");
    assert.equal(a.snapshot().decision.allowed, true);
    assert.equal(client("A").snapshot().expiresAt, 1900);
    now = 1110;
    down = false;
    suspend = true;
    await a.poll({ force: true });
    await b.poll({ force: true });
    assert.equal(a.snapshot().decision.reason, "account_disabled");
    assert.equal(b.snapshot().decision.allowed, true);
    replay = original;
    await a.poll({ force: true });
    assert.equal(a.snapshot().decision.reason, "account_disabled");
    assert.equal(client("A").snapshot().decision.reason, "account_disabled");
    now = 2011;
    assert.equal(client("B").snapshot().decision.reason, "lease_expired");
    now = 900;
    assert.equal(client("B").snapshot().decision.reason, "clock_invalid");
  } finally {
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-managed-test-") && existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
