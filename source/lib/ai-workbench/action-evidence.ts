import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { dateWindow, getGscDateRange } from "@/lib/date-utils";
import { visibleIssuesWhere } from "@/lib/crawler/issue-filter";
import { auditIssueDisplayType } from "@/lib/crawler/audit-policy";
import { reportTotal, reportUrl, type AiReport } from "@/lib/geo/reports";
import type { ProbeReport } from "@/lib/geo/probe";
import type { GeoSnapshot } from "@/lib/geo/types";
import type { ActionScope, ReportEvidence } from "./action-scope";

type Db = Prisma.TransactionClient;
type Site = ReportEvidence["site"];
type Period = ReportEvidence["period"];
type Row = Record<string, string | number | boolean | null>;
type Section = ReportEvidence["sections"][number];
const DAY = 86_400_000;
const day = (value: Date) => value.toISOString().slice(0, 10);

// Only ordinary public site URLs enter the prompt or become links. Query strings
// may contain signed credentials or distinct resources that cannot be merged.
function publicPage(raw: string, site: Site) {
  const url = reportUrl(raw, site.domain);
  return url && !new URL(url).search && url.length <= 512 ? url : null;
}

function weeklyTraffic(rows: { date: Date; clicks: number | null; impressions: number | null }[], period: Period): Row[] {
  const result: Row[] = [];
  for (const [start, end] of [[period.previousStart, period.previousEnd], [period.start, period.end]]) {
    const within = rows.filter(r => day(r.date) >= start && day(r.date) <= end);
    const clicks = within.flatMap(r => r.clicks === null ? [] : [r.clicks]);
    const impressions = within.flatMap(r => r.impressions === null ? [] : [r.impressions]);
    if (!clicks.length && !impressions.length) continue;
    result.push({ kind: "observedTraffic", start, end, expectedDays: 7,
      clickDays: clicks.length, impressionDays: impressions.length,
      observedClicks: clicks.length ? clicks.reduce((sum, n) => sum + n, 0) : null,
      observedImpressions: impressions.length ? impressions.reduce((sum, n) => sum + n, 0) : null });
  }
  return result;
}

async function gscEvidence(db: Db, site: Site, period: Period, property: string | null): Promise<Section> {
  const rows: Row[] = [];
  if (property) {
    const coverage = await db.gscSyncCoverage.findMany({ where: { siteId: site.id, gscProperty: property,
      date: { gte: new Date(period.previousStart), lte: new Date(period.end) } }, orderBy: { date: "asc" }, take: 14,
      select: { date: true, propertyChecked: true, propertyClicks: true, propertyImpressions: true, pagesComplete: true } });
    if (coverage.some(r => r.propertyChecked)) {
      rows.push(...weeklyTraffic(coverage.filter(r => r.propertyChecked).map(r =>
        ({ date: r.date, clicks: r.propertyClicks, impressions: r.propertyImpressions })), period));
    } else {
      const savedDays = coverage.filter(r => r.pagesComplete).map(r => r.date);
      if (savedDays.length) {
        const totals = await db.page.groupBy({ by: ["date"], where: { siteId: site.id, date: { in: savedDays } },
          _sum: { clicks: true, impressions: true }, orderBy: { date: "asc" } });
        rows.push(...weeklyTraffic(totals.map(r => ({ date: r.date, ...r._sum })), period)
          .map(row => ({ ...row, kind: "pageRowsTraffic" })));
      }
    }
    const dates = coverage.filter(r => r.pagesComplete && day(r.date) >= period.start).map(r => r.date);
    if (dates.length) {
      const pages = await db.page.groupBy({ by: ["url"], where: { siteId: site.id, date: { in: dates } },
        _sum: { clicks: true, impressions: true }, orderBy: [{ _sum: { impressions: "desc" } }, { url: "asc" }], take: 5 });
      for (const p of pages) {
        const url = publicPage(p.url, site);
        if (url) rows.push({ kind: "topPage", start: period.start, end: period.end, coveredDays: dates.length,
          url, observedClicks: p._sum.clicks, observedImpressions: p._sum.impressions });
      }
    }
  }
  return { source: "gsc", rows };
}

