import { ContentError } from "@/lib/content-planner/http";

/*
 * Structured Codex tasks added in 1.8.0. Each one is an AiWorkbenchJob of its
 * own kind: the same start, claim, lease, cancel and usage path as the other
 * workbench tasks (lib/ai-workbench/data.ts, worker.ts), with its own
 * evidence, prompt, output schema and server checks (this folder).
 */
// TOPIC_BRIEF (1.9.0) is queued by the background pool (lib/ai-workbench/pool) and has no form of its own.
export const TOOL_KINDS = ["META_REWRITE", "LOCALIZE_ARTICLE", "SCHEMA_MARKUP", "OUTREACH_EMAILS", "QUERY_CLUSTERS", "TOPIC_BRIEF"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export function isToolKind(kind: string): kind is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(kind);
}

/** Tasks shown in a panel on their own page, not among the workbench drafts. */
export const PANEL_KINDS = ["KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS", "META_REWRITE", "OUTREACH_EMAILS", "QUERY_CLUSTERS"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];
export function isPanelKind(kind: string): kind is PanelKind {
  return (PANEL_KINDS as readonly string[]).includes(kind);
}

export const TOOL_CONTEXT_TOO_LARGE = "tool_context_too_large";

// Released workers refuse a claim response longer than this, JSON escaping
// included (source/local-worker/lib.mjs, LIMITS.apiResponseBytes).
export const MAX_CLAIM_CHARS = 65_536;
// Room left for a per-task model and reasoning effort (lib/ai-workbench/pool/routing.ts).
export const ROUTING_HINT_CHARS = 200;

/** Whether a claim with this prompt and output schema fits what released workers accept. */
export function fitsWorkerClaim(prompt: string, outputSchema: unknown): boolean {
  const envelope = { managedProtocol: 2, job: {
    jobId: "x".repeat(100), leaseToken: "x".repeat(36), leaseExpiresAt: "9999-12-31T23:59:59.999Z",
    provider: "CODEX_LOCAL", prompt, outputSchema,
  } };
  return JSON.stringify(envelope).length <= MAX_CLAIM_CHARS - ROUTING_HINT_CHARS;
}

/**
 * The largest sample, from `max` rows down to `min`, whose prompt fits a
 * worker claim. Fails when even `min` rows do not fit.
 */
export function fitSample<T>(max: number, min: number, build: (rows: number) => T, prompt: (context: T) => string, outputSchema: unknown): T {
  const fits = (rows: number) => fitsWorkerClaim(prompt(build(rows)), outputSchema);
  if (max >= min && fits(max)) return build(max);
  if (max < min || !fits(min)) throw new ContentError(TOOL_CONTEXT_TOO_LARGE, 422);
  let low = min + 1, high = max - 1, best = min;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) { best = middle; low = middle + 1; } else high = middle - 1;
  }
  return build(best);
}

// East Asian wide and fullwidth characters take about two Latin letters of
// space in a search result title.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

/** Display width: a CJK or other wide character counts 2, anything else 1. */
export function displayUnits(text: string): number {
  let units = 0;
  for (const character of text) units += WIDE.test(character) ? 2 : 1;
  return units;
}

/** One line of text: no control characters, collapsed whitespace. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'\]`}　-〿＀-￯\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/giu;
const TRAILING = /[),.;!?，。；！]+$/u;

/** The URLs written in a text, without trailing punctuation. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(BARE_URL)].map(match => match[0].replace(TRAILING, ""));
}
