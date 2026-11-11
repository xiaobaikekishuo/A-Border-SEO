import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Starting a tracking run or a trial. The cost confirmation must match the
// kind asked for, and a site has one run or trial at a time. The route runs
// against the real Prisma client; auth and the dispatch are stubbed, so no
// job runs and nothing calls DataForSEO.

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
const dispatchJob = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchJob }));

import { encrypt } from "@/lib/encryption";
import { addPrompts, saveTrackingSettings } from "@/lib/geo/tracking";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { POST } from "./route";

let t: TestDb;
let db: PrismaClient;
const SITE = "s1";

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
  t = await createTestDb();
  db = holder.db = t.db;
  await db.user.create({ data: { id: "u1", email: "owner@local.test" } });
  await db.site.create({ data: { id: SITE, userId: "u1", domain: "kammakhome.com" } });
  await db.apiKey.create({ data: { userId: "u1", provider: "dataforseo", encryptedLogin: encrypt("login"), encryptedPassword: encrypt("password") } });
  await saveTrackingSettings(db, "u1", SITE, {
    brands: { own: { name: "Kammak", aliases: [], domains: [] }, competitors: [] },
    platforms: ["CHATGPT", "GOOGLE_AIO", "PERPLEXITY"], scheduleDays: null, budgetUsd: 1,
  });
  await addPrompts(db, "u1", SITE, { prompts: [{ text: "best sofa brand" }, { text: "sofa for small rooms" }] });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await db.job.deleteMany();
  dispatchJob.mockClear();
});

function start(body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/sites/${SITE}/geo/tracking/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "dataforseo", confirmed: true, language: "en", location: 2840, ...body }),
    }),
    { params: Promise.resolve({ siteId: SITE }) }
  );
}

describe("POST /api/sites/[siteId]/geo/tracking/run", () => {
  it("starts a full run for the confirmed number of tasks: every active prompt on every platform", async () => {
    const res = await start({ operations: 6 });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({ status: "QUEUED", tasks: 6, trial: false, budgetUsd: 1 });
    expect(body.alreadyActive).toBeUndefined();
    expect(await db.job.findMany({ select: { id: true, type: true, source: true, siteId: true } })).toEqual([{ id: body.jobId, type: "geo-visibility", source: "manual", siteId: SITE }]);
    expect(dispatchJob).toHaveBeenCalledOnce();
  });

  it("starts a trial for one task per platform, as its own job type", async () => {
    const res = await start({ trial: true, operations: 3 });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ status: "QUEUED", tasks: 3, trial: true });
    expect((await db.job.findUniqueOrThrow({ where: { id: body.jobId } })).type).toBe("geo-visibility-trial");
  });

  it("refuses a confirmation made for the other kind, and starts nothing", async () => {
    // The full run's count sent for a trial, and the trial's count sent for a full run.
    for (const body of [{ trial: true, operations: 6 }, { operations: 3 }, { trial: true }]) {
      const res = await start(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "PAYMENT_CONFIRMATION_REQUIRED" });
    }
    expect(await db.job.count()).toBe(0);
    expect(dispatchJob).not.toHaveBeenCalled();
  });

  it("answers with the run or trial already under way instead of starting a second one", async () => {
    const trial = await (await start({ trial: true, operations: 3 })).json();
    // A full run asked for while the trial is queued: the trial is returned, nothing new is queued.
    const full = await start({ operations: 6 });
    expect(full.status).toBe(202);
    expect(await full.json()).toMatchObject({ jobId: trial.jobId, alreadyActive: true, trial: true });
    // The same trial asked for twice: the same job.
    expect(await (await start({ trial: true, operations: 3 })).json()).toMatchObject({ jobId: trial.jobId, alreadyActive: true });
    expect(await db.job.count()).toBe(1);
    expect(dispatchJob).toHaveBeenCalledTimes(2);

    // And the other way round: a trial asked for while a full run is queued.
    await db.job.deleteMany();
    const run = await (await start({ operations: 6 })).json();
    expect(await (await start({ trial: true, operations: 3 })).json()).toMatchObject({ jobId: run.jobId, alreadyActive: true, trial: false });
    expect(await db.job.count()).toBe(1);
  });

  it("is the owner's only", async () => {
    await db.user.create({ data: { id: "u2", email: "other@local.test" } });
    await db.site.create({ data: { id: "s2", userId: "u2", domain: "other.test" } });
    const res = await POST(
      new Request("http://localhost/api/sites/s2/geo/tracking/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "dataforseo", confirmed: true, operations: 3, language: "en", location: 2840 }) }),
      { params: Promise.resolve({ siteId: "s2" }) }
    );
    expect(res.status).toBe(404);
    expect(await db.job.count()).toBe(0);
  });
});
