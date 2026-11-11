/**
 * LLM-optimized text formatters for MCP tool responses: compact text tables
 * with aligned columns, from the JSON the /api/v1 API returns.
 */

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = widths.map((w) => "-".repeat(w)).join(" | ");

  const headerLine = headers.map((h, i) => pad(h, widths[i])).join(" | ");
  const dataLines = rows.map((row) =>
    row.map((cell, i) => pad(cell, widths[i])).join(" | ")
  );

  return [headerLine, sep, ...dataLines].join("\n");
}

// Input shapes: only the fields each formatter reads.

type SearchRow = { clicks: number; impressions: number; position: number; ctr: number };

type VitalsRow = {
  date: Date | string;
  device: string;
  perfScore: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  ttfb: number | null;
};

type AuditReview = { excluded: number; unverified: number; message: string };

type CrawlRow = {
  id: string;
  status: string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  pagesFound: number;
  issuesFound: number;
  healthScore: number | null;
  error?: string | null;
  maxPages?: number;
  auditReview?: AuditReview | null;
};

type Period = { startDate: string; endDate: string };

type SiteOverview = {
  id: string;
  domain: string;
  gscProperty?: string | null;
  metricsDays?: number;
  metrics?: {
    current: { clicks: number; impressions: number; avgPosition: number; avgCtr: number; uniqueKeywords: number };
    deltas: { clicks: number | null; impressions: number | null; avgPosition: number | null; avgCtr: number | null };
    coverage?: { comparable: boolean; current: { start: string; end: string }; previous: { start: string; end: string }; currentDays: number; previousDays: number; expectedDays: number };
  } | null;
  latestCrawl?: CrawlRow | null;
  auditReview?: AuditReview | null;
  latestVitals?: VitalsRow | null;
};

type Opportunities = {
  coverage?: { comparable: boolean; queryPagesComplete: boolean };
  summary: { strikingDistance: number; lowCtr: number; contentDecay: number; cannibalization: number };
  feed?: { type: string; severity: string; title?: string | null; detail?: string | null }[];
};

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pos(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "-";
  return n.toFixed(1);
}

function minute(d: Date | string | null | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "-";
}

function period(p: Period): string {
  return `${p.startDate} to ${p.endDate}`;
}

function crawlNotices(crawl: CrawlRow, auditReview = crawl.auditReview): string[] {
  const lines: string[] = [];
  if (crawl.maxPages != null && Number.isFinite(crawl.maxPages) && crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages) {
    lines.push(`Limited crawl sample: reached the ${num(crawl.maxPages)}-page limit. Findings and health describe the crawled sample; potential orphan pages may have inbound links outside it.`);
  }
  if (auditReview && (auditReview.excluded > 0 || auditReview.unverified > 0)) {
    lines.push(`Audit review: ${auditReview.message}`);
  }
  return lines;
}

