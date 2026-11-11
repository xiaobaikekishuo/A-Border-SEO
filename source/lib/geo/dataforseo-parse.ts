/*
 * Reading DataForSEO's AI Optimization and SERP responses into one shape: the
 * answer text and the URLs it cites. Pure functions; lib/geo/dataforseo-ai.ts
 * makes the requests. Field names follow DataForSEO's documentation (read
 * November 2026); anything unexpected is skipped rather than trusted.
 *
 *   LLM Scraper (ChatGPT, Gemini): result.markdown, result.sources[] and
 *     items[].sources[] (url, title, domain), search_results[] (consulted,
 *     not cited), fan_out_queries[].
 *   LLM Responses (Perplexity, Claude): items[type=message].sections[type=text]
 *     with text and annotations[] (title, url); search_results[] consulted.
 *   SERP (AI Overview in organic results, AI Mode): items[type=ai_overview]
 *     with markdown and references[] (url, title, source, domain).
 */

import { markdownLinks, normalizeCitations, type Citation } from "./visibility-rules";

export type ParsedAnswer = {
  status: "OK" | "NO_ANSWER";
  text: string;
  citations: Citation[];
  /** URLs the model looked at without citing them. */
  consulted: number;
  model: string | null;
  fanOut: string[];
  /** The site's position in the organic results of the same search (AI Overview checks only). */
  organicRank?: number | null;
};

