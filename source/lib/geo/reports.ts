/*
 * Importing the AI reports platform owners publish, from their CSV exports:
 *
 *   GSC_AI   Search Console > Generative AI performance (AI Overviews and AI
 *            Mode together): impressions by date, page, country and device.
 *            Not available through the Search Console API (November 2026).
 *   BING_AI  Bing Webmaster Tools > AI Performance (Copilot and Bing AI
 *            answers): citations and cited pages by date, citations by page,
 *            and grounding queries with citations and citation share.
 *
 * Each export is one table per file. The table is recognised by its column
 * names, in English or Chinese, so the files can be dropped in together and
 * in any order. Runs in the browser before upload; the server checks the
 * result again (lib/geo/report-store.ts).
 */

import { csvRows } from "./import";

export type ReportKind = "GSC_AI" | "BING_AI";
export type ReportTable = "DAILY" | "PAGES" | "QUERIES" | "COUNTRIES" | "DEVICES";

export type AiReport = {
  kind: ReportKind;
  start: string | null;
  end: string | null;
  /** Impressions (GSC_AI) or citations (BING_AI) per day; `pages` is Bing's cited pages. */
  daily: { day: string; value: number; pages: number | null }[];
  pages: { url: string; value: number }[];
  queries: { query: string; value: number; share: number | null; intent: string | null; topic: string | null }[];
  countries: { name: string; value: number }[];
  devices: { name: string; value: number }[];
  tables: ReportTable[];
  skipped: number;
};

export const REPORT_LIMITS = { files: 8, characters: 5 * 1024 * 1024, rows: 5000 } as const;

const HEADERS = {
  date: ["date", "day", "日期", "天"],
  page: ["page", "pages", "top pages", "url", "urls", "page url", "cited page", "cited pages url", "网页", "热门网页", "页面", "网址"],
  query: ["grounding query", "grounding queries", "query", "queries", "top queries", "查询", "热门查询", "依据查询", "基础查询"],
  country: ["country", "countries", "国家/地区", "国家", "地区"],
  device: ["device", "devices", "设备"],
  impressions: ["impressions", "展示次数", "展示"],
  citations: ["citations", "total citations", "citation count", "引用", "引用次数", "引用数"],
  citedPages: ["cited pages", "avg. cited pages", "average cited pages", "avg cited pages", "被引用页面", "被引用的页面", "平均被引用页面"],
  share: ["citation share", "citation score", "引用份额", "引用占比"],
  intent: ["intent", "意图"],
  topic: ["topic", "主题"],
} as const;

function column(header: string[], names: readonly string[]): number {
  return header.findIndex(h => names.includes(h));
}

