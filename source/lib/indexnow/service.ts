import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { fetchPublic, USER_AGENT } from "@/lib/crawler/engine";
import {
  generateIndexNowKey, groupSiteUrls, INDEXNOW_ENDPOINT, INDEXNOW_MAX_URLS, keyFileMatches, keyFileUrl,
  OUTCOME_MESSAGES, submissionBody, submissionOutcome, type SubmissionOutcome,
} from "./indexnow";

/*
 * IndexNow for one site: the key, checking the key file on the site, and
 * submitting URLs (the pages that changed in the latest crawl, or a list).
 * Every request is started by the user; nothing is sent on a schedule.
 */

type Db = PrismaClient;

export type IndexNowView = {
  domain: string;
  key: string | null;
  /** Where the key file has to answer: https://<domain>/<key>.txt */
  keyUrl: string | null;
  verifiedAt: string | null;
  last: { at: string; status: number | null; count: number | null; message: string | null } | null;
  /** Indexable pages new or changed in the latest crawl since the one before; null without a crawl. */
  changed: { count: number; crawlDate: string | null; firstCrawl: boolean } | null;
};

export type SubmitResult = {
  submitted: number;
  rejected: number;
  truncated: number;
  outcomes: { origin: string; count: number; status: number | null; outcome: SubmissionOutcome }[];
};

const stateSelect = { key: true, verifiedAt: true, lastSubmittedAt: true, lastStatus: true, lastCount: true, lastMessage: true } as const;
type State = { key: string; verifiedAt: Date | null; lastSubmittedAt: Date | null; lastStatus: number | null; lastCount: number | null; lastMessage: string | null };

async function ownedSite(db: Db, userId: string | undefined, siteId: string) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
  if (!site) throw new ContentError("Not found", 404);
  return site;
}

const siteOrigin = (domain: string) => `https://${domain.replace(/\/+$/, "")}`;

/** Indexable 200 pages of the latest crawl that are new or whose text changed since the crawl before it. */
async function changedPages(db: Db, siteId: string): Promise<{ urls: string[]; crawlDate: string | null; firstCrawl: boolean } | null> {
  const crawls = await db.crawl.findMany({
    where: { siteId, status: "COMPLETED" }, orderBy: [{ finishedAt: "desc" }, { id: "desc" }], take: 2,
    select: { id: true, finishedAt: true },
  }) as { id: string; finishedAt: Date | null }[];
  if (!crawls.length) return null;
  const latest = await db.auditPage.findMany({
    where: { crawlId: crawls[0].id, statusCode: 200, indexable: true },
    select: { url: true, contentHash: true }, orderBy: { url: "asc" }, take: INDEXNOW_MAX_URLS * 2,
  }) as { url: string; contentHash: string | null }[];
  const crawlDate = crawls[0].finishedAt?.toISOString().slice(0, 10) ?? null;
  if (!crawls[1]) return { urls: latest.map(p => p.url), crawlDate, firstCrawl: true };
  const before = new Map((await db.auditPage.findMany({
    where: { crawlId: crawls[1].id }, select: { url: true, contentHash: true },
  }) as { url: string; contentHash: string | null }[]).map(p => [p.url, p.contentHash] as const));
  const urls = latest.filter(p => !before.has(p.url) || (!!p.contentHash && before.get(p.url) !== p.contentHash)).map(p => p.url);
  return { urls, crawlDate, firstCrawl: false };
}

function view(domain: string, state: State | null, changed: Awaited<ReturnType<typeof changedPages>>): IndexNowView {
  return {
    domain,
    key: state?.key ?? null,
    keyUrl: state ? keyFileUrl(siteOrigin(domain), state.key) : null,
    verifiedAt: state?.verifiedAt?.toISOString() ?? null,
    last: state?.lastSubmittedAt ? { at: state.lastSubmittedAt.toISOString(), status: state.lastStatus, count: state.lastCount, message: state.lastMessage } : null,
    changed: changed ? { count: changed.urls.length, crawlDate: changed.crawlDate, firstCrawl: changed.firstCrawl } : null,
  };
}

export async function readIndexNow(db: Db, userId: string | undefined, siteId: string): Promise<IndexNowView> {
  const site = await ownedSite(db, userId, siteId);
  const [state, changed] = await Promise.all([
    db.indexNowState.findUnique({ where: { siteId }, select: stateSelect }) as Promise<State | null>,
    changedPages(db, siteId),
  ]);
  return view(site.domain, state, changed);
}

