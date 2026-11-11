import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), probe: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/seo/ai-access", () => ({ probeAiAccess: mocks.probe }));
import { ContentError } from "@/lib/content-planner/http";
import { POST } from "./route";

const context = { params: Promise.resolve({ siteId: "site" }) };
function request(body: unknown = { url: "https://example.com/article" }, origin = "http://localhost:3300") {
  return new Request("http://localhost:3300/api/sites/site/ai-access", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
}
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.probe.mockResolvedValue({ siteId: "site" }); });
describe("explicit AI access probe route", () => {
  it("passes authenticated identity and returns uncached evidence", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.probe).toHaveBeenCalledWith({}, "owner", "site", { url: "https://example.com/article" });
  });
  it("requires login before parsing the body", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(new Request("http://localhost:3300", { method: "POST" }), context);
    expect(response.status).toBe(401); expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("rejects cross-origin triggering without starting a probe", async () => {
    const response = await POST(request(undefined, "https://evil.example"), context);
    expect(response.status).toBe(403); expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("bounds input before starting an external request", async () => {
    const response = await POST(request({ url: "x".repeat(5000) }), context);
    expect(response.status).toBe(413); expect(mocks.probe).not.toHaveBeenCalled();
  });
  it.each([400, 404, 429])("returns protected %s failures without caching", async status => {
    mocks.probe.mockRejectedValueOnce(new ContentError("Unavailable", status));
    const response = await POST(request(), context);
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not expose raw network failures or request details", async () => {
    mocks.probe.mockRejectedValueOnce(new Error("private details"));
    const response = await POST(request(), context);
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private details");
  });
});
