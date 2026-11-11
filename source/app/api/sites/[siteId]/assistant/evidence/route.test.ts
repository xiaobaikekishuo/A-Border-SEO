import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ai-workbench/diagnostic", () => ({ getDiagnosticEvidence: mocks.get }));
import { ContentError } from "@/lib/content-planner/http";
import { GET } from "./route";
const context = { params: Promise.resolve({ siteId: "site" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.get.mockResolvedValue({ page: null }); });
describe("diagnostic preview route", () => {
  it("passes identity and only the supplied identifiers to the read-only service", async () => {
    const response = await GET(new Request("http://localhost:3300/api/sites/site/assistant/evidence?query=guide&opportunity=low_ctr"), context);
    expect(mocks.get).toHaveBeenCalledWith({}, "owner", "site", { query: "guide", opportunity: "low_ctr" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([401, 404, 409])("keeps %s errors private and uncached", async status => {
    mocks.get.mockRejectedValue(new ContentError("Unavailable", status));
    const response = await GET(new Request("http://localhost:3300"), context);
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