/** A new key; replaces the old one, which then stops working once its file is removed. */
export async function createIndexNowKey(db: Db, userId: string | undefined, siteId: string): Promise<IndexNowView> {
  await ownedSite(db, userId, siteId);
  const key = generateIndexNowKey();
  await db.indexNowState.upsert({
    where: { siteId },
    create: { siteId, key },
    update: { key, verifiedAt: null, lastSubmittedAt: null, lastStatus: null, lastCount: null, lastMessage: null },
  });
  return readIndexNow(db, userId, siteId);
}

/** The first `max` bytes of a body, as text. */
async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export type KeyCheck = { ok: boolean; status: number | null; finalUrl: string | null; reason: "MATCH" | "MISMATCH" | "HTTP_ERROR" | "UNREACHABLE" };

/** Fetches the key file from the site (the crawler's guarded fetch: public addresses only) and records whether it answers with the key. */
export async function verifyIndexNowKey(db: Db, userId: string | undefined, siteId: string): Promise<IndexNowView & { check: KeyCheck }> {
  const site = await ownedSite(db, userId, siteId);
  const state = await db.indexNowState.findUnique({ where: { siteId }, select: stateSelect }) as State | null;
  if (!state) throw new ContentError("Create a key first", 422);
  const url = keyFileUrl(siteOrigin(site.domain), state.key);
  let check: KeyCheck;
  try {
    const r = await fetchPublic(url, { "User-Agent": USER_AGENT, Accept: "text/plain" }, { signal: AbortSignal.timeout(15_000) });
    try {
      if (!r.res.ok) {
        await r.res.body?.cancel().catch(() => {});
        check = { ok: false, status: r.res.status, finalUrl: r.finalUrl, reason: "HTTP_ERROR" };
      } else {
        const matches = keyFileMatches(await readLimited(r.res, 1024), state.key);
        check = { ok: matches, status: r.res.status, finalUrl: r.finalUrl, reason: matches ? "MATCH" : "MISMATCH" };
      }
    } finally {
      r.done();
    }
  } catch {
    check = { ok: false, status: null, finalUrl: null, reason: "UNREACHABLE" };
  }
  await db.indexNowState.update({ where: { siteId }, data: { verifiedAt: check.ok ? new Date() : null } });
  return { ...(await readIndexNow(db, userId, siteId)), check };
}

const submitSchema = z.object({
  source: z.enum(["changed", "list"]),
  urls: z.array(z.string().max(2048)).max(INDEXNOW_MAX_URLS).optional(),
}).strict();

/**
 * Submits URLs: the pages that changed in the latest crawl, or the given
 * list. Needs a verified key, so engines do not reject the batch for a
 * missing file. One request per origin (with and without "www.").
 */
export async function submitIndexNow(
  db: Db, userId: string | undefined, siteId: string, body: unknown, fetcher: typeof fetch = fetch
): Promise<IndexNowView & { result: SubmitResult }> {
  const site = await ownedSite(db, userId, siteId);
  const input = submitSchema.parse(body);
  const state = await db.indexNowState.findUnique({ where: { siteId }, select: stateSelect }) as State | null;
  if (!state) throw new ContentError("Create a key first", 422);
  if (!state.verifiedAt) throw new ContentError("Verify the key file first", 422);
  const urls = input.source === "list" ? input.urls ?? [] : (await changedPages(db, siteId))?.urls ?? [];
  const { groups, rejected, truncated } = groupSiteUrls(urls, site.domain);
  if (!groups.size) throw new ContentError(input.source === "list" ? "No URLs of this site to submit" : "No new or changed pages in the latest crawl", 422);
  const outcomes: SubmitResult["outcomes"] = [];
  for (const [origin, list] of groups) {
    let status: number | null = null;
    try {
      const res = await fetcher(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(submissionBody(origin, state.key, list)),
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch {
      status = null;
    }
    outcomes.push({ origin, count: list.length, status, outcome: status === null ? "FAILED" : submissionOutcome(status) });
  }
  const submitted = outcomes.filter(o => o.outcome === "ACCEPTED" || o.outcome === "PENDING_KEY").reduce((sum, o) => sum + o.count, 0);
  const worst = outcomes.find(o => o.outcome !== "ACCEPTED" && o.outcome !== "PENDING_KEY") ?? outcomes[0];
  await db.indexNowState.update({
    where: { siteId },
    data: {
      lastSubmittedAt: new Date(), lastStatus: worst.status, lastCount: submitted,
      lastMessage: OUTCOME_MESSAGES[worst.outcome],
      // The engines no longer find the key file: ask for a new check.
      ...(worst.outcome === "KEY_INVALID" ? { verifiedAt: null } : {}),
    },
  });
  return { ...(await readIndexNow(db, userId, siteId)), result: { submitted, rejected, truncated, outcomes } };
}
