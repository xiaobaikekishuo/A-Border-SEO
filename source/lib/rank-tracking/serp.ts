import type { DfsCredentials } from "@/lib/geo/dataforseo-ai";
import { DataForSeoError } from "@/lib/geo/dataforseo-parse";
import { domainMatches, normalizeDomain } from "@/lib/geo/visibility-rules";

/*
 * Google rank checks through DataForSEO's standard queue (SERP API, Google
 * organic): task_post sends up to 100 tasks per call and is the only paid
 * step; tasks_ready lists finished tasks not collected yet; task_get/advanced
 * reads one result. Field names follow DataForSEO's documentation (read
 * November 2026). The parsers are pure and exported for tests; anything
 * unexpected in a response is skipped rather than trusted.
 */

const BASE = "https://api.dataforseo.com/v3/serp/google/organic";
/** Tasks per task_post call, DataForSEO's limit. */
export const POST_BATCH = 100;
const TIMEOUT_MS = 60_000;
const TOP_RESULTS = 10;
const MAX_FEATURES = 20;

export type Device = "desktop" | "mobile";
export type RankTaskInput = {
  /** Our id for the task (RankCheck.id), echoed back by DataForSEO as `tag`. */
  tag: string;
  keyword: string;
  language: string;
  location: number;
  device: Device;
  depth: number;
  aiOverview: boolean;
};
export type PostedTask = { tag: string; id: string | null; cost: number; error: string | null };
export type TopResult = { rank: number; domain: string; url: string; title: string | null };
export type SerpReading = {
  position: number | null;
  absolute: number | null;
  url: string | null;
  aiOverview: boolean | null;
  aiCited: boolean | null;
  features: string[];
  top: TopResult[];
  checkedAt: Date | null;
};
export type TaskOutcome =
  | { state: "PENDING" }
  | { state: "OK"; reading: SerpReading }
  | { state: "FAILED"; error: string };
export type ReadyTask = { id: string; tag: string | null };

/**
 * A task_post call that may have created its tasks although no readable
 * answer came back (a timeout after sending, a server error). Posting the
 * same tasks again could pay twice, so the caller waits for them to show up
 * in tasks_ready under their tags instead.
 */
export class AmbiguousPostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPostError";
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const posInt = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function explain(code: number, message: unknown): string {
  const text = typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  return text && text.toLowerCase() !== "ok." ? `${code}: ${text}` : String(code || "unknown");
}

/** DataForSEO decodes the keyword it is sent, so a literal % or + must be encoded. */
export function encodeKeyword(keyword: string): string {
  return keyword.replace(/%/g, "%25").replace(/\+/g, "%2B");
}

/** Search operators (site:, intitle: ...) cost five times as much and say nothing about a ranking. */
export function hasSearchOperator(keyword: string): boolean {
  return /(^|\s)-?(site|intitle|allintitle|inurl|allinurl|intext|allintext|filetype|ext|related|cache|link|inanchor|before|after):/i.test(keyword);
}

/** The task body for one keyword. */
export function taskBody(input: RankTaskInput): Record<string, unknown> {
  return {
    keyword: encodeKeyword(input.keyword),
    location_code: input.location,
    language_code: input.language,
    device: input.device,
    depth: input.depth,
    tag: input.tag,
    ...(input.aiOverview && { load_async_ai_overview: true }),
  };
}

/** The status of a whole response; throws for a refused login, an empty balance or a rate limit. */
function checkRoot(body: unknown): Json {
  const root = obj(body);
  if (!root) throw new DataForSeoError("API", "Unreadable DataForSEO response", true);
  const code = Number(root.status_code);
  const why = explain(code, root.status_message);
  if (code === 40100) throw new DataForSeoError("AUTH", `DataForSEO refused the login (${why})`);
  if (code === 40200) throw new DataForSeoError("BALANCE", `DataForSEO balance is too low (${why})`);
  if (code === 40202) throw new DataForSeoError("RATE_LIMIT", `DataForSEO rate limit (${why})`, true);
  if (code !== 20000) throw new DataForSeoError("API", `DataForSEO status ${why}`, code >= 50000);
  return root;
}

