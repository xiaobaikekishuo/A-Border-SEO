import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, db, domainOverview, backlinksOverview, getSitePeriodMetrics } = vi.hoisted(() => ({
  auth: vi.fn(), db: { site: { findUnique: vi.fn() } }, domainOverview: vi.fn(), backlinksOverview: vi.fn(), getSitePeriodMetrics: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/dataforseo/client", () => ({ domainOverview, backlinksOverview }));
vi.mock("@/lib/seo-metrics", () => ({ getSitePeriodMetrics }));
import { GET, POST } from "./route";
const overview = { organicKeywords: 120, organicTraffic: 300, organicCost: 40, backlinks: 0, referringDomains: 0 };
const backlinks = { totalBacklinks: 42, referringDomains: 12, referringIps: 10, dofollow: 30, nofollow: 12 };
const metrics = { current: { clicks: 7, impressions: 80, avgPosition: 12, uniqueKeywords: 1 }, deltas: { clicks: null } };
const confirmation = { provider: "dataforseo", confirmed: true, operations: 2, language: "en", location: 2840 };
function get(domain?: string, body?: unknown) {
  const url = new URL("http://localhost/api/sites/site-1/domain-overview");
  if (domain !== undefined) url.searchParams.set("domain", domain);
  const request = new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return (body === undefined ? GET : POST)(request, { params: Promise.resolve({ siteId: "site-1" }) });
}
beforeEach(() => {
  vi.resetAllMocks(); auth.mockResolvedValue({ user: { id: "user-1" } });
  db.site.findUnique.mockResolvedValue({ userId: "user-1", domain: "own.example", researchLanguage: "en", researchLocation: 2840 });
  domainOverview.mockResolvedValue(overview); backlinksOverview.mockResolvedValue(backlinks); getSitePeriodMetrics.mockResolvedValue(metrics);
});
describe("domain research confirmation", () => {
  it("GET uses local GSC even when a paid provider is available", async () => {
    const response = await get();
    expect(await response.json()).toMatchObject({ source: "gsc", domain: "own.example", overview: { organicKeywords: 1, organicTraffic: 7 }, metrics });
    expect(domainOverview).not.toHaveBeenCalled(); expect(backlinksOverview).not.toHaveBeenCalled();
  });
  it("GET refuses competitor research without charging", async () => {
    expect((await get("competitor.com")).status).toBe(409);
    expect(domainOverview).not.toHaveBeenCalled(); expect(backlinksOverview).not.toHaveBeenCalled(); expect(getSitePeriodMetrics).not.toHaveBeenCalled();
  });
  it.each([
    ["competitor.com", "competitor.com"], [" https://www.Competitor.com/blog/?ref=test#about ", "competitor.com"],
    ["www.competitor.com/", "competitor.com"], ["https://shop.competitor.com/", "shop.competitor.com"],
  ])("paid POST normalizes %s and uses the chosen market", async (input, target) => {
    const response = await get(input, confirmation);
    expect(await response.json()).toMatchObject({ source: "dataforseo", domain: target, overview, backlinks });
    expect(domainOverview).toHaveBeenCalledWith("user-1", target, "en", 2840);
    expect(backlinksOverview).toHaveBeenCalledWith("user-1", target);
    expect(getSitePeriodMetrics).not.toHaveBeenCalled();
  });
  it("never substitutes own-site traffic for missing paid competitor data", async () => {
    domainOverview.mockResolvedValue(null); backlinksOverview.mockResolvedValue(null);
    expect((await get("competitor.com", confirmation)).status).toBe(502);
    expect(getSitePeriodMetrics).not.toHaveBeenCalled();
  });
  it.each([{}, { ...confirmation, confirmed: false }, { ...confirmation, operations: 1 }, { ...confirmation, location: 2124 }])("refuses incomplete or stale acknowledgement", async body => {
    expect((await get("competitor.com", body)).status).toBe(409);
    expect(domainOverview).not.toHaveBeenCalled(); expect(backlinksOverview).not.toHaveBeenCalled();
  });
  it.each(["", "   ", "https://", "not a domain"])("rejects invalid input %j", async domain => {
    expect((await get(domain, confirmation)).status).toBe(400); expect(domainOverview).not.toHaveBeenCalled();
  });
  it.each(["own-site.com", "www.own-site.com", "https://WWW.Own-Site.com/blog"])("keeps own-site identity for %s", async domain => {
    db.site.findUnique.mockResolvedValue({ userId: "user-1", domain: "www.own-site.com" });
    expect(await (await get(domain)).json()).toMatchObject({ source: "gsc", domain: "www.own-site.com", metrics });
    expect(domainOverview).not.toHaveBeenCalled();
  });
  it.each(["localhost", "http://localhost:3000/", "127.0.0.1", "https://10.0.0.5/admin", "[::1]", "http://[2606:4700::1111]/", "intranet", "printer.local", "shop.test", "nothing.invalid", "competitor.example", "db.internal", "app.localhost", "2130706433", "0x7f000001", "127.1", "user@localhost", "localhost.", "router.home.arpa", "hidden.onion", "nas.lan"])("rejects non-public competitor %s before billing", async domain => {
    expect((await get(domain, confirmation)).status).toBe(400); expect(domainOverview).not.toHaveBeenCalled(); expect(backlinksOverview).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => { auth.mockResolvedValue(null); expect((await get("competitor.com", confirmation)).status).toBe(401); expect(domainOverview).not.toHaveBeenCalled(); });
  it.each([null, { userId: "someone-else", domain: "other.example" }])("requires site ownership", async site => { db.site.findUnique.mockResolvedValue(site); expect((await get("competitor.com", confirmation)).status).toBe(404); expect(domainOverview).not.toHaveBeenCalled(); });
});
