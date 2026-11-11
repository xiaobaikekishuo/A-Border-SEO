import type { AiBotKind, AiBotPurpose } from "./ai-bots";

/**
 * What the robots.txt response means, per RFC 9309 2.3.1:
 * - RULES: a 2xx file was read and its rules apply.
 * - UNAVAILABLE: 4xx (not 429) or too many redirects. Crawlers may fetch everything.
 * - UNREACHABLE: 429 or 5xx. Crawlers must assume everything is disallowed.
 * - UNKNOWN: this check could not tell (network error, timeout, an HTML page instead of rules).
 */
export type AiAccessOutcome = "RULES" | "UNAVAILABLE" | "UNREACHABLE" | "UNKNOWN";
export type AiAccessReason =
  | "ROBOTS_NOT_FOUND" | "ROBOTS_ACCESS_DENIED" | "ROBOTS_CLIENT_ERROR" | "ROBOTS_TOO_MANY_REDIRECTS"
  | "ROBOTS_RATE_LIMITED" | "ROBOTS_SERVER_ERROR"
  | "HTML_RESPONSE" | "ROBOTS_TOO_COMPLEX" | "UNRECOGNIZED_CONTENT" | "UNEXPECTED_STATUS" | "FETCH_FAILED" | "TIMEOUT";
export type AiAccessWarning =
  | "ROBOTS_NOT_PROOF_OF_ACCESS" | "USER_AGENTS_NOT_IMPERSONATED" | "TRAINING_NOT_SEARCH" | "USER_REQUEST_ROBOTS_NOT_RELIABLE"
  | "SAVED_PAGE_NOT_LIVE" | "PREFERENCES_ARE_REQUESTS" | "TRAINING_SIGNAL_ROLLOUT" | "OTHER_PREFERENCES_NOT_EVALUATED"
  | "ROBOTS_TRUNCATED" | "UNEXPECTED_CONTENT_TYPE" | "INVALID_UTF8" | "WAF_MAY_BLOCK" | "ROBOTS_REDIRECTED";
export type AiAccessBot = {
  agent: string;
  provider: string;
  purpose: AiBotPurpose;
  kind: AiBotKind;
  /**
   * The conclusion for this bot. NOT_APPLICABLE: the provider says these
   * user-triggered visits may not follow robots.txt. NO_PREFERENCE: a policy
   * token with no group of its own.
   */
  robots: "ALLOWED" | "BLOCKED" | "UNKNOWN" | "NOT_APPLICABLE" | "NO_PREFERENCE";
  /** What the rules say for this path, before the provider caveat. */
  declared: "ALLOWED" | "BLOCKED" | null;
  /** The user-agent the rules came from: the bot's own token, "*", or null. */
  group: string | null;
  matchedLine: number | null;
  rule: string | null;
  crawlDelay: number | null;
};
export type AiContentPreference = {
  kind: "CONTENT_SIGNAL" | "CONTENT_USAGE";
  /** User agents of the group the line is in, or "FILE" before any group. */
  scope: string[] | "FILE";
  path: string | null;
  values: Record<string, string>;
  line: number;
  text: string;
};
export type AiAccessReport = {
  siteId: string;
  url: string;
  checkedAt: string;
  robots: { url: string; finalUrl: string | null; status: number | null; outcome: AiAccessOutcome; reason: AiAccessReason | null; contentType: string | null; sitemaps: string[] };
  bots: AiAccessBot[];
  /** Content-Signal and Content-Usage lines that apply to this URL (any group). */
  preferences: AiContentPreference[];
  page: { source: "SAVED_CRAWL"; capturedAt: string | null; url: string; statusCode: number | null; robotsMeta: string | null; xRobotsTag: string | null; indexable: boolean | null } | null;
  limits: { robotsMaxBytes: number; timeoutMs: number };
  warnings: AiAccessWarning[];
};
