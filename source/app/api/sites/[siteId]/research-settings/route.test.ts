import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), findFirst: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: m.findFirst, update: m.update } } }));
import { GET, PUT } from "./route";
const context = { params: Promise.resolve({ siteId: "site" }) };
function request(body?: unknown, origin?: string) { return new Request("http://localhost/api/sites/site/research-settings", body ? { method: "PUT", headers: origin ? { origin } : undefined, body: JSON.stringify(body) } : undefined); }
beforeEach(() => {
  vi.resetAllMocks(); m.auth.mockResolvedValue({ user: { id: "owner" } });
  m.findFirst.mockResolvedValue({ id: "site", researchLanguage: "en", researchLocation: 2840 });
});
describe("site research market settings", () => {
  it("reads only the authenticated owner's site", async () => {
    expect(await (await GET(request(), context)).json()).toEqual({ language: "en", location: 2840 });
    expect(m.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "site", userId: "owner" } }));
  });
  it("persists a supported pair only", async () => {
    expect((await PUT(request({ language: "ja", location: 2392 }), context)).status).toBe(200);
    expect(m.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "site" }, data: { researchLanguage: "ja", researchLocation: 2392 } });
  });
  it("rejects unsupported combinations without changing configuration", async () => {
    expect((await PUT(request({ language: "ja", location: 2840 }), context)).status).toBe(400); expect(m.update).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes", async () => {
    expect((await PUT(request({ language: "en", location: 2840 }, "https://elsewhere.example"), context)).status).toBe(403); expect(m.update).not.toHaveBeenCalled();
  });
  it("rejects users who do not own the site", async () => {
    m.findFirst.mockResolvedValue(null);
    expect((await PUT(request({ language: "en", location: 2840 }), context)).status).toBe(404); expect(m.update).not.toHaveBeenCalled();
  });
});

describe("Docker public-host market settings", () => {
  it("accepts the real browser origin despite internal port rewriting", async () => {
    const req = new Request("http://0.0.0.0:3000/api/sites/site/research-settings", { method: "PUT", headers: { host: "localhost:3300", origin: "http://localhost:3300" }, body: JSON.stringify({ language: "ja", location: 2392 }) });
    expect((await PUT(req, context)).status).toBe(200);
    expect(m.update).toHaveBeenCalledTimes(1);
  });
  it("rejects a cross-origin request even with a forged forwarded host", async () => {
    const req = new Request("http://0.0.0.0:3000/api/sites/site/research-settings", { method: "PUT", headers: { host: "localhost:3300", origin: "https://other.example", "x-forwarded-host": "other.example" }, body: JSON.stringify({ language: "ja", location: 2392 }) });
    expect((await PUT(req, context)).status).toBe(403);
    expect(m.update).not.toHaveBeenCalled();
  });
});
