import { afterEach, describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn().mockResolvedValue({ job: null }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/content-planner/worker", () => ({ runWorkerAction: run }));
import { POST } from "./route";
const token = "fixture-only-worker-token-32-characters-long";
afterEach(() => { vi.unstubAllEnvs(); run.mockClear(); });
describe("local content worker API", () => {
  it("requires the dedicated bearer token, not a browser session", async () => {
    vi.stubEnv("LOCAL_CONTENT_WORKER_TOKEN", token);
    const response = await POST(new Request("http://localhost/api/local-content-worker", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claim", workerId: "test" }),
    }));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("forwards only authenticated JSON to the lease service", async () => {
    vi.stubEnv("LOCAL_CONTENT_WORKER_TOKEN", token);
    const response = await POST(new Request("http://localhost/api/local-content-worker", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "claim", workerId: "test" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: null });
    expect(run).toHaveBeenCalledWith({}, { action: "claim", workerId: "test" });
  });
});
