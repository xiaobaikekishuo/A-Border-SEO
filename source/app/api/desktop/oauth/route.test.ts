import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";

const mocks = vi.hoisted(() => ({ db: null as PrismaClient | null, auth: vi.fn(), fetchGaSnapshot: vi.fn() }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(mocks) }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/geo/ga-report", async original => ({
  ...await original<typeof import("@/lib/geo/ga-report")>(),
  fetchGaSnapshot: mocks.fetchGaSnapshot,
}));

import { GET as callback } from "@/app/desktop/oauth/ga4/callback/route";
import { completeDesktopLogin, DESKTOP_GA_CALLBACK, SESSION_COOKIE } from "@/lib/desktop/oauth";
import { POST } from "./route";

const origin = "http://localhost:3300";
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const report = { propertyId: "123456", start: "2026-11-01", end: "2026-11-02", expectedUpdatedAt: null };
let database: TestDb;
let owner: string;
let otherUser: string;
let siteId: string;

function post(input: object, requestOrigin = origin) {
  return POST(new Request(origin + "/api/desktop/oauth", {
    method: "POST",
    headers: {
      "Host": "localhost:3300",
      "Origin": requestOrigin,
      "Content-Type": "application/json",
      "X-Requested-With": "XmlHttpRequest",
    },
    body: JSON.stringify(input),
  }));
}

function gaCallback(query: string) {
  return callback(new Request(origin + DESKTOP_GA_CALLBACK + "?" + query, {
    headers: { "Host": "localhost:3300" },
  }));
}

beforeAll(async () => {
  database = await createTestDb();
  mocks.db = database.db;
  owner = (await database.db.user.create({ data: { email: "owner@example.test" } })).id;
  otherUser = (await database.db.user.create({ data: { email: "other@example.test" } })).id;
  siteId = (await database.db.site.create({ data: { userId: owner, domain: "example.test" } })).id;
}, 30_000);

beforeEach(async () => {
  vi.stubEnv("AUTH_URL", undefined);
  vi.stubEnv("NEXTAUTH_URL", origin);
  vi.stubEnv("NEXTAUTH_SECRET", "test-only-key");
  vi.stubEnv("ABORDER_DESKTOP_MODE", "1");
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  mocks.auth.mockResolvedValue(null);
  mocks.fetchGaSnapshot.mockReset();
  await database.db.desktopLoginChallenge.deleteMany();
  await database.db.desktopOAuthAttempt.deleteMany();
  await database.db.session.deleteMany();
  await database.db.geoSnapshot.deleteMany();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => database?.close());

describe("desktop Google session handoff", () => {
  it("requires explicit local mode and an exact loopback request origin", async () => {
    expect((await post({ action: "login", challenge }, "http://localhost:3301")).status).toBe(403);
    vi.stubEnv("ABORDER_DESKTOP_MODE", undefined);
    expect((await post({ action: "login", challenge })).status).toBe(404);
    expect(await database.db.desktopLoginChallenge.count()).toBe(0);
    expect(await database.db.desktopOAuthAttempt.count()).toBe(0);
  });

  it("binds browser approval to one matching proof and sets a separate database session cookie", async () => {
    const started = await post({ action: "login", challenge });
    const { id, url } = await started.json();
    expect(url).toBe(origin + "/desktop/oauth/login?id=" + id);
    expect(await (await post({ action: "status", id, verifier })).json()).toEqual({ status: "pending" });
    expect((await post({ action: "claim", id, verifier })).status).toBe(410);
    expect(await completeDesktopLogin(id, owner)).toBe(true);
    expect(await database.db.desktopLoginChallenge.count()).toBe(0);
    expect(await completeDesktopLogin(id, otherUser)).toBe(false);
    expect((await post({ action: "claim", id, verifier: "b".repeat(43) })).status).toBe(410);

    const claimed = await post({ action: "claim", id, verifier });
    const cookie = claimed.headers.get("set-cookie");
    expect(claimed.status).toBe(200);
    expect(cookie).toMatch(new RegExp("^" + SESSION_COOKIE.replace(".", "\\.") + "="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(await claimed.json()).toEqual({ signedIn: true });
    expect(await database.db.session.findMany({ select: { userId: true } })).toEqual([{ userId: owner }]);
    expect((await post({ action: "claim", id, verifier })).status).toBe(410);
  });

  it("invalidates an approved handoff when its user is deleted", async () => {
    const removedUser = await database.db.user.create({ data: { email: "removed@example.test" } });
    const { id } = await (await post({ action: "login", challenge })).json();
    expect(await completeDesktopLogin(id, removedUser.id)).toBe(true);
    await database.db.user.delete({ where: { id: removedUser.id } });

    const claimed = await post({ action: "claim", id, verifier });
    expect(claimed.status).toBe(410);
    expect(claimed.headers.has("set-cookie")).toBe(false);
    expect(await completeDesktopLogin(id, owner)).toBe(false);
  });
});

describe("desktop GA4 authorization", () => {
  it("retains the owning site, report arguments and PKCE verifier through the system-browser callback", async () => {
    mocks.auth.mockResolvedValue({ user: { id: owner } });
    const { id, url } = await (await post({ action: "ga4", challenge, siteId, report })).json();
    const authorization = new URL(url);
    expect(authorization.searchParams.get("state")).toBe(id);
    expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
    expect(authorization.searchParams.get("scope")).toMatch(/analytics\.readonly$/);
    expect((await gaCallback(`state=${id}&state=${id}&code=demo-code`)).status).toBe(400);
    expect((await gaCallback(`state=${id}&code=demo-code`)).status).toBe(303);
    expect(mocks.fetchGaSnapshot).not.toHaveBeenCalled();
    const attempt = await database.db.desktopOAuthAttempt.findUnique({ where: { id } });
    expect(attempt?.code).not.toContain("demo-code");

    mocks.auth.mockResolvedValue({ user: { id: otherUser } });
    expect((await post({ action: "claim", id, verifier })).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: owner } });
    mocks.fetchGaSnapshot.mockResolvedValue({ start: report.start, end: report.end, rows: [], skipped: 0, processed: 0, notes: [] });
    expect((await post({ action: "claim", id, verifier })).status).toBe(200);
    expect(mocks.fetchGaSnapshot).toHaveBeenCalledWith({ ...report, code: "demo-code" }, "example.test", origin + DESKTOP_GA_CALLBACK, verifier);
    expect(await database.db.geoSnapshot.count({ where: { siteId } })).toBe(1);
    expect((await post({ action: "claim", id, verifier })).status).toBe(410);
  });

  it("discards a cancelled attempt before any report is fetched", async () => {
    mocks.auth.mockResolvedValue({ user: { id: owner } });
    const { id } = await (await post({ action: "ga4", challenge, siteId, report })).json();
    expect((await post({ action: "cancel", id, verifier })).status).toBe(200);
    expect((await gaCallback(`state=${id}&code=demo-code`)).status).toBe(400);
    expect(mocks.fetchGaSnapshot).not.toHaveBeenCalled();
  });
});