export function formatSiteOverview(site: SiteOverview): string {
  const lines: string[] = [];
  lines.push(`Site: ${site.domain}`);
  lines.push(`ID: ${site.id}`);
  if (site.gscProperty) lines.push(`GSC Property: ${site.gscProperty}`);
  lines.push("");

  if (site.metrics) {
    const m = site.metrics;
    lines.push(`-- Last ${site.metricsDays ?? 28} days vs the ${site.metricsDays ?? 28} days before --`);
    const delta = (value: number | null, suffix = "%") => value === null || !Number.isFinite(value)
      ? "not comparable" : `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
    if (m.coverage) {
      const c = m.coverage;
      lines.push(`Periods: ${c.current.start} to ${c.current.end} vs ${c.previous.start} to ${c.previous.end}`);
      lines.push(`Confirmed sync days: ${c.currentDays}/${c.expectedDays} + ${c.previousDays}/${c.expectedDays}`);
      if (!c.comparable) lines.push("Insufficient synced history: do not infer growth or decline. Run a normal GSC sync to complete the periods.");
    }
    lines.push(`Clicks:      ${num(m.current.clicks)} (${delta(m.deltas.clicks)})`);
    lines.push(`Impressions: ${num(m.current.impressions)} (${delta(m.deltas.impressions)})`);
    lines.push(`Avg Position: ${pos(m.current.avgPosition)} (${delta(m.deltas.avgPosition, " improvement")})`);
    lines.push(`Avg CTR:     ${m.current.impressions > 0 ? pct(m.current.avgCtr) : "-"} (${delta(m.deltas.avgCtr)})`);
    lines.push(`Keywords:    ${num(m.current.uniqueKeywords)}`);
  }

  if (site.latestCrawl) {
    const c = site.latestCrawl;
    lines.push("");
    lines.push("-- Latest Crawl --");
    lines.push(`ID: ${c.id}`);
    lines.push(`Status: ${c.status}  |  Health: ${c.healthScore ?? "-"}/100`);
    if (c.status === "FAILED" && c.error) lines.push(`Error: ${c.error}`);
    lines.push(`Pages: ${num(c.pagesFound)}  |  Issues: ${num(c.issuesFound)}`);
    if (c.finishedAt) lines.push(`Finished: ${minute(c.finishedAt)}`);
    lines.push(...crawlNotices(c, c.auditReview ?? site.auditReview));
  }

  if (site.latestVitals) {
    const v = site.latestVitals;
    lines.push("");
    lines.push("-- Latest Vitals --");
    lines.push(`Perf Score: ${v.perfScore ?? "-"}/100  |  Device: ${v.device}`);
    if (v.lcp != null) lines.push(`LCP: ${v.lcp.toFixed(2)}s`);
    if (v.cls != null) lines.push(`CLS: ${v.cls.toFixed(3)}`);
    if (v.inp != null) lines.push(`INP: ${v.inp.toFixed(0)}ms`);
    if (v.ttfb != null) lines.push(`TTFB: ${v.ttfb.toFixed(2)}s`);
  }

  return lines.join("\n");
}

export function formatKeywords(keywords: (SearchRow & { query: string })[], p: Period): string {
  if (keywords.length === 0) return `No keywords found for ${period(p)}.`;

  const headers = ["Keyword", "Clicks", "Impressions", "Position", "CTR"];
  const rows = keywords.map((k) => [
    k.query.length > 50 ? k.query.slice(0, 47) + "..." : k.query,
    num(k.clicks),
    num(k.impressions),
    pos(k.position),
    pct(k.ctr),
  ]);

  return `Top ${keywords.length} keywords, ${period(p)}:\n\n` + formatTable(headers, rows);
}

export function formatPages(pages: (SearchRow & { url: string })[], p: Period): string {
  if (pages.length === 0) return `No pages found for ${period(p)}.`;

  const headers = ["URL", "Clicks", "Impressions", "Position", "CTR"];
  const rows = pages.map((p) => {
    let url = p.url;
    try {
      url = new URL(p.url).pathname;
    } catch {}
    if (url.length > 60) url = url.slice(0, 57) + "...";
    return [url, num(p.clicks), num(p.impressions), pos(p.position), pct(p.ctr)];
  });

  return `Top ${pages.length} pages, ${period(p)}:\n\n` + formatTable(headers, rows);
}

export function formatTraffic(traffic: { date: string; clicks: number; impressions: number }[], p: Period): string {
  if (traffic.length === 0) return `No traffic data found for ${period(p)}.`;

  const headers = ["Date", "Clicks", "Impressions"];
  const rows = traffic.map((t) => [t.date, num(t.clicks), num(t.impressions)]);

  const totalClicks = traffic.reduce((s, t) => s + t.clicks, 0);
  const totalImpressions = traffic.reduce((s, t) => s + t.impressions, 0);

  return (
    `Daily traffic, ${period(p)} (${traffic.length} days with data):\n` +
    `Total: ${num(totalClicks)} clicks, ${num(totalImpressions)} impressions\n\n` +
    formatTable(headers, rows)
  );
}

export function formatCrawls(crawls: CrawlRow[]): string {
  if (crawls.length === 0) return "No crawls yet.";

  const headers = ["Crawl ID", "Status", "Started", "Finished", "Pages", "Issues", "Health"];
  const rows = crawls.map((c) => [
    c.id,
    c.status,
    minute(c.startedAt),
    minute(c.finishedAt),
    num(c.pagesFound),
    num(c.issuesFound),
    c.healthScore != null ? `${c.healthScore}/100` : "-",
  ]);
  const failed = crawls.filter((c) => c.status === "FAILED" && c.error).map((c) => `${c.id}: ${c.error}`);
  const notices = crawls.flatMap((c) => crawlNotices(c).map((notice) => `${c.id}: ${notice}`));

  return `${crawls.length} crawl(s), newest first:\n\n` + formatTable(headers, rows) +
    (failed.length ? `\n\nFailed:\n${failed.join("\n")}` : "") +
    (notices.length ? `\n\n${notices.join("\n")}` : "");
}

export function formatCrawlIssues(result: {
  crawl: CrawlRow;
  total: number;
  bySeverity: Record<string, number>;
  /** Absent from instances that predate noindex handling. */
  noindexPages?: number;
  /** Set when most fetched pages are noindex; absent from older instances. */
  noindexWarning?: { message: string } | null;
  /** Absent from instances without local audit review. */
  auditReview?: AuditReview | null;
  issues: { severity: string; type: string; url: string; message: string }[];
}): string {
  const { crawl, total, bySeverity, noindexPages, noindexWarning, auditReview, issues } = result;
  const notices = crawlNotices(crawl, auditReview ?? crawl.auditReview);
  const noindex =
    (noindexWarning?.message ? `WARNING: ${noindexWarning.message} The health score leaves them out.\n` : "") +
    (noindexPages ? `${num(noindexPages)} noindex pages crawled but not scored (no issues, not in the health score)\n` : "");
  const head =
    `Crawl ${crawl.id} (${crawl.status}, finished ${minute(crawl.finishedAt)}, health ${crawl.healthScore ?? "-"}/100)\n` +
    `${num(total)} issues: ${num(bySeverity.CRITICAL ?? 0)} critical, ${num(bySeverity.WARNING ?? 0)} warning, ${num(bySeverity.INFO ?? 0)} info\n` +
    noindex +
    (notices.length ? notices.join("\n") + "\n" : "") +
    "\n";
  if (issues.length === 0) return head + "No crawl issues found.";

  const headers = ["Severity", "Type", "URL", "Message"];
  const rows = issues.map((i) => [
    i.severity,
    i.type,
    i.url.length > 40 ? i.url.slice(0, 37) + "..." : i.url,
    i.message.length > 50 ? i.message.slice(0, 47) + "..." : i.message,
  ]);

  return head + `Showing ${issues.length}:\n\n` + formatTable(headers, rows);
}

export function formatVitals(vitals: VitalsRow[]): string {
  if (vitals.length === 0) return "No vitals reports found.";

  const headers = ["Date", "Device", "Perf", "LCP", "CLS", "INP", "TTFB"];
  const rows = vitals.map((v) => [
    new Date(v.date).toISOString().slice(0, 10),
    v.device,
    v.perfScore != null ? String(v.perfScore) : "-",
    v.lcp != null ? `${v.lcp.toFixed(2)}s` : "-",
    v.cls != null ? v.cls.toFixed(3) : "-",
    v.inp != null ? `${v.inp.toFixed(0)}ms` : "-",
    v.ttfb != null ? `${v.ttfb.toFixed(2)}s` : "-",
  ]);

  return `${vitals.length} vitals reports:\n\n` + formatTable(headers, rows);
}

export function formatOpportunities(opportunities: Opportunities): string {
  const lines: string[] = [];
  const s = opportunities.summary;

  lines.push("SEO Opportunities Summary");
  const c = opportunities.coverage;
  lines.push(`Striking distance: ${s.strikingDistance} | Low CTR: ${s.lowCtr} | Content decay: ${c && !c.comparable ? "insufficient data" : s.contentDecay} | Multi-page queries: ${c && !c.queryPagesComplete ? "insufficient data" : s.cannibalization}`);
  if (c && (!c.comparable || !c.queryPagesComplete)) lines.push("Complete a GSC sync before interpreting decay or multi-page queries. Multiple pages can serve different intents; do not merge based on this signal alone.");
  lines.push("");

  if (opportunities.feed && opportunities.feed.length > 0) {
    const headers = ["Type", "Severity", "Title", "Detail"];
    const rows = opportunities.feed.map((o) => [
      o.type,
      o.severity,
      (o.title || "").length > 35 ? (o.title || "").slice(0, 32) + "..." : o.title || "",
      (o.detail || "").length > 55 ? (o.detail || "").slice(0, 52) + "..." : o.detail || "",
    ]);
    lines.push(formatTable(headers, rows));
  } else {
    lines.push("No actionable opportunities found.");
  }

  return lines.join("\n");
}

// Bing Webmaster Tools. Counters Bing did not report are null and read "-".

type BingDay = {
  date: string;
  clicks: number | null;
  impressions: number | null;
  crawledPages: number | null;
  inIndex: number | null;
  crawlErrors: number | null;
};

type BingSearchRow = { clicks: number | null; impressions: number | null; position: number | null; weeks: number };

type BingPeriod = Period & { bingSite: string };

function maybe(n: number | null): string {
  return n === null ? "-" : num(n);
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((s, v) => s + v, 0) : null;
}

export function formatBingTraffic(days: BingDay[], p: BingPeriod): string {
  if (days.length === 0) return `No Bing data found for ${period(p)} (${p.bingSite}).`;

  const headers = ["Date", "Clicks", "Impressions", "Crawled", "In index", "Crawl errors"];
  const rows = days.map((d) => [d.date, maybe(d.clicks), maybe(d.impressions), maybe(d.crawledPages), maybe(d.inIndex), maybe(d.crawlErrors)]);

  return (
    `Bing daily traffic and crawling, ${p.bingSite}, ${period(p)} (${days.length} days with data):\n` +
    `Total: ${maybe(sum(days.map((d) => d.clicks)))} clicks, ${maybe(sum(days.map((d) => d.impressions)))} impressions, ` +
    `${maybe(sum(days.map((d) => d.crawledPages)))} pages crawled\n` +
    `In index and crawl errors are Bing's count on that day, not a daily total.\n\n` +
    formatTable(headers, rows)
  );
}

