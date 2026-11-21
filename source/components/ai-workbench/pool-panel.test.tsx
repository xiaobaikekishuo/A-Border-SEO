import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import type { PoolView } from "@/lib/ai-workbench/pool/view";
import type { FillerPreview } from "@/lib/ai-workbench/pool/fill";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
const { PoolPanel } = await import("./pool-panel");

const window = (usedPercent: number, windowMinutes: number) => ({ usedPercent, windowMinutes, resetsAt: 1_795_000_000 });
const view = (patch: Partial<PoolView> = {}): PoolView => ({
  serverEnabled: true,
  reading: { limits: { planType: "plus", primary: window(64, 300), secondary: window(41, 10080), reached: false, hasCredits: true }, short: window(64, 300), long: window(41, 10080),
    readAt: "2026-11-20T12:00:00.000Z", stale: false, error: null, routing: true,
    models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: false, efforts: ["low"], defaultEffort: "low" }, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" }] },
  policy: { ok: true },
  settings: { enabled: true, shortReserve: 30, weeklyReserve: 10, reviewCap: 20, language: "zh-CN", routing: { light: { model: "gpt-6-luna", reasoning: "low" }, main: { model: null, reasoning: "medium" } } },
  automation: { rankings: true, alerts: true, meta: true, schema: false, clusters: false, briefs: true, caps: { rankings: 2, alerts: 2, meta: 1, schema: 10, clusters: 1, briefs: 7 }, alertsScope: "drops" },
  fillers: {
    status: {
      rankings: { checkedAt: "2026-11-20T11:00:00.000Z", outcome: "no_new_run", count: 0, added: 0, lastAddedAt: "2026-11-18T09:00:00.000Z", lastAdded: 1 },
      meta: { checkedAt: "2026-11-20T08:00:00.000Z", outcome: "merged", count: 12, added: 3 },
      briefs: { checkedAt: "2026-11-20T11:00:00.000Z", outcome: "check_failed", count: 0, added: 0 },
      schema: { checkedAt: "2026-11-19T11:00:00.000Z", outcome: "added", count: 30, added: 10 },
    },
    startedToday: { rankings: 1, alerts: 0, meta: 1, schema: 0, clusters: 0, briefs: 1 }, filledAt: "2026-11-20T11:00:00.000Z",
  },
  counts: { pending: 2, waitingReview: 1, startedToday: 3 },
  missingSchema: 12,
  items: [
    { id: "i1", source: "META", kind: "META_REWRITE", title: "Titles and descriptions (auto) · 8 pages", status: "STARTED", reason: null, jobId: "aw_1", jobStatus: "RUNNING", jobError: null, reviewedAt: null, createdAt: "2026-11-20T11:00:00.000Z", startedAt: "2026-11-20T11:10:00.000Z" },
    { id: "i2", source: "BRIEF", kind: "TOPIC_BRIEF", title: "Topic brief (auto) · Leather care", status: "PENDING", reason: null, jobId: null, jobStatus: null, jobError: null, reviewedAt: null, createdAt: "2026-11-20T10:00:00.000Z", startedAt: null },
    { id: "i3", source: "SCHEMA", kind: "SCHEMA_MARKUP", title: "Structured data (auto) · /cases", status: "STARTED", reason: null, jobId: "aw_3", jobStatus: "SUCCEEDED", jobError: null, reviewedAt: null, createdAt: "2026-11-20T09:00:00.000Z", startedAt: "2026-11-20T09:01:00.000Z" },
    { id: "i4", source: "CLUSTERS", kind: "QUERY_CLUSTERS", title: "Query clusters (auto) · 2026-11", status: "SKIPPED", reason: "not_enough_queries", jobId: null, jobStatus: null, jobError: null, reviewedAt: null, createdAt: "2026-11-20T08:00:00.000Z", startedAt: null },
    { id: "i5", source: "BATCH", kind: "OUTREACH_EMAILS", title: "Outreach drafts (batch 1/3) · 10 prospects", status: "SKIPPED", reason: "prospects_changed", jobId: null, jobStatus: null, jobError: null, reviewedAt: null, createdAt: "2026-11-20T07:00:00.000Z", startedAt: null },
  ],
  ...patch,
});
const preview: FillerPreview = {
  rankings: { runAt: "2026-11-18T09:00:00.000Z", keywords: 3, competitors: 2, queued: false }, alerts: { set: 3, firedWeek: 1 }, meta: { pages: 12, changed: 3 },
  schema: { pages: 34, newPages: 5, open: 30 }, clusters: { queries: 6, doneThisMonth: false }, briefs: { topics: 7, open: 4 },
};
const render = (value: PoolView | null, locale: "en" | "zh" = "en") => renderToStaticMarkup(<I18nProvider initialLocale={locale}><PoolPanel siteId="site-1" initialView={value} /></I18nProvider>);

