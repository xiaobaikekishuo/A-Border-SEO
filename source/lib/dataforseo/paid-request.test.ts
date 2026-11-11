import { describe, expect, it, vi } from "vitest";
import { confirmedResearchRequest } from "./paid-request";
import { validMarket } from "./market";
describe("paid research confirmation in the UI", () => {
  it("cancel sends no network request", async () => {
    const send = vi.fn();
    expect(await confirmedResearchRequest("/local", { language: "en", location: 2840 }, 2, "2 requests", () => false, send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it("asks again for a later batch rather than remembering the first approval", async () => {
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const send = vi.fn().mockResolvedValue(new Response("{}"));
    await confirmedResearchRequest("/local", { language: "en", location: 2840 }, 2, "2 requests", confirm, send);
    await confirmedResearchRequest("/local", { language: "en", location: 2840 }, 2, "2 requests", confirm, send);
    expect(confirm).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ provider: "dataforseo", confirmed: true, operations: 2, language: "en", location: 2840 });
  });
  it("refuses unsupported market-language pairs before spending", () => {
    expect(validMarket({ language: "ja", location: 2840 })).toBe(false);
    expect(validMarket({ language: "zh-CN", location: 2702 })).toBe(true);
    expect(validMarket({ language: "ja", location: 2392 })).toBe(true);
  });
});