function bingSearchTable(label: string, rows: (BingSearchRow & { name: string })[], p: BingPeriod): string {
  if (rows.length === 0) return `No Bing ${label} found for ${period(p)} (${p.bingSite}).`;

  const headers = [label === "keywords" ? "Keyword" : "URL", "Clicks", "Impressions", "Position", "Weeks"];
  const body = rows.map((r) => [
    r.name.length > 60 ? r.name.slice(0, 57) + "..." : r.name,
    maybe(r.clicks),
    maybe(r.impressions),
    r.position === null ? "-" : pos(r.position),
    String(r.weeks),
  ]);

  return (
    `Top ${rows.length} Bing ${label}, ${p.bingSite}, weeks ending ${period(p)}:\n` +
    `Bing reports queries and pages by week; position is weighted by impressions.\n\n` +
    formatTable(headers, body)
  );
}

export function formatBingKeywords(keywords: (BingSearchRow & { query: string })[], p: BingPeriod): string {
  return bingSearchTable("keywords", keywords.map((k) => ({ ...k, name: k.query })), p);
}

export function formatBingPages(pages: (BingSearchRow & { url: string })[], p: BingPeriod): string {
  return bingSearchTable("pages", pages.map((r) => ({ ...r, name: r.url })), p);
}


type SavedKeyword = {
  query: string;
  notes: string | null;
  savedAt: string;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
  ctr: number | null;
};

