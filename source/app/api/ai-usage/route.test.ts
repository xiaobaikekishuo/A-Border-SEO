import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), getAiUsage: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ai-usage/data", () => ({ getAiUsage: mocks.getAiUsage }));
import { GET } from "./route";
import { ContentError } from "@/lib/content-planner/http";
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.getAiUsage.mockResolvedValue({ summary: { tasks: 0 } }); });
describe("usage report read endpoint", () => {
  it("uses the authenticated user and never forwards an arbitrary owner", async () => {
    const response = await GET(new Request("http://localhost/api/ai-usage?days=7&siteId=site-a"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getAiUsage).toHaveBeenCalledWith({}, "owner", 7, "site-a");
    expect((await GET(new Request("http://localhost/api/ai-usage?userId=other"))).status).toBe(400);
  });
  it("rejects invalid periods and preserves authorization failures", async () => {
    for (const query of ["days=0", "days=365", "days=7x", "siteId="]) expect((await GET(new Request(`http://localhost/api/ai-usage?${query}`))).status).toBe(400);
    mocks.auth.mockResolvedValue(null); mocks.getAiUsage.mockRejectedValue(new ContentError("Sign in required", 401));
    expect((await GET(new Request("http://localhost/api/ai-usage"))).status).toBe(401);
  });
});
