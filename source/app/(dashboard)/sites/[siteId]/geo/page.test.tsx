import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, db, getReadiness, buildSiteOverview, locale } = vi.hoisted(() => ({
  auth: vi.fn(),
  db: { site: { findFirst: vi.fn() } },
  getReadiness: vi.fn(),
  buildSiteOverview: vi.fn(),
  locale: { value: "en" as "en" | "zh" },
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/geo/readiness", () => ({ getReadiness }));
vi.mock("@/lib/geo/platform-overview", () => ({ buildSiteOverview, overviewSiteFields: { id: true, domain: true, gscProperty: true, bingSite: true } }));
vi.mock("@/lib/i18n/server", async () => {
  const { createTranslator } = await import("@/lib/i18n/shared");
  return { getI18n: async () => ({ t: createTranslator(locale.value) }) };
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
}));
vi.mock("@/components/sites/geo-platforms", () => ({ default: () => <div>Platforms report</div> }));
vi.mock("@/components/sites/geo-tracking", () => ({ default: () => <div>Prompt tracking</div> }));
vi.mock("@/components/sites/geo-reports", () => ({ default: () => <div>Official reports</div> }));
vi.mock("@/components/sites/geo-observations", () => ({ default: () => <div>Traffic observations</div> }));

import GeoPage from "./page";
import type { GeoReadiness } from "@/lib/geo/readiness";

const site = { id: "site-a", domain: "example.test", gscProperty: null, bingSite: null };
const renderPage = () => GeoPage({ params: Promise.resolve({ siteId: "site-a" }) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  locale.value = "en";
  auth.mockResolvedValue({ user: { id: "owner" } });
  db.site.findFirst.mockResolvedValue(site);
  getReadiness.mockResolvedValue(null);
  buildSiteOverview.mockResolvedValue({ siteId: "site-a" });
});

describe("GEO report streaming", () => {
  it.each(["en", "zh"] as const)("streams the reports before slow readiness checks finish: %s", async language => {
    locale.value = language;
    const readiness = deferred<GeoReadiness | null>();
    getReadiness.mockReturnValue(readiness.promise);

    // The page must return its report tree even though the checklist cannot finish.
    const page = await renderPage();
    expect(db.site.findFirst).toHaveBeenCalledWith({
      where: { id: "site-a", userId: "owner" }, select: { id: true, domain: true, gscProperty: true, bingSite: true },
    });
    const output = new PassThrough();
    const shell = deferred<void>();
    const finished = deferred<void>();
    const errors: unknown[] = [];
    let html = "";
    output.on("data", chunk => { html += chunk.toString(); });
    output.on("end", () => finished.resolve());
    const stream = renderToPipeableStream(page, {
      onShellReady: () => shell.resolve(),
      onShellError: error => { errors.push(error); shell.resolve(); },
      onError: error => { errors.push(error); },
    });
    stream.pipe(output);

    try {
      await shell.promise;
      expect(errors).toEqual([]);
      expect(html).toContain('href="/sites/site-a/assistant?actionScope=geo"');
      expect(html).toContain(language === "zh" ? "用 ChatGPT 分析 GEO 数据" : "Analyze GEO evidence with ChatGPT");
      expect(getReadiness).toHaveBeenCalledWith(db, "site-a");
      expect(buildSiteOverview).toHaveBeenCalledExactlyOnceWith(db, site);
      for (const report of ["Prompt tracking", "Official reports", "Traffic observations"]) {
        expect(html).toContain(report);
      }
      expect(html).toContain(language === "zh" ? "正在加载准备度检查…" : "Loading readiness checks…");
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain("75/100");

      readiness.resolve({
        version: 2, date: "2026-11-15", total: 20, sampled: 10,
        sampling: "GSC_IMPRESSIONS", rankedPages: 8, score: 75,
        checks: [{ key: "SNIPPET", passed: 7, applicable: 10 }],
      });
      await finished.promise;
      expect(errors).toEqual([]);
      expect(html).toContain("75/100");
      expect(html).toContain("Platforms report");
      expect(html).toContain("7 / 10");
      expect(html).toContain(language === "zh" ? "其中 8 页按 GSC 曝光选取" : "8 pages chosen by GSC impressions");
    } finally {
      readiness.resolve(null);
      stream.abort();
      output.destroy();
    }
  });

  it("does not start readiness work before ownership is confirmed", async () => {
    const ownership = deferred<typeof site | null>();
    db.site.findFirst.mockReturnValue(ownership.promise);
    const page = renderPage();
    await vi.waitFor(() => expect(db.site.findFirst).toHaveBeenCalledOnce());
    expect(getReadiness).not.toHaveBeenCalled();
    expect(buildSiteOverview).not.toHaveBeenCalled();
    ownership.resolve(null);
    await expect(page).rejects.toThrow("REDIRECT /sites");
    expect(getReadiness).not.toHaveBeenCalled();
  });

  it("does not query site data or readiness for an anonymous visitor", async () => {
    auth.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("REDIRECT /login");
    expect(db.site.findFirst).not.toHaveBeenCalled();
    expect(buildSiteOverview).not.toHaveBeenCalled();
    expect(getReadiness).not.toHaveBeenCalled();
  });
});