export function formatSavedKeywords(saved: SavedKeyword[], p: Period): string {
  if (saved.length === 0) return "No saved keywords for this site.";

  const headers = ["Keyword", "Clicks", "Impressions", "Position", "CTR", "Saved", "Notes"];
  const rows = saved.map((k) => [
    k.query.length > 50 ? k.query.slice(0, 47) + "..." : k.query,
    k.clicks === null ? "-" : num(k.clicks),
    k.impressions === null ? "-" : num(k.impressions),
    k.position === null ? "-" : pos(k.position),
    k.ctr === null ? "-" : pct(k.ctr),
    k.savedAt.slice(0, 10),
    k.notes ? (k.notes.length > 40 ? k.notes.slice(0, 37) + "..." : k.notes) : "",
  ]);
  const noData = saved.filter((k) => k.impressions === null).length;

  return (
    `${saved.length} saved keywords, Search Console totals for ${period(p)}:\n` +
    (noData ? `${noData} had no Search Console data in this period ("-").\n` : "") +
    "\n" +
    formatTable(headers, rows)
  );
}

type AiLayerState = "GOOD" | "WARN" | "BAD" | "UNKNOWN" | "NA";
type AiVisibility = {
  site: { domain: string };
  probe: { checkedAt: string; cdn: string | null; urls: string[] } | null;
  crawl: { finishedAt: string | null; pages: number } | null;
  tracking: {
    activePrompts: number;
    lastRun: { status: string; startedAt: string; planned: number; done: number; failed: number; costUsd: number; errorCode: string | null } | null;
  };
  platforms: {
    name: string;
    access: { state: AiLayerState; blockedInRobots: string[]; refusedLive: string[] };
    eligibility: { state: AiLayerState; pages: number; ok: number; limited: number; excluded: number };
    index: { state: AiLayerState; kind: string | null; pages: number | null };
    report: { state: AiLayerState; kind: string | null; total: number | null };
    answers: { state: AiLayerState; source: string; tracked: boolean; answers: number; mentionRate: number | null; citationRate: number | null; shareOfVoice: number | null };
    traffic: { state: AiLayerState; referrals: number | null; crawlerRequests: number | null };
  }[];
};

