import type { PrismaClient } from "@prisma/client";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { audience, signLease, type LeaseClaims } from "@/lib/managed/protocol.mjs";
import { APP_VERSION } from "@/lib/version";
import { openGoogleTokens, sealGoogleTokens } from "@/lib/google/token-store";
import { getAccessToken, ReauthRequiredError } from "@/lib/google/google-auth";

const mocks = vi.hoisted(() => ({ db: null as PrismaClient | null, auth: vi.fn(), googleFetch: vi.fn() }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(mocks) }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/google/google-fetch", () => ({ googleFetch: mocks.googleFetch }));
import { GET, POST } from "./route";
import { handleGoogleConnectionCallback as callback } from "@/lib/google/connection-callback";
import { GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK, GOOGLE_CONNECTION_STATE_PREFIX, GSC_CONNECTION_SCOPE } from "@/lib/google/connection";

const origin = "http://localhost:3300";
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const config = { serverUrl: "https://management.example.test", issuer: "https://management.example.test", productId: "a-border-seo",
  keys: { fixture: publicKey.export({ type: "spki", format: "pem" }) } };
const grant = { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600,
  token_type: "Bearer", scope: GSC_CONNECTION_SCOPE };
let database: TestDb;
let directory: string;
let owner: string;
let other: string;

function post(input: object, extra = {}) {
  return POST(new Request(origin + "/api/google/connection", { method: "POST", headers: {
    Host: "localhost:3300", Origin: origin, "X-Requested-With": "XmlHttpRequest", "Content-Type": "application/json", ...extra,
  }, body: JSON.stringify(input) }));
}
function returned(query: string, path = GOOGLE_CONNECTION_CALLBACK) {
  return callback(new Request(origin + path + "?" + query, { headers: { Host: "localhost:3300" } }));
}
async function start() {
  const response = await post({ action: "start", challenge });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; url: string }>;
}
async function approve() {
  const value = await start();
  expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${value.id}&code=fixture-code`)).status).toBe(303);
  return value;
}
function writeLease(disabled = false) {
  const now = Math.floor(Date.now() / 1000);
  const claims: LeaseClaims = { v: 1, iss: config.issuer, aud: audience, productId: config.productId,
    accountId: "registered-owner", installationId: "fixture-installation", iat: now, exp: now + 900, sequence: 1, revision: 1,
    policy: { productDisabled: false, accountDisabled: disabled, deviceDisabled: false, entitlementExpiresAt: null,
      maintenance: { active: false, message: "" }, features: { jobs: true, codex: true, manus: true, geo: true },
      minimumDesktopVersion: null, minimumBackendVersion: null, release: null } };
  writeFileSync(join(directory, "state.json"), JSON.stringify({ v: 1, installationId: claims.installationId,
    accountId: claims.accountId, lease: signLease(claims, "fixture", privateKey), desktopVersion: APP_VERSION,
    receivedAt: now, highestWallTime: now }));
}

beforeAll(async () => { database = await createTestDb(); mocks.db = database.db; }, 30_000);
beforeEach(async () => {
  await database.db.user.deleteMany();
  owner = (await database.db.user.create({ data: { email: randomBytes(6).toString("hex") + "@managed.invalid", name: "Registered owner" } })).id;
  other = (await database.db.user.create({ data: { email: "other-google@example.test" } })).id;
  await database.db.managedIdentity.create({ data: { issuer: config.issuer, productId: config.productId, accountId: "registered-owner", userId: owner } });
  directory = mkdtempSync(join(tmpdir(), "aborder-google-connection-"));
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  writeFileSync(join(directory, "nonce"), randomBytes(32).toString("base64url"));
  writeLease();
  vi.stubEnv("ABORDER_MANAGED", "1");
  vi.stubEnv("ABORDER_DESKTOP_MODE", "1");
  vi.stubEnv("ABORDER_MANAGED_POLICY_DIR", directory);
  vi.stubEnv("ABORDER_DESKTOP_LOGIN_NONCE_FILE", join(directory, "nonce"));
  vi.stubEnv("AUTH_URL", undefined);
  vi.stubEnv("NEXTAUTH_URL", origin);
  vi.stubEnv("NEXTAUTH_SECRET", "fixture-encryption-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-client-secret");
  mocks.auth.mockResolvedValue({ user: { id: owner } });
  mocks.googleFetch.mockReset().mockImplementation(async () => Response.json(grant));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
  rmdirSync(directory);
});
afterAll(async () => database?.close());

describe("Google connection for an existing registered workspace owner", () => {
  it("reports missing configuration and absent tokens without treating them as a server error", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(await (await GET()).json()).toMatchObject({ configured: false, connected: false, reason: "GOOGLE_CONNECTION_NOT_CONFIGURED" });
    expect((await post({ action: "start", challenge })).status).toBe(503);
    expect(await database.db.desktopOAuthAttempt.count()).toBe(0);
    await expect(getAccessToken(owner)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("requires current application login, local origin and current managed owner", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await post({ action: "start", challenge })).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: owner } });
    expect((await post({ action: "start", challenge }, { Origin: "https://attacker.example.test" })).status).toBe(403);
    mocks.auth.mockResolvedValue({ user: { id: other } });
    expect((await post({ action: "start", challenge })).status).toBe(403);
  });

  it("uses PKCE and offline GSC-only consent; callback stages an encrypted grant without changing login", async () => {
    const { id, url } = await start();
    const target = new URL(url);
    expect(target.searchParams.get("redirect_uri")).toBe(origin + GOOGLE_CONNECTION_CALLBACK);
    expect(target.searchParams.get("scope")).toBe(GSC_CONNECTION_SCOPE);
    expect(target.searchParams.get("access_type")).toBe("offline");
    expect(target.searchParams.get("code_challenge")).toBe(challenge);
    expect(target.searchParams.get("state")).toBe(GOOGLE_CONNECTION_STATE_PREFIX + id);
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=fixture-code`)).status).toBe(400);
    mocks.auth.mockResolvedValue(null);
    const response = await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=fixture-code`);
    expect(response.status).toBe(303);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("location")).not.toContain("fixture-code");
    expect((await database.db.desktopOAuthAttempt.findUniqueOrThrow({ where: { id } })).code).not.toContain("fixture-code");
    expect(mocks.googleFetch).not.toHaveBeenCalled();
    expect(await database.db.session.count()).toBe(0);
  });

  it("rejects unknown, malformed and duplicate namespaced state without touching login or exchanging a grant", async () => {
    const { id } = await start();
    for (const query of [
      `state=${GOOGLE_CONNECTION_STATE_PREFIX}${"z".repeat(43)}&code=fixture-code`,
      `state=${GOOGLE_CONNECTION_STATE_PREFIX}invalid&code=fixture-code`,
      `state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&state=nextauth-state&code=fixture-code`,
      `state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=one&code=two`,
      `state=${id}&code=fixture-code`,
    ]) {
      const response = await returned(query);
      expect(response.status).toBe(400);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    expect((await database.db.desktopOAuthAttempt.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(await database.db.session.count()).toBe(0);
    expect(mocks.googleFetch).not.toHaveBeenCalled();
  });

  it("binds the callback path and exchange redirect to the transaction, including legacy in-flight grants", async () => {
    const { id } = await start();
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=fixture-code`, GOOGLE_CONNECTION_LEGACY_CALLBACK)).status).toBe(400);
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=fixture-code`)).status).toBe(303);
    expect((await post({ action: "claim", id, verifier })).status).toBe(200);
    expect(mocks.googleFetch.mock.calls[0][1].body.get("redirect_uri")).toBe(origin + GOOGLE_CONNECTION_CALLBACK);

    const legacy = await start();
    const row = await database.db.desktopOAuthAttempt.findUniqueOrThrow({ where: { id: legacy.id } });
    const report = { ...row.report as Record<string, string> };
    delete report.redirectUri;
    await database.db.desktopOAuthAttempt.update({ where: { id: legacy.id }, data: { report } });
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${legacy.id}&code=fixture-code`)).status).toBe(400);
    expect((await returned(`state=${legacy.id}&code=fixture-code`, GOOGLE_CONNECTION_LEGACY_CALLBACK)).status).toBe(303);
    expect((await post({ action: "claim", id: legacy.id, verifier })).status).toBe(200);
    expect(mocks.googleFetch.mock.calls[1][1].body.get("redirect_uri")).toBe(origin + GOOGLE_CONNECTION_LEGACY_CALLBACK);
    expect(await database.db.session.count()).toBe(0);
    expect(await database.db.account.count()).toBe(0);
  });

  it("only attaches tokens to the initiating user after matching proof, never creates or switches accounts", async () => {
    const before = await database.db.user.findUniqueOrThrow({ where: { id: owner } });
    const { id } = await approve();
    expect((await post({ action: "claim", id, verifier: "b".repeat(43) })).status).toBe(410);
    mocks.auth.mockResolvedValue({ user: { id: other } });
    expect((await post({ action: "claim", id, verifier })).status).toBe(410);
    mocks.auth.mockResolvedValue({ user: { id: owner } });
    const response = await post({ action: "claim", id, verifier });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    const [endpoint, options] = mocks.googleFetch.mock.calls[0];
    expect(endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(options.body.get("code_verifier")).toBe(verifier);
    expect(options.body.get("redirect_uri")).toBe(origin + GOOGLE_CONNECTION_CALLBACK);
    const after = await database.db.user.findUniqueOrThrow({ where: { id: owner } });
    expect(after.email).toBe(before.email);
    expect(after.name).toBe(before.name);
    expect(JSON.stringify(after.googleTokens)).not.toContain("fixture-access");
    expect(openGoogleTokens(after.googleTokens)?.refreshToken).toBe("fixture-refresh");
    expect((await database.db.user.findUniqueOrThrow({ where: { id: other } })).googleTokens).toBeNull();
    expect(await database.db.user.count()).toBe(2);
    expect(await database.db.account.count()).toBe(0);
    expect(await (await GET()).json()).toMatchObject({ configured: true, connected: true });
    expect((await post({ action: "claim", id, verifier })).status).toBe(410);
  });

  it("cancels, expires and declines without exchanging or storing tokens", async () => {
    const { id } = await start();
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&error=access_denied`)).status).toBe(303);
    expect(await (await post({ action: "status", id, verifier })).json()).toEqual({ status: "declined" });
    expect((await post({ action: "claim", id, verifier })).status).toBe(409);
    expect((await post({ action: "cancel", id, verifier })).status).toBe(200);
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${id}&code=fixture-code`)).status).toBe(400);
    const next = await start();
    await database.db.desktopOAuthAttempt.update({ where: { id: next.id }, data: { expiresAt: new Date(0) } });
    expect((await post({ action: "status", id: next.id, verifier })).status).toBe(410);
    expect(mocks.googleFetch).not.toHaveBeenCalled();
  });

  it("invalidates the grant when logout rotates nonce or the account is disabled", async () => {
    const { id } = await approve();
    writeFileSync(join(directory, "nonce"), randomBytes(32).toString("base64url"));
    expect((await post({ action: "claim", id, verifier })).status).toBe(403);
    const next = await start();
    writeLease(true);
    expect((await returned(`state=${GOOGLE_CONNECTION_STATE_PREFIX}${next.id}&code=fixture-code`)).status).toBe(400);
    expect(mocks.googleFetch).not.toHaveBeenCalled();
  });

  it("rechecks policy after exchange and preserves the current stored connection on a race", async () => {
    const prior = sealGoogleTokens({ accessToken: "old-access", refreshToken: "old-refresh", scope: GSC_CONNECTION_SCOPE });
    await database.db.user.update({ where: { id: owner }, data: { googleTokens: prior } });
    const { id } = await approve();
    mocks.googleFetch.mockImplementationOnce(async () => { writeLease(true); return Response.json(grant); });
    expect((await post({ action: "claim", id, verifier })).status).toBe(403);
    expect(openGoogleTokens((await database.db.user.findUniqueOrThrow({ where: { id: owner } })).googleTokens)?.accessToken).toBe("old-access");
    writeLease(false);
    const next = await approve();
    mocks.googleFetch.mockImplementationOnce(async () => {
      await database.db.user.update({ where: { id: owner }, data: { name: "Changed profile" } });
      return Response.json(grant);
    });
    expect((await post({ action: "claim", id: next.id, verifier })).status).toBe(409);
  });

  it("returns fixed errors for rejected/incomplete Google responses and never exposes provider secrets", async () => {
    const { id } = await approve();
    mocks.googleFetch.mockResolvedValueOnce(new Response("secret-provider-fixture", { status: 400 }));
    const response = await post({ action: "claim", id, verifier });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-provider-fixture");
    const next = await approve();
    mocks.googleFetch.mockResolvedValueOnce(Response.json({ ...grant, scope: "openid" }));
    expect((await post({ action: "claim", id: next.id, verifier })).status).toBe(502);
    expect((await database.db.user.findUniqueOrThrow({ where: { id: owner } })).googleTokens).toBeNull();
  });
});
