import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { getWorkbenchWorkspace, runWorkbenchAction } from "../data";
import { fillSite } from "./fill";
import { getPoolView, runPoolAction, savePool } from "./view";

// The background pool on PGlite: an idle claim turns a waiting item into a
// task only when the worker's reading allows it, a task the owner starts
// takes the place of a background one, the caps hold, the fillers say what
// they found, and work queued by hand is not queued twice.

let database: TestDb; let db: PrismaClient;
const now = new Date("2026-11-20T12:00:00Z");
const user = "pool-owner"; const site = "pool-site";
const siteRef = { id: site, domain: "pool.example" };
const searchDay = new Date("2026-11-10T00:00:00Z");
const seconds = (ms: number) => Math.round((now.getTime() + ms) / 1000);
const reading = (short: number, weekly: number) => ({ planType: "plus", reached: false, hasCredits: null,
  primary: { usedPercent: short, windowMinutes: 300, resetsAt: seconds(3600_000) },
  secondary: { usedPercent: weekly, windowMinutes: 10080, resetsAt: seconds(3 * 86400_000) } });

beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.create({ data: { id: user, email: "pool@pool.example" } });
  await db.site.create({ data: { id: site, userId: user, domain: "pool.example" } });
  await db.contentPillar.create({ data: { id: "pool-pillar", siteId: site, title: "Leather", keyword: "leather goods" } });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.aiBacklogItem.deleteMany(); await db.aiWorkbenchJob.deleteMany(); await db.contentCluster.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.aiPoolSetting.deleteMany(); await db.aiAutomation.deleteMany(); await db.crawl.deleteMany();
  await db.queryPage.deleteMany(); await db.gscSyncCoverage.deleteMany(); await db.rankRun.deleteMany(); await db.manusResearchTask.deleteMany();
  await db.aiPoolSetting.create({ data: { userId: user, enabled: true, lightModel: "gpt-6-luna" } });
  await db.contentWorkerState.create({ data: { id: "pool-worker", lastSeenAt: now, limits: reading(20, 30), limitsAt: now, capabilities: ["routing-v1"],
    models: [{ id: "gpt-6-luna", name: "Luna", isDefault: false, efforts: ["low"], defaultEffort: "low" }] } });
  await db.crawl.create({ data: { id: "pool-crawl", siteId: site, status: "COMPLETED", finishedAt: now } });
  await db.auditPage.create({ data: { id: "pool-page", crawlId: "pool-crawl", url: "https://pool.example/guide", statusCode: 200, title: "Leather guide", articleText: "Leather care facts. ".repeat(10) } });
  await db.contentCluster.createMany({ data: [
    { id: "topic-a", siteId: site, pillarId: "pool-pillar", title: "Leather care", keyword: "leather care", dedupeKey: "a", funnel: "TOFU" },
    { id: "topic-b", siteId: site, pillarId: "pool-pillar", title: "Leather types", keyword: "leather types", dedupeKey: "b", funnel: "TOFU" },
  ] });
});

const brief = (id: string, clusterId: string, source = "BRIEF") => db.aiBacklogItem.create({ data: { id, siteId: site, source, kind: "TOPIC_BRIEF",
  title: `Brief ${id}`, payload: { clusterId }, dedupeKey: `brief:${clusterId}:${id}`, priority: source === "BATCH" ? 50 : 30, createdAt: now } });
async function claim() {
  const response = await runWorkerAction(db, { action: "claim", workerId: "pool-worker" }, now);
  return "job" in response ? response.job : null;
}
const itemOf = (id: string) => db.aiBacklogItem.findUniqueOrThrow({ where: { id } });
/** Search Console data for 12 queries on a complete day inside the last 28 days. */
async function searchQueries(count = 12) {
  await db.site.update({ where: { id: site }, data: { gscProperty: "sc-domain:pool.example" } });
  await db.gscSyncCoverage.create({ data: { siteId: site, date: searchDay, gscProperty: "sc-domain:pool.example", pagesComplete: true, queryPagesComplete: true } });
  await db.queryPage.createMany({ data: Array.from({ length: count }, (_, n) => ({ siteId: site, query: `leather ${n}`, page: "https://pool.example/guide", date: searchDay, clicks: 1, impressions: 50 })) });
}

