import { describe, expect, it } from "vitest";
import { z } from "zod";
import { poolPolicy, storedLimits, storedModels, windowsOf, type WorkerLimits } from "./limits";
import { DEFAULT_ROUTING, routingFrom, routingHint, tierOf, withHint } from "./routing";
import { itemTitle, PoolSkip, poolServerEnabled, requestForItem, skipReasonOf } from "./items";
import { alertWhere, capOf, metaChanges, notableRankRows, rankMoves, schemaKey, schemaOrder, storedMarkers, storedStatuses, urlKey, withLastAdded } from "./fill";
import { generationSchemaFor } from "../schema";
import { applyTopicBrief, reviewTopicBrief } from "../tools/topic-brief";
import { assertToolRequest } from "../tools";

const HOUR = 3600_000;
const now = new Date("2026-11-20T12:00:00.000Z");
const at = (ms: number) => Math.round((now.getTime() + ms) / 1000);
const reading = (primary: [number, number, number] | null, secondary: [number, number, number] | null, extra: Partial<WorkerLimits> = {}): WorkerLimits => ({
  planType: "plus", reached: false, hasCredits: null,
  primary: primary ? { usedPercent: primary[0], windowMinutes: primary[1], resetsAt: primary[2] } : null,
  secondary: secondary ? { usedPercent: secondary[0], windowMinutes: secondary[1], resetsAt: secondary[2] } : null, ...extra,
});
const reserves = { shortReserve: 30, weeklyReserve: 10 };
const fresh = new Date(now.getTime() - 60_000);

describe("when background work may start", () => {
  it("needs a fresh reading", () => {
    expect(poolPolicy(null, null, now, reserves)).toEqual({ ok: false, reason: "no_reading", resumeAt: null });
    const limits = reading([10, 300, at(2 * HOUR)], [10, 10080, at(100 * HOUR)]);
    expect(poolPolicy(limits, new Date(now.getTime() - 16 * 60_000), now, reserves)).toMatchObject({ ok: false, reason: "stale_reading" });
    expect(poolPolicy(limits, fresh, now, reserves)).toEqual({ ok: true });
  });
  it("keeps the short window's reserve for tasks the owner starts", () => {
    const limits = reading([70, 300, at(2 * HOUR)], [10, 10080, at(100 * HOUR)]);
    expect(poolPolicy(limits, fresh, now, reserves)).toEqual({ ok: false, reason: "short_window", resumeAt: new Date(at(2 * HOUR) * 1000) });
    expect(poolPolicy(limits, fresh, now, { ...reserves, shortReserve: 20 })).toEqual({ ok: true });
  });
  it("uses the week at its pace, and what is left in the last day", () => {
    // 3.5 of 7 days gone: up to 55% (50% plus 5 points of slack).
    const half = (used: number) => reading([0, 300, at(HOUR)], [used, 10080, at(84 * HOUR)]);
    expect(poolPolicy(half(54), fresh, now, reserves)).toEqual({ ok: true });
    const ahead = poolPolicy(half(60), fresh, now, reserves);
    expect(ahead).toMatchObject({ ok: false, reason: "weekly_pace" });
    // The pace line reaches 60% when 55% of the week is gone: 3.85 days in, 0.35 days from now.
    expect(ahead.ok ? null : ahead.resumeAt?.getTime()).toBe(new Date(at(84 * HOUR) * 1000 - 7 * 24 * HOUR + 0.55 * 7 * 24 * HOUR).getTime());
    const lastDay = (used: number) => reading([0, 300, at(HOUR)], [used, 10080, at(20 * HOUR)]);
    expect(poolPolicy(lastDay(85), fresh, now, reserves)).toEqual({ ok: true });
    expect(poolPolicy(lastDay(90), fresh, now, reserves)).toMatchObject({ ok: false, reason: "weekly_reserve" });
  });
  it("stops at a reached limit and resumes after the latest exhausted window", () => {
    const limits = reading([100, 300, at(3 * HOUR)], [100, 10080, at(50 * HOUR)], { reached: true });
    expect(poolPolicy(limits, fresh, now, reserves)).toEqual({ ok: false, reason: "limit_reached", resumeAt: new Date(at(50 * HOUR) * 1000) });
  });
  it("tells the 5-hour window from the weekly one by length, and handles a plan without a short window", () => {
    const swapped = reading([40, 10080, at(50 * HOUR)], [5, 300, at(HOUR)]);
    expect(windowsOf(swapped).short?.windowMinutes).toBe(300);
    expect(windowsOf(swapped).long?.windowMinutes).toBe(10080);
    const pro = reading([20, 10080, at(100 * HOUR)], null);
    expect(windowsOf(pro)).toEqual({ short: null, long: pro.primary });
    expect(poolPolicy(pro, fresh, now, reserves)).toEqual({ ok: true });
    expect(poolPolicy(reading(null, null), fresh, now, reserves)).toMatchObject({ ok: false, reason: "no_reading" });
  });
  it("reads stored values defensively", () => {
    expect(storedLimits({ bogus: true })).toBeNull();
    expect(storedLimits(reading([1, 300, 5], null))).not.toBeNull();
    expect(storedModels([{ id: "bad model" }])).toEqual([]);
    expect(poolServerEnabled({})).toBe(true);
    expect(poolServerEnabled({ AI_POOL_ENABLED: "false" })).toBe(false);
  });
});