async function bingEvidence(db: Db, site: Site, period: Period, property: string | null): Promise<Section> {
  if (!property) return { source: "bing", rows: [] };
  const range = { gte: new Date(period.previousStart), lte: new Date(period.end) };
  const [days, bucket] = await Promise.all([
    db.bingDaily.findMany({ where: { siteId: site.id, date: range }, orderBy: { date: "asc" }, take: 14,
      select: { date: true, clicks: true, impressions: true, inIndex: true, crawlErrors: true, blockedByRobots: true } }),
    db.bingSearchWeekly.aggregate({ where: { siteId: site.id, kind: "page", weekEnding: range }, _max: { weekEnding: true } }),
  ]);
  const rows = weeklyTraffic(days, period);
  const index = days.filter(r => r.inIndex !== null || r.crawlErrors !== null || r.blockedByRobots !== null).at(-1);
  if (index) rows.push({ kind: "indexSnapshot", date: day(index.date), inIndex: index.inIndex,
    crawlErrors: index.crawlErrors, blockedByRobots: index.blockedByRobots });
  const weekEnding = bucket._max.weekEnding;
  if (weekEnding) {
    const pages = await db.bingSearchWeekly.findMany({ where: { siteId: site.id, weekEnding, kind: "page", impressions: { not: null } },
      orderBy: [{ impressions: "desc" }, { key: "asc" }], take: 5, select: { key: true, clicks: true, impressions: true } });
    for (const p of pages) {
      const url = publicPage(p.key, site);
      if (url) rows.push({ kind: "topPage", start: dateWindow(7, day(weekEnding)).start, end: day(weekEnding), url,
        observedClicks: p.clicks, observedImpressions: p.impressions });
    }
  }
  return { source: "bing", rows };
}

async function auditEvidence(db: Db, site: Site, since: Date | undefined): Promise<Section> {
  const crawl = await db.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED", finishedAt: { not: null, gte: since } },
    orderBy: [{ finishedAt: "desc" }, { id: "asc" }],
    select: { id: true, finishedAt: true, pagesFound: true, maxPages: true, healthScore: true } });
  const rows: Row[] = [];
  if (crawl?.finishedAt) {
    const date = crawl.finishedAt.toISOString();
    rows.push({ kind: "crawlSummary", date, sampledPages: crawl.pagesFound, pageLimit: crawl.maxPages, healthScore: crawl.healthScore });
    const issues = await db.crawlIssue.findMany({ where: visibleIssuesWhere(crawl.id), take: 8,
      orderBy: [{ severity: "asc" }, { url: "asc" }, { id: "asc" }], select: { severity: true, type: true, details: true, url: true } });
    for (const issue of issues) {
      const url = publicPage(issue.url, site);
      const details = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details) ? issue.details : null;
      if (url) rows.push({ kind: "crawlIssue", date, url, severity: issue.severity, issue: auditIssueDisplayType({ type: issue.type, details }) });
    }
  }
  return { source: "audit", rows };
}

async function performanceEvidence(db: Db, site: Site, since: Date | undefined): Promise<Section> {
  const reports = await db.vitalsReport.findMany({ where: { siteId: site.id, date: { gte: since } },
    orderBy: [{ date: "desc" }, { id: "asc" }], take: 10,
    select: { date: true, url: true, device: true, perfScore: true, lcp: true, cls: true, inp: true, ttfb: true, speedIndex: true } });
  const rows: Row[] = [];
  for (const r of reports) {
    const url = publicPage(r.url, site);
    if (url) rows.push({ kind: "performanceSample", date: r.date.toISOString(), url, device: r.device, perfScore: r.perfScore,
      lcpSeconds: r.lcp, cls: r.cls, inpMs: r.inp, ttfbSeconds: r.ttfb, speedIndexSeconds: r.speedIndex });
  }
  return { source: "performance", rows };
}

async function alertsEvidence(db: Db, site: Site, since: Date | undefined): Promise<Section> {
  // The database stores the last trigger per rule, not a history of events.
  // Alert.config may contain a webhook URL or private delivery settings.
  const rules = await db.alert.findMany({ where: { siteId: site.id, lastFired: { not: null, gte: since } },
    orderBy: [{ lastFired: "desc" }, { id: "asc" }], take: 8, select: { type: true, enabled: true, lastFired: true } });
  return { source: "alerts", rows: rules.map(r => ({ kind: "lastAlertTrigger", issue: r.type, enabled: r.enabled, date: r.lastFired!.toISOString() })) };
}

