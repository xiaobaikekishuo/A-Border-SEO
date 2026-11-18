import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real Prisma client on PGlite; auth, DNS and next/server's after() are
// stubbed. Manual sites must work without Google and without a GSC job.

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
const session = vi.hoisted(() => ({ userId: "u1" as string | null }));
const listGSCProperties = vi.hoisted(() => vi.fn());
const after = vi.hoisted(() => vi.fn());
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.userId ? { user: { id: session.userId } } : null }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});
vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/google", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/google")>(), listGSCProperties,
}));

import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { SERVERLESS_MAX_DURATION_S } from "@/lib/jobs/config";
import { setSitePolicy } from "@/lib/site-policy";
import { getWorkbenchWorkspace } from "@/lib/ai-workbench/data";
import { ReauthRequiredError } from "@/lib/google";
import { maxDuration, POST } from "./route";

let t: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  t = await createTestDb();
  db = holder.db = t.db;
  await db.user.create({ data: { id: "u1", email: "demo@quayline.app" } });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await db.job.deleteMany();
  await db.site.deleteMany();
  after.mockClear();
  session.userId = "u1";
  lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  listGSCProperties.mockReset().mockResolvedValue([{ siteUrl: "sc-domain:quayline.app", permissionLevel: "siteOwner" }]);
  vi.unstubAllEnvs();
  setSitePolicy(null);
});

const add = (gscProperty: string) =>
  POST(new Request("http://localhost/api/sites", { method: "POST", body: JSON.stringify({ gscProperty }) }));
