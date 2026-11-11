/*
 * Page-level directives that decide whether a platform may use a page in an
 * answer. Pure functions over what the crawler saved for each page:
 *
 *   GOOGLE  (AI Overviews, AI Mode, Gemini): noindex, nosnippet and
 *           max-snippet:0 keep a page out; a short max-snippet and
 *           data-nosnippet limit what can be quoted. Read from the robots and
 *           googlebot meta tags and X-Robots-Tag lines for all crawlers or
 *           "googlebot:".
 *   BING    (Copilot): noindex keeps a page out, NOARCHIVE keeps it out of
 *           Copilot answers, NOCACHE limits it to the URL, title and snippet
 *           (both together count as NOCACHE), nosnippet may limit citations,
 *           and "ai-grounding:disallow" (announced for Bingbot in late 2026)
 *           keeps it out. Read from the robots, bingbot and msnbot meta tags
 *           and X-Robots-Tag lines for all crawlers or "bingbot:".
 *   GENERIC (ChatGPT, Perplexity, Claude, others): no page-level control is
 *           documented. noindex is reported as a limitation, not a block.
 */

import type { EligibilityRules } from "./platforms";

export type DirectiveEffect = "OK" | "LIMITED" | "EXCLUDED";
export type DirectiveReason =
  | "NOINDEX" | "NOSNIPPET" | "MAX_SNIPPET_ZERO" | "MAX_SNIPPET_SHORT" | "DATA_NOSNIPPET"
  | "NOARCHIVE" | "NOCACHE" | "AI_GROUNDING_DISALLOW" | "NOINDEX_UNDOCUMENTED";

export type DirectivePage = {
  url: string;
  statusCode: number;
  /** content of <meta name="robots">, from every crawl. */
  robotsMeta: string | null;
  /** [name, content] of robots-type meta tags; null for crawls saved before they were recorded. */
  robotsMetas: [string, string][] | null;
  /** X-Robots-Tag lines, newline-separated. */
  xRobotsTag: string | null;
  /** The page has a data-nosnippet attribute; null when not recorded. */
  dataNosnippet: boolean | null;
};

/** Directives written as "name:value"; any other "word:" prefix in an X-Robots-Tag line names a crawler. */
const VALUED = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview", "ai-grounding", "ai-training"]);
const SCOPES: Record<EligibilityRules, readonly string[]> = {
  GOOGLE: ["googlebot"],
  BING: ["bingbot", "msnbot"],
  GENERIC: [],
};
/** Below this many characters a snippet can hardly carry a quotation. */
const SHORT_SNIPPET = 50;

/** Directives in X-Robots-Tag lines that apply to every crawler or to one of `bots`. */
export function headerDirectives(lines: readonly string[], bots: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let scope = "*";
    for (const raw of line.split(",")) {
      let token = raw.trim().toLowerCase();
      if (!token) continue;
      const prefixed = /^([a-z0-9_.-]+)\s*:\s*(.*)$/.exec(token);
      if (prefixed && !VALUED.has(prefixed[1])) {
        scope = prefixed[1];
        token = prefixed[2].trim();
        if (!token) continue;
      }
      if (scope === "*" || bots.includes(scope)) out.push(token.replace(/\s*:\s*/, ":"));
    }
  }
  return out;
}

/** Directives in meta tags named "robots" or one of `bots`. */
export function metaDirectives(metas: readonly [string, string][], bots: readonly string[]): string[] {
  const out: string[] = [];
  for (const [name, content] of metas) {
    const n = name.trim().toLowerCase();
    if (n !== "robots" && !bots.includes(n)) continue;
    for (const raw of content.split(",")) {
      const token = raw.trim().toLowerCase().replace(/\s*:\s*/, ":");
      if (token) out.push(token);
    }
  }
  return out;
}

function snippetLimit(directives: readonly string[]): number | null {
  let limit: number | null = null;
  for (const d of directives) {
    const m = /^max-snippet:(-?\d+)$/.exec(d);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 0) limit = limit === null ? n : Math.min(limit, n);
  }
  return limit;
}

export type PageEligibility = { effect: DirectiveEffect; reasons: DirectiveReason[]; complete: boolean };

/** What the page's directives allow on platforms that follow `rules`. */
export function pageEligibility(page: DirectivePage, rules: EligibilityRules): PageEligibility {
  const bots = SCOPES[rules];
  const metas = page.robotsMetas ?? (page.robotsMeta ? [["robots", page.robotsMeta] as [string, string]] : []);
  const lines = page.xRobotsTag ? page.xRobotsTag.split("\n") : [];
  const directives = [...metaDirectives(metas, bots), ...headerDirectives(lines, bots)];
  const has = (d: string) => directives.includes(d);
  const reasons: DirectiveReason[] = [];
  let effect: DirectiveEffect = "OK";
  const exclude = (reason: DirectiveReason) => { reasons.push(reason); effect = "EXCLUDED"; };
  const limit = (reason: DirectiveReason) => { reasons.push(reason); if (effect === "OK") effect = "LIMITED"; };
  const noindex = has("noindex") || has("none");

  if (rules === "GOOGLE") {
    if (noindex) exclude("NOINDEX");
    if (has("nosnippet")) exclude("NOSNIPPET");
    const max = snippetLimit(directives);
    if (max === 0) exclude("MAX_SNIPPET_ZERO");
    else if (max !== null && max < SHORT_SNIPPET) limit("MAX_SNIPPET_SHORT");
    if (page.dataNosnippet) limit("DATA_NOSNIPPET");
  } else if (rules === "BING") {
    if (noindex) exclude("NOINDEX");
    if (directives.some(d => d === "ai-grounding:disallow")) exclude("AI_GROUNDING_DISALLOW");
    // Both together are treated as NOCACHE.
    if (has("nocache")) limit("NOCACHE");
    else if (has("noarchive")) exclude("NOARCHIVE");
    if (has("nosnippet")) limit("NOSNIPPET");
  } else if (noindex) {
    limit("NOINDEX_UNDOCUMENTED");
  }
  // Without the bot-specific meta tags (older crawls) a googlebot/bingbot tag could be missed.
  const complete = rules === "GENERIC" || (page.robotsMetas !== null && (rules !== "GOOGLE" || page.dataNosnippet !== null));
  return { effect, reasons, complete };
}

export type EligibilitySummary = {
  pages: number;
  ok: number;
  limited: number;
  excluded: number;
  reasons: Partial<Record<DirectiveReason, number>>;
  /** False when some pages come from crawls that did not record every directive. */
  complete: boolean;
  examples: { url: string; effect: DirectiveEffect; reasons: DirectiveReason[] }[];
};

/** Counts over the crawled pages that answered 200. */
export function summarizeEligibility(pages: readonly DirectivePage[], rules: EligibilityRules, maxExamples = 8): EligibilitySummary {
  const summary: EligibilitySummary = { pages: 0, ok: 0, limited: 0, excluded: 0, reasons: {}, complete: true, examples: [] };
  for (const page of pages) {
    if (page.statusCode !== 200) continue;
    const result = pageEligibility(page, rules);
    summary.pages++;
    if (!result.complete) summary.complete = false;
    if (result.effect === "OK") summary.ok++;
    else {
      if (result.effect === "LIMITED") summary.limited++;
      else summary.excluded++;
      for (const reason of result.reasons) summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
      if (summary.examples.length < maxExamples) summary.examples.push({ url: page.url, effect: result.effect, reasons: result.reasons });
    }
  }
  return summary;
}