async function geoEvidence(db: Db, site: Site): Promise<Section> {
  const [snapshots, answers] = await Promise.all([
    db.geoSnapshot.findMany({ where: { siteId: site.id, kind: { in: ["PROBE", "BOT", "GA4", "BING_AI", "GSC_AI"] } },
      orderBy: { kind: "asc" }, take: 5, select: { kind: true, updatedAt: true, report: true } }),
    db.geoAnswer.findMany({ where: { siteId: site.id, status: "OK" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 5,
      select: { platform: true, source: true, createdAt: true, citations: true } }),
  ]);
  const rows: Row[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.report || typeof snapshot.report !== "object" || Array.isArray(snapshot.report)) continue;
    const date = snapshot.updatedAt.toISOString();
    if (snapshot.kind === "PROBE") {
      const probe = snapshot.report as unknown as ProbeReport;
      for (const check of (probe.checks ?? []).slice(0, 8)) {
        const url = publicPage(check.url, site);
        if (url) rows.push({ kind: "accessProbe", date, platform: check.token, url, verdict: check.verdict, httpStatus: check.status });
      }
    } else if (snapshot.kind === "BOT" || snapshot.kind === "GA4") {
      const snapshotData = snapshot.report as unknown as GeoSnapshot;
      const platforms = new Map<string, number>();
      for (const row of snapshotData.rows ?? []) platforms.set(row.platform, (platforms.get(row.platform) ?? 0) + row.count);
      const top = [...platforms].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5);
      const traffic = snapshot.kind === "GA4";
      for (const [platform, count] of top) rows.push({ kind: traffic ? "referralTraffic" : "botRequests", platform, date,
        start: snapshotData.start ?? null, end: snapshotData.end ?? null, [traffic ? "referralSessions" : "crawlerRequests"]: count });
    } else {
      const report = snapshot.report as unknown as AiReport;
      if (!Array.isArray(report.daily)) continue;
      const citations = snapshot.kind === "BING_AI";
      rows.push({ kind: citations ? "officialCitations" : "officialImpressions", date, platform: snapshot.kind,
        start: report.start ?? null, end: report.end ?? null, [citations ? "citations" : "impressions"]: reportTotal(report) });
      if (citations) for (const item of (report.queries ?? []).slice(0, 3)) {
        rows.push({ kind: "queryCitations", date, platform: snapshot.kind, query: item.query.slice(0, 160), citations: item.value });
      }
    }
  }
  for (const answer of answers) {
    const refs = Array.isArray(answer.citations) ? answer.citations : null;
    const siteCited = refs?.some(ref => ref && typeof ref === "object" && !Array.isArray(ref) &&
      typeof ref.url === "string" && /^https?:\/\//i.test(ref.url) && reportUrl(ref.url, site.domain) !== null) ?? null;
    rows.push({ kind: "answerObservation", platform: answer.platform, date: answer.createdAt.toISOString(), answerSource: answer.source, siteCited });
  }
  return { source: "geo", rows };
}

/** The caller must already have verified ownership of site in the same transaction. */
export async function collectActionEvidence(db: Db, site: Site, scope: ActionScope, now = new Date()): Promise<ReportEvidence> {
  const current = getGscDateRange(7, now);
  const previous = dateWindow(7, day(new Date(Date.parse(current.start) - DAY)));
  const period = { ...current, previousStart: previous.start, previousEnd: previous.end };
  const since = scope === "weekly" ? new Date(dateWindow(7, day(now)).start) : undefined;
  const sections: Section[] = [];
  if (scope === "weekly" || scope === "bing") {
    const binding = await db.site.findUnique({ where: { id: site.id }, select: { gscProperty: true, bingSite: true } });
    if (scope === "weekly") sections.push(await gscEvidence(db, site, period, binding?.gscProperty ?? null));
    sections.push(await bingEvidence(db, site, period, binding?.bingSite ?? null));
  }
  if (scope === "weekly" || scope === "audit") sections.push(await auditEvidence(db, site, since));
  if (scope === "weekly" || scope === "performance") sections.push(await performanceEvidence(db, site, since));
  if (scope === "weekly" || scope === "alerts") sections.push(await alertsEvidence(db, site, since));
  if (scope === "geo") sections.push(await geoEvidence(db, site));
  return limitActionEvidence({ scope, site: { id: site.id, domain: site.domain }, period, sections, hasData: sections.some(s => s.rows.length > 0) });
}

// A prompt enters the worker's claim as an escaped JSON string. Allocate
// budget across sources so large page URLs cannot crowd out another report.
export function limitActionEvidence(evidence: ReportEvidence): ReportEvidence {
  const limit = 18_000;
  const wireLength = (value: unknown) => JSON.stringify(JSON.stringify(value)).length;
  if (wireLength(evidence) <= limit) return evidence;
  const sections = evidence.sections.map(section => ({ source: section.source, rows: [] as Row[] }));
  const bounded = { ...evidence, sections, truncated: true };
  let used = wireLength(bounded);
  const exhausted = new Set<number>();
  const longest = Math.max(0, ...evidence.sections.map(s => s.rows.length));
  for (let j = 0; j < longest; j++) {
    for (const [i, source] of evidence.sections.entries()) {
      const row = source.rows[j];
      if (!row || exhausted.has(i)) continue;
      const growth = wireLength(row) - 2 + (j ? 1 : 0);
      if (used + growth > limit) { exhausted.add(i); continue; }
      sections[i].rows.push(row);
      used += growth;
    }
  }
  bounded.hasData = sections.some(s => s.rows.length > 0);
  return bounded;
}

export function actionEvidenceRevision(evidence: ReportEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest("hex");
}

export async function getActionEvidence(db: PrismaClient, userId: string | undefined | null, siteId: string, scope: ActionScope, now = new Date()) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  return db.$transaction(async tx => {
    const site = await tx.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
    if (!site) throw new ContentError("Unknown site", 404);
    const evidence = await collectActionEvidence(tx, site, scope, now);
    return { ...evidence, revision: actionEvidenceRevision(evidence) };
  }, { isolationLevel: "RepeatableRead" });
}
