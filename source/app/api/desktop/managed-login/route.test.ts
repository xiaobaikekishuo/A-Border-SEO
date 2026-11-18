import type { PrismaClient } from "@prisma/client";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { audience, signLease, type LeaseClaims, type LeasePolicy } from "@/lib/managed/protocol.mjs";
import { managedSessionAdapter } from "@/lib/desktop/managed-session";
import { APP_VERSION } from "@/lib/version";
import { createAccessKey } from "@/lib/access-keys";
import { checkKey } from "@/lib/api-v1/auth";
import { managedUserScope } from "@/lib/managed/identity";

const mocks = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(mocks) }));
import { POST } from "./route";

const origin = "http://localhost:3300";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = "test";
const configuration = { serverUrl: "https://management.example.test", issuer: "https://management.example.test", productId: "a-border-seo",
  keys: { [key]: publicKey.export({ type: "spki", format: "pem" }) } };
let database: TestDb;
let directory: string;
let nonce: string;
let accountId: string;
let owner: string;
let sequence: number;
const policy: LeasePolicy = { productDisabled: false, accountDisabled: false, deviceDisabled: false,
  entitlementExpiresAt: null, maintenance: { active: false, message: "" },
  features: { jobs: true, codex: true, manus: true, geo: true }, minimumDesktopVersion: null, minimumBackendVersion: null, release: null };

function lease(overrides: Partial<LeasePolicy> = {}, issuedAt = Math.floor(Date.now() / 1000)) {
  sequence++;
  const claims: LeaseClaims = { v: 1, iss: configuration.issuer, aud: audience, productId: configuration.productId,
    accountId, installationId: "fixture-installation", iat: issuedAt, exp: issuedAt + 900, sequence, revision: 1,
    policy: { ...policy, ...overrides } };
  const state = { v: 1, installationId: claims.installationId, accountId, lease: signLease(claims, key, privateKey),
    desktopVersion: APP_VERSION, receivedAt: issuedAt, highestWallTime: issuedAt };
  writeFileSync(join(directory, "state.json"), JSON.stringify(state));
}
function post(changes = {}, headers = {}) {
  return POST(new Request(origin + "/api/desktop/managed-login", { method: "POST", headers: {
    Host: "localhost:3300", Origin: origin, "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest", ...headers,
  }, body: JSON.stringify({ nonce, accountId, installationId: "fixture-installation", sequence, ...changes }) }));
}
function cookieToken(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
}
function adapter() { return managedSessionAdapter(PrismaAdapter(database.db), database.db); }

beforeAll(async () => {
  database = await createTestDb();
  mocks.db = database.db;
}, 30_000);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "aborder-managed-session-"));
  nonce = randomBytes(32).toString("base64url");
  accountId = "fixture-account";
  sequence = 0;
  writeFileSync(join(directory, "config.json"), JSON.stringify(configuration));
  writeFileSync(join(directory, "login-nonce"), nonce);
  vi.stubEnv("ABORDER_MANAGED", "1");
  vi.stubEnv("ABORDER_DESKTOP_MODE", "1");
  vi.stubEnv("ABORDER_MANAGED_POLICY_DIR", directory);
  vi.stubEnv("ABORDER_DESKTOP_LOGIN_NONCE_FILE", join(directory, "login-nonce"));
  vi.stubEnv("AUTH_URL", undefined);
  vi.stubEnv("NEXTAUTH_URL", origin);
  await database.db.user.deleteMany();
  owner = (await database.db.user.create({ data: { email: "existing-google@example.test" } })).id;
  await database.db.site.create({ data: { domain: "existing.example.test", userId: owner } });
  lease();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
  rmdirSync(directory);
});
afterAll(async () => database?.close());