describe("per-task models", () => {
  const models = [
    { id: "gpt-6.1-sol", name: "Sol", isDefault: true, efforts: ["low", "medium", "high"] as ("low" | "medium" | "high")[], defaultEffort: "medium" as const },
    { id: "gpt-6-luna", name: "Luna", isDefault: false, efforts: ["low"] as "low"[], defaultEffort: "low" as const },
  ];
  it("sorts tasks into light and main", () => {
    for (const kind of ["META_REWRITE", "OUTREACH_EMAILS", "QUERY_CLUSTERS", "SCHEMA_MARKUP", "TOPIC_BRIEF", "KEYWORD_RESEARCH"]) expect(tierOf(kind)).toBe("light");
    for (const kind of ["WRITE_ARTICLE", "REWRITE_ARTICLE", "SEO_FIX_PLAN", "LOCALIZE_ARTICLE", "DOMAIN_ANALYSIS", "PLAN", "ARTICLE_REVIEW"]) expect(tierOf(kind)).toBe("main");
  });
  it("sends the tier's model and effort, dropping what the account or model does not offer", () => {
    const routing = routingFrom({ lightModel: "gpt-6-luna", lightReasoning: "medium", mainModel: "gone-model", mainReasoning: "high" });
    expect(routingHint("SCHEMA_MARKUP", routing, models)).toEqual({ model: "gpt-6-luna" });
    expect(routingHint("SEO_FIX_PLAN", routing, models)).toEqual({ reasoning: "high" });
    expect(routingHint("SEO_FIX_PLAN", routing, [])).toEqual({ model: "gone-model", reasoning: "high" });
    expect(routingHint("WRITE_ARTICLE", DEFAULT_ROUTING, models)).toEqual({ reasoning: "medium" });
    expect(routingFrom({ lightModel: "bad model", lightReasoning: "max", mainModel: null, mainReasoning: null })).toEqual({ light: { model: null, reasoning: null }, main: { model: null, reasoning: null } });
    expect(routingFrom(null)).toEqual(DEFAULT_ROUTING);
  });
  it("adds the hint to a claim only when it still fits a worker", () => {
    const small = { managedProtocol: 2, job: { jobId: "aw_1", prompt: "x" } };
    expect(withHint(small, { model: "gpt-6-luna" }).job).toMatchObject({ model: "gpt-6-luna" });
    expect(withHint({ job: null }, { model: "gpt-6-luna" })).toEqual({ job: null });
    const big = { job: { jobId: "aw_1", prompt: "x".repeat(65_500) } };
    expect(withHint(big, { model: "gpt-6-luna", reasoning: "low" })).toBe(big);
  });
});

