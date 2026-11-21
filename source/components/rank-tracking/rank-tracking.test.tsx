import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/sites/site-a/rankings" }));
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/shared";
import type { CheckView, RankRow, RankWorkspace } from "@/lib/rank-tracking/rules";
import RankTracking from "./rank-tracking";

const check = (position: number | null, extra: Partial<CheckView> = {}): CheckView => ({
  position, absolute: position, url: position ? "https://kammakhome.com/sofa" : null, aiOverview: false, aiCited: null, features: [],
  checkedAt: "2026-11-19T08:00:00.000Z", runId: "run-2", ...extra,
});
const row = (keyword: string, extra: Partial<RankRow>): RankRow => ({
  id: keyword, keyword, tracked: true, notes: null, latest: null, previous: null, change: null, movement: null, urlChanged: false,
  failure: null, gsc: null, operator: false, ...extra,
});

const workspace: RankWorkspace = {
  siteId: "site-a",
  domain: "kammakhome.com",
  settings: { device: "desktop", depth: 30, aiOverview: true, scheduleDays: 7, budgetUsd: 1 },
  saved: true,
  rows: [
    row("sofa beds", { latest: check(2, { aiOverview: true, aiCited: true }), previous: check(5), change: 3, movement: "UP", gsc: { position: 4.2, clicks: 30, impressions: 900 } }),
    row("corner sofa", { latest: check(null), previous: check(9), movement: "LEFT", failure: { error: "DataForSEO task status 40101", at: "2026-11-19T09:00:00.000Z" } }),
    row("new keyword", {}),
    row("site:kammakhome.com sofa", { tracked: false, operator: true }),
  ],
  summary: { tracked: 3, checked: 2, top3: 1, top10: 1, ranked: 1, notRanked: 1, up: 1, down: 1, aiOverview: 1, aiCited: 1 },
  runs: [
    { id: "run-3", source: "manual", status: "WAITING", planned: 3, checks: 3, done: 1, failed: 0, costUsd: 0.0072, budgetUsd: 1, device: "desktop", depth: 30, aiOverview: true, startedAt: "2026-11-19T10:00:00.000Z", postedAt: "2026-11-19T10:00:05.000Z", finishedAt: null, error: null, errorCode: null },
    { id: "run-2", source: "schedule", status: "PARTIAL", planned: 3, checks: 2, done: 2, failed: 0, costUsd: 0.0048, budgetUsd: 0.05, device: "desktop", depth: 30, aiOverview: true, startedAt: "2026-11-19T08:00:00.000Z", postedAt: "2026-11-19T08:00:05.000Z", finishedAt: "2026-11-19T08:06:00.000Z", error: "Checked 2 of 3 keywords", errorCode: "BUDGET" },
  ],
  active: null,
  credentials: true,
  market: { language: "en", location: 2840 },
  estimate: { tasks: 3, usd: 0.0072, skipped: 0 },
  monthlyUsd: 0.0309,
  scheduler: false,
  limits: { tracked: 200 },
};

function render(locale: Locale, initial = workspace) {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}><RankTracking siteId="site-a" initial={initial} /></I18nProvider>);
}

describe("rank tracking screen", () => {
  it("shows measured positions, changes and the run being collected", () => {
    const html = render("en");
    expect(html).toContain("Measured positions");
    expect(html).toContain("Market: United States · English");
    expect(html).toContain("Waiting for results: 1 of 3 back.");
    expect(html).toMatch(/sofa beds[\s\S]*?>2<[\s\S]*?Up 3 places since the previous check[\s\S]*?4\.2[\s\S]*?\/sofa[\s\S]*?Cites you/);
    expect(html).toContain("Not in top 30");
    expect(html).toContain("Dropped out");
    expect(html).toContain("last check failed");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("The budget per run covered 2 of 3 keywords; the rest were not checked.");
    expect(html).toContain("Scheduled tasks are turned off on this server");
    expect(html).not.toContain("search operator, not checked");
  });

  it("speaks Chinese and keeps glyphs and em dashes out", () => {
    const html = render("zh");
    expect(html).toContain("实测排名");
    expect(html).toContain("市场：美国 · 英语");
    expect(html).toContain("等待结果：已返回 1/3");
    expect(html).toContain("未进前 30");
    expect(html).toContain("引用了你");
    expect(html).not.toMatch(/[\u2014\u2015\u2191\u2193\u25b2\u25bc\u2713\u2715]/);
  });

  it("asks for a DataForSEO login and explains an empty list", () => {
    const html = render("en", { ...workspace, credentials: false, rows: [], runs: [], summary: { ...workspace.summary, tracked: 0, checked: 0 } });
    expect(html).toContain("No DataForSEO login is saved.");
    expect(html).toContain("No keyword is tracked yet.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Check rankings now/);
  });
});
