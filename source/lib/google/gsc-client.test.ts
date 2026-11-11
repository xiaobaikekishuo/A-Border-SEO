import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./google-auth", () => ({ getAccessToken: async () => "test-only-token" }));
import { fetchPageAnalytics, fetchSearchAnalytics } from "./gsc-client";
afterEach(() => vi.unstubAllGlobals());
const row = (keys: string[]) => ({ keys, clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
describe("GSC API dimensions and pagination", () => {
  it("maps dimensions by name and preserves the page dimension when requested", async () => {
    const fetcher = vi.fn(async () => Response.json({ rows: [row(["term", "https://example.test/a", "2026-10-01"]), row(["term", "https://example.test/b", "2026-10-01"])] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchSearchAnalytics("u", "sc-domain:example.test", "2026-10-01", "2026-10-02", ["query", "page", "date"], undefined, true);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ query: "term", page: "https://example.test/b", date: "2026-10-01" });
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).dataState).toBe("final");
  });
  it("paginates pages beyond the first 25000 rows", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ rows: Array.from({ length: 25000 }, () => row(["https://example.test/a", "2026-10-01"])) }))
      .mockResolvedValueOnce(Response.json({ rows: [row(["https://example.test/last", "2026-10-01"])] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchPageAnalytics("u", "sc-domain:example.test", "2026-10-01", "2026-10-02");
    expect(result).toHaveLength(25001);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).startRow).toBe(25000);
    expect(result.at(-1)?.page).toBe("https://example.test/last");
  });
});