describe("pool items", () => {
  it("queues a ranking review only for notable moves", () => {
    expect(notableRankRows([{ kind: "rankRun" }, { kind: "rankChange", change: -2, position: 5, previousPosition: 3, url: "/a", previousUrl: "/a" }])).toBe(false);
    expect(notableRankRows([{ kind: "rankChange", change: -3, position: 6, previousPosition: 3, url: "/a", previousUrl: "/a" }])).toBe(true);
    expect(notableRankRows([{ kind: "rankChange", change: null, position: null, previousPosition: 8, url: null, previousUrl: "/a" }])).toBe(true);
    expect(notableRankRows([{ kind: "rankChange", change: 0, position: 4, previousPosition: 4, url: "/b", previousUrl: "/a" }])).toBe(true);
    expect(notableRankRows([{ kind: "serpEntrant", query: "q" }])).toBe(true);
  });
  it("keeps markers and keys tidy", () => {
    expect(storedMarkers({ rankRunId: "r1", crawlId: 3, other: "x" })).toEqual({ rankRunId: "r1" });
    expect(storedMarkers(null)).toEqual({});
    expect(urlKey("https://shop.test/a")).toHaveLength(32);
    expect(urlKey("https://shop.test/a")).toBe(urlKey("https://shop.test/a"));
    expect(itemTitle.schema("zh-CN", "x".repeat(200))).toMatch(/^结构化数据（自动）· x+…$/);
    expect(itemTitle.meta("en", 4)).toBe("Titles and descriptions (auto) · 4 pages");
    expect(skipReasonOf("report_evidence_empty")).toBe("no_data");
    expect(skipReasonOf("cluster_not_enough_queries")).toBe("not_enough_queries");
    expect(skipReasonOf("Page not found in this site's latest completed crawl")).toBe("page_gone");
    expect(skipReasonOf("something else")).toBe("prepare_failed");
  });
  it("turns an item into a checked workbench request, skipping work that is already done", async () => {
    const pages: Record<string, { id: string; hasSchema: boolean; articleText: string | null; statusCode: number }> = {
      "https://shop.test/a": { id: "p1", hasSchema: false, articleText: "x".repeat(150), statusCode: 200 },
      "https://shop.test/b": { id: "p2", hasSchema: true, articleText: "short", statusCode: 200 },
    };
    const topics: Record<string, { brief: unknown }> = { t1: { brief: null }, t2: { brief: { summary: "s" } } };
    const db = {
      crawl: { findFirst: async () => ({ id: "c1" }) },
      auditPage: { findFirst: async ({ where }: { where: { url: string } }) => pages[where.url] ?? null },
      contentCluster: { findFirst: async ({ where }: { where: { id: string } }) => topics[where.id] ?? null },
    } as never;
    const site = { id: "s1" };
    const request = (kind: string, payload: unknown) => requestForItem(db, site, { kind, title: "T", payload }, "zh-CN");
    expect(await request("SCHEMA_MARKUP", { url: "https://shop.test/a" })).toMatchObject({ kind: "SCHEMA_MARKUP", pageId: "p1", provider: "CODEX_LOCAL" });
    await expect(request("SCHEMA_MARKUP", { url: "https://shop.test/b" })).rejects.toThrow("has_schema");
    await expect(request("SCHEMA_MARKUP", { url: "https://shop.test/c" })).rejects.toThrow("page_gone");
    expect(await request("LOCALIZE_ARTICLE", { url: "https://shop.test/a", language: "de", location: 2276 })).toMatchObject({ language: "de", localization: { location: 2276 }, pageId: "p1" });
    await expect(request("LOCALIZE_ARTICLE", { url: "https://shop.test/b", language: "de", location: 2276 })).rejects.toThrow("no_body");
    expect(await request("TOPIC_BRIEF", { clusterId: "t1" })).toMatchObject({ topicBrief: { clusterId: "t1" } });
    await expect(request("TOPIC_BRIEF", { clusterId: "t2" })).rejects.toThrow("has_brief");
    await expect(request("TOPIC_BRIEF", { clusterId: "t9" })).rejects.toBeInstanceOf(PoolSkip);
    expect(await request("SEO_FIX_PLAN", { scope: "rankings" })).toMatchObject({ actionScope: "rankings" });
    expect(await request("META_REWRITE", { urls: ["https://shop.test/a"] })).toMatchObject({ metaRewrite: { urls: ["https://shop.test/a"] } });
    expect(await request("QUERY_CLUSTERS", { limit: 200 })).toMatchObject({ queryClusters: { limit: 200 } });
    for (const kind of ["SCHEMA_MARKUP", "LOCALIZE_ARTICLE", "TOPIC_BRIEF", "META_REWRITE", "QUERY_CLUSTERS"]) {
      const payload = { SCHEMA_MARKUP: { url: "https://shop.test/a" }, LOCALIZE_ARTICLE: { url: "https://shop.test/a", language: "de", location: 2276 }, TOPIC_BRIEF: { clusterId: "t1" },
        META_REWRITE: { urls: ["https://shop.test/a"] }, QUERY_CLUSTERS: { limit: 100 } }[kind];
      const built = await request(kind, payload);
      expect(() => assertToolRequest(built)).not.toThrow();
    }
    await expect(request("WRITE_ARTICLE", {})).rejects.toThrow("prepare_failed");
  });
});

