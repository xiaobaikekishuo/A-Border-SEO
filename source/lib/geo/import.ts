import type { GeoKind, GeoRow } from "./types";
import { AI_BOTS, botLabel } from "@/lib/seo/ai-bots";

/*
 * AI assistant referrers: the hostnames GA4 reports as session source, and
 * the plain names used in utm_source tags. Platform names are stored with
 * imported rows, so existing names never change; new platforms are appended.
 * Search engines (google.com, bing.com, duckduckgo.com) stay out: their AI
 * answers cannot be told apart from ordinary results by the referrer.
 */
const SOURCE_ALIASES: Record<string, readonly string[]> = {
  ChatGPT: ["chatgpt", "chatgpt.com", "chat.openai.com"],
  Claude: ["claude", "claude.ai"],
  Perplexity: ["perplexity", "perplexity.ai"],
  Gemini: ["gemini", "gemini.google.com", "bard.google.com"],
  Copilot: ["copilot", "copilot.microsoft.com", "edgeservices.bing.com"],
  DeepSeek: ["deepseek", "chat.deepseek.com", "deepseek.com"],
  Doubao: ["doubao", "doubao.com"],
  Kimi: ["kimi", "kimi.com", "kimi.moonshot.cn", "kimi.moonshot.ai"],
  Grok: ["grok", "grok.com"],
  "Meta AI": ["meta.ai"],
  Mistral: ["mistral", "chat.mistral.ai"],
  Poe: ["poe", "poe.com"],
  "You.com": ["you.com"],
  "Duck.ai": ["duck.ai"],
  Qwen: ["qwen", "tongyi", "qianwen", "tongyi.com", "tongyi.aliyun.com", "qianwen.com", "chat.qwen.ai"],
  "ERNIE Bot": ["yiyan", "yiyan.baidu.com"],
  Yuanbao: ["yuanbao", "yuanbao.tencent.com"],
  ChatGLM: ["chatglm", "chatglm.cn"],
  Metaso: ["metaso", "metaso.cn"],
};
export const REFERRAL_PLATFORMS: readonly string[] = Object.keys(SOURCE_ALIASES);
const sourceLookup = new Map<string, string>();
for (const [platform, aliases] of Object.entries(SOURCE_ALIASES)) {
  for (const alias of aliases) {
    sourceLookup.set(alias, platform);
    if (alias.split(".").length === 2) sourceLookup.set("www." + alias, platform);
  }
}
export const GA4_SOURCE_VALUES: readonly string[] = [...sourceLookup.keys()];

/** Hosted sources and explicit campaign tags. General search-engine domains are ambiguous. */
export function classifyAiSource(raw: string): string | null {
  const source = raw.trim().split(/\s+\/\s+/, 1)[0].trim().toLowerCase();
  if (/^https?:\/\//.test(source)) {
    try {
      const url = new URL(source);
      if (url.username || url.password || url.port) return null;
      return sourceLookup.get(url.hostname) ?? null;
    } catch { return null; }
  }
  return sourceLookup.get(source) ?? null;
}

// AI-specific user agents from the shared registry (control and policy tokens never appear in logs).
// A user agent is only a claim: the import does not verify the provider's published IP ranges.
const bots = AI_BOTS.filter(bot => bot.inLogs).map(bot => ({
  label: botLabel(bot),
  match: new RegExp("(?:^|[\\s;(])" + bot.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[\\s;)]|/\\d)", "i"),
}));
export const BOT_PLATFORMS: readonly string[] = bots.map(bot => bot.label);

function siteHost(domain: string): string {
  try {
    const url = new URL(domain.includes("://") ? domain : "https://" + domain);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname)
      return url.host.toLowerCase();
  } catch { /* Invalid selected site */ }
  throw new Error("geo_site_invalid");
}