export class DataForSeoError extends Error {
  constructor(readonly code: "AUTH" | "BALANCE" | "RATE_LIMIT" | "INVALID" | "API", message: string, readonly retryable = false) {
    super(message);
    this.name = "DataForSeoError";
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export const MAX_ANSWER_CHARS = 20_000;

/** DataForSEO's own explanation, short, for the run log ("Invalid Field: 'language_code'."). */
function explain(code: number, message: unknown): string {
  const text = typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  return text && text.toLowerCase() !== "ok." ? `${code}: ${text}` : String(code || "unknown");
}

/** The single task of a Live response, after checking the status codes. Returns its cost in USD too. */
export function liveTask(body: unknown): { result: Json | null; cost: number } {
  const root = obj(body);
  if (!root) throw new DataForSeoError("API", "Unreadable response");
  const code = Number(root.status_code);
  const why = explain(code, root.status_message);
  if (code === 40100) throw new DataForSeoError("AUTH", `DataForSEO refused the login (${why})`);
  if (code === 40200) throw new DataForSeoError("BALANCE", `DataForSEO balance is too low (${why})`);
  if (code === 40202) throw new DataForSeoError("RATE_LIMIT", `DataForSEO rate limit (${why})`, true);
  // 40101: the search engine or model failed on DataForSEO's side; a later attempt can work.
  if (code !== 20000) throw new DataForSeoError("API", `DataForSEO status ${why}`, code === 40101 || code >= 50000);
  const task = obj(arr(root.tasks)[0]);
  if (!task) throw new DataForSeoError("API", "Response without a task");
  const cost = Number(task.cost);
  const taskCode = Number(task.status_code);
  const taskWhy = explain(taskCode, task.status_message);
  // 40102: no results for the request. The check itself worked.
  if (taskCode === 40102) return { result: null, cost: Number.isFinite(cost) ? cost : 0 };
  if (taskCode === 40501 || taskCode === 40503) throw new DataForSeoError("INVALID", `DataForSEO rejected the request (${taskWhy})`);
  if (taskCode === 40200) throw new DataForSeoError("BALANCE", `DataForSEO balance is too low (${taskWhy})`);
  if (taskCode !== 20000) throw new DataForSeoError("API", `DataForSEO task status ${taskWhy}`, taskCode === 40101 || taskCode >= 50000);
  return { result: obj(arr(task.result)[0]), cost: Number.isFinite(cost) ? cost : 0 };
}

function strings(value: unknown, limit = 20): string[] {
  return arr(value).flatMap(v => (typeof v === "string" && v.trim() ? [v.trim().slice(0, 300)] : [])).slice(0, limit);
}

function sourceList(value: unknown): { url: string | null; title: string | null }[] {
  return arr(value).flatMap(v => {
    const o = obj(v);
    return o ? [{ url: str(o.url), title: str(o.title) ?? str(o.source_name) ?? str(o.source) }] : [];
  });
}

const clip = (text: string) => text.slice(0, MAX_ANSWER_CHARS);

/** ChatGPT and Gemini LLM Scraper (live/advanced). */
export function parseScraper(result: Json | null): ParsedAnswer {
  if (!result) return { status: "NO_ANSWER", text: "", citations: [], consulted: 0, model: null, fanOut: [] };
  const items = arr(result.items).map(obj).filter((i): i is Json => !!i);
  const text = str(result.markdown) ?? items.map(i => str(i.markdown) ?? str(i.original_text) ?? "").filter(Boolean).join("\n\n");
  const cited = [
    ...sourceList(result.sources),
    ...items.flatMap(i => sourceList(i.sources)),
    ...items.filter(i => typeof i.type === "string" && i.type.endsWith("_source")).map(i => ({ url: str(i.url), title: str(i.title) })),
  ];
  const citations = normalizeCitations(cited.length ? cited : markdownLinks(text ?? ""));
  return {
    status: text || citations.length ? "OK" : "NO_ANSWER",
    text: clip(text ?? ""),
    citations,
    consulted: arr(result.search_results).length,
    model: str(result.model),
    fanOut: strings(result.fan_out_queries),
  };
}

/** Perplexity and Claude LLM Responses (live). */
export function parseResponses(result: Json | null): ParsedAnswer {
  if (!result) return { status: "NO_ANSWER", text: "", citations: [], consulted: 0, model: null, fanOut: [] };
  const sections = arr(result.items).map(obj).filter((i): i is Json => !!i && i.type === "message")
    .flatMap(i => arr(i.sections).map(obj).filter((s): s is Json => !!s && s.type === "text"));
  const text = sections.map(s => str(s.text) ?? "").filter(Boolean).join("\n\n");
  const annotated = sections.flatMap(s => sourceList(s.annotations));
  const citations = normalizeCitations(annotated.length ? annotated : markdownLinks(text));
  return {
    status: text || citations.length ? "OK" : "NO_ANSWER",
    text: clip(text),
    citations,
    consulted: arr(result.search_results).length,
    model: str(result.model_name),
    fanOut: strings(result.fan_out_queries),
  };
}

/** The AI Overview of an organic results page, or an AI Mode page (serp/google/.../live/advanced). */
export function parseSerpAi(result: Json | null, ownDomains: readonly string[] = []): ParsedAnswer {
  const items = result ? arr(result.items).map(obj).filter((i): i is Json => !!i) : [];
  const overview = items.find(i => i.type === "ai_overview");
  let organicRank: number | null = null;
  for (const item of items) {
    if (item.type !== "organic") continue;
    const domain = (str(item.domain) ?? "").toLowerCase().replace(/^www\./, "");
    if (ownDomains.some(d => domain === d || domain.endsWith("." + d))) {
      const rank = Number(item.rank_group);
      if (Number.isFinite(rank)) { organicRank = rank; break; }
    }
  }
  if (!overview) return { status: "NO_ANSWER", text: "", citations: [], consulted: 0, model: null, fanOut: [], organicRank };
  const elements = arr(overview.items).map(obj).filter((i): i is Json => !!i);
  const text = str(overview.markdown) ?? elements.map(e => str(e.markdown) ?? str(e.text) ?? "").filter(Boolean).join("\n\n");
  const references = [...sourceList(overview.references), ...elements.flatMap(e => sourceList(e.references))];
  return {
    status: "OK",
    text: clip(text ?? ""),
    citations: normalizeCitations(references.length ? references : markdownLinks(text ?? "")),
    consulted: 0,
    model: null,
    fanOut: [],
    organicRank,
  };
}

export type LlmModel = { name: string; webSearch: boolean; reasoning: boolean };

/** Models from a .../llm_responses/models response, as listed. */
export function parseModels(body: unknown): LlmModel[] {
  const task = obj(arr(obj(body)?.tasks)[0]);
  return arr(task?.result).flatMap(r => {
    const o = obj(r);
    const name = str(o?.model_name);
    // Listed without the flag: treat as unknown, not as unsupported.
    return name ? [{ name, webSearch: o?.web_search_supported !== false, reasoning: o?.reasoning === true }] : [];
  });
}