describe("fillers", () => {
  it("counts low-CTR pages that are new or a fifth worse than at the last check", () => {
    const { changed, seen } = metaChanges([{ url: "https://shop.test/a", ctr: 0.01 }, { url: "https://shop.test/b", ctr: 0.015 }, { url: "https://shop.test/c", ctr: 0.019 }],
      { "https://shop.test/b": 0.02, "https://shop.test/c": 0.02 });
    expect(changed).toEqual(["https://shop.test/a", "https://shop.test/b"]);
    expect(seen).toEqual({ "https://shop.test/a": 0.01, "https://shop.test/b": 0.015, "https://shop.test/c": 0.019 });
    expect(metaChanges([{ url: "https://shop.test/a", ctr: 0.01 }], undefined).changed).toEqual(["https://shop.test/a"]);
  });
  it("puts pages new since the previous crawl first, then the most impressions", () => {
    const pages = [{ url: "https://shop.test/a" }, { url: "https://shop.test/b" }, { url: "https://shop.test/c" }];
    const impressions = new Map([["https://shop.test/a", 50], ["https://shop.test/b", 10], ["https://shop.test/c", 900]]);
    expect(schemaOrder(pages, impressions, new Set(["https://shop.test/a", "https://shop.test/c"])).map(page => page.url)).toEqual(["https://shop.test/b", "https://shop.test/c", "https://shop.test/a"]);
    expect(schemaOrder(pages, new Map(), null).map(page => page.url)).toEqual(["https://shop.test/a", "https://shop.test/b", "https://shop.test/c"]);
    expect(schemaKey({ url: "https://shop.test/a", contentHash: null }, "crawl-1")).toBe(`schema:${urlKey("https://shop.test/a")}:crawl-1`);
  });
  it("keeps when a filler last queued work while later checks find nothing new", () => {
    const first = withLastAdded({}, { rankings: { checkedAt: "2026-11-18T09:00:00.000Z", outcome: "added", count: 3, added: 1 } });
    expect(first.rankings).toMatchObject({ lastAddedAt: "2026-11-18T09:00:00.000Z", lastAdded: 1 });
    const later = withLastAdded(first, { rankings: { checkedAt: "2026-11-20T12:00:00.000Z", outcome: "no_new_run", count: 0, added: 0 } });
    expect(later.rankings).toEqual({ checkedAt: "2026-11-20T12:00:00.000Z", outcome: "no_new_run", count: 0, added: 0, lastAddedAt: "2026-11-18T09:00:00.000Z", lastAdded: 1 });
    expect(storedStatuses({ rankings: later.rankings, meta: { checkedAt: "x", outcome: "bogus" }, schema: "nope" })).toEqual({ rankings: later.rankings });
    expect(storedStatuses(null)).toEqual({});
  });
  it("gives each kind of automatic task its own daily limit, and work queued by hand none", () => {
    expect(capOf("SCHEMA", { schemaCap: 30 })).toBe(30);
    expect(capOf("SCHEMA", null)).toBe(10);
    expect(capOf("BRIEF", { schemaCap: 30 })).toBe(5);
    expect(capOf("BATCH", { schemaCap: 30 })).toBeNull();
  });
  it("diagnoses drops by default and any alert when asked, and counts notable moves", () => {
    expect(alertWhere("s1", "drops")).toEqual({ siteId: "s1", enabled: true, type: { in: ["TRAFFIC_DROP", "POSITION_CHANGE", "RANK_DROP"] } });
    expect(alertWhere("s1", undefined)).toEqual(alertWhere("s1", "drops"));
    expect(alertWhere("s1", "all")).toEqual({ siteId: "s1", enabled: true });
    expect(rankMoves([
      { kind: "rankChange", change: -4, position: 9, previousPosition: 5, url: "/a", previousUrl: "/a" },
      { kind: "rankChange", change: -1, position: 3, previousPosition: 2, url: "/b", previousUrl: "/b" },
      { kind: "serpEntrant", competitor: "rival.test" }, { kind: "serpEntrant", competitor: "rival.test" }, { kind: "serpEntrant", competitor: "other.test" },
    ])).toEqual({ keywords: 1, competitors: 2 });
  });
  it("turns batch outreach into a request in the chosen language, finding the offered page again", async () => {
    const db = {
      crawl: { findFirst: async () => ({ id: "c1" }) },
      auditPage: { findFirst: async ({ where }: { where: { url: string } }) => where.url === "https://shop.test/guide" ? { id: "p9", hasSchema: false, articleText: null, statusCode: 200 } : null },
    } as never;
    const payload = { taskId: "m1", rows: [0, 1, 2], senderName: "Ann", senderRole: "Editor", offer: "Our sizing guide", offerUrl: "https://shop.test/guide", language: "de", instructions: "Keep it short" };
    const request = (value: unknown) => requestForItem(db, { id: "s1" }, { kind: "OUTREACH_EMAILS", title: "Outreach", payload: value }, "zh-CN");
    const built = await request(payload);
    expect(built).toMatchObject({ kind: "OUTREACH_EMAILS", language: "de", instructions: "Keep it short", outreach: { taskId: "m1", rows: [0, 1, 2], senderName: "Ann", offerPageId: "p9" } });
    expect(() => assertToolRequest(built)).not.toThrow();
    await expect(request({ ...payload, offerUrl: "https://shop.test/gone" })).rejects.toThrow("page_gone");
    expect((await request({ ...payload, offerUrl: null })).outreach?.offerPageId).toBeUndefined();
    await expect(request({ ...payload, rows: Array.from({ length: 11 }, (_, n) => n) })).rejects.toThrow();
    expect(skipReasonOf("outreach_rows_changed")).toBe("prospects_changed");
    expect(itemTitle.outreach("en", 2, 6, 10)).toBe("Outreach drafts (batch 2/6) · 10 prospects");
    expect(itemTitle.metaBatch("zh-CN", 1, 3, 20)).toBe("标题和描述（批量 1/3）· 20 个页面");
    expect(itemTitle.rankingsLatest("en", "2026-11-18")).toBe("Ranking review · check of 2026-11-18 (by hand)");
  });
});