function pathForHost(raw: string, host: string): string | null {
  const value = raw.trim();
  if (value === "(not set)" || value === "（未设置）" || value === "(未设置)") return "(not set)";
  if (!value || value.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("//") || !/^(?:\/|https?:\/\/)/i.test(value)) return null;
  try {
    const url = new URL(value, "https://" + host);
    if (url.host.toLowerCase() !== host || url.username || url.password) return null;
    const path = url.pathname;
    if (path.length > 1024 || path.includes("//")) return null;
    const decoded = decodeURIComponent(path);
    if (/[?#\\\u0000-\u001f\u007f]/.test(decoded) || /%(?:25|2f)/i.test(path)) return null;
    const sensitiveRoute = /(?:^|\/)(?:api|auth|oauth2?|callback|login|account|accounts|user|users|profile|checkout|orders?|invoices?|cart|password|reset-password|reset|activate|verify|unsubscribe|token)(?:\/|$)/i;
    const privateValue = /@|\b(?:\d{1,3}\.){3}\d{1,3}\b|\d{8,}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-z\d_]{32,}|\b(?:sk-|GOCSPX-|eyJ)[A-Za-z0-9._-]+/i;
    if (sensitiveRoute.test(decoded) || privateValue.test(decoded)) return "/[private]";
    return path;
  } catch { return null; }
}

export function normalizeGeoPath(raw: string, domain: string): string | null {
  return pathForHost(raw, siteHost(domain));
}

export function normalizeGeoDay(raw: string): string | null {
  const value = raw.trim();
  if (!/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(value)) return null;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!match || match[1] < "1970") return null;
  const day = match.slice(1).join("-");
  const ms = Date.parse(day + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : null;
}

/** Parse GA4 CSV records including quoted commas, doubled quotes and quoted line breaks. */
export function csvRows(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  function finishField() {
    row.push(field.trim());
    if (row.length > 256) throw new Error("geo_csv_invalid");
    field = "";
    closed = false;
  }
  function finishRow() {
    finishField();
    if (row.some(Boolean)) records.push(row);
    row = [];
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!quoted && !closed && !row.length && !field && char === "#") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === ",") finishField();
    else if (char === "\n") finishRow();
    else if (char === '"' && !closed && !field) quoted = true;
    else if (closed || char === '"') throw new Error("geo_csv_invalid");
    else field += char;
  }
  if (quoted) throw new Error("geo_csv_invalid");
  finishRow();
  return records;
}

const headerAliases = {
  day: ["date", "日期"],
  source: ["session source", "sessionSource", "session source / medium", "sessionSourceMedium", "会话来源", "会话来源/媒介", "会话来源/媒体", "会话来源/介质"],
  path: ["landing page", "landing page + query string", "landingPagePlusQueryString", "着陆页", "着陆页+查询字符串", "着陆页和查询字符串", "落地页", "落地页+查询字符串"],
  count: ["sessions", "会话数", "会话次数"],
  host: ["host name", "hostname", "主机名", "主机名称"],
};
const headerKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
function columnIndex(header: string[], aliases: string[], required = true): number {
  const accepted = aliases.map(headerKey);
  const matches = header.map((key, index) => accepted.includes(key) ? index : -1).filter(index => index >= 0);
  if (matches.length > 1 || (required && !matches.length)) throw new Error("geo_csv_headers");
  return matches[0] ?? -1;
}

