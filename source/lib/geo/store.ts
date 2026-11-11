import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { BOT_PLATFORMS, REFERRAL_PLATFORMS, normalizeGeoPath } from "./import";
import type { GeoKind, GeoRow, GeoSnapshot, GeoWorkspace } from "./types";

const row = z.object({
  day: z.iso.date(),
  platform: z.string().min(1).max(100),
  path: z.string().min(1).max(2048),
  count: z.number().int().min(0).max(2_147_483_647),
}).strict();
const sourceCounts = {
  rows: z.array(row).max(10000),
  skipped: z.number().int().min(0).max(10000000),
  processed: z.number().int().min(0).max(10000000),
  expectedUpdatedAt: z.iso.datetime().nullable(),
};
const imported = z.object({
  ...sourceCounts, kind: z.enum(["GA4", "BOT"]), source: z.enum(["GA4_CSV", "ACCESS_LOG"]),
}).strict();
const apiResult = z.object({
  ...sourceCounts, start: z.iso.date(), end: z.iso.date(), notes: z.array(z.string().max(500)).max(12),
}).strict();
type Db = Pick<PrismaClient, "site" | "geoSnapshot">;

export async function ownedGeoSite(db: Db, userId: string | undefined, siteId: string) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({where: {id: siteId, userId}, select: {id: true, domain: true}});
  if (!site) throw new ContentError("Unknown site", 404);
  return site;
}

async function load(db: Db, siteId: string): Promise<GeoWorkspace> {
  const stored = await db.geoSnapshot.findMany({where: {siteId, kind: {in: ["GA4", "BOT"]}}});
  const snapshots: GeoWorkspace["snapshots"] = {GA4: null, BOT: null};
  for (const item of stored) {
    if (item.kind === "GA4" || item.kind === "BOT") {
      snapshots[item.kind] = {...(item.report as Omit<GeoSnapshot, "updatedAt">), updatedAt: item.updatedAt.toISOString()};
    }
  }
  return {siteId, snapshots};
}
export async function readGeoWorkspace(db: Db, userId: string | undefined, siteId: string) {
  await ownedGeoSite(db, userId, siteId);
  return load(db, siteId);
}
function validateRows(kind: GeoKind, domain: string, rows: GeoRow[]) {
  const allowed: readonly string[] = kind === "GA4" ? REFERRAL_PLATFORMS : BOT_PLATFORMS;
  const seen = new Set<string>();
  for (const r of rows) {
    if (!allowed.includes(r.platform) || normalizeGeoPath(r.path, domain) !== r.path) {
      throw new ContentError("Invalid platform or page path", 422);
    }
    const key = JSON.stringify([r.day,r.platform,r.path]);
    if (seen.has(key)) throw new ContentError("Duplicate aggregate row", 422);
    seen.add(key);
  }
}

async function persist(db: Db, siteId: string, kind: GeoKind, report: Omit<GeoSnapshot, "updatedAt">, expected: string | null) {
  if (report.skipped > report.processed) throw new ContentError("Invalid source counts", 422);
  if (expected === null) {
    try {
      await db.geoSnapshot.create({data:{siteId, kind, report, updatedAt:new Date()}});
    } catch (error) {
      if ((error as {code?:string}).code === "P2002") throw new ContentError("Snapshot changed. Refresh before saving.", 409);
      throw error;
    }
  } else {
    const prior = new Date(expected);
    const updatedAt = new Date(Math.max(Date.now(), prior.getTime()+1));
    const saved = await db.geoSnapshot.updateMany({where:{siteId, kind, updatedAt:prior}, data:{report, updatedAt}});
    if (saved.count !== 1) throw new ContentError("Snapshot changed. Refresh before saving.", 409);
  }
  return load(db, siteId);
}

export async function saveGeoImport(db: Db, userId: string | undefined, siteId: string, body: unknown) {
  const site = await ownedGeoSite(db,userId,siteId);
  const {rows,kind,source,processed,skipped,expectedUpdatedAt} = imported.parse(body);
  if ((kind === "GA4") !== (source === "GA4_CSV")) throw new ContentError("Source mismatch", 422);
  if (!rows.length || processed < rows.length) throw new ContentError("Supply a report containing matching AI observations", 422);
  validateRows(kind,site.domain,rows);
  const days = rows.map(r => r.day).sort();
  return persist(db,siteId,kind,{rows,source,skipped,processed,start:days[0],end:days[days.length-1],notes:[]},expectedUpdatedAt);
}

export async function saveGaSnapshot(db: Db, userId: string | undefined, siteId: string, data: z.input<typeof apiResult>) {
  const site = await ownedGeoSite(db,userId,siteId);
  const {expectedUpdatedAt,...report} = apiResult.parse(data);
  validateRows("GA4",site.domain,report.rows);
  if (report.start > report.end || report.rows.some(r => r.day < report.start || r.day > report.end)) {
    throw new ContentError("Invalid Google reporting period", 422);
  }
  return persist(db,siteId,"GA4",{...report,source:"GA4_API"},expectedUpdatedAt);
}
