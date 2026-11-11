import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentError } from "@/lib/content-planner/http";
import { pageQuerySchema } from "@/lib/content-planner/schema";

const state = vi.hoisted(() => ({ userId: "owner" as string | null, load: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => state.userId ? { user: { id: state.userId } } : null }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/content-planner/pages", () => ({ getImportablePages: state.load }));
import { GET } from "./route";
const context = { params: Promise.resolve({ siteId: "owned-site" }) };
const endpoint = "http://localhost:3300/api/sites/owned-site/content/pages";
const payload = { siteId: "owned-site", crawl: null, rows: [], total: 0, page: 1, pageSize: 25 };

beforeEach(() => { state.userId = "owner"; state.load.mockReset(); state.load.mockResolvedValue(payload); });
describe("content page inventory API", () => {
  it("passes the authenticated owner, route site and raw filters to the ownership-enforcing service", async () => {
    const response = await GET(new Request(`${endpoint}?query=cup%20guide&page=2&pageSize=10&articlesOnly=true`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
    expect(state.load).toHaveBeenCalledWith({}, "owner", "owned-site", { query: "cup guide", page: "2", pageSize: "10", articlesOnly: "true" });
  });

  it("propagates an unauthenticated service rejection without inventing a user", async () => {
    state.userId = null;
    state.load.mockImplementation(async (_db, userId) => { if (!userId) throw new ContentError("Unauthorized", 401); return payload; });
    const response = await GET(new Request(endpoint), context);
    expect(response.status).toBe(401);
    expect(state.load).toHaveBeenCalledWith({}, "", "owned-site", {});
  });

  it("hides another owner's site using the service's ownership error", async () => {
    state.load.mockRejectedValue(new ContentError("Site not found", 404));
    expect((await GET(new Request(endpoint), context)).status).toBe(404);
  });

  it("returns validation failures as 400 rather than treating invalid filters as server errors", async () => {
    state.load.mockImplementation(async (_db, _userId, _siteId, query) => { pageQuerySchema.parse(query); return payload; });
    const response = await GET(new Request(`${endpoint}?pageSize=51`), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("pageSize");
  });

  it("keeps unexpected backend details out of error responses", async () => {
    state.load.mockRejectedValue(new Error("private database detail"));
    const response = await GET(new Request(endpoint), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Content planner operation failed" });
  });
});