describe("topic briefs", () => {
  const brief = { summary: "s", audience: "a", searchIntent: "i", angle: "g", outline: ["o"], keyPoints: ["k"], cta: "c",
    internalLinks: [{ target: "http://shop.test/guide/", title: "Guide", reason: "r" }, { target: "https://elsewhere.test/x", title: "X", reason: "r" }], evidenceNotes: ["e"] };
  const base = { title: "t", summary: "s", contentMarkdown: "c", metaTitle: "m", metaDescription: "d", changeNotes: [], factChecks: [], internalLinks: [{ anchor: "a", target: "https://shop.test/", reason: "r" }], paragraphEdits: [] };
  it("asks for every brief field and keeps links to crawled pages only", () => {
    const schema = z.toJSONSchema(generationSchemaFor("TOPIC_BRIEF"), { target: "draft-7" }) as { required: string[] };
    expect(schema.required).toContain("topicBrief");
    const reviewed = reviewTopicBrief({ ...base, topicBrief: brief } as never, { domain: "shop.test", knownPages: [{ url: "https://shop.test/guide", title: "Guide" }] });
    expect(reviewed.topicBrief?.internalLinks).toEqual([{ target: "https://shop.test/guide", title: "Guide", reason: "r" }]);
    expect(reviewed).toMatchObject({ metaTitle: "", metaDescription: "", internalLinks: [], paragraphEdits: [] });
    expect(() => reviewTopicBrief(base as never, { domain: "shop.test", knownPages: [] })).toThrow("Codex did not return a brief for this topic");
  });
  it("fills an empty topic and never replaces a brief written meanwhile", async () => {
    const writes: unknown[] = [];
    const db = (current: unknown, status = "PLANNED") => ({ contentCluster: {
      findFirst: async () => ({ brief: current, status }),
      updateMany: async (args: unknown) => { writes.push(args); return { count: 1 }; },
    } }) as never;
    const request = { topicBrief: { clusterId: "t1" } } as never;
    const result = { ...base, topicBrief: { ...brief, internalLinks: [] } } as never;
    expect(await applyTopicBrief(db(null), "s1", request, result)).toBe(true);
    expect(writes[0]).toMatchObject({ where: { id: "t1", siteId: "s1" }, data: { status: "BRIEF_READY" } });
    expect(await applyTopicBrief(db({ summary: "mine" }), "s1", request, result)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(await applyTopicBrief(db(null, "WRITING"), "s1", request, result)).toBe(true);
    expect((writes[1] as { data: Record<string, unknown> }).data.status).toBeUndefined();
  });
});