/** One entry per tag sent, in the order sent: the task id and cost, or why it was not created. */
export function parsePosted(body: unknown, tags: readonly string[]): PostedTask[] {
  const root = checkRoot(body);
  const byTag = new Map<string, PostedTask>();
  for (const value of arr(root.tasks)) {
    const task = obj(value);
    if (!task) continue;
    const tag = str(obj(task.data)?.tag);
    if (!tag || !tags.includes(tag) || byTag.has(tag)) continue;
    const code = Number(task.status_code);
    const cost = Number(task.cost);
    const id = str(task.id);
    if (code === 20100 && id && id.length <= 64) {
      byTag.set(tag, { tag, id, cost: Number.isFinite(cost) && cost >= 0 ? cost : 0, error: null });
    } else {
      if (code === 40200) throw new DataForSeoError("BALANCE", `DataForSEO balance is too low (${explain(code, task.status_message)})`);
      byTag.set(tag, { tag, id: null, cost: 0, error: `DataForSEO did not create the task (${explain(code, task.status_message)})` });
    }
  }
  return tags.map(tag => byTag.get(tag) ?? { tag, id: null, cost: 0, error: "DataForSEO did not answer for this task" });
}

/** The finished tasks DataForSEO lists as not collected yet. */
export function parseReady(body: unknown): ReadyTask[] {
  const root = checkRoot(body);
  const out: ReadyTask[] = [];
  for (const value of arr(root.tasks)) {
    const task = obj(value);
    if (!task || Number(task.status_code) !== 20000) continue;
    for (const item of arr(task.result)) {
      const row = obj(item);
      const id = str(row?.id);
      if (id) out.push({ id, tag: str(row?.tag) });
    }
  }
  return out;
}

/** "2026-11-19 08:30:12 +00:00" as a Date, or null. */
export function serpTime(value: unknown): Date | null {
  const text = str(value);
  const m = text?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+00:00$/);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ownsDomain(domain: string | null, ownDomains: readonly string[]): boolean {
  return !!domain && ownDomains.some(d => domainMatches(domain, d));
}

/**
 * Where the site stands in one results page: its first organic result
 * (rank_group counts organic results only; rank_absolute counts everything on
 * the page), the first ten organic results, the other result types shown, and
 * the AI Overview: whether the page had one, and when it was loaded whether
 * it cites the site.
 */
export function readSerp(result: Json | null, ownDomains: readonly string[], aiLoaded: boolean): SerpReading {
  const items = result ? arr(result.items).map(obj).filter((i): i is Json => !!i) : [];
  let own: { position: number; absolute: number | null; url: string } | null = null;
  const top: TopResult[] = [];
  for (const item of items) {
    if (item.type !== "organic") continue;
    const rank = posInt(item.rank_group);
    const url = str(item.url);
    const domain = normalizeDomain(str(item.domain) ?? url ?? "");
    if (!rank || !url || !domain || url.length > 2048) continue;
    if (top.length < TOP_RESULTS) top.push({ rank, domain, url, title: str(item.title)?.slice(0, 200) ?? null });
    if (!own && ownsDomain(domain, ownDomains)) own = { position: rank, absolute: posInt(item.rank_absolute), url };
  }
  const types = new Set<string>();
  for (const type of [...arr(result?.item_types), ...items.map(i => i.type)]) {
    if (typeof type === "string" && /^[a-z_]{1,40}$/.test(type) && type !== "organic") types.add(type);
  }
  const overview = items.find(i => i.type === "ai_overview");
  let aiCited: boolean | null = null;
  if (overview && aiLoaded) {
    const elements = arr(overview.items).map(obj).filter((e): e is Json => !!e);
    const references = [...arr(overview.references), ...elements.flatMap(e => arr(e.references))].map(obj).filter((r): r is Json => !!r);
    const loaded = elements.length > 0 || references.length > 0 || !!str(overview.markdown);
    aiCited = loaded ? references.some(r => ownsDomain(normalizeDomain(str(r.domain) ?? str(r.url) ?? ""), ownDomains)) : null;
  }
  return {
    position: own?.position ?? null,
    absolute: own?.absolute ?? null,
    url: own?.url ?? null,
    aiOverview: result ? types.has("ai_overview") : null,
    aiCited,
    features: [...types].sort().slice(0, MAX_FEATURES),
    top,
    checkedAt: serpTime(result?.datetime),
  };
}

