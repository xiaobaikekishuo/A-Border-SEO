import { describe, expect, it } from "vitest";
import { buildPlatformStatuses, type OverviewInput } from "./platform-overview";
import type { ProbeReport } from "./probe";
import { analyzeRecord, estimateRun, parseSettings, settingsOf, storedBrands, summarizeByPlatform } from "./tracking";
import { askWithRetry, runStatus } from "./visibility-job";
import { DataForSeoError } from "./dataforseo-parse";

const settings = {
  brands: { own: { name: "Kammak", aliases: ["卡玛克"], domains: ["https://www.kammak.shop/"] }, competitors: [{ name: "Acme", aliases: [], domains: ["acme.test"] }] },
  platforms: ["CHATGPT", "PERPLEXITY", "CHATGPT"],
  scheduleDays: 7,
  budgetUsd: 1.234,
};

describe("tracking settings", () => {
  it("adds the site's own domain, normalizes domains and drops repeated platforms", () => {
    const parsed = parseSettings(settings, "kammakhome.com");
    expect(parsed.brands.own.domains).toEqual(["kammakhome.com", "kammak.shop"]);
    expect(parsed.platforms).toEqual(["CHATGPT", "PERPLEXITY"]);
    expect(parsed.budgetUsd).toBe(1.23);
  });

  it("refuses platforms DataForSEO cannot ask, bad domains and brands named twice", () => {
    expect(() => parseSettings({ ...settings, platforms: ["COPILOT"] }, "kammakhome.com")).toThrow("Not trackable");
    expect(() => parseSettings({ ...settings, brands: { ...settings.brands, competitors: [{ name: "X", aliases: [], domains: ["not a domain"] }] } }, "kammakhome.com")).toThrow("Not a domain");
    expect(() => parseSettings({ ...settings, brands: { ...settings.brands, competitors: [{ name: "kammak", aliases: [], domains: [] }] } }, "kammakhome.com")).toThrow("own name");
    expect(() => parseSettings({ ...settings, budgetUsd: 500 }, "kammakhome.com")).toThrow();
  });

  it("reads stored settings defensively", () => {
    expect(storedBrands({ broken: true }, "kammakhome.com").own).toEqual({ name: "kammakhome.com", aliases: [], domains: ["kammakhome.com"] });
    expect(settingsOf({ brands: {}, platforms: ["CHATGPT", "GROK", "nope"], scheduleDays: null, budgetUsd: 2 }, "kammakhome.com")?.platforms).toEqual(["CHATGPT"]);
    expect(settingsOf(null, "kammakhome.com")).toBeNull();
  });

  it("estimates a run from the published task prices", () => {
    expect(estimateRun(10, ["CHATGPT", "GOOGLE_AIO"])).toEqual({ tasks: 20, usd: 0.08 });
    expect(estimateRun(0, ["CHATGPT"])).toEqual({ tasks: 0, usd: 0 });
  });
});

describe("answers read with the current brands", () => {
  const brands = parseSettings(settings, "kammakhome.com").brands;
  const record = (over: Record<string, unknown> = {}) => ({
    id: "a1", promptId: "p1", platform: "CHATGPT", source: "DATAFORSEO", status: "OK", error: null, createdAt: new Date("2026-11-01T00:00:00Z"),
    text: "Acme or 卡玛克", citations: [{ url: "https://kammak.shop/sofa", title: "Sofa" }, { url: 42 }], ...over,
  });

  it("finds the brand by its alias and the site by a second domain", () => {
    const { row, analysis } = analyzeRecord(record(), brands);
    expect(analysis).toMatchObject({ ownMentioned: true, ownCited: true, ownRank: 1, mentionRank: 2 });
    expect(row.citations).toHaveLength(1);
  });

  it("summarizes per platform and ignores unknown platforms", () => {
    const summary = summarizeByPlatform([record(), record({ id: "a2", status: "NO_ANSWER", text: null, citations: [] }), record({ id: "a3", platform: "OTHER" })], brands);
    expect(Object.keys(summary)).toEqual(["CHATGPT"]);
    expect(summary.CHATGPT).toMatchObject({ answers: 1, noAnswer: 1, mentionRate: 1, citationRate: 1 });
  });
});

describe("run status", () => {
  it("succeeds only when every planned task answered", () => {
    expect(runStatus(4, 4, 0)).toBe("SUCCEEDED");
    expect(runStatus(4, 3, 0)).toBe("PARTIAL");
    expect(runStatus(4, 4, 1)).toBe("PARTIAL");
    expect(runStatus(4, 2, 2)).toBe("FAILED");
    expect(runStatus(4, 0, 0)).toBe("FAILED");
  });
});

