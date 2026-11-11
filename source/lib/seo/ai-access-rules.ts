import { AI_BOTS } from "./ai-bots";
import { crawlDelayOf, decidePath, parseRobots, patternMatches, robotsTarget, selectGroups, type ParsedRobots } from "./robots-rules";
import type { AiAccessBot, AiAccessOutcome, AiAccessReason, AiAccessReport, AiAccessWarning, AiContentPreference } from "./ai-access-types";

/*
 * Pure parts of the AI access check: what a robots.txt response means, what
 * it says for each AI bot, and the report. No network, no database.
 */

export type RobotsEvidence = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  outcome: AiAccessOutcome;
  reason: AiAccessReason | null;
  parsed: ParsedRobots | null;
  warnings: AiAccessWarning[];
};
export type Classification = Pick<RobotsEvidence, "outcome" | "reason" | "parsed" | "warnings">;

function looksLikeHtml(contentType: string | null, text: string): boolean {
  const start = text.replace(/^\uFEFF/, "").trimStart().slice(0, 2048);
  if (/^<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|\?xml)/i.test(start)) return true;
  return !!contentType && /^text\/html\b/i.test(contentType) && /<(?:html|body|head|script)\b/i.test(start);
}

/**
 * The meaning of a robots.txt response (RFC 9309 2.3.1): 2xx rules apply; 4xx
 * other than 429 allows everything; 429 and 5xx disallow everything. An HTML
 * page answered with 2xx (a soft 404 or a bot challenge) is not treated as
 * rules: the result is unknown.
 */
export function classifyRobots(status: number, contentType: string | null, text: string, warnings: AiAccessWarning[] = []): Classification {
  if (status === 404 || status === 410) return { outcome: "UNAVAILABLE", reason: "ROBOTS_NOT_FOUND", parsed: null, warnings };
  if (status === 401 || status === 403) return { outcome: "UNAVAILABLE", reason: "ROBOTS_ACCESS_DENIED", parsed: null, warnings: [...warnings, "WAF_MAY_BLOCK"] };
  if (status === 429) return { outcome: "UNREACHABLE", reason: "ROBOTS_RATE_LIMITED", parsed: null, warnings };
  if (status >= 400 && status < 500) return { outcome: "UNAVAILABLE", reason: "ROBOTS_CLIENT_ERROR", parsed: null, warnings };
  if (status >= 500 && status < 600) return { outcome: "UNREACHABLE", reason: "ROBOTS_SERVER_ERROR", parsed: null, warnings };
  if (status < 200 || status >= 300) return { outcome: "UNKNOWN", reason: "UNEXPECTED_STATUS", parsed: null, warnings };
  if (looksLikeHtml(contentType, text)) return { outcome: "UNKNOWN", reason: "HTML_RESPONSE", parsed: null, warnings: [...warnings, "WAF_MAY_BLOCK"] };
  const parsed = parseRobots(text);
  if (parsed.tooComplex) return { outcome: "UNKNOWN", reason: "ROBOTS_TOO_COMPLEX", parsed: null, warnings };
  if (!parsed.recognized && parsed.unrecognized) return { outcome: "UNKNOWN", reason: "UNRECOGNIZED_CONTENT", parsed: null, warnings };
  const type = contentType?.split(";", 1)[0].trim().toLowerCase();
  return { outcome: "RULES", reason: null, parsed, warnings: type && type !== "text/plain" ? [...warnings, "UNEXPECTED_CONTENT_TYPE"] : warnings };
}