describe("background task pool", () => {
  it("stores the worker's reading of its allowance", async () => {
    await runWorkerAction(db, { action: "limits", workerId: "pool-worker", limits: reading(50, 60), error: null, models: [], capabilities: ["routing-v1"] }, now);
    expect(await db.contentWorkerState.findUniqueOrThrow({ where: { id: "pool-worker" } }))
      .toMatchObject({ limits: { primary: { usedPercent: 50 } }, models: [], capabilities: ["routing-v1"], limitsError: null });
    await runWorkerAction(db, { action: "limits", workerId: "pool-worker", limits: null, error: "login_required" }, now);
    expect(await db.contentWorkerState.findUniqueOrThrow({ where: { id: "pool-worker" } })).toMatchObject({ limits: null, limitsError: "login_required", capabilities: [] });
    await expect(runWorkerAction(db, { action: "limits", workerId: "pool-worker", limits: { primary: "full" }, error: null }, now)).rejects.toThrow();
  });

  it("turns a waiting item into a task with the owner's model when the allowance allows it", async () => {
    await brief("i1", "topic-a");
    const job = await claim();
    expect(job).toMatchObject({ provider: "CODEX_LOCAL", model: "gpt-6-luna", reasoning: "low" });
    expect(await itemOf("i1")).toMatchObject({ status: "STARTED", jobId: job?.jobId });
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: job!.jobId } })).toMatchObject({ kind: "TOPIC_BRIEF", status: "RUNNING", activeKey: site });
    // The site is busy now: nothing more starts until that task ends.
    await brief("i2", "topic-b");
    expect(await claim()).toBeNull();
    expect((await itemOf("i2")).status).toBe("PENDING");
  });

  it("waits while the 5-hour window is at its reserve or the reading is old", async () => {
    await brief("i1", "topic-a");
    await db.contentWorkerState.update({ where: { id: "pool-worker" }, data: { limits: reading(75, 30) } });
    expect(await claim()).toBeNull();
    await db.contentWorkerState.update({ where: { id: "pool-worker" }, data: { limits: reading(20, 30), limitsAt: new Date(now.getTime() - 20 * 60_000) } });
    expect(await claim()).toBeNull();
    await db.contentWorkerState.update({ where: { id: "pool-worker" }, data: { limits: reading(20, 80), limitsAt: now } });
    expect(await claim()).toBeNull();
    expect((await itemOf("i1")).status).toBe("PENDING");
  });

  it("gives way to a task the owner starts, and the item waits again", async () => {
    await brief("i1", "topic-a");
    const pooled = await claim();
    const started = await runWorkbenchAction(db, user, site, { action: "start", kind: "WRITE_ARTICLE", title: "Mine", language: "en", instructions: "", keyword: "" }, now);
    expect(started).toHaveProperty("jobId");
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: pooled!.jobId } })).toMatchObject({ status: "FAILED", activeKey: null });
    expect(await itemOf("i1")).toMatchObject({ status: "PENDING", jobId: null, reason: "yielded" });
  });

  it("pauses at the review cap, keeps to each kind's daily cap, and lets batch work through", async () => {
    await db.aiPoolSetting.update({ where: { userId: user }, data: { reviewCap: 5 } });
    for (const n of [1, 2, 3, 4, 5]) {
      await db.aiWorkbenchJob.create({ data: { id: `aw_done_${n}`, siteId: site, kind: "TOPIC_BRIEF", title: "done", status: "SUCCEEDED", request: {}, context: {}, finishedAt: now } });
      await db.aiBacklogItem.create({ data: { id: `done-${n}`, siteId: site, source: "BATCH", kind: "TOPIC_BRIEF", title: "done", payload: {}, dedupeKey: `done:${n}`,
        priority: 30, status: "STARTED", jobId: `aw_done_${n}`, startedAt: new Date("2026-11-19T12:00:00Z") } });
    }
    await brief("i1", "topic-a");
    expect(await claim()).toBeNull();
    expect((await getPoolView(db, user, site, now)).policy).toEqual({ ok: false, reason: "review_cap", resumeAt: null });
    await runPoolAction(db, user, site, { action: "reviewedAll" }, now);

    await db.aiAutomation.create({ data: { siteId: site, briefsCap: 1 } });
    await db.aiWorkbenchJob.create({ data: { id: "aw_today", siteId: site, kind: "TOPIC_BRIEF", title: "today", status: "FAILED", request: {}, context: {}, finishedAt: now } });
    await db.aiBacklogItem.create({ data: { id: "today", siteId: site, source: "BRIEF", kind: "TOPIC_BRIEF", title: "today", payload: {}, dedupeKey: "today",
      priority: 30, status: "STARTED", jobId: "aw_today", startedAt: now } });
    expect(await claim()).toBeNull();
    await brief("b1", "topic-b", "BATCH");
    const job = await claim();
    expect(job).not.toBeNull();
    expect((await itemOf("b1")).status).toBe("STARTED");
    expect((await itemOf("i1")).status).toBe("PENDING");
  });

  it("fills a site's pool once per period, replacing an older waiting clustering, and says what each filler found", async () => {
    await searchQueries();
    const automation = await db.aiAutomation.create({ data: { siteId: site, clusters: true, briefs: true } });
    await db.aiBacklogItem.create({ data: { id: "old-clusters", siteId: site, source: "CLUSTERS", kind: "QUERY_CLUSTERS", title: "October", payload: { limit: 200 },
      dedupeKey: "clusters:2026-10", priority: 20, createdAt: now } });
    const first = await fillSite(db, siteRef, automation, "en", now);
    expect(first.added).toBe(3);
    expect(first.status.clusters).toMatchObject({ outcome: "added", count: 12, added: 1, lastAddedAt: now.toISOString() });
    expect(first.status.briefs).toMatchObject({ outcome: "added", count: 2, added: 2 });
    expect(await itemOf("old-clusters")).toMatchObject({ status: "SKIPPED", reason: "superseded" });
    const saved = await db.aiAutomation.findUniqueOrThrow({ where: { siteId: site } });
    expect(saved.markers).toMatchObject({ clusterMonth: "2026-11" });
    expect(saved.status).toMatchObject({ clusters: { outcome: "added" } });
    const second = await fillSite(db, siteRef, saved, "en", now);
    expect(second.added).toBe(0);
    expect(second.status.clusters).toMatchObject({ outcome: "done_this_month", lastAddedAt: now.toISOString() });
    expect(second.status.briefs).toMatchObject({ outcome: "no_change", count: 2 });
    const keys = (await db.aiBacklogItem.findMany({ where: { siteId: site, status: "PENDING" }, select: { dedupeKey: true } })).map(item => item.dedupeKey).sort();
    expect(keys).toEqual(["brief:topic-a", "brief:topic-b", "clusters:2026-11"]);
  });

  it("clusters only with 10 queries, and does not queue what is in the pool already", async () => {
    const automation = await db.aiAutomation.create({ data: { siteId: site, clusters: true } });
    expect((await fillSite(db, siteRef, automation, "en", now)).status.clusters).toMatchObject({ outcome: "not_enough_queries", count: 0 });
    expect(await db.aiBacklogItem.count({ where: { siteId: site, source: "CLUSTERS" } })).toBe(0);
    await searchQueries();
    await db.aiBacklogItem.create({ data: { siteId: site, source: "BATCH", kind: "QUERY_CLUSTERS", title: "Mine", payload: { limit: 200 }, dedupeKey: "clusters:2026-11", priority: 50 } });
    // Checked today already: only a forced check (the owner's "check now") looks again.
    const saved = await db.aiAutomation.findUniqueOrThrow({ where: { siteId: site } });
    expect((await fillSite(db, siteRef, saved, "en", now)).status.clusters).toMatchObject({ outcome: "not_enough_queries" });
    expect(await fillSite(db, siteRef, saved, "en", now, true)).toMatchObject({ added: 0, status: { clusters: { outcome: "already_queued", count: 12 } } });
  });

  it("reviews the latest rank check by hand once, and checks the fillers now", async () => {
    await expect(runPoolAction(db, user, site, { action: "reviewLatestRun" }, now)).rejects.toMatchObject({ status: 409 });
    await db.rankRun.create({ data: { id: "pool-run", siteId: site, source: "manual", status: "SUCCEEDED", device: "desktop", depth: 20, language: "en", location: 2840,
      planned: 1, budgetUsd: 1, finishedAt: now } });
    expect(await runPoolAction(db, user, site, { action: "reviewLatestRun" }, now)).toMatchObject({ queued: 1, existing: 0, enabled: true });
    expect(await db.aiBacklogItem.findFirstOrThrow({ where: { siteId: site, dedupeKey: "rankings:pool-run" } })).toMatchObject({ source: "BATCH", kind: "SEO_FIX_PLAN", priority: 80, status: "PENDING" });
    expect(await runPoolAction(db, user, site, { action: "reviewLatestRun" }, now)).toMatchObject({ queued: 0, existing: 1 });

    expect(await runPoolAction(db, user, site, { action: "fillNow" }, now)).toMatchObject({ added: 0, status: {} });
    await db.aiAutomation.create({ data: { siteId: site, rankings: true, briefs: true, briefsCap: 3 } });
    expect(await runPoolAction(db, user, site, { action: "fillNow" }, now)).toMatchObject({ added: 2, enabled: true,
      status: { rankings: { outcome: "not_notable" }, briefs: { outcome: "added", added: 2 } } });
    expect((await db.aiAutomation.findUniqueOrThrow({ where: { siteId: site } })).markers).toMatchObject({ rankRunId: "pool-run" });
    const view = await getPoolView(db, user, site, now);
    expect(view.automation).toMatchObject({ rankings: true, briefs: true, meta: false, caps: { schema: 10, briefs: 3 }, alertsScope: "drops" });
    expect(view.fillers.status).toMatchObject({ rankings: { outcome: "not_notable" }, briefs: { outcome: "added" } });
    expect(view.fillers.startedToday).toEqual({ rankings: 0, alerts: 0, meta: 0, schema: 0, clusters: 0, briefs: 0 });
  });

  it("queues briefs and outreach by hand, lets skipped work wait again and counts what a filler would find", async () => {
    await db.aiBacklogItem.create({ data: { id: "old-brief", siteId: site, source: "BRIEF", kind: "TOPIC_BRIEF", title: "old", payload: { clusterId: "topic-a" },
      dedupeKey: "brief:topic-a", priority: 30, status: "SKIPPED", reason: "expired", createdAt: new Date("2026-10-01T00:00:00Z") } });
    const preview = (await getPoolView(db, user, site, now, { preview: true })).preview!;
    expect(preview).toMatchObject({ briefs: { topics: 2, open: 2 }, schema: { pages: 1, newPages: 0, open: 1 }, clusters: { queries: 0, doneThisMonth: false },
      alerts: { set: 0, firedWeek: 0 }, rankings: { runAt: null }, meta: { pages: 0, changed: 0 } });
    expect(await runPoolAction(db, user, site, { action: "batchBriefs" }, now)).toMatchObject({ queued: 2, existing: 0, remaining: 0, enabled: true });
    expect(await itemOf("old-brief")).toMatchObject({ status: "PENDING", source: "BATCH", reason: null, createdAt: now });
    expect(await runPoolAction(db, user, site, { action: "batchBriefs" }, now)).toMatchObject({ queued: 0, existing: 2 });
    expect(await runPoolAction(db, user, site, { action: "batchMeta" }, now)).toMatchObject({ queued: 0, pages: 0 });
    expect(await runPoolAction(db, user, site, { action: "batchSchema" }, now)).toMatchObject({ queued: 1, existing: 0, remaining: 0 });

    const rows = Array.from({ length: 23 }, (_, n) => ({ url: `https://blog${n}.example/post`, domain: `blog${n}.example`, prospectType: "resource page", relevance: "r", approach: "a",
      contactUrl: null, pitchAngle: "p", effort: null, priority: null, evidenceUrls: [], observedOn: null }));
    await db.manusResearchTask.create({ data: { id: "manus-1", userId: user, siteId: site, requestId: "r1", kind: "LINK_PROSPECTS", input: { topic: "leather" }, status: "completed", rows } });
    const outreach = { action: "batchOutreach", taskId: "manus-1", senderName: "Ann", offer: "Our leather care guide", offerPageId: "pool-page", language: "de" };
    expect(await runPoolAction(db, user, site, outreach, now)).toMatchObject({ queued: 3, existing: 0, prospects: 23 });
    const items = await db.aiBacklogItem.findMany({ where: { siteId: site, kind: "OUTREACH_EMAILS" }, orderBy: { dedupeKey: "asc" } });
    expect(items.map(item => (item.payload as { rows: number[] }).rows.length)).toEqual([10, 10, 3]);
    expect(items[0].payload).toMatchObject({ offerUrl: "https://pool.example/guide", language: "de", senderRole: "", instructions: "" });
    expect(await runPoolAction(db, user, site, outreach, now)).toMatchObject({ queued: 0, existing: 3 });
    expect(await runPoolAction(db, user, site, { ...outreach, offer: "Another offer" }, now)).toMatchObject({ queued: 3 });
    await expect(runPoolAction(db, user, site, { ...outreach, taskId: "missing" }, now)).rejects.toMatchObject({ status: 409 });
    await expect(runPoolAction(db, user, site, { ...outreach, offerPageId: "no-such-page" }, now)).rejects.toMatchObject({ status: 404 });
  });

  it("lists a task a link points at even when it is older than the latest 20", async () => {
    for (let n = 0; n < 22; n++) {
      await db.aiWorkbenchJob.create({ data: { id: `aw_list_${n}`, siteId: site, kind: "SCHEMA_MARKUP", title: `Task ${n}`, status: "SUCCEEDED", request: {}, context: {},
        createdAt: new Date(now.getTime() - (22 - n) * 60_000), finishedAt: now } });
    }
    expect((await getWorkbenchWorkspace(db, user, site, now)).jobs.some(job => job.id === "aw_list_0")).toBe(false);
    const linked = await getWorkbenchWorkspace(db, user, site, now, undefined, "aw_list_0");
    expect(linked.jobs).toHaveLength(21);
    expect(linked.jobs.at(-1)?.id).toBe("aw_list_0");
    // A panel's list never takes in a task of another kind.
    expect((await getWorkbenchWorkspace(db, user, site, now, "META_REWRITE", "aw_list_0")).jobs).toHaveLength(0);
  });

  it("saves settings, shows the reading and lets a waiting item be canceled", async () => {
    const view = await savePool(db, user, site, {
      settings: { enabled: true, shortReserve: 40, weeklyReserve: 10, reviewCap: 20, language: "en", routing: { light: { model: null, reasoning: "low" }, main: { model: null, reasoning: "high" } } },
      automation: { rankings: true, alerts: false, meta: false, schema: false, clusters: false, briefs: false,
        caps: { rankings: 3, alerts: 2, meta: 1, schema: 10, clusters: 1, briefs: 5 }, alertsScope: "all" },
    }, now);
    expect(view.settings).toMatchObject({ shortReserve: 40, routing: { main: { reasoning: "high" } } });
    expect(view.automation).toMatchObject({ rankings: true, caps: { rankings: 3 }, alertsScope: "all" });
    expect(view.fillers.status.rankings).toMatchObject({ outcome: "no_run" });
    expect(view.reading).toMatchObject({ short: { usedPercent: 20 }, long: { usedPercent: 30 }, routing: true, stale: false });
    expect((await db.aiAutomation.findUniqueOrThrow({ where: { siteId: site } })).markers).toMatchObject({ rankRunId: "" });
    await brief("i1", "topic-a");
    await runPoolAction(db, user, site, { action: "cancel", itemId: "i1" }, now);
    expect((await itemOf("i1")).status).toBe("CANCELED");
    await expect(runPoolAction(db, user, site, { action: "cancel", itemId: "i1" }, now)).rejects.toMatchObject({ status: 409 });
    await expect(getPoolView(db, "someone-else", site, now)).rejects.toMatchObject({ status: 404 });
  });
});
