import type { PrismaClient } from "@prisma/client";
import { fetchPublic, readBodyCapped } from "@/lib/crawler/engine";
import { ContentError } from "@/lib/content-planner/http";
import { RateLimiter } from "@/lib/rate-limit";
import { evaluateAiRobots, fetchAiRobots } from "@/lib/seo/ai-access";
import type { AiAccessBot, AiAccessOutcome } from "@/lib/seo/ai-access-types";
import { GEO_PLATFORMS } from "./platforms";
import type { ProbeCheck, ProbeOutcome, ProbeResponse } from "./probe-rules";
import { runProbe } from "./probe-run";

/*
 * The live access check: the site's home page and its most visible page,
 * requested once as an ordinary browser and once with each AI crawler's user
 * agent, plus robots.txt read for every crawler and control token. Only the
 * owner's own site is requested, a few requests at a time; the result is kept
 * as the site's PROBE snapshot. See probe-rules.ts for what a result can and
 * cannot show.
 */

export type ProbeRobots = Pick<AiAccessBot, "robots" | "declared" | "rule" | "matchedLine"> & { token: string; url: string };
export type ProbeReport = {
  checkedAt: string;
  urls: string[];
  cdn: string | null;
  browser: { url: string; outcome: ProbeOutcome; status: number | null; error: string | null; finalUrl: string | null }[];
  checks: ProbeCheck[];
  robots: { url: string; status: number | null; outcome: AiAccessOutcome; reason: string | null; bots: ProbeRobots[] };
};

const BODY_BYTES = 64 * 1024;
const limiter = new RateLimiter(2);
const running = new Set<string>();

/** Tokens the platform view reads robots.txt rules for: every crawler and control token. */
export function robotsTokens(): string[] {
  return [...new Set(GEO_PLATFORMS.flatMap(p => [...p.crawlers.map(c => c.token), ...p.controlTokens]))];
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Timed out after /.test(message)) return "Timed out";
  if (/^Too many redirects/.test(message)) return "Too many redirects";
  if (/private|reserved|blocked address/i.test(message)) return "Address not allowed";
  return message.replace(/https?:\/\/\S+/g, "").trim().slice(0, 120) || "Request failed";
}

async function request(url: string, userAgent: string, signal: AbortSignal): Promise<ProbeResponse> {
  const headers = {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  try {
    const response = await fetchPublic(url, headers, {
      signal,
      guard: async next => {
        const hop = new URL(next);
        if (hop.username || hop.password) throw new Error("Credentials in a redirect");
      },
    });
    try {
      const out: Record<string, string> = {};
      let count = 0;
      response.res.headers.forEach((value, name) => { if (count++ < 60) out[name.toLowerCase()] = value.slice(0, 300); });
      let body = "";
      try {
        body = new TextDecoder("utf-8", { fatal: false }).decode(await readBodyCapped(response.res, BODY_BYTES, true));
      } catch { /* the status and headers still tell */ }
      return { status: response.res.status, headers: out, body, error: null, finalUrl: response.finalUrl };
    } finally {
      response.done();
    }
  } catch (error) {
    return { status: null, headers: {}, body: "", error: shortError(error), finalUrl: null };
  }
}

/** The home page and the page with the most Search Console impressions in the last 28 days, else a crawled page. */
async function probeUrls(db: PrismaClient, siteId: string, domain: string): Promise<string[]> {
  const home = new URL(`https://${domain}/`).href;
  const since = new Date(Date.now() - 28 * 86_400_000);
  const top = await db.page.groupBy({
    by: ["url"], where: { siteId, date: { gte: since } }, _sum: { impressions: true },
    orderBy: { _sum: { impressions: "desc" } }, take: 5,
  });
  const crawl = await db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
  const crawled = crawl
    ? await db.auditPage.findMany({ where: { crawlId: crawl.id, statusCode: 200, indexable: true }, select: { url: true }, orderBy: { url: "asc" }, take: 5 }) as { url: string }[]
    : [];
  const sameSite = (url: string) => {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      // Another page than the home page, on the site's host (with or without www).
      return /^https?:$/.test(u.protocol) && !u.username && !u.password && host === domain.replace(/^www\./, "") && (u.pathname !== "/" || u.search !== "");
    } catch { return false; }
  };
  const second = [...top.map(r => r.url), ...crawled.map(r => r.url)].find(sameSite);
  return second ? [home, second] : [home];
}

/** Runs the check for an owned site and saves it as the PROBE snapshot. */
export async function probeSite(db: PrismaClient, userId: string | undefined, siteId: string, signal?: AbortSignal): Promise<ProbeReport> {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
  if (!site) throw new ContentError("Unknown site", 404);
  if (running.has(site.id)) throw new ContentError("An access check is already running for this site", 429);
  if (!limiter.hit(userId).ok) throw new ContentError("Too many access checks. Wait a minute and retry.", 429);
  running.add(site.id);
  try {
    const urls = await probeUrls(db, site.id, site.domain);
    const stop = signal ?? new AbortController().signal;
    const [live, evidence] = await Promise.all([
      runProbe(urls, (url, ua) => request(url, ua, stop)),
      fetchAiRobots(urls[0]),
    ]);
    // A check cut short (the request went away) would read as refusals: keep the previous one.
    stop.throwIfAborted();
    const tokens = new Set(robotsTokens());
    const bots = urls.flatMap(url => evaluateAiRobots(url, evidence)
      .filter(bot => tokens.has(bot.agent))
      .map((bot): ProbeRobots => ({ token: bot.agent, url, robots: bot.robots, declared: bot.declared, rule: bot.rule, matchedLine: bot.matchedLine })));
    const report: ProbeReport = {
      checkedAt: new Date().toISOString(),
      ...live,
      robots: { url: evidence.url, status: evidence.status, outcome: evidence.outcome, reason: evidence.reason, bots },
    };
    const updatedAt = new Date();
    await db.geoSnapshot.upsert({
      where: { siteId_kind: { siteId: site.id, kind: "PROBE" } },
      create: { siteId: site.id, kind: "PROBE", report, updatedAt },
      update: { report, updatedAt },
    });
    return report;
  } finally {
    running.delete(site.id);
  }
}
