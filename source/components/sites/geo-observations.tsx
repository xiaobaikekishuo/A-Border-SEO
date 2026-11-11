"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Bot, Download, FolderOpen, Globe2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { GeoKind, GeoRow, GeoSnapshot, GeoWorkspace } from "@/lib/geo/types";
import { LOG_STREAM_LIMITS, parseGeoImport } from "@/lib/geo/import";
import { readAccessLog } from "@/lib/geo/log-stream";
import GeoGaConnection from "./geo-ga-connection";
import s from "./geo-observations.module.css";

type SiteProps = { siteId: string; domain: string; oauthClientId?: string };
type Parsed = ReturnType<typeof parseGeoImport>;
const MB = 1024 * 1024;
const PAGE_SIZE = 25;

function sourceLabel(source: GeoSnapshot["source"], t: Translator) {
  if (source === "GA4_API") return t("Google Analytics Data API", "Google Analytics Data API");
  if (source === "GA4_CSV") return t("GA4 report file", "GA4 报表文件");
  return t("Web access log", "网站访问日志");
}

function parseMessage(error: unknown, t: Translator, kind: GeoKind = "GA4") {
  const log = kind === "BOT";
  const messages: Record<string, [string, string]> = {
    geo_empty: ["Choose a file with report rows.", "请选择含数据行的文件。"],
    geo_too_large: log ? ["Choose a log of up to 512 MB after decompression, or split it by date.", "请选择解压后不超过 512 MB 的日志，或按日期拆分。"] : ["Choose a file of up to 1 MiB.", "请选择不超过 1 MiB 的文件。"],
    geo_too_many_lines: log ? ["Limit each log to 3,000,000 lines, or split it by date.", "每个日志最多读取 3,000,000 行，或按日期拆分。"] : ["Limit each file to 10,000 lines.", "每个文件最多可读取 10,000 行。"],
    geo_read_failed: ["The file could not be read. If it is compressed, check that it is a complete .gz file.", "文件读取失败。如果是压缩文件，请确认是完整的 .gz 文件。"],
    geo_csv_invalid: ["Check the CSV quoting and column separators.", "请检查 CSV 的引号与逗号分隔符。"],
    geo_csv_headers: ["Check the report dimensions and Sessions column against the template.", "请对照表头模板检查报表维度和会话数列。"],
    geo_no_valid_rows: ["No usable rows for this site. Check the format and hostname.", "没有可读取的本站记录，请检查格式和主机名。"],
    geo_count_limit: ["This aggregate exceeds the supported count or row limit. Export a shorter period.", "汇总结果超过支持的计数或行数，请缩短导出时段。"],
    geo_site_invalid: ["Check the domain selected for this workspace.", "请检查当前工作区选择的站点域名。"],
  };
  const key = error instanceof Error ? error.message : "";
  const message = messages[key];
  return message ? t(message[0], message[1]) : t("Could not read this file. Check its encoding and format.", "文件读取失败，请检查编码及格式。");
}

