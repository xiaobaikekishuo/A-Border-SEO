import { describe, expect, it } from "vitest";
import { aiUsageSchema, responseUsage, storedUsage } from "./schema";

describe("provider token metadata", () => {
  it("distinguishes real zeros from missing fields and never estimates totals", () => {
    expect(responseUsage(undefined)).toBeNull();
    expect(responseUsage({})).toBeNull();
    expect(storedUsage({ source: "CODEX_CLI" })).toBeNull();
    expect(responseUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: null, reasoningTokens: null });
    expect(responseUsage({ input_tokens: 10, output_tokens: 5 })).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: null });
  });
  it("preserves inclusive cache/reasoning values without double counting", () => {
    expect(responseUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 150 }))
      .toEqual({ source: "CHATGPT_RESPONSE", inputTokens: 100, cachedInputTokens: 80, outputTokens: 50, reasoningTokens: 20, totalTokens: 150 });
  });
  it("rejects invalid, inconsistent, unsafe or coerced counts", () => {
    for (const input_tokens of [-1, 1.2, "10", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(responseUsage({ input_tokens })).toBeNull();
    expect(responseUsage({ input_tokens: 5, input_tokens_details: { cached_tokens: 6 } })).toBeNull();
    expect(responseUsage({ output_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } })).toBeNull();
    expect(responseUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 20 })).toBeNull();
    expect(aiUsageSchema.safeParse({ source: "CODEX_CLI", inputTokens: 5, remainingPercent: 90 }).success).toBe(false);
  });
});