describe("retrying a task", () => {
  const signal = new AbortController().signal;
  it("retries errors a retry can fix, then gives up", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw new DataForSeoError("RATE_LIMIT", "slow down", true);
      return { status: "OK" as const, text: "x", citations: [], consulted: 0, model: null, fanOut: [], cost: 0.004 };
    };
    expect((await askWithRetry(flaky, signal, [0, 0])).cost).toBe(0.004);
    expect(calls).toBe(3);
    calls = 0;
    await expect(askWithRetry(async () => { calls++; throw new DataForSeoError("API", "down", true); }, signal, [0, 0])).rejects.toThrow("down");
    expect(calls).toBe(3);
    calls = 0;
    await expect(askWithRetry(async () => { calls++; throw new DataForSeoError("AUTH", "no"); }, signal, [0, 0])).rejects.toThrow("no");
    expect(calls).toBe(1);
  });
});

describe("platform overview", () => {
  const empty: OverviewInput = {
    probe: null, eligibility: null,
    google: { connected: false, pages: 0, date: null }, bing: { connected: false, inIndex: null, date: null },
    reports: { GSC_AI: null, BING_AI: null }, visibility: {}, tracked: [], ga4: null, bots: null,
  };

  it("says what is missing rather than guessing", () => {
    const statuses = buildPlatformStatuses(empty);
    expect(statuses).toHaveLength(10);
    const grok = statuses.find(s => s.id === "GROK")!;
    expect(grok.access.state).toBe("NA");
    expect(grok.report.state).toBe("NA");
    const chatgpt = statuses.find(s => s.id === "CHATGPT")!;
    expect(chatgpt.access.state).toBe("UNKNOWN");
    expect(chatgpt.eligibility.state).toBe("UNKNOWN");
    expect(statuses.find(s => s.id === "GOOGLE_AIO")!.report).toMatchObject({ state: "UNKNOWN", kind: "GSC_AI" });
  });

  it("flags a blocked search crawler, not a blocked training crawler", () => {
    const probe: ProbeReport = {
      checkedAt: "2026-11-09T00:00:00.000Z", urls: ["https://kammakhome.com/"], cdn: "Cloudflare",
      browser: [{ url: "https://kammakhome.com/", outcome: "OK", status: 200, error: null, finalUrl: "https://kammakhome.com/" }],
      checks: [
        { token: "OAI-SearchBot", url: "https://kammakhome.com/", outcome: "OK", verdict: "OK", status: 200, error: null },
        { token: "PerplexityBot", url: "https://kammakhome.com/", outcome: "CHALLENGE", verdict: "BLOCKED_FOR_BOT", status: 403, error: null },
      ],
      robots: {
        url: "https://kammakhome.com/robots.txt", status: 200, outcome: "RULES", reason: null,
        bots: [
          { token: "GPTBot", url: "https://kammakhome.com/", robots: "BLOCKED", declared: "BLOCKED", rule: "Disallow: /", matchedLine: 2 },
          { token: "OAI-SearchBot", url: "https://kammakhome.com/", robots: "ALLOWED", declared: null, rule: null, matchedLine: null },
          { token: "ChatGPT-User", url: "https://kammakhome.com/", robots: "ALLOWED", declared: null, rule: null, matchedLine: null },
        ],
      },
    };
    const statuses = buildPlatformStatuses({ ...empty, probe });
    expect(statuses.find(s => s.id === "CHATGPT")!.access.state).toBe("GOOD");
    expect(statuses.find(s => s.id === "PERPLEXITY")!.access.state).toBe("BAD");
  });

  it("counts referrals and crawler requests by the platform's names", () => {
    const statuses = buildPlatformStatuses({
      ...empty,
      ga4: { rows: [{ day: "2026-11-01", platform: "ChatGPT", path: "/", count: 5 }, { day: "2026-11-01", platform: "Perplexity", path: "/", count: 2 }] },
      bots: { rows: [{ day: "2026-11-01", platform: "OpenAI · OAI-SearchBot", path: "/", count: 9 }] },
    });
    expect(statuses.find(s => s.id === "CHATGPT")!.traffic).toMatchObject({ state: "GOOD", referrals: 5, crawlerRequests: 9 });
    expect(statuses.find(s => s.id === "GOOGLE_AIO")!.traffic).toMatchObject({ referrals: null });
  });
});