function downloadHeaders() {
  const blob = new Blob(["\uFEFFDate,Session source,Landing page,Sessions,Host name\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "ga4-ai-referrals-headers.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ImportReport({ siteId, domain, kind, snapshot, refresh }: SiteProps & {
  kind: GeoKind; snapshot: GeoSnapshot | null; refresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Parsed | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const readVersion = useRef(0);
  const request = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isGa = kind === "GA4";
  useEffect(() => {
    setConfirmed(false);
  }, [snapshot?.updatedAt]);
  useEffect(() => () => { readVersion.current++; request.current?.abort(); }, []);

  async function read(file: File | undefined) {
    const version = ++readVersion.current;
    setPreview(null); setConfirmed(false); setError(""); setNotice(""); setReading(false); setProgress(0);
    if (!file) return;
    if (file.size > (isGa ? MB : LOG_STREAM_LIMITS.characters)) { setError(parseMessage(new Error("geo_too_large"), t, kind)); return; }
    setReading(true);
    try {
      // Access logs are read line by line (plain or .gz) so large files never sit in memory whole.
      const result = isGa
        ? parseGeoImport(kind, await file.text(), domain)
        : await readAccessLog(file, domain, { onProgress: characters => { if (readVersion.current === version) setProgress(characters); } });
      if (readVersion.current !== version) return;
      setPreview(result);
    } catch (cause) {
      if (readVersion.current === version) setError(parseMessage(cause, t, kind));
    } finally {
      if (readVersion.current === version) setReading(false);
    }
  }

  async function save() {
    if (!confirmed || !preview?.rows.length || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/sites/" + encodeURIComponent(siteId) + "/geo-observations", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, source: isGa ? "GA4_CSV" : "ACCESS_LOG",
          rows: preview.rows, skipped: preview.skipped, processed: preview.processed, expectedUpdatedAt: snapshot?.updatedAt ?? null }),
      });
      if (response.status === 409) {
        setConfirmed(false);
        setError(t("The saved report changed. Review the latest report before replacing it.", "已保存的报表有更新，请核对最新报表后重新确认替换。"));
        await refresh();
        return;
      }
      if (!response.ok) {
        setError(response.status === 401 ? t("Sign in to your local workspace again.", "请重新登录本地工作区。") : t("The report could not be saved. Review the selected site, file size and rows.", "报表保存失败，请核对站点、文件大小和汇总行。"));
        return;
      }
      setPreview(null); setConfirmed(false);
      if (fileInput.current) fileInput.current.value = "";
      setNotice(t("Report saved.", "报表已保存。"));
      await refresh();
    } catch {
      setConfirmed(false);
      setError(t("The save result is uncertain. Check the refreshed report before trying again.", "保存结果待确认，请查看刷新后的报表再决定是否重试。"));
      await refresh();
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setSaving(false); }
    }
  }

  return <details className={s.importer} open={isGa ? undefined : true}>
    <summary><FolderOpen size={17} />{isGa ? t("Import a GA4 CSV report", "导入 GA4 CSV 报表") : t("Import a site access log", "导入站点访问日志")}</summary>
    <div className={s.importBody}>
      {isGa ? <p>{t("Export an exploration for {domain} with Date, Session source, Landing page and Sessions. Include Host name for a property shared by multiple sites.", "在 GA4 探索中筛选 {domain}，导出日期、会话来源、着陆页及会话数。多个站点共用媒体资源时请加入主机名列。", { domain })}</p>
        : <p>{t("Use an Apache or Nginx combined access log for {domain}. One request is counted per matching line. Crawler names come from the recorded User-Agent and need identity verification.", "选择 {domain} 专用的 Apache 或 Nginx combined 格式访问日志。每条匹配记录计作一次请求，爬虫名称取自日志中的 User-Agent，身份待核验。", { domain })}</p>}
      <p>{isGa ? t("UTF-8 files up to 1 MiB and 10,000 lines. The preview runs in this browser. Saving sends the daily totals by platform and page to the local workspace.", "请选择 UTF-8 文件，最多 1 MiB、10,000 行。浏览器会先生成预览，保存时只上传按天、平台和页面汇总的结果。")
        : t("Plain or gzip (.gz) logs up to 512 MB after decompression and 3,000,000 lines. The browser reads the file line by line; saving sends only daily totals by crawler and page. A User-Agent is only a claim: requests are not checked against the providers' published IP ranges.", "支持普通或 gzip（.gz）日志，解压后最多 512 MB、3,000,000 行。浏览器逐行读取，保存时只上传按天、爬虫和页面汇总的结果。User-Agent 只是自称，未与服务商公布的 IP 段核对。")}</p>
      <div className={s.fileActions}>
        <label>{t("Select file", "选择文件")}<input ref={fileInput} type="file" accept={isGa ? ".csv,text/csv,text/plain" : ".log,.txt,.gz,text/plain,application/gzip"} disabled={saving}
          onChange={event => void read(event.currentTarget.files?.[0])} /></label>
        {isGa && <button type="button" className={s.secondary} onClick={downloadHeaders}><Download size={14}/>{t("CSV headers", "下载 CSV 表头")}</button>}
      </div>
      {reading && <p role="status">{t("Preparing preview…", "正在生成预览…")}{!isGa && progress > 0 && " " + t("{mb} MB read", "已读取 {mb} MB", { mb: Math.round(progress / MB) })}</p>}
      {preview && <div className={s.preview}>
        <h4>{t("Import preview", "导入预览")}</h4>
        <p>{t("{processed} input rows · {skipped} skipped · {grouped} aggregated rows", "读取 {processed} 行 · 跳过 {skipped} 行 · 汇总 {grouped} 行", { processed: preview.processed, skipped: preview.skipped, grouped: preview.rows.length })}</p>
        {preview.rows.length > 0 ? <>
          <RowsTable rows={preview.rows.slice(0, 5)} kind={kind} caption={t("First five aggregated rows", "前五条汇总记录")} />
          <p>{t("The saved date range uses the earliest and latest matching rows in this file.", "导入后的日期范围取自文件中首条和末条匹配记录的日期。")}</p>
          <label className={s.confirm}><input type="checkbox" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} />
            {snapshot ? t("This file is for {domain}. Replace the saved report for this data source.", "我确认文件属于 {domain}，并用本次汇总替换当前类型的报表。", { domain })
              : t("I confirm this file is for {domain} and want to save its totals.", "我确认文件属于 {domain}，并保存本次汇总。", { domain })}</label>
          <button type="button" className={s.primary} disabled={!confirmed || saving} onClick={() => void save()}>{saving ? t("Saving…", "正在保存…") : snapshot ? t("Replace report", "替换报表") : t("Save report", "保存报表")}</button>
        </> : <p>{t("No matching AI records were found. Check the site, dimensions and time range.", "文件中未识别到匹配的 AI 记录，请检查站点、维度和时段。")}</p>}
      </div>}
      {error && <p role="alert" className={s.error}>{error}</p>}{notice && <p role="status" className={s.ok}>{notice}</p>}
    </div>
  </details>;
}