describe("registered desktop identity to local session", () => {
  it("requires the exact local origin, private nonce and current signed binding", async () => {
    expect((await post({}, { Origin: "http://attacker.example.test" })).status).toBe(403);
    expect((await post({}, { Host: "attacker.example.test" })).status).toBe(403);
    expect((await post({ nonce: randomBytes(32).toString("base64url") })).status).toBe(403);
    expect((await post({ accountId: "another-account" })).status).toBe(403);
    expect((await post({ installationId: "another-installation" })).status).toBe(403);
    expect((await post({ sequence: sequence + 1 })).status).toBe(403);
    vi.stubEnv("ABORDER_MANAGED", "0");
    expect((await post()).status).toBe(403);
    expect(await database.db.session.count()).toBe(0);
    expect(await database.db.managedIdentity.count()).toBe(0);
  });

  it("creates a separate owning user and real HttpOnly database session without merging existing Google data", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("authjs.session-token=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const session = await adapter().getSessionAndUser!(cookieToken(response));
    expect(session?.user.id).not.toBe(owner);
    expect(session?.user.email).toMatch(/@managed\.invalid$/);
    expect(await database.db.site.count({ where: { userId: owner } })).toBe(1);
    expect(await database.db.site.count({ where: { userId: session!.user.id } })).toBe(0);
    const again = await post();
    expect((await adapter().getSessionAndUser!(cookieToken(again)))?.user.id).toBe(session?.user.id);
    expect(await adapter().getSessionAndUser!(cookieToken(response))).toBeNull();
    expect(await database.db.managedIdentity.count()).toBe(1);
  });

  it("rejects another account's session and any session after logout nonce rotation", async () => {
    const first = cookieToken(await post());
    const original = await adapter().getSessionAndUser!(first);
    accountId = "second-account";
    lease();
    expect(await adapter().getSessionAndUser!(first)).toBeNull();
    const second = cookieToken(await post());
    expect((await adapter().getSessionAndUser!(second))?.user.id).not.toBe(original?.user.id);
    writeFileSync(join(directory, "login-nonce"), randomBytes(32).toString("base64url"));
    expect(await adapter().getSessionAndUser!(second)).toBeNull();
    expect((await post()).status).toBe(403);
  });

  it("allows maintenance read sessions, but rejects disabled, expired and unsigned grants", async () => {
    lease({ maintenance: { active: true, message: "fixture maintenance" } });
    const token = cookieToken(await post());
    expect(await adapter().getSessionAndUser!(token)).not.toBeNull();
    lease({ accountDisabled: true });
    expect(await adapter().getSessionAndUser!(token)).toBeNull();
    expect((await post()).status).toBe(403);
    lease({}, Math.floor(Date.now() / 1000) - 901);
    expect((await post()).status).toBe(403);
    writeFileSync(join(directory, "state.json"), JSON.stringify({ accountId, lease: "unsigned" }));
    expect((await post()).status).toBe(403);
  });

  it("preserves ordinary Google sessions only in unmanaged mode", async () => {
    await database.db.session.create({ data: { userId: owner, sessionToken: "legacy-token", expires: new Date(Date.now() + 60_000) } });
    expect(await adapter().getSessionAndUser!("legacy-token")).toBeNull();
    vi.stubEnv("ABORDER_MANAGED", "0");
    expect((await adapter().getSessionAndUser!("legacy-token"))?.user.id).toBe(owner);
  });

  it("also binds read-only API and MCP keys to the current registered account", async () => {
    const token = cookieToken(await post());
    const managedOwner = (await adapter().getSessionAndUser!(token))!.user.id;
    for (const userId of [owner, managedOwner]) {
      await database.db.userSettings.create({ data: { userId, mcpEnabled: true } });
    }
    const oldKey = await createAccessKey(database.db, owner, "legacy");
    const currentKey = await createAccessKey(database.db, managedOwner, "current");
    const check = (key: string) => checkKey(new Request(origin + "/api/v1/sites", { headers: { Authorization: `Bearer ${key}` } }));
    expect((await check(oldKey.key)).ok).toBe(false);
    expect((await check(currentKey.key)).ok).toBe(true);
    accountId = "another-account";
    lease();
    expect((await check(currentKey.key)).ok).toBe(false);
  });

  it("provides worker owner scope without the desktop nonce or desktop mode", async () => {
    expect(await managedUserScope(database.db)).toEqual({ managed: true, userId: null });
    const token = cookieToken(await post());
    const userId = (await adapter().getSessionAndUser!(token))!.user.id;
    vi.stubEnv("ABORDER_DESKTOP_MODE", undefined);
    vi.stubEnv("ABORDER_DESKTOP_LOGIN_NONCE_FILE", undefined);
    expect(await managedUserScope(database.db)).toEqual({ managed: true, userId });
    lease({ accountDisabled: true });
    expect(await managedUserScope(database.db)).toEqual({ managed: true, userId: null });
    vi.stubEnv("ABORDER_MANAGED", "0");
    expect(await managedUserScope(database.db)).toEqual({ managed: false, userId: null });
  });
});
