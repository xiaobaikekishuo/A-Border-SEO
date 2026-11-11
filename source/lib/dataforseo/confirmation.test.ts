import { describe, expect, it } from "vitest";
import { paidConfirmation } from "./confirmation";
const market = { language: "en", location: 2840 };
const accepted = { confirmed: true, provider: "dataforseo", operations: 2, ...market };
function post(body: unknown, origin?: string) { return new Request("http://localhost/api/research", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }); }
describe("paid batch authorization", () => {
  it("refuses GET even if query claims confirmation", async () => expect((await paidConfirmation(new Request("http://localhost/api?confirmed=true"), market, 2))?.status).toBe(409));
  it.each([null, {}, { ...accepted, confirmed: "true" }, { ...accepted, provider: "other" }, { ...accepted, operations: 1 }, { ...accepted, language: "ja" }])("refuses absent, incorrect or stale authorization", async value => expect((await paidConfirmation(post(value), market, 2))?.status).toBe(409));
  it("refuses cross-origin billing", async () => expect((await paidConfirmation(post(accepted, "https://other.example"), market, 2))?.status).toBe(403));
  it("accepts the explicitly reviewed batch only", async () => expect(await paidConfirmation(post(accepted, "http://localhost"), market, 2)).toBeNull());
});

describe("Docker public-host origin boundary", () => {
  it("accepts the browser origin at port 3300 with Next on internal port 3000", async () => {
    const req = new Request("http://0.0.0.0:3000/api/research", { method: "POST", headers: { host: "localhost:3300", origin: "http://localhost:3300" }, body: JSON.stringify(accepted) });
    expect(await paidConfirmation(req, market, 2)).toBeNull();
  });
  it("does not trust a spoofed forwarded host for billing", async () => {
    const req = new Request("http://0.0.0.0:3000/api/research", { method: "POST", headers: { host: "localhost:3300", origin: "https://other.example", "x-forwarded-host": "other.example" }, body: JSON.stringify(accepted) });
    expect((await paidConfirmation(req, market, 2))?.status).toBe(403);
  });
});
