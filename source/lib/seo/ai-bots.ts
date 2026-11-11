/*
 * AI-related robots.txt product tokens, shared by the AI access check and the
 * access-log import. Purposes follow each provider's own documentation (read
 * November 2026). A name here describes a robots.txt group, not a claim that
 * the service can reach, index or cite a page.
 *
 * - CRAWLER: a real HTTP user agent that reads robots.txt.
 * - CONTROL_TOKEN: a robots.txt token with no crawler of its own
 *   (Google-Extended, Applebot-Extended); other user agents fetch the pages.
 * - POLICY_TOKEN: a usage preference written as a group, such as the shared
 *   "__usage_ai-training" token (draft-kelley-aipref-training-preference-signal).
 *   "User-agent: *" never applies to it.
 */

export type AiBotPurpose = "SEARCH" | "TRAINING" | "USER_REQUEST";
export type AiBotKind = "CRAWLER" | "CONTROL_TOKEN" | "POLICY_TOKEN";
export type AiBot = {
  token: string;
  provider: string;
  purpose: AiBotPurpose;
  kind: AiBotKind;
  /** False when the provider says user-triggered visits may not follow robots.txt. */
  followsRobots: boolean;
  /** Counted in access-log imports: a real, AI-specific HTTP user agent. */
  inLogs: boolean;
};

export const TRAINING_POLICY_TOKEN = "__usage_ai-training";

export const AI_BOTS: readonly AiBot[] = [
  { token: "OAI-SearchBot", provider: "OpenAI", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "GPTBot", provider: "OpenAI", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "ChatGPT-User", provider: "OpenAI", purpose: "USER_REQUEST", kind: "CRAWLER", followsRobots: false, inLogs: true },
  { token: "Claude-SearchBot", provider: "Anthropic", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "ClaudeBot", provider: "Anthropic", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "Claude-User", provider: "Anthropic", purpose: "USER_REQUEST", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "PerplexityBot", provider: "Perplexity", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "Perplexity-User", provider: "Perplexity", purpose: "USER_REQUEST", kind: "CRAWLER", followsRobots: false, inLogs: true },
  // Search engines whose indexes also feed AI answers (AI Overviews, Copilot, Apple Intelligence).
  { token: "Googlebot", provider: "Google", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: false },
  { token: "Google-Extended", provider: "Google", purpose: "TRAINING", kind: "CONTROL_TOKEN", followsRobots: true, inLogs: false },
  { token: "Bingbot", provider: "Microsoft", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: false },
  { token: "Applebot", provider: "Apple", purpose: "SEARCH", kind: "CRAWLER", followsRobots: true, inLogs: false },
  { token: "Applebot-Extended", provider: "Apple", purpose: "TRAINING", kind: "CONTROL_TOKEN", followsRobots: true, inLogs: false },
  { token: "Meta-ExternalAgent", provider: "Meta", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "Meta-ExternalFetcher", provider: "Meta", purpose: "USER_REQUEST", kind: "CRAWLER", followsRobots: false, inLogs: true },
  { token: "Amazonbot", provider: "Amazon", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "Bytespider", provider: "ByteDance", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "CCBot", provider: "Common Crawl", purpose: "TRAINING", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: "DuckAssistBot", provider: "DuckDuckGo", purpose: "USER_REQUEST", kind: "CRAWLER", followsRobots: true, inLogs: true },
  { token: TRAINING_POLICY_TOKEN, provider: "Shared", purpose: "TRAINING", kind: "POLICY_TOKEN", followsRobots: true, inLogs: false },
];

/** "OpenAI · GPTBot": the platform label stored for access-log rows. */
export function botLabel(bot: Pick<AiBot, "provider" | "token">): string {
  return bot.provider + " · " + bot.token;
}
