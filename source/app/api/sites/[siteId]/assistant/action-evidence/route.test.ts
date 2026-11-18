import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentError } from "@/lib/content-planner/http";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), evidence: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ai-workbench/action-evidence", () => ({ getActionEvidence: mocks.evidence }));
import { GET } from "./route";

const call = (query: string) => GET(new Request("http://localhost/test?" + query), { params: Promise.resolve({ siteId: "site-a" }) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); });
describe("action evidence preview", () => {
  it("reads only the authenticated site and whitelisted scope", async () => {
    mocks.evidence.mockResolvedValue({ hasData: false, revision: "test" });
    const response = await call("scope=bing&siteId=other&userId=other");
    expect(mocks.evidence).toHaveBeenCalledWith({}, "owner", "site-a", "bing");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ revision: "test" });
  });
  it("rejects unsupported scopes and unauthenticated requests before collecting data", async () => {
    expect((await call("scope=admin")).status).toBe(400);
    mocks.auth.mockResolvedValue(null);
    expect((await call("scope=audit")).status).toBe(401);
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
  it("keeps ownership errors uncached", async () => {
    mocks.evidence.mockRejectedValue(new ContentError("Unknown site", 404));
    const response = await call("scope=performance");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
