import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { ownedSite } from "@/lib/content-planner/data";
import { fetchPublic, USER_AGENT } from "@/lib/crawler/engine";
import { normalizeSourceUrl, sourceKey } from "./source-url";

/*
 * Trusted sources of one site: external pages an AI draft may link to as the
 * source of a claim (lib/ai-workbench/link-review.ts). Entries are exact
 * pages. A whole domain would let the model invent deep links that look
 * trusted, and the model cannot open pages to check them.
 * Nothing is fetched unless the owner asks to check an entry.
 */

type Db = PrismaClient;
export const MAX_TRUSTED_SOURCES = 300;
/** Sources given to one task, and the characters of JSON they may take in its evidence. */
export const TASK_SOURCES = 20;
const TASK_SOURCE_CHARS = 6_000;

export type TrustedSourceView = {
  id: string; url: string; title: string | null; note: string | null;
  checkedAt: string | null; lastStatus: number | null; createdAt: string;
};
const select = { id: true, url: true, title: true, note: true, checkedAt: true, lastStatus: true, createdAt: true } as const;
type Row = { id: string; url: string; title: string | null; note: string | null; checkedAt: Date | null; lastStatus: number | null; createdAt: Date };
const view = (row: Row): TrustedSourceView => ({ ...row, checkedAt: row.checkedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() });

async function rows(db: Db, siteId: string): Promise<TrustedSourceView[]> {
  const found: Row[] = await db.trustedSource.findMany({ where: { siteId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_TRUSTED_SOURCES, select });
  return found.map(view);
}

export async function listTrustedSources(db: Db, userId: string | undefined | null, siteId: string): Promise<TrustedSourceView[]> {
  await ownedSite(db, userId, siteId);
  return rows(db, siteId);
}

const addSchema = z.object({
  sources: z.array(z.object({
    url: z.string().trim().min(1).max(2048),
    title: z.string().trim().max(200).optional(),
    note: z.string().trim().max(300).optional(),
  }).strict()).min(1).max(100),
}).strict();

export type AddResult = { added: number; existing: number; invalid: string[]; full: boolean; sources: TrustedSourceView[] };

/** Adds pages; a page already in the list (http/https, www, trailing slash aside) is counted, not added twice. */
export async function addTrustedSources(db: Db, userId: string | undefined | null, siteId: string, raw: unknown): Promise<AddResult> {
  await ownedSite(db, userId, siteId);
  const { sources } = addSchema.parse(raw);
  const current: { url: string }[] = await db.trustedSource.findMany({ where: { siteId }, select: { url: true } });
  const keys = new Set(current.map(row => sourceKey(row.url)));
  const data: { siteId: string; url: string; title: string | null; note: string | null }[] = [];
  const invalid: string[] = [];
  let existing = 0;
  let full = false;
  for (const entry of sources) {
    const url = normalizeSourceUrl(entry.url);
    if (!url) { if (invalid.length < 20) invalid.push(entry.url.slice(0, 200)); continue; }
    const key = sourceKey(url);
    if (keys.has(key)) { existing++; continue; }
    if (current.length + data.length >= MAX_TRUSTED_SOURCES) { full = true; continue; }
    keys.add(key);
    data.push({ siteId, url, title: entry.title || null, note: entry.note || null });
  }
  if (data.length) await db.trustedSource.createMany({ data, skipDuplicates: true });
  return { added: data.length, existing, invalid, full, sources: await rows(db, siteId) };
}

export async function removeTrustedSource(db: Db, userId: string | undefined | null, siteId: string, id: string): Promise<TrustedSourceView[]> {
  await ownedSite(db, userId, siteId);
  await db.trustedSource.deleteMany({ where: { id, siteId } });
  return rows(db, siteId);
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/** The <title> of an HTML page, entities decoded and whitespace collapsed; null without one. */
export function pageTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = match[1]
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : null;
}

export type SourceCheck = { status: number | null; finalUrl: string | null; title: string | null };

/**
 * Opens the page once, through the crawler's guarded fetch (public addresses
 * only), and records its status. An empty title is filled from the page.
 */
export async function checkTrustedSource(db: Db, userId: string | undefined | null, siteId: string, id: string, fetcher: typeof fetchPublic = fetchPublic): Promise<{ check: SourceCheck; sources: TrustedSourceView[] }> {
  await ownedSite(db, userId, siteId);
  const row = await db.trustedSource.findFirst({ where: { id, siteId }, select: { id: true, url: true, title: true } });
  if (!row) throw new ContentError("Source not found", 404);
  let check: SourceCheck = { status: null, finalUrl: null, title: null };
  try {
    const r = await fetcher(row.url, { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" }, { signal: AbortSignal.timeout(15_000) });
    try {
      const html = r.res.ok && /html/i.test(r.res.headers.get("content-type") ?? "") ? await readLimited(r.res, 64 * 1024) : "";
      if (!html) await r.res.body?.cancel().catch(() => {});
      check = { status: r.res.status, finalUrl: r.finalUrl, title: pageTitle(html) };
    } finally {
      r.done();
    }
  } catch {
    // Not reachable: the status stays null.
  }
  await db.trustedSource.updateMany({ where: { id: row.id, siteId }, data: {
    checkedAt: new Date(), lastStatus: check.status, ...(!row.title && check.title ? { title: check.title } : {}),
  } });
  return { check, sources: await rows(db, siteId) };
}

/** Words of a task, for ranking sources: Latin words of three or more letters, and pairs of Chinese characters. */
function searchTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const words = (lower.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !/\p{Script=Han}/u.test(word));
  const pairs = (lower.match(/\p{Script=Han}+/gu) ?? []).flatMap(run => Array.from({ length: Math.max(0, run.length - 1) }, (_, i) => run.slice(i, i + 2)));
  return [...new Set([...words, ...pairs])];
}

/**
 * The sources given to a task: those sharing the most words with the task
 * first, then the newest, at most TASK_SOURCES and TASK_SOURCE_CHARS of JSON.
 */
export async function trustedSourcesFor(db: Prisma.TransactionClient | Db, siteId: string, about: string): Promise<{ url: string; title: string | null; note: string | null }[]> {
  type Source = { url: string; title: string | null; note: string | null };
  const found: Source[] = await db.trustedSource.findMany({ where: { siteId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_TRUSTED_SOURCES, select: { url: true, title: true, note: true } });
  const terms = searchTerms(about);
  const ranked: { row: Source; index: number; score: number }[] = found.map((row, index) => {
    const haystack = `${row.title ?? ""} ${row.note ?? ""} ${row.url}`.toLowerCase();
    return { row, index, score: terms.filter(term => haystack.includes(term)).length };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: Source[] = [];
  let chars = 2;
  for (const { row } of ranked) {
    if (picked.length >= TASK_SOURCES) break;
    const entry = { url: row.url, title: row.title, note: row.note };
    const size = JSON.stringify(entry).length + 1;
    if (chars + size > TASK_SOURCE_CHARS) continue;
    picked.push(entry);
    chars += size;
  }
  return picked;
}
