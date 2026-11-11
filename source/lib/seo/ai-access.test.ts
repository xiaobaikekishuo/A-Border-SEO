import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("@/lib/db", () => ({ db: {} }));
import { buildAccessReport, classifyRobots, decodeRobots, evaluateAiRobots, fetchAiRobots, probeAiAccess } from "./ai-access";
import { ROBOTS_MAX_BYTES } from "@/lib/crawler/robots";
import { AI_BOTS, TRAINING_POLICY_TOKEN } from "./ai-bots";

const fetchMock = vi.fn<typeof fetch>();
const url = "https://example.com/private/article";
let userSequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock.mockResolvedValue(new Response("User-agent: *\nAllow: /", { headers: { "Content-Type": "text/plain" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function policy(text: string, target = url) { return evaluateAiRobots(target, classifyRobots(200, "text/plain", text)); }
function named(text: string, agent = "GPTBot", target = url) { return policy(text, target).find(bot => bot.agent === agent)!; }

describe("AI robots rule evidence", () => {
  it("covers every registered bot once", () => {
    const agents = policy("").map(bot => bot.agent);
    expect(agents).toEqual(AI_BOTS.map(bot => bot.token));
    expect(new Set(agents).size).toBe(agents.length);
  });
  it("keeps search and training separate and identifies the winning rule and group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /private";
    expect(named(text, "OAI-SearchBot")).toMatchObject({ purpose: "SEARCH", robots: "ALLOWED", group: "OAI-SearchBot", matchedLine: 5, rule: "Allow: /" });
    expect(named(text)).toMatchObject({ purpose: "TRAINING", robots: "BLOCKED", group: "GPTBot", matchedLine: 8, rule: "Disallow: /private" });
    expect(named(text, "ClaudeBot")).toMatchObject({ robots: "BLOCKED", group: "*", matchedLine: 2 });
  });
  it("does not claim that robots rules control providers' user-triggered fetchers, but shows the declared rule", () => {
    const results = policy("User-agent: *\nDisallow: /");
    expect(results.filter(bot => bot.robots === "NOT_APPLICABLE").map(bot => bot.agent)).toEqual(["ChatGPT-User", "Perplexity-User", "Meta-ExternalFetcher"]);
    expect(results.find(bot => bot.agent === "ChatGPT-User")).toMatchObject({ declared: "BLOCKED", rule: "Disallow: /" });
    expect(results.find(bot => bot.agent === "Claude-User")).toMatchObject({ purpose: "USER_REQUEST", robots: "BLOCKED" });
  });
  it("uses longest path matching, allows ties, and decodes unreserved octets", () => {
    const text = "User-agent: *\nDisallow: /private\nAllow: /private/article\nDisallow: /private/article\nCrawl-delay: 2";
    expect(named(text, "GPTBot", "https://example.com/%70rivate/article")).toMatchObject({ robots: "ALLOWED", crawlDelay: 2 });
    expect(named("User-agent: *\nDisallow: /private?*", "GPTBot", "https://example.com/private?mode=1").robots).toBe("BLOCKED");
  });
  it("evaluates the multi-wildcard rules common on e-commerce sites", () => {
    const shopify = "User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /*/collections/*sort_by*\nDisallow: /*?*oseid=*\nDisallow: /*preview_theme_id*\nDisallow: /cart";
    expect(named(shopify, "OAI-SearchBot", "https://example.com/collections/all?sort_by=price-ascending")).toMatchObject({ robots: "BLOCKED", matchedLine: 2 });
    expect(named(shopify, "OAI-SearchBot", "https://example.com/en/collections/all?sort_by=title")).toMatchObject({ robots: "BLOCKED", matchedLine: 3 });
    expect(named(shopify, "OAI-SearchBot", "https://example.com/products/mug?ref=x&oseid=1")).toMatchObject({ robots: "BLOCKED", matchedLine: 4 });
    expect(named(shopify, "OAI-SearchBot", "https://example.com/collections/all")).toMatchObject({ robots: "ALLOWED", rule: null });
  });
  it("stays fast on adversarial wildcard patterns and long near-miss URLs", () => {
    const body = "User-agent: *\n" + Array.from({ length: 300 }, (_, i) => "Disallow: /" + "a*".repeat(20) + `z${i}$`).join("\n");
    const started = Date.now();
    expect(named(body, "GPTBot", "https://example.com/" + "a".repeat(2000)).robots).toBe("ALLOWED");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("matches repeated agent groups and supports comment-only or empty valid files", () => {
    expect(named("User-agent: GPTBot\nDisallow: /private\nUser-agent: GPTBot\nAllow: /private/article").robots).toBe("ALLOWED");
    expect(named("# No restrictions").robots).toBe("ALLOWED");
    expect(named("").robots).toBe("ALLOWED");
  });
  it("reads the shared AI training preference only from its own group", () => {
    const training = (text: string, target = url) => named(text, TRAINING_POLICY_TOKEN, target);
    expect(training("User-agent: *\nDisallow: /")).toMatchObject({ kind: "POLICY_TOKEN", robots: "NO_PREFERENCE", group: null });
    expect(training("User-Agent: __usage_ai-training\nDisallow: /\nAllow: /press-kit/")).toMatchObject({ robots: "BLOCKED", group: TRAINING_POLICY_TOKEN, matchedLine: 2 });
    expect(training("User-Agent: __usage_ai-training\nDisallow: /\nAllow: /press-kit/", "https://example.com/press-kit/logo.png")).toMatchObject({ robots: "ALLOWED", matchedLine: 3 });
    expect(training("User-Agent: __usage_ai-training\nDisallow: /").crawlDelay).toBeNull();
  });
  it.each([
    [404, "UNAVAILABLE", "ROBOTS_NOT_FOUND", "ALLOWED"],
    [410, "UNAVAILABLE", "ROBOTS_NOT_FOUND", "ALLOWED"],
    [401, "UNAVAILABLE", "ROBOTS_ACCESS_DENIED", "ALLOWED"],
    [403, "UNAVAILABLE", "ROBOTS_ACCESS_DENIED", "ALLOWED"],
    [451, "UNAVAILABLE", "ROBOTS_CLIENT_ERROR", "ALLOWED"],
    [429, "UNREACHABLE", "ROBOTS_RATE_LIMITED", "BLOCKED"],
    [500, "UNREACHABLE", "ROBOTS_SERVER_ERROR", "BLOCKED"],
    [503, "UNREACHABLE", "ROBOTS_SERVER_ERROR", "BLOCKED"],
  ] as const)("applies RFC 9309 to HTTP %s", (status, outcome, reason, robots) => {
    const evidence = classifyRobots(status, "text/html", "error page");
    expect(evidence).toMatchObject({ outcome, reason });
    const bots = evaluateAiRobots(url, evidence);
    expect(bots.find(bot => bot.agent === "GPTBot")).toMatchObject({ robots, declared: robots });
    expect(bots.find(bot => bot.agent === TRAINING_POLICY_TOKEN)?.robots).toBe(outcome === "UNAVAILABLE" ? "NO_PREFERENCE" : "UNKNOWN");
    expect(bots.find(bot => bot.agent === "ChatGPT-User")?.robots).toBe("NOT_APPLICABLE");
  });
  it("flags a possible firewall when robots.txt itself is refused", () => {
    expect(classifyRobots(403, null, "").warnings).toContain("WAF_MAY_BLOCK");
  });
  it.each([
    ["text/plain", "<html>Just a moment</html>", "HTML_RESPONSE"],
    [null, "<!DOCTYPE html>challenge", "HTML_RESPONSE"],
    ["text/html", "<html><body>Sign in</body></html>", "HTML_RESPONSE"],
    ["text/plain", "Please sign in to continue", "UNRECOGNIZED_CONTENT"],
  ])("does not interpret a page that is not robots rules as unrestricted", (contentType, body, reason) => {
    const evidence = classifyRobots(200, contentType, body!);
    expect(evidence).toMatchObject({ outcome: "UNKNOWN", reason });
    expect(evaluateAiRobots(url, evidence).find(bot => bot.agent === "GPTBot")?.robots).toBe("UNKNOWN");
  });
  it("parses rules served with another content type and says so", () => {
    expect(classifyRobots(200, "application/octet-stream", "User-agent: *\nDisallow: /private")).toMatchObject({ outcome: "RULES", warnings: ["UNEXPECTED_CONTENT_TYPE"] });
    expect(classifyRobots(200, null, "User-agent: *\nDisallow: /private").warnings).toEqual([]);
  });
  it("ignores orphan rules before any group, like a crawler does", () => {
    expect(named("Disallow: /").robots).toBe("ALLOWED");
  });
  it("rejects a file with too many rules instead of matching part of it", () => {
    const body = "User-agent: *\n" + "Disallow: /p\n".repeat(20_001);
    expect(classifyRobots(200, "text/plain", body)).toMatchObject({ outcome: "UNKNOWN", reason: "ROBOTS_TOO_COMPLEX" });
  });
  it("cuts a truncated file at its last complete line and keeps invalid UTF-8 visible", () => {
    const bytes = new TextEncoder().encode("User-agent: *\nDisallow: /a\nDisallow: /b-partial");
    expect(decodeRobots(bytes, true)).toEqual({ text: "User-agent: *\nDisallow: /a", warnings: ["ROBOTS_TRUNCATED"] });
    expect(decodeRobots(new Uint8Array([0x55, 0x73, 0xff, 0x0a]), false).warnings).toEqual(["INVALID_UTF8"]);
  });
});

describe("declared content preferences", () => {
  it("reports Content-Signal and Content-Usage lines that apply to the URL", () => {
    const text = "User-Agent: *\nContent-Signal: search=yes, ai-train=no\nContent-Usage: /ai-ok/ train-ai=y\nContent-Usage: train-ai=n\nAllow: /";
    const evidence = { url: "https://example.com/robots.txt", finalUrl: "https://example.com/robots.txt", status: 200, contentType: "text/plain", ...classifyRobots(200, "text/plain", text) };
    const report = buildAccessReport("site", url, evidence, null, new Date("2026-11-09T00:00:00Z"));
    expect(report.preferences.map(item => [item.kind, item.values])).toEqual([
      ["CONTENT_SIGNAL", { search: "yes", "ai-train": "no" }],
      ["CONTENT_USAGE", { "train-ai": "n" }],
    ]);
    expect(report.preferences[0].scope).toEqual(["*"]);
    expect(report.warnings).toContain("PREFERENCES_ARE_REQUESTS");
    expect(buildAccessReport("site", "https://example.com/ai-ok/page", evidence, null).preferences).toHaveLength(3);
  });
});

describe("bounded public robots requests", () => {
  it("fetches robots only, with the existing crawler identity and hardened dispatcher", async () => {
    const result = await fetchAiRobots(url);
    expect(result).toMatchObject({ outcome: "RULES", status: 200, finalUrl: "https://example.com/robots.txt" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("https://example.com/robots.txt");
    expect(init).toMatchObject({ redirect: "manual" });
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/^ABorderSEOBot/);
    expect(init).toHaveProperty("dispatcher");
  });
  it("rejects private DNS before making an HTTP request", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await fetchAiRobots(url)).toMatchObject({ outcome: "UNKNOWN", reason: "FETCH_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("follows a redirect to another public host, as crawlers do, and records it", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://www.example.com/robots.txt" } }));
    const result = await fetchAiRobots(url);
    expect(result).toMatchObject({ outcome: "RULES", finalUrl: "https://www.example.com/robots.txt" });
    expect(result.warnings).toContain("ROBOTS_REDIRECTED");
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["https://example.com/robots.txt", "https://www.example.com/robots.txt"]);
  });
  it("does not follow a redirect that carries credentials", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://user:pass@example.com/robots.txt" } }));
    expect(await fetchAiRobots(url)).toMatchObject({ outcome: "UNKNOWN", reason: "FETCH_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("treats more than five redirects as unavailable rules", async () => {
    for (let i = 0; i < 6; i++) fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `/r${i}` } }));
    expect(await fetchAiRobots(url)).toMatchObject({ outcome: "UNAVAILABLE", reason: "ROBOTS_TOO_MANY_REDIRECTS" });
  });
  it("rechecks DNS on a redirect instead of trusting a previous public answer", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/robots2.txt" } }));
    expect(await fetchAiRobots(url)).toMatchObject({ outcome: "UNKNOWN", reason: "FETCH_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reads at most the parse limit and parses the complete lines before it", async () => {
    const body = "User-agent: *\nDisallow: /private\n" + "# padding\n".repeat(ROBOTS_MAX_BYTES / 10);
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/plain" } }));
    const result = await fetchAiRobots(url);
    expect(result).toMatchObject({ outcome: "RULES" });
    expect(result.warnings).toContain("ROBOTS_TRUNCATED");
    expect(evaluateAiRobots(url, result).find(bot => bot.agent === "GPTBot")?.robots).toBe("BLOCKED");
  });
  it("classifies server errors without reading the body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    expect(await fetchAiRobots(url)).toMatchObject({ outcome: "UNREACHABLE", reason: "ROBOTS_SERVER_ERROR", status: 503 });
  });
  it("returns unknown after a timeout and does not retry", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }));
    const pending = fetchAiRobots(url);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({ outcome: "UNKNOWN", reason: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function database() {
  const user = `access-owner-${++userSequence}`;
  const fixture = {
    site: { findFirst: vi.fn().mockResolvedValue({ id: "site", domain: "example.com" }) },
    crawl: { findFirst: vi.fn().mockResolvedValue({ id: "crawl", finishedAt: new Date("2026-10-01T12:00:00Z") }) },
    auditPage: { findFirst: vi.fn().mockResolvedValue({ url, statusCode: 200, robotsMeta: "noindex", xRobotsTag: null, indexable: false }) },
  };
  return { fixture, db: fixture as unknown as PrismaClient, user };
}
describe("owner-scoped explicit access probe", () => {
  it("requires identity and ownership before touching network", async () => {
    const { db, fixture, user } = database();
    await expect(probeAiAccess(db, null, "site", { url })).rejects.toMatchObject({ status: 401 });
    expect(fixture.site.findFirst).not.toHaveBeenCalled();
    fixture.site.findFirst.mockResolvedValue(null);
    await expect(probeAiAccess(db, user, "foreign", { url })).rejects.toMatchObject({ status: 404 });
    expect(fixture.site.findFirst).toHaveBeenCalledWith({ where: { id: "foreign", userId: user }, select: { id: true, domain: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["https://other.example/article", "http://example.com/article", "https://example.com:444/article", "https://user:pass@example.com/article", "file:///etc/passwd"]) (
    "rejects URLs outside the site's approved origin: %s", async input => {
      const { db, user } = database();
      await expect(probeAiAccess(db, user, "site", { url: input })).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it("marks historical page directives with their capture time and never fetches that page", async () => {
    const { db, fixture, user } = database();
    const report = await probeAiAccess(db, user, "site", { url });
    expect(report.page).toMatchObject({ source: "SAVED_CRAWL", capturedAt: "2026-10-01T12:00:00.000Z", statusCode: 200, robotsMeta: "noindex", indexable: false });
    expect(fixture.crawl.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "site", status: "COMPLETED" } }));
    expect(fixture.auditPage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { crawlId: "crawl", url } }));
    expect(report.warnings).toContain("SAVED_PAGE_NOT_LIVE");
    expect(report.warnings).toContain("TRAINING_SIGNAL_ROLLOUT");
    expect(report.robots).not.toHaveProperty("text");
    expect(report.robots).not.toHaveProperty("parsed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps a missing crawl sample unknown rather than claiming a successful page fetch", async () => {
    const { db, fixture, user } = database(); fixture.crawl.findFirst.mockResolvedValue(null);
    expect((await probeAiAccess(db, user, "site", { url })).page).toBeNull();
    expect(fixture.auditPage.findFirst).not.toHaveBeenCalled();
  });
  it("rate limits explicit checks per user", async () => {
    const { db, user } = database();
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(new Response("", { headers: { "content-type": "text/plain" } }));
      await probeAiAccess(db, user, "site", { url });
    }
    await expect(probeAiAccess(db, user, "site", { url })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
