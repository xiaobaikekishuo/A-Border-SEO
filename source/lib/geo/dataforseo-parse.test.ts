import { describe, expect, it } from "vitest";
import { DataForSeoError, liveTask, parseModels, parseResponses, parseScraper, parseSerpAi } from "./dataforseo-parse";

const live = (task: Record<string, unknown>, status = 20000) => ({ status_code: status, tasks: [{ status_code: 20000, cost: 0.004, result: [{}], ...task }] });

function code(fn: () => unknown): { code: string; retryable: boolean } | null {
  try { fn(); return null; } catch (error) {
    return error instanceof DataForSeoError ? { code: error.code, retryable: error.retryable } : null;
  }
}

describe("DataForSEO live envelope", () => {
  it("returns the task result and its cost", () => {
    expect(liveTask(live({ result: [{ markdown: "x" }] }))).toEqual({ result: { markdown: "x" }, cost: 0.004 });
  });

  it("maps refusals to errors a run can act on", () => {
    expect(code(() => liveTask({ status_code: 40100 }))).toEqual({ code: "AUTH", retryable: false });
    expect(code(() => liveTask({ status_code: 40200 }))).toEqual({ code: "BALANCE", retryable: false });
    expect(code(() => liveTask({ status_code: 40202 }))).toEqual({ code: "RATE_LIMIT", retryable: true });
    expect(code(() => liveTask({ status_code: 50000 }))).toEqual({ code: "API", retryable: true });
    expect(code(() => liveTask(live({ status_code: 40101 })))).toEqual({ code: "API", retryable: true });
    expect(code(() => liveTask(live({ status_code: 40501 })))).toEqual({ code: "INVALID", retryable: false });
    try { liveTask(live({ status_code: 40501, status_message: "Invalid Field: 'language_code'." })); }
    catch (error) { expect((error as Error).message).toContain("Invalid Field: 'language_code'."); }
    expect(code(() => liveTask("nope"))).toEqual({ code: "API", retryable: false });
  });

  it("treats 40102 as a check that found no answer, still charged", () => {
    expect(liveTask(live({ status_code: 40102, cost: 0.002 }))).toEqual({ result: null, cost: 0.002 });
  });
});

describe("answer parsers", () => {
  it("LLM Scraper: markdown, sources, consulted results and fan-out queries", () => {
    const parsed = parseScraper({
      model: "gpt-5",
      markdown: "Try **Kammak** for sofas.",
      sources: [{ url: "https://kammakhome.com/sofa?utm_source=chatgpt.com", title: "Sofa" }],
      items: [{ type: "chat_gpt_text", sources: [{ url: "https://acme.test/", title: "Acme" }] }],
      search_results: [{ url: "https://a.test/" }, { url: "https://b.test/" }],
      fan_out_queries: ["best sofa brands"],
    });
    expect(parsed).toMatchObject({ status: "OK", text: "Try **Kammak** for sofas.", consulted: 2, model: "gpt-5", fanOut: ["best sofa brands"] });
    expect(parsed.citations.map(c => c.url)).toEqual(["https://kammakhome.com/sofa", "https://acme.test/"]);
    expect(parseScraper(null).status).toBe("NO_ANSWER");
  });

  it("LLM Responses: message text and its annotations", () => {
    const parsed = parseResponses({
      model_name: "sonar",
      items: [{ type: "message", sections: [{ type: "text", text: "Kammak and Acme.", annotations: [{ title: "Kammak", url: "https://kammakhome.com/" }] }] }],
    });
    expect(parsed).toMatchObject({ status: "OK", text: "Kammak and Acme.", model: "sonar" });
    expect(parsed.citations).toHaveLength(1);
    expect(parseResponses({ items: [{ type: "message", sections: [{ type: "text", text: "See [Acme](https://acme.test/x)." }] }] }).citations[0].url).toBe("https://acme.test/x");
  });

  it("SERP: the AI Overview with its references, and the site's organic rank", () => {
    const parsed = parseSerpAi({
      items: [
        { type: "ai_overview", markdown: "Sofas: Kammak", references: [{ url: "https://kammakhome.com/guide", title: "Guide", source: "Kammak" }] },
        { type: "organic", rank_group: 1, domain: "acme.test" },
        { type: "organic", rank_group: 2, domain: "www.kammakhome.com" },
      ],
    }, ["kammakhome.com"]);
    expect(parsed).toMatchObject({ status: "OK", text: "Sofas: Kammak", organicRank: 2 });
    expect(parsed.citations[0]).toMatchObject({ url: "https://kammakhome.com/guide", domain: "kammakhome.com", rank: 1 });
    expect(parseSerpAi({ items: [{ type: "organic", rank_group: 4, domain: "kammakhome.com" }] }, ["kammakhome.com"])).toMatchObject({ status: "NO_ANSWER", organicRank: 4 });
  });

  it("lists model names", () => {
    expect(parseModels({ tasks: [{ result: [
      { model_name: "claude-haiku-4-5", reasoning: false, web_search_supported: true },
      { model_name: "claude-3-opus-latest", reasoning: false, web_search_supported: false },
      { model_name: "claude-next" },
      {},
    ] }] })).toEqual([
      { name: "claude-haiku-4-5", webSearch: true, reasoning: false },
      { name: "claude-3-opus-latest", webSearch: false, reasoning: false },
      { name: "claude-next", webSearch: true, reasoning: false },
    ]);
  });
});
