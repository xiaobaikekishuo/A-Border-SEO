import { describe, expect, it } from "vitest";
import { askPlatform, countryIso, pickClaudeModel, taskBody } from "./dataforseo-ai";
import { DataForSeoError } from "./dataforseo-parse";

const market = { language: "en", location: 2840 };
const credentials = { login: "user@example.test", password: "pw" };

function fetcher(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("DataForSEO AI requests", () => {
  it("builds the task for each platform from the site's market", () => {
    expect(taskBody({ platform: "CHATGPT", prompt: " best sofa ", market, ownDomains: [] })).toEqual({ keyword: "best sofa", location_code: 2840, language_code: "en", force_web_search: true });
    expect(taskBody({ platform: "GOOGLE_AIO", prompt: "sofa", market, ownDomains: [] })).toMatchObject({ device: "desktop", load_async_ai_overview: true });
    expect(taskBody({ platform: "PERPLEXITY", prompt: "sofa", market, ownDomains: [] })).toEqual({ user_prompt: "sofa", model_name: "sonar", web_search_country_iso_code: "US" });
    expect(taskBody({ platform: "CLAUDE", prompt: "sofa", market, ownDomains: [], claudeModel: "claude-haiku-4-5" })).toEqual({ user_prompt: "sofa", model_name: "claude-haiku-4-5", web_search: true, web_search_country_iso_code: "US" });
    expect(() => taskBody({ platform: "CLAUDE", prompt: "sofa", market, ownDomains: [] })).toThrow("No Claude model");
    expect(() => taskBody({ platform: "COPILOT", prompt: "sofa", market, ownDomains: [] })).toThrow("cannot be asked");
    expect(String(taskBody({ platform: "GEMINI", prompt: "x".repeat(900), market, ownDomains: [] }).keyword)).toHaveLength(500);
  });

  it("picks the cheapest Claude model and maps markets to countries", () => {
    const model = (name: string, webSearch = true) => ({ name, webSearch, reasoning: false });
    expect(pickClaudeModel([model("claude-3-haiku-20240307"), model("claude-opus-4-1"), model("claude-haiku-4-5-20251001"), model("claude-haiku-4-5"), model("claude-3-5-haiku-latest")])).toBe("claude-haiku-4-5");
    expect(pickClaudeModel([model("claude-haiku-4-5", false), model("claude-sonnet-4-0"), model("claude-sonnet-4-5")])).toBe("claude-sonnet-4-5");
    expect(pickClaudeModel([model("claude-3-opus-latest", false)])).toBeNull();
    expect(pickClaudeModel([])).toBeNull();
    expect(countryIso(2826)).toBe("GB");
    expect(countryIso(1)).toBeNull();
  });

  it("posts one task with Basic auth and parses the answer with its cost", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const body = { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.0041, result: [{ markdown: "Kammak", sources: [{ url: "https://kammakhome.com/" }] }] }] };
    const answer = await askPlatform(credentials, { platform: "CHATGPT", prompt: "sofa", market, ownDomains: [] }, undefined, fetcher(200, body, seen));
    expect(seen.url).toBe("https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("user@example.test:pw").toString("base64"));
    expect(JSON.parse(String(seen.init?.body))).toEqual([{ keyword: "sofa", location_code: 2840, language_code: "en", force_web_search: true }]);
    expect(answer).toMatchObject({ status: "OK", text: "Kammak", cost: 0.0041 });
  });

  it("turns HTTP refusals into errors", async () => {
    const input = { platform: "GEMINI" as const, prompt: "sofa", market, ownDomains: [] };
    await expect(askPlatform(credentials, input, undefined, fetcher(401, {}))).rejects.toMatchObject({ code: "AUTH" });
    await expect(askPlatform(credentials, input, undefined, fetcher(402, {}))).rejects.toMatchObject({ code: "BALANCE" });
    await expect(askPlatform(credentials, input, undefined, fetcher(429, {}))).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true });
    await expect(askPlatform(credentials, input, undefined, fetcher(500, {}))).rejects.toMatchObject({ code: "API", retryable: true });
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(askPlatform(credentials, input, undefined, failing)).rejects.toBeInstanceOf(DataForSeoError);
  });
});
