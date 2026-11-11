import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null);
export const tokenFields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
export const aiUsageSchema = z.object({
  source: z.enum(["CHATGPT_RESPONSE", "CODEX_CLI"]),
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  totalTokens: count,
}).strict().superRefine((value, ctx) => {
  if (value.inputTokens !== null && value.cachedInputTokens !== null && value.cachedInputTokens > value.inputTokens)
    ctx.addIssue({ code: "custom", message: "Cached input exceeds total input", path: ["cachedInputTokens"] });
  if (value.outputTokens !== null && value.reasoningTokens !== null && value.reasoningTokens > value.outputTokens)
    ctx.addIssue({ code: "custom", message: "Reasoning exceeds total output", path: ["reasoningTokens"] });
  if (value.inputTokens !== null && value.outputTokens !== null && value.totalTokens !== null && value.totalTokens !== value.inputTokens + value.outputTokens)
    ctx.addIssue({ code: "custom", message: "Total tokens must equal input plus output", path: ["totalTokens"] });
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export function storedUsage(value: unknown): AiUsage | null {
  const parsed = aiUsageSchema.safeParse(value);
  return parsed.success && tokenFields.some(key => parsed.data[key] !== null) ? parsed.data : null;
}

// Only provider metadata is accepted. Draft text and local token estimates are never used.
export function responseUsage(value: unknown): AiUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const detail = (value: unknown, key: string) => value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] ?? null : null;
  return storedUsage({
    source: "CHATGPT_RESPONSE",
    inputTokens: raw.input_tokens ?? null,
    cachedInputTokens: detail(raw.input_tokens_details, "cached_tokens"),
    outputTokens: raw.output_tokens ?? null,
    reasoningTokens: detail(raw.output_tokens_details, "reasoning_tokens"),
    totalTokens: raw.total_tokens ?? null,
  });
}
