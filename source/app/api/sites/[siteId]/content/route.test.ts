import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "owner" as string | null, siteOwned: true,
  load: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => state.userId ? { user: { id: state.userId } } : null }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/content-planner/data", async () => {
  const { ContentError } = await import("@/lib/content-planner/http");
  return {
    ownedSite: async (_db: unknown, userId: string | null) => {
      if (!userId) throw new ContentError("Unauthorized", 401);
      if (!state.siteOwned) throw new ContentError("Not found", 404);
      return { id: "s1", domain: "catalog.example" };
    },
    getContentWorkspace: state.load,
    runContentAction: state.mutate,
  };
});
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ siteId: "s1" }) };
const endpoint = "http://localhost:3000/api/sites/s1/content";
function request(origin = "http://localhost:3000") {
  return new Request(endpoint, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action: "seedExample" }) });
}
beforeEach(() => {
  state.userId = "owner"; state.siteOwned = true; state.load.mockReset(); state.mutate.mockReset();
  state.load.mockResolvedValue({ site: { id: "s1", domain: "catalog.example" }, pillars: [] });
  state.mutate.mockResolvedValue({ ok: true });
});
describe("content API authorization", () => {
  it("denies unauthenticated reads and mutations before processing content", async () => {
    state.userId = null;
    expect((await GET(new Request(endpoint), context)).status).toBe(401);
    expect((await POST(request(), context)).status).toBe(401);
    expect(state.load).not.toHaveBeenCalled();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("hides another owner's site and refuses cross-origin browser writes", async () => {
    state.siteOwned = false;
    expect((await GET(new Request(endpoint), context)).status).toBe(404);
    expect((await POST(request(), context)).status).toBe(404);
    state.siteOwned = true;
    expect((await POST(request("https://outside.example"), context)).status).toBe(403);
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("keeps authenticated workspace responses uncached and accepts a same-origin JSON action", async () => {
    const response = await GET(new Request(endpoint), context);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await POST(request(), context)).status).toBe(200);
    expect(state.mutate).toHaveBeenCalledWith({}, "owner", "s1", { action: "seedExample" });
  });
});