function RowsTable({ rows, kind, caption }: { rows: GeoRow[]; kind: GeoKind; caption: string }) {
  const { t, locale } = useI18n();
  const isGa = kind === "GA4";
  return <div className={s.tableWrap}><table>
    <caption>{caption}</caption><thead><tr><th>{t("Date", "日期")}</th><th>{t("Platform / agent", "平台／爬虫")}</th>
      <th>{isGa ? t("Landing page", "着陆页") : t("Requested path", "请求路径")}</th>
      <th>{isGa ? t("Sessions", "会话数") : t("Requests", "请求数")}</th>
    </tr></thead><tbody>{rows.map(row => <tr key={JSON.stringify([row.day,row.platform,row.path])}>
      <td>{row.day}</td><td>{row.platform}</td><td><code>{row.path}</code></td><td>{row.count.toLocaleString(locale)}</td></tr>)}</tbody>
  </table></div>;
}

function DailyBars({ rows }: { rows: GeoRow[] }) {
  const { t, locale } = useI18n();
  const days = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.day, (totals.get(row.day) ?? 0) + row.count);
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  }, [rows]);
  if (!days.length) return null;
  const max = Math.max(1, ...days.map(([, count]) => count));
  return <figure className={s.trend}>
    <figcaption>{t("Daily counts", "每日计数")} <span>{t("Latest 30 dates with matching records", "最近 30 个有匹配记录的日期")}</span></figcaption>
    <div className={s.bars}>{days.map(([day, count]) => <div key={day} className={s.column}
      title={day + " · " + count.toLocaleString(locale)} aria-label={day + " · " + count.toLocaleString(locale)}>
      <i style={{height: Math.max(count ? 3 : 1, 100 * count / max) + "%"}} /></div>)}</div>
    <div className={s.scale}><span>{days[0][0]}</span>{days.length > 1 && <span>{days[days.length - 1][0]}</span>}</div>
  </figure>;
}

function PlatformTotals({ rows, kind }: {rows: GeoRow[]; kind: GeoKind}) {
  const { t, locale } = useI18n();
  const totals = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.platform, (counts.get(row.platform) ?? 0) + row.count);
    return [...counts.entries()].sort(([a, n], [b, m]) => m - n || a.localeCompare(b));
  }, [rows]);
  if (!totals.length) return null;
  return <div className={s.breakdown}>
    <h4>{kind === "GA4" ? t("Sessions by platform", "各平台引荐会话") : t("Requests by crawler", "各爬虫请求数")}</h4>
    <dl>{totals.map(([platform, count]) => <div key={platform}><dt>{platform}</dt><dd>{count.toLocaleString(locale)}</dd></div>)}</dl>
  </div>;
}