type Parsed = { row: GeoRow | null; inScope: boolean };
const excluded = { row: null, inScope: false };
function parseCsv(text: string, host: string): Parsed[] {
  const [head, ...records] = csvRows(text);
  if (!head) throw new Error("geo_empty");
  const header = head.map(headerKey);
  const dayCol = columnIndex(header, headerAliases.day);
  const pathCol = columnIndex(header, headerAliases.path);
  const sourceCol = columnIndex(header, headerAliases.source);
  const sessionsCol = columnIndex(header, headerAliases.count);
  const hostCol = columnIndex(header, headerAliases.host, false);
  return records.map(fields => {
    if (fields.length !== header.length || (hostCol >= 0 && fields[hostCol].toLowerCase() !== host)) return excluded;
    const day = normalizeGeoDay(fields[dayCol]);
    const path = pathForHost(fields[pathCol], host);
    const value = fields[sessionsCol];
    if (!day || !path || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return excluded;
    const count = Number(value.replace(/,/g, ""));
    if (!Number.isSafeInteger(count) || count > 2147483647) throw new Error("geo_count_limit");
    const platform = classifyAiSource(fields[sourceCol]);
    return { row: platform ? { day, platform, path, count } : null, inScope: true };
  });
}

const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function accessDay(timestamp: string): string | null {
  const match = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(timestamp);
  if (!match) return null;
  const [, dd, month, year, hh, mm, ss, sign, offsetHours, offsetMinutes] = match;
  const day = normalizeGeoDay(year + String(months.indexOf(month) + 1).padStart(2, "0") + dd);
  if (!day || +hh > 23 || +mm > 59 || +ss > 59 || +offsetHours > 23 || +offsetMinutes > 59) return null;
  const ms = Date.parse(day + "T" + hh + ":" + mm + ":" + ss + sign + offsetHours + ":" + offsetMinutes);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

// Optional vhost, standard combined format: identity, time, request, status, bytes, referrer and declared UA.
const combined = /^(?:(\S+)\s+)?\S+\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"[A-Z]+ (\S+) HTTP\/[\d.]+"\s+[1-5]\d\d\s+(?:\d+|-)\s+"(?:[^"\\]|\\.)*"\s+"((?:[^"\\]|\\.)*)"\s*$/;
function parseLog(line: string, host: string): Parsed {
  if (line.length > 16384) return excluded;
  const match = combined.exec(line);
  if (!match || (match[1] !== undefined && match[1].toLowerCase() !== host)) return excluded;
  const day = accessDay(match[2]);
  const path = pathForHost(match[3], host);
  if (!day || !path || path === "(not set)") return excluded;
  const ua = match[4];
  const platform = bots.find(bot => bot.match.test(ua))?.label;
  return { row: platform ? { day, platform, path, count: 1 } : null, inScope: true };
}

/** Streaming access-log import limits: far larger than a whole-file read, still bounded for the browser. */
export const LOG_STREAM_LIMITS = { characters: 512 * 1024 * 1024, lines: 3_000_000, rows: 10_000 } as const;

const rowOrder = (a: GeoRow, b: GeoRow) => a.day.localeCompare(b.day) || a.platform.localeCompare(b.platform) || a.path.localeCompare(b.path);

/**
 * Line-by-line access-log aggregation for large or gzip files read as a
 * stream. The result has the same shape and rules as parseGeoImport("BOT").
 */
export function createLogAccumulator(domain: string) {
  const host = siteHost(domain);
  const grouped = new Map<string, GeoRow>();
  let processed = 0, skipped = 0, inScope = false;
  return {
    add(line: string) {
      if (!line.trim()) return;
      if (++processed > LOG_STREAM_LIMITS.lines) throw new Error("geo_too_many_lines");
      const parsed = parseLog(line, host);
      if (parsed.inScope) inScope = true;
      if (!parsed.row) { skipped++; return; }
      const key = parsed.row.day + "\t" + parsed.row.platform + "\t" + parsed.row.path;
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.count > 2147483647) throw new Error("geo_count_limit");
      } else {
        if (grouped.size >= LOG_STREAM_LIMITS.rows) throw new Error("geo_count_limit");
        grouped.set(key, parsed.row);
      }
    },
    finish(): { rows: GeoRow[]; skipped: number; processed: number } {
      if (!processed) throw new Error("geo_empty");
      if (!inScope) throw new Error("geo_no_valid_rows");
      return { rows: [...grouped.values()].sort(rowOrder), skipped, processed };
    },
  };
}

export function parseGeoImport(kind: GeoKind, text: string, domain: string): { rows: GeoRow[]; skipped: number; processed: number } {
  if (text.length > 1048576 || new TextEncoder().encode(text).length > 1048576) throw new Error("geo_too_large");
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!normalized.trim()) throw new Error("geo_empty");
  const lines = normalized.split("\n");
  if (lines.length > 10000) throw new Error("geo_too_many_lines");
  const host = siteHost(domain);
  const parsed = kind === "GA4" ? parseCsv(normalized, host) : lines.filter(line => line.trim()).map(line => parseLog(line, host));
  if (!parsed.some(item => item.inScope)) throw new Error("geo_no_valid_rows");
  const grouped = new Map<string, GeoRow>();
  let skipped = 0;
  for (const { row } of parsed) {
    if (!row) { skipped++; continue; }
    const key = row.day + "\t" + row.platform + "\t" + row.path;
    const existing = grouped.get(key);
    if (!existing) grouped.set(key, row);
    else {
      existing.count += row.count;
      if (existing.count > 2147483647) throw new Error("geo_count_limit");
    }
  }
  return { rows: [...grouped.values()].sort(rowOrder), skipped, processed: parsed.length };
}
