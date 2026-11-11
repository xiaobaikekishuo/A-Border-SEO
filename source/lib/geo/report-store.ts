import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { REPORT_KEEP, reportUrl, type AiReport, type ReportKind } from "./reports";

/*
 * The imported AI reports (Search Console generative AI, Bing AI
 * Performance), one GeoSnapshot per kind. The browser parses the export
 * (lib/geo/reports.ts); this checks the result again before it is kept.
 */

export type StoredAiReport = AiReport & { truncated: number; ignored: string[]; updatedAt: string };
export type AiReports = Record<ReportKind, StoredAiReport | null>;

const value = z.number().min(0).max(1e12);
const label = z.string().trim().min(1).max(100);
const reportSchema = z.object({
  kind: z.enum(["GSC_AI", "BING_AI"]),
  daily: z.array(z.object({ day: z.iso.date(), value, pages: z.number().min(0).max(1e9).nullable() }).strict()).max(REPORT_KEEP.daily),
  pages: z.array(z.object({ url: z.string().min(1).max(2048), value }).strict()).max(REPORT_KEEP.pages),
  queries: z.array(z.object({
    query: z.string().min(1).max(500), value, share: z.number().min(0).max(1).nullable(),
    intent: z.string().max(60).nullable(), topic: z.string().max(120).nullable(),
  }).strict()).max(REPORT_KEEP.queries),
  countries: z.array(z.object({ name: label, value }).strict()).max(REPORT_KEEP.countries),
  devices: z.array(z.object({ name: label, value }).strict()).max(REPORT_KEEP.devices),
  tables: z.array(z.enum(["DAILY", "PAGES", "QUERIES", "COUNTRIES", "DEVICES"])).min(1).max(5),
  skipped: z.number().int().min(0).max(1e7),
  truncated: z.number().int().min(0).max(1e7),
  ignored: z.array(z.string().max(200)).max(40),
  expectedUpdatedAt: z.iso.datetime().nullable(),
}).strict();

type Db = PrismaClient;

async function ownedSite(db: Db, userId: string | undefined, siteId: string) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } }) as { id: string; domain: string } | null;
  if (!site) throw new ContentError("Unknown site", 404);
  return site;
}

export async function loadAiReports(db: Db, siteId: string): Promise<AiReports> {
  const rows = await db.geoSnapshot.findMany({ where: { siteId, kind: { in: ["GSC_AI", "BING_AI"] } } }) as { kind: string; report: unknown; updatedAt: Date }[];
  const out: AiReports = { GSC_AI: null, BING_AI: null };
  for (const row of rows) {
    if (row.kind === "GSC_AI" || row.kind === "BING_AI") out[row.kind] = { ...(row.report as Omit<StoredAiReport, "updatedAt">), updatedAt: row.updatedAt.toISOString() };
  }
  return out;
}

export async function readAiReports(db: Db, userId: string | undefined, siteId: string): Promise<AiReports> {
  await ownedSite(db, userId, siteId);
  return loadAiReports(db, siteId);
}

/** Checks a parsed report against the site and saves it in place of the one before (optimistic: expectedUpdatedAt). */
export async function saveAiReport(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<AiReports> {
  const site = await ownedSite(db, userId, siteId);
  const { expectedUpdatedAt, ...input } = reportSchema.parse(body);
  if (input.pages.some(p => reportUrl(p.url, site.domain) !== p.url)) throw new ContentError("Report pages must belong to this site", 422);
  const days = input.daily.map(d => d.day);
  if (days.some((day, i) => i > 0 && day <= days[i - 1])) throw new ContentError("Report days must be unique and in order", 422);
  if (!input.daily.length && !input.pages.length && !input.queries.length) throw new ContentError("The report has no rows", 422);
  if (input.kind === "GSC_AI" && input.daily.some(d => d.pages !== null)) throw new ContentError("Cited pages belong to the Bing report", 422);
  const report: Omit<StoredAiReport, "updatedAt"> = { ...input, start: days[0] ?? null, end: days[days.length - 1] ?? null };
  const kind = input.kind;
  if (expectedUpdatedAt === null) {
    const inserted = await db.geoSnapshot.createMany({
      data: [{ siteId: site.id, kind, report, updatedAt: new Date() }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) throw new ContentError("The saved report changed. Reload before saving.", 409);
  } else {
    const prior = new Date(expectedUpdatedAt);
    const saved = await db.geoSnapshot.updateMany({
      where: { siteId: site.id, kind, updatedAt: prior },
      data: { report, updatedAt: new Date(Math.max(Date.now(), prior.getTime() + 1)) },
    }) as { count: number };
    if (saved.count !== 1) throw new ContentError("The saved report changed. Reload before saving.", 409);
  }
  return loadAiReports(db, site.id);
}

export async function deleteAiReport(db: Db, userId: string | undefined, siteId: string, kind: string): Promise<AiReports> {
  const site = await ownedSite(db, userId, siteId);
  if (kind !== "GSC_AI" && kind !== "BING_AI") throw new ContentError("Unknown report", 400);
  await db.geoSnapshot.deleteMany({ where: { siteId: site.id, kind } });
  return loadAiReports(db, site.id);
}
