import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/seo/crawl-comparison", () => ({ getCrawlComparison: mocks.get }));
import { ContentError } from "@/lib/content-planner/http";
import { GET } from "./route";
const context = { params: Promise.resolve({ siteId: "site" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.get.mockResolvedValue({ comparison: null }); });
describe("crawl comparison route", () => {
  it("passes only supplied identifiers and the authenticated owner to the service", async () => {
    const response = await GET(new Request("http://localhost/api/sites/site/crawl-comparison?beforeId=a&afterId=b"), context);
    expect(mocks.get).toHaveBeenCalledWith({}, "owner", "site", { beforeId: "a", afterId: "b" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.status).toBe(200);
  });
  it.each([400, 401, 404])("returns private uncached %s failures", async status => {
    mocks.get.mockRejectedValue(new ContentError("Unavailable", status));
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