/** One task_get/advanced answer: still queued, read, or failed for good. */
export function parseTaskGet(body: unknown, ownDomains: readonly string[], aiLoaded: boolean): TaskOutcome {
  const root = checkRoot(body);
  const task = obj(arr(root.tasks)[0]);
  if (!task) throw new DataForSeoError("API", "Response without a task", true);
  const code = Number(task.status_code);
  // Received but not queued yet, or queued: ask again later.
  if (code === 40601 || code === 40602) return { state: "PENDING" };
  // Google answered with no results at all: the check worked and the site is not there.
  if (code === 40102) return { state: "OK", reading: readSerp(null, ownDomains, aiLoaded) };
  if (code !== 20000) return { state: "FAILED", error: `DataForSEO task status ${explain(code, task.status_message)}` };
  return { state: "OK", reading: readSerp(obj(arr(task.result)[0]), ownDomains, aiLoaded) };
}

async function call(credentials: DfsCredentials, path: string, init: { method: "GET" | "POST"; body?: unknown }, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const posting = init.method === "POST";
  let res: Response;
  try {
    res = await fetcher(BASE + path, {
      method: init.method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64"),
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // A post that timed out may have reached DataForSEO; one that could not connect did not.
    if (posting && timeout.aborted) throw new AmbiguousPostError("DataForSEO did not answer the post in time");
    throw new DataForSeoError("API", timeout.aborted ? "DataForSEO did not answer in time" : "Could not reach DataForSEO", true);
  }
  if (res.status === 401) throw new DataForSeoError("AUTH", "DataForSEO refused the login (HTTP 401)");
  if (res.status === 402) throw new DataForSeoError("BALANCE", "DataForSEO balance is too low (HTTP 402)");
  if (res.status === 429) throw new DataForSeoError("RATE_LIMIT", "DataForSEO rate limit (HTTP 429)", true);
  if (!res.ok) {
    if (posting && res.status >= 500) throw new AmbiguousPostError(`DataForSEO HTTP ${res.status} while posting`);
    throw new DataForSeoError("API", `DataForSEO HTTP ${res.status}`, res.status >= 500);
  }
  try {
    return await res.json();
  } catch {
    if (posting) throw new AmbiguousPostError("Unreadable DataForSEO answer to the post");
    throw new DataForSeoError("API", "Unreadable DataForSEO response", true);
  }
}

/** Posts up to POST_BATCH tasks; the only paid call. */
export async function postTasks(credentials: DfsCredentials, inputs: readonly RankTaskInput[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<PostedTask[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > POST_BATCH) throw new Error(`At most ${POST_BATCH} tasks per post`);
  const body = await call(credentials, "/task_post", { method: "POST", body: inputs.map(taskBody) }, signal, fetcher);
  return parsePosted(body, inputs.map(i => i.tag));
}

/** Finished tasks of this DataForSEO account not collected yet (up to 1000; free). */
export async function readyTasks(credentials: DfsCredentials, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ReadyTask[]> {
  return parseReady(await call(credentials, "/tasks_ready", { method: "GET" }, signal, fetcher));
}

/** One task's result (free). */
export async function getTask(credentials: DfsCredentials, id: string, ownDomains: readonly string[], aiLoaded: boolean, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<TaskOutcome> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return { state: "FAILED", error: "Unreadable task id" };
  return parseTaskGet(await call(credentials, `/task_get/advanced/${id}`, { method: "GET" }, signal, fetcher), ownDomains, aiLoaded);
}