const addBody = (body: unknown) =>
  POST(new Request("http://localhost/api/sites", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/sites", () => {
  it("opens the workbench for a manual site owned by a user with no Google authorization", async () => {
    const afterCreate = vi.fn(async () => {});
    const canAdd = vi.fn(async () => ({ ok: true as const }));
    setSitePolicy({ canAdd, afterCreate });
    expect((await db.user.findUniqueOrThrow({ where: { id: "u1" } })).googleTokens).toBeNull();

    const res = await addBody({ domain: " https://WWW.Quayline.app/blog/?topic=seo " });
    expect(res.status).toBe(201);
    const site = await res.json();
    expect(site).toMatchObject({ domain: "www.quayline.app", gscProperty: null });
    expect(await db.site.findUnique({ where: { id: site.id } })).toMatchObject({ userId: "u1", domain: "www.quayline.app", gscProperty: null });
    expect(canAdd).toHaveBeenCalledWith({ id: "u1" }, { domain: "www.quayline.app", gscProperty: null });
    expect(afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: site.id, userId: "u1", gscProperty: null }));
    expect(await db.job.count()).toBe(0);
    expect(listGSCProperties).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(await getWorkbenchWorkspace(db, "u1", site.id)).toMatchObject({ site: { id: site.id, domain: "www.quayline.app" }, pages: [], jobs: [] });
  });

  it("refuses a manual site when the deployment policy denies it", async () => {
    setSitePolicy({ canAdd: async () => ({ ok: false, reason: "Site limit reached", status: 403 }) });
    const res = await addBody({ domain: "quayline.app" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Site limit reached" });
    expect(await db.site.count()).toBe(0);
    expect(await db.job.count()).toBe(0);
  });

  it("refuses unauthenticated creation before looking up a domain", async () => {
    session.userId = null;
    expect((await addBody({ domain: "quayline.app" })).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(await db.site.count()).toBe(0);
  });

  it.each([{}, null, [], { domain: "" }, { domain: 123 }, { domain: "https://" },
    { domain: "localhost" }, { domain: "http://127.0.0.1/" }, { domain: "http://[::1]/" },
    { domain: "printer.local" }, { domain: "quayline.app", gscProperty: false },
    { domain: "quayline.app", gscProperty: "" }])("rejects malformed or non-public input %j", async body => {
    expect((await addBody(body)).status).toBe(400);
    expect(await db.site.count()).toBe(0);
  });

  it("rejects a public-looking domain that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const res = await addBody({ domain: "quayline.app" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Domain must resolve to a public IP address" });
    expect(await db.site.count()).toBe(0);
  });

  it("deduplicates normalized manual domains", async () => {
    expect((await addBody({ domain: "https://QUAYLINE.app/blog" })).status).toBe(201);
    const duplicate = await addBody({ domain: "quayline.app/" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "Site already exists" });
    expect(await db.site.count()).toBe(1);
  });

  it("returns a conflict when a duplicate appears after the initial lookup", async () => {
    // PGlite's wire bridge closes the connection after a unique violation.
    // Model that specific Prisma result without corrupting later DB checks.
    const create = vi.spyOn(db.site, "create").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed", { code: "P2002", clientVersion: Prisma.prismaVersion.client },
    ));
    try {
      const res = await addBody({ domain: "https://quayline.app/" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Site already exists" });
      expect(await db.site.count()).toBe(0);
      expect(await db.job.count()).toBe(0);
    } finally {
      create.mockRestore();
    }
  });

  it("queues the initial GSC sync for the new site", async () => {
    const res = await add("sc-domain:quayline.app");
    expect(res.status).toBe(201);
    expect(listGSCProperties).toHaveBeenCalledWith("u1");
    const site = (await res.json()) as { id: string };
    expect(await db.job.findFirstOrThrow({ where: { siteId: site.id } })).toMatchObject({
      type: "gsc-sync",
      source: "site-added",
      status: "QUEUED",
    });
  });

  it("requires Google authorization when a property is supplied directly", async () => {
    listGSCProperties.mockRejectedValueOnce(new ReauthRequiredError());
    const res = await add("sc-domain:quayline.app");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(await db.site.count()).toBe(0);
    expect(await db.job.count()).toBe(0);
  });

  it.each([{ properties: [] }, { properties: [{ siteUrl: "sc-domain:quayline.app", permissionLevel: "siteUnverifiedUser" }] }])("rejects properties absent from the user's verified resources", async ({ properties }) => {
    listGSCProperties.mockResolvedValueOnce(properties);
    const res = await add("sc-domain:quayline.app");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "GSC_PROPERTY_UNAVAILABLE" });
    expect(await db.site.count()).toBe(0);
    expect(await db.job.count()).toBe(0);
  });

  it("keeps provider details out of a failed verification response", async () => {
    listGSCProperties.mockRejectedValueOnce(new Error("sensitive upstream detail"));
    const res = await add("sc-domain:quayline.app");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not verify Search Console access. Please try again.", code: "GSC_PROPERTIES_UNAVAILABLE" });
    expect(await db.site.count()).toBe(0);
  });

  it("derives a connected site's domain from its GSC property even when a different domain is supplied", async () => {
    const res = await addBody({ domain: "untrusted.example", gscProperty: " sc-domain:quayline.app " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ domain: "quayline.app", gscProperty: "sc-domain:quayline.app" });
    expect(await db.job.count({ where: { type: "gsc-sync" } })).toBe(1);
  });

  it("on a serverless host runs that sync after the response, within the route's time limit", async () => {
    vi.stubEnv("VERCEL", "1");
    expect((await add("sc-domain:quayline.app")).status).toBe(201);
    expect(after).toHaveBeenCalledTimes(1);
    expect(maxDuration).toBe(SERVERLESS_MAX_DURATION_S);
  });

  it("refuses a site the site policy does not allow, and creates nothing", async () => {
    const canAdd = vi.fn(async () => ({ ok: false as const, reason: "Verify this site in Search Console first", status: 403 }));
    setSitePolicy({ canAdd });
    const res = await add("sc-domain:quayline.app");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Verify this site in Search Console first" });
    expect(canAdd).toHaveBeenCalledWith({ id: "u1" }, { domain: "quayline.app", gscProperty: "sc-domain:quayline.app" });
    expect(await db.site.count()).toBe(0);
  });

  it("tells the site policy about the new site", async () => {
    const afterCreate = vi.fn(async () => {});
    setSitePolicy({ afterCreate });
    const res = await add("sc-domain:quayline.app");
    const site = (await res.json()) as { id: string };
    expect(afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: site.id, userId: "u1", domain: "quayline.app" }));
  });
});
