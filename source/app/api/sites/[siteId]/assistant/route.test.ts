import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ai-workbench/data", () => ({ getWorkbenchWorkspace: mocks.get, runWorkbenchAction: mocks.run }));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ siteId: "site" }) };
function request(body: unknown, origin = "http://localhost:3300") { return new Request("http://0.0.0.0:3000/api/sites/site/assistant", { method: "POST", headers: { host: "localhost:3300", origin, "content-type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.get.mockResolvedValue({ jobs: [] }); mocks.run.mockResolvedValue({ ok: true }); });
describe("workbench HTTP boundaries", () => {
  it("passes authenticated identity to the ownership-enforcing data layer and disables caching", async () => {
    const response = await GET(new Request("http://localhost:3300"), context); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.get).toHaveBeenCalledWith({}, "owner", "site");
  });
  it("rejects cross-origin changes before a write", async () => {
    const response = await POST(request({ action: "start" }, "https://outside.example"), context); expect(response.status).toBe(403); expect(mocks.run).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("passes only supported research filters to the ownership-enforcing workspace", async () => {
    for (const kind of ["KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"]) {
      expect((await GET(new Request(`http://localhost:3300/api/sites/site/assistant?kind=${kind}`), context)).status).toBe(200);
      expect(mocks.get).toHaveBeenLastCalledWith({}, "owner", "site", expect.any(Date), kind);
    }
    mocks.get.mockClear();
    expect((await GET(new Request("http://localhost:3300/api/sites/site/assistant?kind=all"), context)).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("accepts 60000 Chinese characters within the explicit byte limit", async () => {
    const body = { action: "saveDraft", jobId: "aw_test", expectedUpdatedAt: new Date().toISOString(), draftText: "文".repeat(60000) };
    expect((await POST(request(body), context)).status).toBe(200); expect(mocks.run).toHaveBeenCalledWith({}, "owner", "site", body);
  });
  it("rejects oversized streamed JSON before a write", async () => {
    expect((await POST(request({ body: "文".repeat(180000) }), context)).status).toBe(413); expect(mocks.run).not.toHaveBeenCalled();
  });
});
