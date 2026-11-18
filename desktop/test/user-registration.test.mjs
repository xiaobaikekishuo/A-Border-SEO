import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedClient } from "../managed-client.mjs";
import * as protocol from "../../source/lib/managed/protocol.mjs";
import { createControlPlane } from "../../control-plane/server.mjs";
import { configureAdmin } from "../../control-plane/admin-auth.mjs";
import { openDatabase } from "../../control-plane/db.mjs";

test("user registration requires approval and logout revokes local workspace authority without retaining passwords", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aborder-desktop-user-"));
  const db = openDatabase(path.join(directory, "control.sqlite"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const serverConfig = { origin: "http://127.0.0.1", secure: false, leaseSeconds: 900, kid: "test", privateKey };
  configureAdmin(db, "operator", "test-administrator-secret");
  const server = createControlPlane({ db, config: serverConfig });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  serverConfig.origin += ":" + server.address().port;
  const config = protocol.validateConfig({ serverUrl: serverConfig.origin, issuer: serverConfig.origin,
    productId: "a-border-seo", keys: { test: publicKey.export({ type: "spki", format: "pem" }) } }, { allowHttpLoopback: true });
  const identityFile = path.join(directory, "identity.json");
  const dataRoot = path.join(directory, "installation");
  const client = () => new ManagedClient({ protocol, config, file: identityFile, dataRoot, desktopVersion: "1.4.0",
    requireUser: true, versions: () => ({ backendVersion: "1.4.0" }), onChange() {},
    seal: async value => Buffer.from(value).toString("base64"), open: async value => Buffer.from(value,"base64").toString() });
  const post = (url, body, headers = {}) => fetch(config.serverUrl + url, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.serverUrl, ...headers }, body: JSON.stringify(body) });
  try {
    const current = client();
    const credentials = { username: "desktop_owner", password: "desktop-fixture-password" };
    await current.register(credentials);
    assert.equal(current.snapshot().pendingUsername, credentials.username);
    assert.equal(current.snapshot().signedIn, false);
    assert.equal(current.snapshot().decision.allowed, false);
    await assert.rejects(current.login(credentials), /account_pending/);
    const login = await post("/admin/login", { username: "operator", password: "test-administrator-secret" });
    const { csrf } = await login.json();
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const overview = await fetch(config.serverUrl + "/admin/api/state", { headers: { Cookie: cookie } }).then(r => r.json());
    const account = overview.accounts.find(row => row.username === credentials.username);
    assert(account);
    const approved = await post("/admin/api/accounts", { productId: config.productId, id: account.id,
      label: account.label, enabled: true, expiresAt: null, deviceLimit: 1, features: account.features,
      reason: "Approve isolated registration" }, { Cookie: cookie, "X-CSRF-Token": csrf });
    assert.equal(approved.status, 200);
    await current.login(credentials);
    assert.equal(current.snapshot().signedIn, true);
    assert.equal(current.snapshot().decision.allowed, true);
    assert.equal(client().snapshot().signedIn, true);
    const installation = current.snapshot().installationId;
    assert(!readFileSync(identityFile,"utf8").includes(credentials.password));
    const projectedFile = path.join(dataRoot, "private", "managed", "state.json");
    assert(JSON.parse(readFileSync(projectedFile,"utf8")).lease);
    await current.logout();
    assert.equal(current.snapshot().signedIn, false);
    assert.equal(JSON.parse(readFileSync(projectedFile,"utf8")).lease, null);
    assert.equal(client().snapshot().decision.allowed, false);
    await current.poll({ force: true });
    assert.equal(current.snapshot().signedIn, false);
    await current.login(credentials);
    assert.equal(current.snapshot().installationId, installation);
    assert.equal(current.snapshot().decision.allowed, true);
    const otherRoot = path.join(directory, "other-installation");
    current.setDataRoot(otherRoot);
    assert.equal(JSON.parse(readFileSync(projectedFile,"utf8")).lease, null);
    assert(JSON.parse(readFileSync(path.join(otherRoot,"private","managed","state.json"),"utf8")).lease);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith("aborder-desktop-user-")) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
