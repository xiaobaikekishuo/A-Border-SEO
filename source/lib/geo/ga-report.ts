import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { googleFetch } from "@/lib/google/google-fetch";
import { readBodyCapped } from "@/lib/crawler/engine";
import { classifyAiSource, GA4_SOURCE_VALUES, normalizeGeoDay, normalizeGeoPath } from "./import";
import type { GeoRow } from "./types";

export const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
/** Rows read per runReport request, and the most read for one period (GA4 allows 250,000 per request). */
const PAGE_ROWS = 10_000;
export const MAX_REPORT_ROWS = 50_000;
/** Aggregated day/platform/page rows a snapshot may keep (lib/geo/store.ts). */
const MAX_SNAPSHOT_ROWS = 10_000;
const dimensions = ["date", "hostName", "sessionSource", "landingPage"];
const dateRange = z.object({ start: z.iso.date(), end: z.iso.date() });
export const gaRequest = dateRange.extend({
  propertyId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  expectedUpdatedAt: z.iso.datetime().nullable(),
  code: z.string().min(1).max(4096)
}).strict().refine(({start,end}) => {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  return days >= 1 && days <= 93;
}, "Choose a period of 1 to 93 days");

function problem(code: string, status: number) { return new ContentError(code, status); }

async function requestGoogle(url: string, init: RequestInit) {
  try {
    return await googleFetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(25_000) });
  } catch {
    throw problem("GA_NETWORK", 502);
  }
}

async function exchangeCode(code: string, origin: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw problem("GA_CONFIG", 503);
  const response = await requestGoogle("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      code, grant_type: "authorization_code", redirect_uri: origin }),
  });
  if (!response.ok) throw problem("GA_AUTH", 403);
  const grant = z.object({ access_token: z.string().min(1), scope: z.string() }).safeParse(await response.json());
  if (!grant.success || !grant.data.scope.split(/\s+/).includes(GA_SCOPE)) throw problem("GA_SCOPE", 403);
  return grant.data.access_token;
}

const cell = z.object({ value: z.string().optional() });
const reportSchema = z.object({
  dimensionHeaders: z.array(z.object({name:z.string()})),
  metricHeaders: z.array(z.object({name:z.string()})),
  rows: z.array(z.object({dimensionValues:z.array(cell).length(4),metricValues:z.array(cell).length(1)})).optional(),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: z.object({
    timeZone:z.string().max(100).optional(), dataLossFromOtherRow:z.boolean().optional(),
    subjectToThresholding:z.boolean().optional(), samplingMetadatas:z.array(z.unknown()).optional(),
    dataTruncationReasons:z.array(z.unknown()).optional(), emptyReason:z.string().optional(),
    schemaRestrictionResponse:z.object({activeMetricRestrictions:z.array(z.unknown()).optional()}).optional()
  }).optional()
});

/** One runReport page, checked. */
function parseReportPage(body: unknown) {
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) throw problem("GA_RESPONSE", 502);
  const report = parsed.data;
  if (report.dimensionHeaders.map(h => h.name).join("|") !== dimensions.join("|") ||
      report.metricHeaders.map(h => h.name).join("|") !== "sessions") throw problem("GA_RESPONSE", 502);
  return report;
}

export function summarizeGaReport(body: unknown, host: string, start: string, end: string, propertyId: string) {
  return summarizeGaPages([body], host, start, end, propertyId);
}

/** Every page of one report (same request, increasing offsets). The rows must add up to rowCount. */
export function summarizeGaPages(bodies: readonly unknown[], host: string, start: string, end: string, propertyId: string) {
  const pages = bodies.map(parseReportPage);
  const report = pages[0] ?? parseReportPage(undefined);
  const records = pages.flatMap(page => page.rows ?? []);
  const size = report.rowCount ?? 0;
  if (size > MAX_REPORT_ROWS || records.length > MAX_REPORT_ROWS) throw problem("GA_LIMIT", 422);
  if (pages.some(page => (page.rowCount ?? 0) !== size) || size !== records.length) throw problem("GA_RESPONSE", 502);
  const sums = new Map<string,GeoRow>();
  let skipped = 0;
  for (const item of records) {
    const [date, hostname, source, page] = item.dimensionValues.map(d => d.value ?? "");
    const day = normalizeGeoDay(date);
    const countText = item.metricValues[0].value ?? "";
    if (!day || day < start || day > end || hostname.toLowerCase() !== host || !/^\d{1,10}$/.test(countText)) throw problem("GA_RESPONSE", 502);
    const count = Number(countText);
    if (count > 2147483647) throw problem("GA_LIMIT", 422);
    const platform = classifyAiSource(source);
    const path = normalizeGeoPath(page,host);
    if (!platform || !path) { skipped++; continue; }
    const key = JSON.stringify([day,platform,path]);
    const existing = sums.get(key);
    if (existing) {
      existing.count += count;
      if (existing.count > 2147483647) throw problem("GA_LIMIT", 422);
    } else sums.set(key,{day,platform,path,count});
  }
  if (sums.size > MAX_SNAPSHOT_ROWS) throw problem("GA_LIMIT", 422);
  const m = report.metadata;
  const notes = ["GA4 " + propertyId + " · " + host];
  if (m?.timeZone) notes.push("GA4 TZ · " + m.timeZone);
  if (m?.subjectToThresholding) notes.push("GA4 thresholding / 数据可能受隐私阈值影响");
  if (m?.dataLossFromOtherRow) notes.push("GA4 grouped rows / 高基数数据可能已合并");
  if (m?.samplingMetadatas?.length) notes.push("GA4 sampled report / 抽样报表");
  if (m?.dataTruncationReasons?.length) notes.push("GA4 truncated data / 部分时段数据已截断");
  if (m?.schemaRestrictionResponse?.activeMetricRestrictions?.length) notes.push("GA4 metric restriction / 指标受限");
  if (!size || m?.emptyReason) notes.push("No matching rows returned / 此资源和时段未返回匹配来源的记录");
  if (skipped) notes.push("Excluded unmappable rows / 已排除无法归类的记录");
  return { start, end, rows:[...sums.values()], processed:size, skipped, notes };
}

