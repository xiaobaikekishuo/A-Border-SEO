import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import type { ResearchMarket } from "./market";

/*
 * The live DataForSEO Labs catalog of countries and languages
 * (GET /v3/dataforseo_labs/locations_and_languages, free of charge). Saving
 * a research market checks the pair here when the user has a DataForSEO
 * login, so a pair the provider does not offer is caught before the first
 * paid request fails on it. The catalog changes rarely; one copy is kept
 * for a day.
 */

const CATALOG_URL = "https://api.dataforseo.com/v3/dataforseo_labs/locations_and_languages";
const TTL_MS = 24 * 3_600_000;

export type LabsCatalog = Map<number, Set<string>>;
export type MarketSupport = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

let cache: { at: number; catalog: LabsCatalog } | null = null;

/** Location code → language codes with Google data, from the catalog response; null when it is not one. */
export function parseLabsCatalog(body: unknown): LabsCatalog | null {
  const task = (body as { tasks?: { status_code?: number; result?: unknown[] | null }[] } | null)?.tasks?.[0];
  if (!task || task.status_code !== 20000 || !Array.isArray(task.result)) return null;
  const catalog: LabsCatalog = new Map();
  for (const item of task.result) {
    const location = item as { location_code?: unknown; available_languages?: unknown };
    if (typeof location.location_code !== "number" || !Array.isArray(location.available_languages)) continue;
    const languages = new Set<string>();
    for (const entry of location.available_languages) {
      const language = entry as { language_code?: unknown; available_sources?: unknown };
      if (typeof language.language_code !== "string") continue;
      // Entries list the search engines they hold data for; research here uses Google's.
      if (Array.isArray(language.available_sources) && !language.available_sources.includes("google")) continue;
      languages.add(language.language_code);
    }
    catalog.set(location.location_code, languages);
  }
  return catalog.size ? catalog : null;
}

export function marketSupport(catalog: LabsCatalog | null, market: ResearchMarket): MarketSupport {
  if (!catalog) return "UNKNOWN";
  return catalog.get(market.location)?.has(market.language) ? "SUPPORTED" : "UNSUPPORTED";
}

async function fetchCatalog(login: string, password: string, fetcher: typeof fetch): Promise<LabsCatalog | null> {
  const res = await fetcher(CATALOG_URL, {
    headers: { Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64") },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return parseLabsCatalog(await res.json().catch(() => null));
}

/**
 * Whether the user's DataForSEO account offers this market. UNKNOWN without
 * a login or when the catalog cannot be read: the save then goes ahead, as
 * it did before this check.
 */
export async function checkMarket(userId: string, market: ResearchMarket, fetcher: typeof fetch = fetch, now = Date.now()): Promise<MarketSupport> {
  if (cache && now - cache.at < TTL_MS) return marketSupport(cache.catalog, market);
  try {
    const key = await db.apiKey.findUnique({ where: { userId_provider: { userId, provider: "dataforseo" } } });
    if (!key?.encryptedLogin) return "UNKNOWN";
    const catalog = await fetchCatalog(decrypt(key.encryptedLogin), decrypt(key.encryptedPassword), fetcher);
    if (!catalog) return "UNKNOWN";
    cache = { at: now, catalog };
    return marketSupport(catalog, market);
  } catch {
    return "UNKNOWN";
  }
}

/** Test hook: forget the cached catalog. */
export function resetLabsCatalogCache(): void {
  cache = null;
}