/** A number as exported: "1,234", "1 234", "12.5", "31%" (as 0.31 when `percent`). */
export function reportNumber(raw: string, percent = false): number | null {
  const value = raw.replace(/[\s,]/g, "").trim();
  if (!value) return null;
  const pct = value.endsWith("%");
  const n = Number(pct ? value.slice(0, -1) : value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (percent) return pct || n > 1 ? Math.round((n / 100) * 10000) / 10000 : n;
  return n;
}

/** YYYY-MM-DD from "2026-10-04", "2026/10/04", "20261004", "10/4/2026" (M/D unless the first part exceeds 12) or "Oct 4, 2026". */
export function reportDay(raw: string): string | null {
  const value = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) {
    const a = Number(match[1]), b = Number(match[2]);
    [y, m, d] = a > 12 ? [Number(match[3]), b, a] : [Number(match[3]), a, b];
  } else if ((match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (/^[A-Za-z]{3,9}\.? \d{1,2}, \d{4}$/.test(value)) {
    const ms = Date.parse(value + " UTC");
    if (!Number.isFinite(ms)) return null;
    const date = new Date(ms);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const ms = Date.parse(iso + "T00:00:00Z");
  return y >= 2020 && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? iso : null;
}

/** A page URL of this site (any subdomain) without fragment and utm_ parameters; null for another site. */
export function reportUrl(raw: string, domain: string): string | null {
  const site = domain.toLowerCase().replace(/^www\./, "");
  let url: URL;
  try { url = new URL(raw.trim().startsWith("/") ? `https://${site}${raw.trim()}` : raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== site && !host.endsWith("." + site)) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  const href = url.toString();
  return href.length <= 2048 ? href : null;
}

const BOM = String.fromCharCode(0xfeff);
const normalize = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/g, "\n");

type Table = { table: ReportTable; rows: string[][]; header: string[] };

function recognise(records: string[][]): Table | null {
  // Some exports put a title or a filter summary above the header row.
  for (let i = 0; i < Math.min(records.length, 5); i++) {
    const header = records[i].map(h => h.trim().toLowerCase());
    const has = (names: readonly string[]) => column(header, names) >= 0;
    const metric = has(HEADERS.impressions) || has(HEADERS.citations);
    if (!metric) continue;
    const rows = records.slice(i + 1);
    if (has(HEADERS.date)) return { table: "DAILY", rows, header };
    if (has(HEADERS.page)) return { table: "PAGES", rows, header };
    if (has(HEADERS.query)) return { table: "QUERIES", rows, header };
    if (has(HEADERS.country)) return { table: "COUNTRIES", rows, header };
    if (has(HEADERS.device)) return { table: "DEVICES", rows, header };
  }
  return null;
}

/** Most rows kept per table; the rest are counted in `truncated`. */
export const REPORT_KEEP = { daily: 1000, pages: 2000, queries: 2000, countries: 300, devices: 20 } as const;

/**
 * Reads the CSV files of one export (a Search Console download unzipped, or
 * the Bing tables). Files that hold no table of the report, such as a filter
 * summary, are listed in `ignored`. Errors are thrown as codes the importer
 * translates: report_files, report_too_large, report_unrecognised,
 * report_wrong_kind, report_not_ai, report_duplicate_table,
 * report_duplicate_day, report_empty, geo_csv_invalid.
 */
export function parseReportFiles(kind: ReportKind, files: readonly { name: string; text: string }[], domain: string): AiReport & { ignored: string[]; truncated: number } {
  if (!files.length || files.length > REPORT_LIMITS.files) throw new Error("report_files");
  const report: AiReport = { kind, start: null, end: null, daily: [], pages: [], queries: [], countries: [], devices: [], tables: [], skipped: 0 };
  const ignored: string[] = [];
  const pages = new Map<string, number>();
  for (const file of files) {
    if (file.text.length > REPORT_LIMITS.characters) throw new Error("report_too_large");
    const table = recognise(csvRows(normalize(file.text)));
    if (!table) { ignored.push(file.name); continue; }
    const { header, rows } = table;
    const metricCol = column(header, kind === "GSC_AI" ? HEADERS.impressions : HEADERS.citations);
    if (metricCol < 0) throw new Error("report_wrong_kind");
    // The ordinary performance report has average position and CTR; the generative AI report does not.
    if (kind === "GSC_AI" && column(header, ["position", "average position", "ctr", "排名", "平均排名", "点击率"]) >= 0) throw new Error("report_not_ai");
    if (report.tables.includes(table.table)) throw new Error("report_duplicate_table");
    if (rows.length > REPORT_LIMITS.rows) throw new Error("report_too_large");
    report.tables.push(table.table);
    const keyCol = column(header, table.table === "DAILY" ? HEADERS.date : table.table === "PAGES" ? HEADERS.page
      : table.table === "QUERIES" ? HEADERS.query : table.table === "COUNTRIES" ? HEADERS.country : HEADERS.device);
    const pagesCol = column(header, HEADERS.citedPages);
    const shareCol = column(header, HEADERS.share);
    const intentCol = column(header, HEADERS.intent);
    const topicCol = column(header, HEADERS.topic);
    for (const row of rows) {
      const value = reportNumber(row[metricCol] ?? "");
      const key = (row[keyCol] ?? "").trim();
      if (value === null || !key) { report.skipped++; continue; }
      if (table.table === "DAILY") {
        const day = reportDay(key);
        if (!day) { report.skipped++; continue; }
        report.daily.push({ day, value, pages: pagesCol >= 0 ? reportNumber(row[pagesCol] ?? "") : null });
      } else if (table.table === "PAGES") {
        const url = reportUrl(key, domain);
        if (!url) { report.skipped++; continue; }
        pages.set(url, (pages.get(url) ?? 0) + value);
      } else if (table.table === "QUERIES") {
        report.queries.push({
          query: key.slice(0, 500), value,
          share: shareCol >= 0 ? reportNumber(row[shareCol] ?? "", true) : null,
          intent: intentCol >= 0 ? (row[intentCol] ?? "").trim().slice(0, 60) || null : null,
          topic: topicCol >= 0 ? (row[topicCol] ?? "").trim().slice(0, 120) || null : null,
        });
      } else (table.table === "COUNTRIES" ? report.countries : report.devices).push({ name: key.slice(0, 100), value });
    }
  }
  if (!report.tables.length) throw new Error("report_unrecognised");
  report.daily.sort((a, b) => a.day.localeCompare(b.day));
  const days = new Set(report.daily.map(d => d.day));
  if (days.size !== report.daily.length) throw new Error("report_duplicate_day");
  report.pages = [...pages].map(([url, value]) => ({ url, value })).sort((a, b) => b.value - a.value || a.url.localeCompare(b.url));
  report.queries.sort((a, b) => b.value - a.value || a.query.localeCompare(b.query));
  report.countries.sort((a, b) => b.value - a.value);
  report.devices.sort((a, b) => b.value - a.value);
  let truncated = 0;
  const keep = <T,>(list: T[], max: number) => { truncated += Math.max(0, list.length - max); return list.slice(0, max); };
  report.daily = keep(report.daily.slice().reverse(), REPORT_KEEP.daily).reverse();
  report.pages = keep(report.pages, REPORT_KEEP.pages);
  report.queries = keep(report.queries, REPORT_KEEP.queries);
  report.countries = keep(report.countries, REPORT_KEEP.countries);
  report.devices = keep(report.devices, REPORT_KEEP.devices);
  report.start = report.daily[0]?.day ?? null;
  report.end = report.daily[report.daily.length - 1]?.day ?? null;
  if (!report.daily.length && !report.pages.length && !report.queries.length) throw new Error("report_empty");
  return { ...report, ignored, truncated };
}

/** Text of an exported file: UTF-8, or UTF-16 when it starts with a UTF-16 byte order mark. */
export function decodeReportBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}