const ratio = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

/** One line per platform; a layer without data reads "no data", one that does not apply "n/a". */
export function formatAiVisibility(r: AiVisibility): string {
  const layer = (state: AiLayerState, detail: string) => (state === "NA" ? "n/a" : state === "UNKNOWN" ? "no data" : `${state} ${detail}`.trim());
  const rows = r.platforms.map((p) => [
    p.name,
    layer(p.access.state, [...p.access.blockedInRobots.map((t) => `robots blocks ${t}`), ...p.access.refusedLive.map((t) => `refuses ${t}`)].join(", ")),
    layer(p.eligibility.state, p.eligibility.pages ? `${p.eligibility.ok}/${p.eligibility.pages} usable` : ""),
    layer(p.index.state, p.index.pages !== null ? `${p.index.pages} pages` : ""),
    layer(p.report.state, p.report.total !== null ? `${p.report.total} ${p.report.kind === "GSC_AI" ? "impressions" : "citations"}` : ""),
    p.answers.answers
      ? `${ratio(p.answers.mentionRate)} named, ${ratio(p.answers.citationRate)} cited, SoV ${ratio(p.answers.shareOfVoice)} (${p.answers.answers})`
      : p.answers.source === "MANUAL" ? "record by hand" : p.answers.tracked ? "no answers yet" : "not tracked",
    p.traffic.state === "NA" || p.traffic.state === "UNKNOWN" ? layer(p.traffic.state, "")
      : [p.traffic.referrals !== null ? `${p.traffic.referrals} sessions` : "", p.traffic.crawlerRequests !== null ? `${p.traffic.crawlerRequests} crawler hits` : ""].filter(Boolean).join(", "),
  ]);
  const run = r.tracking.lastRun;
  return [
    `AI platforms for ${r.site.domain}`,
    r.probe ? `Access check: ${String(r.probe.checkedAt).slice(0, 10)}${r.probe.cdn ? `, CDN ${r.probe.cdn}` : ""} (requests sent as each crawler from the app's server; indicative only)` : "Access check: not run yet",
    r.crawl ? `Page directives: crawl of ${r.crawl.finishedAt ? String(r.crawl.finishedAt).slice(0, 10) : "-"}, ${r.crawl.pages} pages` : "Page directives: no completed crawl",
    `Prompt tracking: ${r.tracking.activePrompts} active prompts; last run ${run ? `${String(run.startedAt).slice(0, 10)} ${run.status}, ${run.done - run.failed}/${run.planned} tasks, $${run.costUsd.toFixed(3)}${run.errorCode ? ` (${run.errorCode})` : ""}` : "none"}`,
    "",
    formatTable(["Platform", "Access", "Page directives", "Index", "AI report", "Answers", "Traffic"], rows),
  ].join("\n");
}