/** Pure policy matching per bot, including the winning rule's original line. No outbound requests. */
export function evaluateAiRobots(url: string, evidence: Pick<RobotsEvidence, "outcome" | "parsed">): AiAccessBot[] {
  const target = robotsTarget(url);
  return AI_BOTS.map<AiAccessBot>(bot => {
    const base = { agent: bot.token, provider: bot.provider, purpose: bot.purpose, kind: bot.kind, group: null, matchedLine: null, rule: null, crawlDelay: null };
    const policy = bot.kind === "POLICY_TOKEN";
    const conclude = (declared: "ALLOWED" | "BLOCKED") => bot.followsRobots ? declared : "NOT_APPLICABLE" as const;
    if (evidence.outcome === "UNKNOWN" || (evidence.outcome === "RULES" && !evidence.parsed)) return { ...base, robots: "UNKNOWN", declared: null };
    if (evidence.outcome === "UNAVAILABLE") return { ...base, robots: policy ? "NO_PREFERENCE" : conclude("ALLOWED"), declared: policy ? null : "ALLOWED" };
    if (evidence.outcome === "UNREACHABLE") return { ...base, robots: policy ? "UNKNOWN" : conclude("BLOCKED"), declared: policy ? null : "BLOCKED" };
    const selected = selectGroups(evidence.parsed!, bot.token);
    if (policy && !selected.matched) return { ...base, robots: "NO_PREFERENCE", declared: null };
    const decision = decidePath(selected.groups, target);
    const declared = decision.allowed ? "ALLOWED" : "BLOCKED";
    return {
      ...base,
      robots: conclude(declared),
      declared,
      group: selected.matched === "*" ? "*" : selected.matched ? bot.token : null,
      matchedLine: decision.rule?.line ?? null,
      rule: decision.rule?.text ?? null,
      crawlDelay: policy ? null : crawlDelayOf(selected.groups),
    };
  });
}

/** Every Content-Signal and Content-Usage line whose optional path matches this URL. */
export function contentPreferences(url: string, parsed: ParsedRobots | null): AiContentPreference[] {
  if (!parsed) return [];
  const target = robotsTarget(url);
  return [...parsed.filePreferences, ...parsed.groups.flatMap(group => group.preferences)]
    .filter(preference => preference.path === null || patternMatches(preference.path, target))
    .slice(0, 40)
    .map(preference => ({ ...preference, scope: preference.scope === "FILE" ? "FILE" : [...preference.scope] }));
}

/** UTF-8 text of the file. A truncated file is cut at its last complete line, as content past the limit is ignored. */
export function decodeRobots(bytes: Uint8Array, truncated: boolean): { text: string; warnings: AiAccessWarning[] } {
  const warnings: AiAccessWarning[] = truncated ? ["ROBOTS_TRUNCATED"] : [];
  let usable = bytes;
  if (truncated) {
    const lastBreak = Math.max(bytes.lastIndexOf(0x0a), bytes.lastIndexOf(0x0d));
    usable = lastBreak >= 0 ? bytes.subarray(0, lastBreak) : new Uint8Array(0);
  }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(usable), warnings }; }
  catch { return { text: new TextDecoder("utf-8").decode(usable), warnings: [...warnings, "INVALID_UTF8"] }; }
}

const STANDING_WARNINGS: AiAccessWarning[] = [
  "ROBOTS_NOT_PROOF_OF_ACCESS", "USER_AGENTS_NOT_IMPERSONATED", "TRAINING_NOT_SEARCH", "USER_REQUEST_ROBOTS_NOT_RELIABLE",
  "TRAINING_SIGNAL_ROLLOUT", "OTHER_PREFERENCES_NOT_EVALUATED", "SAVED_PAGE_NOT_LIVE",
];

/** Builds the report from fetched evidence. */
export function assembleAccessReport(siteId: string, url: string, evidence: RobotsEvidence, page: AiAccessReport["page"], limits: AiAccessReport["limits"], now = new Date()): AiAccessReport {
  const preferences = contentPreferences(url, evidence.parsed);
  const warnings = [...new Set<AiAccessWarning>([...evidence.warnings, ...STANDING_WARNINGS, ...(preferences.length ? ["PREFERENCES_ARE_REQUESTS" as const] : [])])];
  return {
    siteId, url, checkedAt: now.toISOString(),
    robots: { url: evidence.url, finalUrl: evidence.finalUrl, status: evidence.status, outcome: evidence.outcome, reason: evidence.reason, contentType: evidence.contentType, sitemaps: evidence.parsed?.sitemaps.slice(0, 10) ?? [] },
    bots: evaluateAiRobots(url, evidence),
    preferences,
    page,
    limits,
    warnings,
  };
}

