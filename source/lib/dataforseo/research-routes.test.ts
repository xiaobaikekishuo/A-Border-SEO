import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), findUnique: vi.fn(), keywordResearch: vi.fn(), backlinksOverview: vi.fn(), backlinksProfile: vi.fn(), fetchSuggestions: vi.fn(), crawl: vi.fn(), links: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { site: { findUnique: m.findUnique }, crawl: { findFirst: m.crawl }, auditLink: { findMany: m.links } } }));
vi.mock("./client", () => ({ keywordResearch: m.keywordResearch, backlinksOverview: m.backlinksOverview, backlinksProfile: m.backlinksProfile }));
vi.mock("@/lib/google/autocomplete", () => ({ fetchSuggestions: m.fetchSuggestions }));
import { GET as keywordsGet, POST as keywordsPost } from "@/app/api/sites/[siteId]/keyword-research/route";
import { GET as backlinksGet, POST as backlinksPost } from "@/app/api/sites/[siteId]/backlinks/route";
const context = { params: Promise.resolve({ siteId: "site" }) };
const ack = { provider: "dataforseo", confirmed: true, language: "ja", location: 2392 };
function req(path: string, body?: unknown) { return new Request(`http://localhost/api/sites/site/${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.resetAllMocks(); m.auth.mockResolvedValue({ user: { id: "user" } });
  m.findUnique.mockResolvedValue({ userId: "user", domain: "example.com", researchLanguage: "ja", researchLocation: 2392 });
  m.keywordResearch.mockResolvedValue([]); m.fetchSuggestions.mockResolvedValue(["test suggestion"]);
  m.backlinksOverview.mockResolvedValue({ totalBacklinks: 2 }); m.backlinksProfile.mockResolvedValue([]); m.crawl.mockResolvedValue(null);
});
describe("research routes never charge through GET or unconfirmed POST", () => {
  it("keyword GET always uses free suggestions", async () => { expect((await keywordsGet(req("keyword-research?q=test"), context)).status).toBe(200); expect(m.keywordResearch).not.toHaveBeenCalled(); expect(m.fetchSuggestions).toHaveBeenCalled(); });
  it("backlink GET uses local crawl only", async () => { expect((await backlinksGet(req("backlinks"), context)).status).toBe(200); expect(m.backlinksOverview).not.toHaveBeenCalled(); expect(m.backlinksProfile).not.toHaveBeenCalled(); });
  it("denies both unconfirmed paid routes without contacting a provider", async () => {
    expect((await keywordsPost(req("keyword-research?q=test", {}), context)).status).toBe(409);
    expect((await backlinksPost(req("backlinks", { ...ack, operations: 1 }), context)).status).toBe(409);
    expect(m.keywordResearch).not.toHaveBeenCalled(); expect(m.backlinksOverview).not.toHaveBeenCalled(); expect(m.backlinksProfile).not.toHaveBeenCalled();
  });
  it("executes only the confirmed keyword request in the saved market", async () => {
    expect((await keywordsPost(req("keyword-research?q=test", { ...ack, operations: 1 }), context)).status).toBe(200);
    expect(m.keywordResearch).toHaveBeenCalledExactlyOnceWith("user", "test", "ja", 2392); expect(m.fetchSuggestions).not.toHaveBeenCalled();
  });
  it("executes the confirmed two-request backlink batch", async () => {
    expect((await backlinksPost(req("backlinks", { ...ack, operations: 2 }), context)).status).toBe(200);
    expect(m.backlinksOverview).toHaveBeenCalledExactlyOnceWith("user", "example.com"); expect(m.backlinksProfile).toHaveBeenCalledExactlyOnceWith("user", "example.com", 50, 0);
  });
  it("denies cross-user sites before paid lookup", async () => { m.findUnique.mockResolvedValue({ userId: "other" }); expect((await keywordsPost(req("keyword-research?q=test", { ...ack, operations: 1 }), context)).status).toBe(404); expect(m.keywordResearch).not.toHaveBeenCalled(); });
});