const googleErrorInfo = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  domain: z.literal("googleapis.com"),
  reason: z.string(),
  metadata: z.object({service:z.string().optional()}).optional(),
});

/** Only return recognized categories. Google responses can contain identifiers and request details. */
export async function gaAccessCategory(response: Response) {
  if (response.status === 404) return "GA_PROPERTY_NOT_FOUND";
  try {
    const raw = await readBodyCapped(response, 32 * 1024);
    const envelope = z.object({error:z.object({
      message:z.string().optional(), details:z.array(z.unknown()).optional(),
    })}).safeParse(JSON.parse(new TextDecoder().decode(raw)));
    if (!envelope.success) return "GA_ACCESS";
    for (const record of envelope.data.error.details ?? []) {
      const detail = googleErrorInfo.safeParse(record);
      if (!detail.success) continue;
      const service = detail.data.metadata?.service;
      if (service && service !== "analyticsdata.googleapis.com") continue;
      if (detail.data.reason === "SERVICE_DISABLED") return "GA_API_DISABLED";
      if (detail.data.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") return "GA_SCOPE_INSUFFICIENT";
    }
    if (/^user does not have sufficient permissions for this property\b/i.test(envelope.data.error.message ?? "")) return "GA_PROPERTY_ACCESS";
  } catch { /* Unknown or oversized provider response. */ }
  return "GA_ACCESS";
}

async function runReport(propertyId: string, token: string, report: object) {
  const response = await requestGoogle("https://analyticsdata.googleapis.com/v1beta/properties/" + propertyId + ":runReport", {
    method:"POST", headers:{ Authorization:"Bearer " + token, "Content-Type":"application/json" },
    body:JSON.stringify(report)
  });
  if (!response.ok) {
    if (response.status === 401) throw problem("GA_AUTH", 403);
    if (response.status === 403 || response.status === 404) throw problem(await gaAccessCategory(response), 403);
    if (response.status === 429) throw problem("GA_QUOTA", 429);
    if (response.status === 400) throw problem("GA_REPORT", 422);
    throw problem("GA_NETWORK", 502);
  }
  return await response.json() as unknown;
}

export async function fetchGaSnapshot(req: z.infer<typeof gaRequest>, siteDomain: string, origin: string) {
  let host: string;
  try { host = new URL(siteDomain.includes("://") ? siteDomain : "https://" + siteDomain).hostname.toLowerCase(); }
  catch { throw problem("GA_SITE", 422); }
  const token = await exchangeCode(req.code, origin);
  const period = {dateRanges:[{startDate:req.start,endDate:req.end}],metrics:[{name:"sessions"}]};
  const hostFilter = {filter:{fieldName:"hostName",stringFilter:{matchType:"EXACT",value:host,caseSensitive:false}}};
  const query = {
    ...period, dimensions:dimensions.map(name => ({name})),
    dimensionFilter:{andGroup:{expressions:[hostFilter,
      {filter:{fieldName:"sessionSource",inListFilter:{values:GA4_SOURCE_VALUES,caseSensitive:false}}}
    ]}},
    // A stable order keeps offset pages from overlapping or skipping rows.
    orderBys:dimensions.map(dimensionName => ({dimension:{dimensionName}})),
  };
  const pages: unknown[] = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const page = await runReport(req.propertyId,token,{...query, limit:String(PAGE_ROWS), offset:String(offset)});
    pages.push(page);
    const total = parseReportPage(page).rowCount ?? 0;
    if (total > MAX_REPORT_ROWS) throw problem("GA_LIMIT", 422);
    if (offset + PAGE_ROWS >= total) break;
  }
  const snapshot = summarizeGaPages(pages,host,req.start,req.end,req.propertyId);
  if (!snapshot.processed) {
    const hostActivity = await runReport(req.propertyId,token,{
      ...period,dimensions:[{name:"hostName"}],dimensionFilter:hostFilter,limit:"1"
    });
    const coverage = z.object({rows:z.array(z.object({dimensionValues:z.array(cell).length(1),metricValues:z.array(cell).length(1)})).length(1)}).safeParse(hostActivity);
    const row = coverage.success ? coverage.data.rows[0] : null;
    if (row?.dimensionValues[0].value?.toLowerCase() !== host || !/^[1-9]\d*$/.test(row?.metricValues[0].value ?? "")) throw problem("GA_NO_HOST_DATA",422);
  }
  return snapshot;
}