describe("background task pool panel", () => {
  it("shows both windows with where background tasks stop, and the counts", () => {
    const html = render(view());
    expect(html).toContain("Background task pool");
    expect(html).toContain("64% used");
    expect(html).toContain("Background tasks stop at 70%");
    expect(html).toContain("Background tasks stop at 90%");
    expect(html).toContain("This account has a credit balance.");
    expect(html).toContain("1 / 20");
    expect(html).toContain("Started automatically today on this site");
    expect(html).toContain("Running: the worker takes the next item whenever it is idle.");
  });
  it("lists items with their state, the actions that fit and links to their results", () => {
    const html = render(view());
    expect(html).toContain("Titles and descriptions (auto) · 8 pages");
    expect(html).toContain(">Running<");
    expect(html).toContain("Waiting for review");
    expect(html).toContain('href="/sites/site-1/assistant?job=aw_3#workbench-results"');
    expect(html).toContain("Open the result");
    expect(html).toContain('href="/sites/site-1/opportunities?job=aw_1#ai-meta-rewrite"');
    expect(html).toContain("Open the task");
    expect(html).toContain("Skipped：fewer than 10 search queries");
    expect(html).toContain("Skipped：the link prospects changed or the Manus task is gone");
    expect(html).toContain("Queued by you");
    expect(html).toContain(">Cancel<");
    expect(html).toContain("Mark all results as reviewed");
  });
  it("shows what each filler found last time, its daily limit and today's count", () => {
    const html = render(view());
    expect(html).toContain("No new rank check.");
    expect(html).toContain("Last added");
    expect(html).toContain("3 pages new or worse, added to the rewrite already waiting.");
    expect(html).toContain("The check failed; it is tried again next time.");
    // A filler that is off shows no last check.
    expect(html).not.toContain("30 pages without structured data, 10 queued.");
    expect(html).toContain("Per day at most");
    expect(html).toContain('<option value="7" selected="">7</option>');
    expect(html).toContain("Started today: 1");
    expect(html).toContain("Traffic and ranking drops");
    expect(html).toContain("Review the latest check now");
    expect(html).toContain("Check now");
    expect(html).toContain("Not checked yet");
  });
  it("shows what each filler would find now, and the batch counts", () => {
    const html = render(view({ preview }));
    expect(html).toContain("Latest check");
    expect(html).toContain("3 keywords with notable moves, 2 competitors moving up.");
    expect(html).toContain("3 traffic and ranking drop alerts are on; 1 fired in the last 7 days.");
    expect(html).toContain("12 low-CTR pages can be rewritten now; 3 are new or worse since the last check.");
    expect(html).toContain("34 pages of the latest crawl have no structured data: 5 new since the previous crawl, 30 not queued yet.");
    expect(html).toContain("Only 6 search queries had impressions in the last 28 days; at least 10 are needed.");
    expect(html).toContain("7 planned topics have no brief; 4 are not queued yet.");
    expect(html).toContain("Queue title rewrites");
    expect(html).toContain("12 pages now.");
    expect(html).toContain("Queue topic briefs");
    expect(html).toContain("4 not queued yet.");
    expect(html).toContain('href="/sites/site-1/backlinks#ai-outreach-emails"');
    expect(render(view({ preview: { ...preview, rankings: null } }))).toContain("Could not count this right now.");
  });
  it("offers the account's models per tier and keeps a saved model the list no longer has", () => {
    const html = render(view({ settings: { ...view().settings, routing: { light: { model: "gpt-old", reasoning: "low" }, main: { model: null, reasoning: "medium" } } } }));
    expect(html).toContain("GPT-6 Luna (gpt-6-luna)");
    expect(html).toContain('value="gpt-old" selected=""');
    expect(html).toContain("Codex default model");
  });
  it("says why the pool waits", () => {
    expect(render(view({ policy: { ok: false, reason: "short_window", resumeAt: "2026-11-20T15:00:00.000Z" } }))).toContain("The 5-hour window reached 70%; the rest is kept for tasks you start.");
    expect(render(view({ policy: { ok: false, reason: "review_cap", resumeAt: null } }))).toContain("Results waiting for review: 1.");
    const old = render(view({ reading: null, policy: { ok: false, reason: "no_reading", resumeAt: null } }));
    expect(old).toContain("It needs the 1.9.0 desktop client or local worker.");
    expect(old).toContain("Per-task models need the 1.9.0 desktop client");
    const login = render(view({ reading: { ...view().reading!, limits: null, short: null, long: null, error: "login_required" }, policy: { ok: false, reason: "no_reading", resumeAt: null } }));
    expect(login).toContain("Codex is not signed in to ChatGPT.");
    const off = render(view({ settings: { ...view().settings, enabled: false }, policy: { ok: false, reason: "pool_off", resumeAt: null } }));
    expect(off).toContain("The pool is off, so nothing is checked by itself.");
  });
  it("renders in Chinese without dashes or text arrows, and loads quietly without a view", () => {
    const html = render(view({ preview }), "zh");
    expect(html).toContain("后台任务池");
    expect(html).toContain("后台任务在 70% 停");
    expect(html).toContain("格式固定的任务");
    expect(html).toContain("本站自动加任务");
    expect(html).toContain("现在检查一次");
    expect(html).toContain("现在复盘最近一次检查");
    expect(html).toContain("每天最多");
    expect(html).toContain("手动加入");
    expect(html).toContain("排队改写标题和描述");
    expect(html).not.toMatch(/[—―↑↓▲▼✓✕]/);
    expect(render(null)).toContain("Loading");
  });
});
