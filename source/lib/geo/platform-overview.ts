import type { PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { summarizeEligibility, type DirectivePage, type EligibilitySummary } from "./directives";
import type { ProbeReport } from "./probe";
import { worstVerdict, type ProbeVerdict } from "./probe-rules";
import { GEO_PLATFORMS, type CrawlerRole, type EligibilityRules, type GeoPlatform, type GeoPlatformId } from "./platforms";
import { loadAiReports, type AiReports } from "./report-store";
import { latestAnswers, settingsOf, storedBrands, summarizeByPlatform } from "./tracking";
import type { GeoSnapshot } from "./types";
import type { PlatformVisibility } from "./visibility-rules";

/*
 * Every platform on six layers, from what the site already has:
 *   access       robots.txt and the live access check (PROBE snapshot)
 *   eligibility  page directives of the latest crawl, by the platform's rules
 *   index        the search index the platform answers from (Search Console, Bing)
 *   report       the platform owner's AI report, when imported
 *   answers      prompt tracking: mentioned and cited in its answers
 *   traffic      AI referrals (GA4) and crawler requests (access logs)
 * A layer that has no data says so (UNKNOWN); one that does not apply to the
 * platform is NA.
 */

export type LayerState = "GOOD" | "WARN" | "BAD" | "UNKNOWN" | "NA";

export type AccessToken = {
  token: string;
  role: CrawlerRole | "CONTROL";
  robots: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "NOT_APPLICABLE" | "NO_PREFERENCE" | null;
  rule: string | null;
  live: ProbeVerdict | null;
};
export type PlatformStatus = {
  id: GeoPlatformId;
  access: { state: LayerState; tokens: AccessToken[] };
  eligibility: { state: LayerState; rules: EligibilityRules; summary: EligibilitySummary | null };
  index: { state: LayerState; kind: "GOOGLE" | "BING" | null; pages: number | null; at: string | null };
  report: { state: LayerState; kind: "GSC_AI" | "BING_AI" | null; total: number | null; start: string | null; end: string | null };
  answers: { state: LayerState; source: "DATAFORSEO" | "MANUAL"; tracked: boolean; visibility: PlatformVisibility | null };
  traffic: { state: LayerState; referrals: number | null; crawlerRequests: number | null };
};
export type PlatformOverview = {
  siteId: string;
  domain: string;
  probe: { checkedAt: string; cdn: string | null; urls: string[] } | null;
  crawl: { finishedAt: string | null; pages: number; directivesRecorded: boolean } | null;
  platforms: PlatformStatus[];
};

export type OverviewInput = {
  probe: ProbeReport | null;
  eligibility: Record<EligibilityRules, EligibilitySummary> | null;
  google: { connected: boolean; pages: number; date: string | null };
  bing: { connected: boolean; inIndex: number | null; date: string | null };
  reports: AiReports;
  visibility: Partial<Record<GeoPlatformId, PlatformVisibility>>;
  tracked: readonly GeoPlatformId[];
  ga4: Pick<GeoSnapshot, "rows"> | null;
  bots: Pick<GeoSnapshot, "rows"> | null;
};

const rank: Record<LayerState, number> = { NA: 0, GOOD: 1, UNKNOWN: 2, WARN: 3, BAD: 4 };
const worst = (states: LayerState[]): LayerState => states.reduce<LayerState>((a, b) => (rank[b] > rank[a] ? b : a), "NA");

function accessLayer(platform: GeoPlatform, probe: ProbeReport | null): PlatformStatus["access"] {
  const tokens: AccessToken[] = [
    ...platform.crawlers.map(c => ({ token: c.token, role: c.role as AccessToken["role"] })),
    ...platform.controlTokens.map(token => ({ token, role: "CONTROL" as const })),
  ].map(({ token, role }) => {
    const robots = probe?.robots.bots.filter(b => b.token === token) ?? [];
    const blocked = robots.find(b => b.robots === "BLOCKED");
    const verdicts = probe?.checks.filter(c => c.token === token).map(c => c.verdict) ?? [];
    return {
      token, role,
      robots: probe ? (blocked ? "BLOCKED" : robots[0]?.robots ?? null) : null,
      rule: (blocked ?? robots[0])?.rule ?? null,
      live: worstVerdict(verdicts),
    };
  });
  if (!tokens.length) return { state: "NA", tokens };
  if (!probe) return { state: "UNKNOWN", tokens };
  // Training crawlers do not decide whether answers can use the site.
  const states = tokens.filter(t => t.role !== "TRAINING").map((t): LayerState => {
    const serious = t.role === "INDEX" || t.role === "CONTROL";
    if (t.robots === "BLOCKED" || t.live === "BLOCKED_FOR_BOT") return serious ? "BAD" : "WARN";
    if (t.robots === "UNKNOWN" || t.live === "BLOCKED_FOR_ALL" || t.live === "ERROR") return "WARN";
    return "GOOD";
  });
  return { state: states.length ? worst(states) : "GOOD", tokens };
}

function eligibilityLayer(platform: GeoPlatform, eligibility: OverviewInput["eligibility"]): PlatformStatus["eligibility"] {
  const summary = eligibility?.[platform.eligibility] ?? null;
  if (!summary || !summary.pages) return { state: "UNKNOWN", rules: platform.eligibility, summary };
  const state: LayerState = summary.excluded / summary.pages >= 0.5 ? "BAD" : summary.excluded || summary.limited ? "WARN" : "GOOD";
  return { state, rules: platform.eligibility, summary };
}

function indexLayer(platform: GeoPlatform, input: OverviewInput): PlatformStatus["index"] {
  if (platform.index === "GOOGLE") {
    if (!input.google.connected) return { state: "UNKNOWN", kind: "GOOGLE", pages: null, at: null };
    return { state: input.google.pages > 0 ? "GOOD" : "WARN", kind: "GOOGLE", pages: input.google.pages, at: input.google.date };
  }
  if (platform.index === "BING") {
    if (!input.bing.connected || input.bing.inIndex === null) return { state: "UNKNOWN", kind: "BING", pages: input.bing.inIndex, at: input.bing.date };
    return { state: input.bing.inIndex > 0 ? "GOOD" : "WARN", kind: "BING", pages: input.bing.inIndex, at: input.bing.date };
  }
  return { state: "NA", kind: null, pages: null, at: null };
}

function reportLayer(platform: GeoPlatform, reports: AiReports): PlatformStatus["report"] {
  if (!platform.report) return { state: "NA", kind: null, total: null, start: null, end: null };
  const report = reports[platform.report];
  if (!report) return { state: "UNKNOWN", kind: platform.report, total: null, start: null, end: null };
  const total = report.daily.length
    ? report.daily.reduce((sum, d) => sum + d.value, 0)
    : report.pages.reduce((sum, p) => sum + p.value, 0);
  return { state: total > 0 ? "GOOD" : "WARN", kind: platform.report, total, start: report.start, end: report.end };
}

function answersLayer(platform: GeoPlatform, input: OverviewInput): PlatformStatus["answers"] {
  const visibility = input.visibility[platform.id] ?? null;
  const source = platform.answers.kind;
  const tracked = input.tracked.includes(platform.id);
  if (!visibility || !visibility.answers) return { state: "UNKNOWN", source, tracked, visibility };
  return { state: (visibility.citationRate ?? 0) > 0 || (visibility.mentionRate ?? 0) > 0 ? "GOOD" : "WARN", source, tracked, visibility };
}

function trafficLayer(platform: GeoPlatform, input: OverviewInput): PlatformStatus["traffic"] {
  const referrals = input.ga4 && platform.referrers.length
    ? input.ga4.rows.filter(r => platform.referrers.includes(r.platform)).reduce((sum, r) => sum + r.count, 0)
    : null;
  const tokens = platform.crawlers.map(c => " · " + c.token);
  const crawlerRequests = input.bots && tokens.length
    ? input.bots.rows.filter(r => tokens.some(t => r.platform.endsWith(t))).reduce((sum, r) => sum + r.count, 0)
    : null;
  if (referrals === null && crawlerRequests === null) {
    return { state: platform.referrers.length || platform.crawlers.length ? "UNKNOWN" : "NA", referrals, crawlerRequests };
  }
  return { state: (referrals ?? 0) > 0 ? "GOOD" : "WARN", referrals, crawlerRequests };
}

/** The six layers of every platform. Pure; readPlatformOverview gathers the input. */
export function buildPlatformStatuses(input: OverviewInput): PlatformStatus[] {
  return GEO_PLATFORMS.map(platform => ({
    id: platform.id,
    access: accessLayer(platform, input.probe),
    eligibility: eligibilityLayer(platform, input.eligibility),
    index: indexLayer(platform, input),
    report: reportLayer(platform, input.reports),
    answers: answersLayer(platform, input),
    traffic: trafficLayer(platform, input),
  }));
}

const PAGE_LIMIT = 5000;

function directivePage(row: { url: string; statusCode: number; robotsMeta: string | null; xRobotsTag: string | null; robotsDirectives: unknown }): DirectivePage {
  const directives = row.robotsDirectives as { metas?: unknown; dataNosnippet?: unknown } | null;
  const metas = Array.isArray(directives?.metas)
    ? directives.metas.filter((m): m is [string, string] => Array.isArray(m) && m.length === 2 && typeof m[0] === "string" && typeof m[1] === "string")
    : null;
  return {
    url: row.url,
    statusCode: row.statusCode,
    robotsMeta: row.robotsMeta,
    robotsMetas: metas,
    xRobotsTag: row.xRobotsTag,
    dataNosnippet: typeof directives?.dataNosnippet === "boolean" ? directives.dataNosnippet : null,
  };
}

export async function readPlatformOverview(db: PrismaClient, userId: string | undefined, siteId: string, now = new Date()): Promise<PlatformOverview> {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true, gscProperty: true, bingSite: true } }) as
    { id: string; domain: string; gscProperty: string | null; bingSite: string | null } | null;
  if (!site) throw new ContentError("Unknown site", 404);
  const since = new Date(now.getTime() - 28 * 86_400_000);
  const [snapshots, reports, crawl, googleRows, bingDay, tracking, latest] = await Promise.all([
    db.geoSnapshot.findMany({ where: { siteId, kind: { in: ["PROBE", "GA4", "BOT"] } } }) as Promise<{ kind: string; report: unknown; updatedAt: Date }[]>,
    loadAiReports(db, siteId),
    db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true } }) as Promise<{ id: string; finishedAt: Date | null } | null>,
    db.$queryRaw`SELECT COUNT(DISTINCT "url")::int AS n FROM "Page" WHERE "siteId" = ${siteId} AND "date" >= ${since} AND "impressions" > 0` as Promise<{ n: number }[]>,
    db.bingDaily.findFirst({ where: { siteId, inIndex: { not: null } }, orderBy: { date: "desc" }, select: { date: true, inIndex: true } }) as Promise<{ date: Date; inIndex: number | null } | null>,
    db.geoTracking.findUnique({ where: { siteId }, select: { brands: true, platforms: true, scheduleDays: true, budgetUsd: true } }),
    latestAnswers(db, siteId, now),
  ]);
  const pages = crawl
    ? (await db.auditPage.findMany({
        where: { crawlId: crawl.id },
        select: { url: true, statusCode: true, robotsMeta: true, xRobotsTag: true, robotsDirectives: true },
        orderBy: { url: "asc" },
        take: PAGE_LIMIT,
      }) as { url: string; statusCode: number; robotsMeta: string | null; xRobotsTag: string | null; robotsDirectives: unknown }[]).map(directivePage)
    : [];
  const googlePages = Number(googleRows[0]?.n ?? 0);
  const snapshot = (kind: string) => snapshots.find(s => s.kind === kind)?.report ?? null;
  const probe = snapshot("PROBE") as ProbeReport | null;
  const settings = settingsOf(tracking, site.domain);
  const brands = settings?.brands ?? storedBrands(null, site.domain);
  const eligibility = crawl
    ? { GOOGLE: summarizeEligibility(pages, "GOOGLE"), BING: summarizeEligibility(pages, "BING"), GENERIC: summarizeEligibility(pages, "GENERIC") }
    : null;
  const platforms = buildPlatformStatuses({
    probe,
    eligibility,
    google: { connected: !!site.gscProperty, pages: googlePages, date: googlePages ? since.toISOString().slice(0, 10) : null },
    bing: { connected: !!site.bingSite, inIndex: bingDay?.inIndex ?? null, date: bingDay?.date.toISOString().slice(0, 10) ?? null },
    reports,
    visibility: summarizeByPlatform(latest.records, brands),
    tracked: settings?.platforms ?? [],
    ga4: snapshot("GA4") as GeoSnapshot | null,
    bots: snapshot("BOT") as GeoSnapshot | null,
  });
  return {
    siteId: site.id,
    domain: site.domain,
    probe: probe ? { checkedAt: probe.checkedAt, cdn: probe.cdn, urls: probe.urls } : null,
    crawl: crawl ? { finishedAt: crawl.finishedAt?.toISOString() ?? null, pages: pages.length, directivesRecorded: pages.some(p => p.robotsMetas !== null) } : null,
    platforms,
  };
}