function Measurements({ snapshot, kind }: { snapshot: GeoSnapshot; kind: GeoKind }) {
  const { t, locale } = useI18n();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [platform, setPlatform] = useState("");
  const [path, setPath] = useState("");
  const [page, setPage] = useState(0);
  const isGa = kind === "GA4";
  const platforms = useMemo(() => [...new Set(snapshot.rows.map(row => row.platform))].sort(), [snapshot]);
  const filtered = useMemo(() => {
    const search = path.trim().toLowerCase();
    return snapshot.rows.filter(row => (!start || row.day >= start) && (!end || row.day <= end)
      && (!platform || row.platform === platform) && row.path.toLowerCase().includes(search))
      .sort((a,b) => b.day.localeCompare(a.day) || b.count-a.count || a.platform.localeCompare(b.platform) || a.path.localeCompare(b.path));
  }, [snapshot, start, end, platform, path]);
  const dateError = Boolean(start && end && start > end);
  const outsidePeriod = Boolean(
    (end && snapshot.start && end < snapshot.start) || (start && snapshot.end && start > snapshot.end)
  );
  const total = filtered.reduce((sum, row) => sum + row.count, 0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);

  return <section className={s.report}>
    <header className={s.reportHead}><div><h3>{sourceLabel(snapshot.source, t)}</h3>
      <p>{t("Saved", "保存于")} {new Date(snapshot.updatedAt).toLocaleString(locale)}</p></div>
      {snapshot.start && snapshot.end && <span>{snapshot.source === "GA4_API" ? t("Query period", "查询时段") : t("Matched dates", "匹配记录日期")} · {snapshot.start} ~ {snapshot.end}</span>}</header>
    <div className={s.filters}>
      <label>{t("From", "开始日期")}<input type="date" value={start} onChange={e => { setStart(e.target.value); setPage(0); }} /></label>
      <label>{t("Through", "结束日期")}<input type="date" value={end} onChange={e => { setEnd(e.target.value); setPage(0); }} /></label>
      <label>{t("Platform / agent", "平台／爬虫")}<select value={platform} onChange={e => { setPlatform(e.target.value); setPage(0); }}>
        <option value="">{t("All", "全部")}</option>{platforms.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>{t("Page contains", "页面路径包含")}<input value={path} placeholder="/article/" maxLength={500} onChange={e => { setPath(e.target.value); setPage(0); }} /></label>
    </div>
    {(start || end || platform || path) && <div><button type="button" className={s.secondary} onClick={() => {
      setStart(""); setEnd(""); setPlatform(""); setPath(""); setPage(0);
    }}>{t("Clear filters", "清除筛选")}</button></div>}
    {dateError ? <p className={s.error} role="alert">{t("Choose an end date on or after the start date.", "结束日期须晚于或等于开始日期。")}</p>
      : outsidePeriod ? <p className={s.note}>{t("Coverage for these dates is unavailable in this snapshot. Load a report or file for the selected period.", "所选时段的覆盖情况未知。请读取或导入该时段的报表。")}</p> : <>
      <div className={s.metrics}><div><span>{isGa ? t("Matched referral sessions", "匹配的引荐会话") : t("Matched crawler requests", "匹配的爬虫请求")}</span><b>{total.toLocaleString(locale)}</b></div>
        <div><span>{isGa ? t("Observed platforms", "已观察平台") : t("Declared crawlers", "日志声明的爬虫")}</span><b>{new Set(filtered.map(row => row.platform)).size.toLocaleString(locale)}</b></div>
        <div><span>{t("Page paths", "页面路径数")}</span><b>{new Set(filtered.map(row => row.path)).size.toLocaleString(locale)}</b></div>
      </div>
      {filtered.length > 0 && <div className={s.summaryGrid}><DailyBars rows={filtered}/><PlatformTotals rows={filtered} kind={kind}/></div>}
      {filtered.length ? <>
        <RowsTable rows={filtered.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE)} kind={kind} caption={t("Recorded observations", "观测明细")}/>
        <div className={s.pager}><span>{t("{n} rows", "共 {n} 行", { n: filtered.length })} · {visiblePage + 1} / {pageCount}</span><button type="button" className={s.secondary} disabled={!visiblePage} onClick={() => setPage(visiblePage - 1)}>{t("Previous", "上一页")}</button>
          <button type="button" className={s.secondary} disabled={visiblePage === pageCount - 1} onClick={() => setPage(visiblePage + 1)}>{t("Next", "下一页")}</button></div>
      </> : <p className={s.note}>{t("No matching records in this report for the selected filters.", "当前报表中没有符合筛选条件的记录。")}</p>}
    </>}
    <p className={s.note}>{isGa ? t("Session dates follow the GA4 property timezone. Only sessions with an identifiable AI source are counted.", "日期使用 GA4 媒体资源时区。这里统计能识别 AI 来源的会话。") : t("Dates use UTC. Counts reflect request lines and the User-Agent recorded in the imported log.", "日期使用 UTC，计数依据导入日志里的请求行和 User-Agent。")}</p>
    <details className={s.notes}><summary>{t("Source notes", "数据来源说明")}</summary>
      <p>{t("{processed} source rows read · {skipped} rows skipped", "共读取 {processed} 条来源记录，跳过 {skipped} 条。", {processed:snapshot.processed, skipped:snapshot.skipped})}</p>
      {snapshot.notes.length > 0 && <ul>{snapshot.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
    </details>
  </section>;
}

function SiteObservations({siteId, domain, oauthClientId}: SiteProps) {
  const {t} = useI18n();
  const [kind, setKind] = useState<GeoKind>("GA4");
  const [data, setData] = useState<GeoWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true); setLoadError(false);
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/sites/" + encodeURIComponent(siteId) + "/geo-observations", {cache: "no-store", signal: controller.signal});
      if (!response.ok) throw new Error();
      const workspace = await response.json() as GeoWorkspace;
      if (workspace.siteId !== siteId || !workspace.snapshots || !("GA4" in workspace.snapshots) || !("BOT" in workspace.snapshots)) throw new Error();
      if (mounted.current && active.current === controller) setData(workspace);
    } catch {
      if (mounted.current && active.current === controller) setLoadError(true);
    } finally {
      clearTimeout(timeout);
      if (mounted.current && active.current === controller) { setLoading(false); active.current = null; }
    }
  }, [siteId]);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, [refresh]);

  const isGa = kind === "GA4";
  const snapshot = data?.snapshots[kind];
  return <section className={s.panel} aria-label={t("AI traffic measurements", "AI 访问数据")}>
    <div className={s.topbar}>
      <div className={s.tabs} role="group" aria-label={t("Traffic data source", "访问数据类型")}>
        <button type="button" aria-pressed={isGa} onClick={() => setKind("GA4")}><Globe2 size={16}/>{t("AI referrals", "AI 引荐流量")}</button>
        <button type="button" aria-pressed={!isGa} onClick={() => setKind("BOT")}><Bot size={16}/>{t("Crawler requests", "AI 爬虫来访")}</button></div>
      <button type="button" className={s.secondary} disabled={loading} onClick={() => void refresh()}><RefreshCw size={15}/>{t("Refresh", "刷新")}</button>
    </div>
    {loadError && <p className={s.error} role="alert">{t("Could not refresh this site's reports. Check your local session and try Refresh.", "本站报表读取失败，请检查本地登录状态后点击刷新。")}</p>}
    {loading && !data && <p className={s.note} role="status">{t("Loading saved reports…", "正在读取已保存的报表…")}</p>}
    {data && (snapshot ? <Measurements key={kind + snapshot.updatedAt} snapshot={snapshot} kind={kind} /> : <div className={s.empty}>
      <BarChart3 size={28}/><div><h3>{isGa ? t("No referral report yet", "尚无 AI 引荐报表") : t("No crawler log imported", "尚未导入爬虫日志")}</h3>
        <p>{isGa ? t("Read your site's GA4 property or import a saved exploration to see sessions and landing pages.", "读取本站 GA4 媒体资源或导入探索报表后，即可查看引荐会话及着陆页。") : t("Import this site's access log to view requests by crawler, day and page.", "导入本站的访问日志后，即可查看各爬虫的请求日期、页面及次数。")}</p></div></div>)}
    {data && !loadError && <div key={kind} className={s.sources}>
      {isGa && <GeoGaConnection siteId={siteId} domain={domain} oauthClientId={oauthClientId} expectedUpdatedAt={snapshot?.updatedAt ?? null} disabled={loading} onSaved={refresh} />}
      <ImportReport kind={kind} snapshot={snapshot ?? null} siteId={siteId} domain={domain} refresh={refresh}/>
    </div>}
  </section>;
}

export default function GeoObservations(props: SiteProps) {
  return <SiteObservations key={props.siteId} {...props}/>;
}

