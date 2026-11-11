import type { ResearchMarket } from "@/lib/dataforseo/market";
import { DataForSeoError, liveTask, parseModels, parseResponses, parseScraper, parseSerpAi, type LlmModel, type ParsedAnswer } from "./dataforseo-parse";
import { TASK_ESTIMATE_USD } from "./costs";
import { geoPlatform, type AnswerSource, type GeoPlatformId } from "./platforms";

/*
 * Asking one platform one prompt through DataForSEO's Live endpoints, with the
 * user's own DataForSEO login. Each call is one paid task; its cost as
 * DataForSEO reports it comes back with the answer.
 */

export type DfsCredentials = { login: string; password: string };
type Endpoint = Extract<AnswerSource, { kind: "DATAFORSEO" }>["endpoint"];

const BASE = "https://api.dataforseo.com/v3";
const PATHS: Record<Endpoint, string> = {
  CHATGPT_SCRAPER: "/ai_optimization/chat_gpt/llm_scraper/live/advanced",
  GEMINI_SCRAPER: "/ai_optimization/gemini/llm_scraper/live/advanced",
  GOOGLE_AI_OVERVIEW: "/serp/google/organic/live/advanced",
  GOOGLE_AI_MODE: "/serp/google/ai_mode/live/advanced",
  PERPLEXITY_RESPONSES: "/ai_optimization/perplexity/llm_responses/live",
  CLAUDE_RESPONSES: "/ai_optimization/claude/llm_responses/live",
};
const CLAUDE_MODELS_PATH = "/ai_optimization/claude/llm_responses/models";

export { TASK_ESTIMATE_USD };

/** A live task can take up to two minutes on DataForSEO's side. */
export const TASK_TIMEOUT_MS = 180_000;
export const MAX_PROMPT_CHARS = 500;

/** DataForSEO location codes of the research markets, as ISO 3166-1 alpha-2. */
const COUNTRY: Record<number, string> = {
  2840: "US", 2826: "GB", 2124: "CA", 2036: "AU", 2702: "SG", 2344: "HK", 2158: "TW", 2392: "JP", 2276: "DE", 2250: "FR",
};
export function countryIso(location: number): string | null {
  return COUNTRY[location] ?? null;
}

/** Version numbers in a model name ("claude-haiku-4-5" -> [4, 5]); 8-digit snapshot dates are not versions. */
function versionOf(name: string): number[] {
  return name.split(/[^0-9]+/).filter(part => part && part.length < 8).map(Number);
}
function newerFirst(a: LlmModel, b: LlmModel): number {
  const va = versionOf(a.name), vb = versionOf(b.name);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d) return d;
  }
  // An alias without a date follows the newest snapshot.
  return Number(/\d{8}/.test(a.name)) - Number(/\d{8}/.test(b.name)) || a.name.localeCompare(b.name);
}

/**
 * The model for Claude tasks: the newest Haiku that can search the web (the
 * cheapest family), else the newest Sonnet, else any model with web search.
 * Null when none can search: an answer without the web says nothing about
 * citations.
 */
export function pickClaudeModel(models: readonly LlmModel[]): string | null {
  const searching = models.filter(m => m.webSearch);
  for (const family of [/haiku/i, /sonnet/i, /./]) {
    const match = searching.filter(m => family.test(m.name)).sort(newerFirst)[0];
    if (match) return match.name;
  }
  return null;
}

export type AskInput = {
  platform: GeoPlatformId;
  prompt: string;
  market: ResearchMarket;
  /** The site's domains, to find its organic rank next to an AI Overview. */
  ownDomains: readonly string[];
  claudeModel?: string | null;
};
export type AskResult = ParsedAnswer & { cost: number };

function endpointOf(platform: GeoPlatformId): Endpoint {
  const answers = geoPlatform(platform)?.answers;
  if (!answers || answers.kind !== "DATAFORSEO") throw new DataForSeoError("INVALID", `${platform} cannot be asked through DataForSEO`);
  return answers.endpoint;
}

/** The task body for one prompt. Exported for tests. */
export function taskBody(input: AskInput): Record<string, unknown> {
  const endpoint = endpointOf(input.platform);
  const keyword = input.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const market = { location_code: input.market.location, language_code: input.market.language };
  switch (endpoint) {
    case "CHATGPT_SCRAPER": return { keyword, ...market, force_web_search: true };
    case "GEMINI_SCRAPER": return { keyword, ...market };
    case "GOOGLE_AI_OVERVIEW": return { keyword, ...market, device: "desktop", load_async_ai_overview: true };
    case "GOOGLE_AI_MODE": return { keyword, ...market, device: "desktop" };
    case "PERPLEXITY_RESPONSES": {
      const country = countryIso(input.market.location);
      return { user_prompt: keyword, model_name: "sonar", ...(country && { web_search_country_iso_code: country }) };
    }
    case "CLAUDE_RESPONSES": {
      if (!input.claudeModel) throw new DataForSeoError("INVALID", "No Claude model with web search is available");
      const country = countryIso(input.market.location);
      return { user_prompt: keyword, model_name: input.claudeModel, web_search: true, ...(country && { web_search_country_iso_code: country }) };
    }
  }
}

async function call(credentials: DfsCredentials, path: string, init: { method: "GET" | "POST"; body?: unknown }, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<unknown> {
  const timeout = AbortSignal.timeout(TASK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetcher(BASE + path, {
      method: init.method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64"),
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DataForSeoError("API", timeout.aborted ? "DataForSEO did not answer in time" : "Could not reach DataForSEO", true);
  }
  if (res.status === 401) throw new DataForSeoError("AUTH", "DataForSEO refused the login (HTTP 401)");
  if (res.status === 402) throw new DataForSeoError("BALANCE", "DataForSEO balance is too low (HTTP 402)");
  if (res.status === 429) throw new DataForSeoError("RATE_LIMIT", "DataForSEO rate limit (HTTP 429)", true);
  if (!res.ok) throw new DataForSeoError("API", `DataForSEO HTTP ${res.status}`, res.status >= 500);
  try {
    return await res.json();
  } catch {
    throw new DataForSeoError("API", "Unreadable DataForSEO response", true);
  }
}

/** One prompt on one platform. Throws DataForSeoError for anything but an answer or "no answer". */
export async function askPlatform(credentials: DfsCredentials, input: AskInput, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AskResult> {
  const endpoint = endpointOf(input.platform);
  const body = await call(credentials, PATHS[endpoint], { method: "POST", body: [taskBody(input)] }, signal, fetcher);
  const { result, cost } = liveTask(body);
  const parsed = endpoint === "CHATGPT_SCRAPER" || endpoint === "GEMINI_SCRAPER" ? parseScraper(result)
    : endpoint === "PERPLEXITY_RESPONSES" || endpoint === "CLAUDE_RESPONSES" ? parseResponses(result)
    : parseSerpAi(result, input.ownDomains);
  return { ...parsed, model: parsed.model ?? (endpoint === "CLAUDE_RESPONSES" ? input.claudeModel ?? null : null), cost };
}

/** The Claude models DataForSEO offers, with whether each can search the web. */
export async function claudeModels(credentials: DfsCredentials, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<LlmModel[]> {
  return parseModels(await call(credentials, CLAUDE_MODELS_PATH, { method: "GET" }, signal, fetcher));
}
