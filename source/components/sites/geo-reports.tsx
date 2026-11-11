"use client";

import { useCallback, useEffect, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { AiReports, StoredAiReport } from "@/lib/geo/report-store";
import { decodeReportBytes, parseReportFiles, REPORT_LIMITS, type ReportKind } from "@/lib/geo/reports";
import { zipCsvEntries } from "@/lib/geo/zip";
import { geoErrorMessage } from "./geo-errors";
import { announceGeoUpdate } from "./geo-events";

type Props = { siteId: string; domain: string };
type Parsed = ReturnType<typeof parseReportFiles>;

function errorMessage(error: unknown, t: Translator): string {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, [string, string]> = {
    report_files: [`Choose 1 to ${REPORT_LIMITS.files} files.`, `请选择 1 到 ${REPORT_LIMITS.files} 个文件。`],
    report_too_large: ["A file is too large (up to 5 MB and 5,000 rows each).", "文件太大（每个最多 5 MB、5,000 行）。"],
    report_unrecognised: ["No report table was found. Choose the CSV files of the export.", "没有找到报表表格，请选择导出的 CSV 文件。"],
    report_wrong_kind: ["These files belong to the other report.", "这些文件属于另一个报表。"],
    report_not_ai: ["This is the ordinary performance report (it has position and CTR). Export the generative AI report instead.", "这是普通的效果报告（含排名和点击率），请导出“生成式 AI”报告。"],
    report_duplicate_table: ["Two files hold the same table. Choose each table once.", "有两个文件是同一张表，每张表只选一次。"],
    report_duplicate_day: ["A day appears twice in the daily table.", "每日表中有重复的日期。"],
    report_empty: ["The files have no usable rows.", "文件中没有可用的数据行。"],
    geo_csv_invalid: ["A file is not valid CSV.", "有文件不是有效的 CSV。"],
    zip_invalid: ["The zip file is damaged.", "zip 文件已损坏。"],
    zip_unsupported: ["This zip format is not supported. Unzip it and choose the CSV files.", "不支持这种 zip 格式，请解压后选择其中的 CSV 文件。"],
    zip_too_large: ["The zip holds too much data.", "zip 中的数据太多。"],
  };
  const message = messages[code];
  return message ? t(message[0], message[1]) : code;
}

async function readFiles(list: FileList): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  for (const file of Array.from(list)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      for (const entry of await zipCsvEntries(bytes)) out.push({ name: entry.name, text: decodeReportBytes(entry.bytes) });
    } else {
      out.push({ name: file.name, text: decodeReportBytes(bytes) });
    }
  }
  return out;
}

function total(report: Pick<StoredAiReport, "daily" | "pages">): number {
  return report.daily.length ? report.daily.reduce((sum, d) => sum + d.value, 0) : report.pages.reduce((sum, p) => sum + p.value, 0);
}

function ReportCard({ kind, siteId, domain, stored, onSaved }: { kind: ReportKind; siteId: string; domain: string; stored: StoredAiReport | null; onSaved: (reports: AiReports) => void }) {
  const { t } = useI18n();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const gsc = kind === "GSC_AI";
  const metric = gsc ? t("impressions", "次展示") : t("citations", "次引用");

  async function choose(list: FileList | null) {
    setError("");
    setParsed(null);
    if (!list?.length) return;
    try {
      setParsed(parseReportFiles(kind, await readFiles(list), domain));
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }

  async function send(method: "POST" | "DELETE") {
    setBusy(true);
    setError("");
    try {
      const res = method === "POST"
        ? await fetch(`/api/sites/${siteId}/geo/reports`, {
            method, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind, daily: parsed!.daily, pages: parsed!.pages, queries: parsed!.queries, countries: parsed!.countries, devices: parsed!.devices,
              tables: parsed!.tables, skipped: parsed!.skipped, truncated: parsed!.truncated, ignored: parsed!.ignored.slice(0, 40).map(n => n.slice(0, 200)),
              expectedUpdatedAt: stored?.updatedAt ?? null,
            }),
          })
        : await fetch(`/api/sites/${siteId}/geo/reports?kind=${kind}`, { method });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("Saving failed.", "保存失败。")));
      setParsed(null);
      onSaved(body as AiReports);
      announceGeoUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-3 rounded-lg border border-border p-4">
    <div>
      <h3 className="font-medium">{gsc ? t("Search Console: generative AI", "Search Console：生成式 AI") : t("Bing Webmaster Tools: AI Performance", "Bing 网站管理员工具：AI 表现")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{gsc
        ? t("Impressions of the site's pages in AI Overviews and AI Mode. In Search Console open the generative AI report, choose Export → Download CSV, and pick the downloaded zip (or the CSV files in it). Search Console offers no API for this report.", "网站页面在 AI 概览和 AI 模式中的展示。在 Search Console 打开“生成式 AI”报告，选择“导出 → 下载 CSV”，再选择下载的 zip（或其中的 CSV 文件）。该报告没有 API。")
        : t("How often Copilot and Bing's AI answers cite the site. In Bing Webmaster Tools open AI Performance and export each table (daily, pages, grounding queries) as CSV, then pick them together.", "Copilot 和 Bing AI 回答引用网站的次数。在 Bing 网站管理员工具打开“AI 表现”，把每张表（每日、网页、依据查询）分别导出为 CSV，再一起选择。")}</p>
    </div>
    {stored && <div className="space-y-2 text-sm">
      <div><strong>{total(stored).toLocaleString()}</strong> {metric}{stored.start && stored.end ? ` · ${stored.start} – ${stored.end}` : ""}</div>
      <div className="text-xs text-muted-foreground">{t("Imported {at}", "导入于 {at}", { at: new Date(stored.updatedAt).toLocaleString() })}{stored.skipped ? " · " + t("{n} rows skipped", "跳过 {n} 行", { n: stored.skipped }) : ""}</div>
      {stored.pages.length > 0 && <div>
        <div className="text-xs font-medium">{t("Top pages", "热门页面")}</div>
        <ul className="mt-1 space-y-0.5 text-xs">{stored.pages.slice(0, 5).map(p => <li key={p.url} className="flex justify-between gap-3"><span className="truncate font-mono">{p.url.replace(/^https?:\/\//, "")}</span><span>{p.value.toLocaleString()}</span></li>)}</ul>
      </div>}
      {stored.queries.length > 0 && <div>
        <div className="text-xs font-medium">{gsc ? t("Top queries", "热门查询") : t("Grounding queries", "依据查询")}</div>
        <ul className="mt-1 space-y-0.5 text-xs">{stored.queries.slice(0, 5).map(q => <li key={q.query} className="flex justify-between gap-3"><span className="truncate">{q.query}</span><span>{q.value.toLocaleString()}{q.share !== null ? ` · ${Math.round(q.share * 100)}%` : ""}</span></li>)}</ul>
      </div>}
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
        <FileUp size={14} />{stored ? t("Import again", "重新导入") : t("Choose files", "选择文件")}
        <input type="file" className="sr-only" multiple accept=".csv,.zip,text/csv,application/zip" onChange={e => { void choose(e.target.files); e.target.value = ""; }} />
      </label>
      {stored && <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-danger disabled:opacity-50" disabled={busy} onClick={() => { if (window.confirm(t("Delete this imported report?", "删除这份已导入的报表？"))) void send("DELETE"); }}>
        <Trash2 size={14} />{t("Delete", "删除")}
      </button>}
    </div>
    {parsed && <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
      <div>{t("Found {tables}: {n} {metric}", "识别到 {tables}：共 {n} {metric}", { tables: parsed.tables.join(", "), n: total(parsed).toLocaleString(), metric })}{parsed.start && parsed.end ? ` · ${parsed.start} – ${parsed.end}` : ""}</div>
      {(parsed.skipped > 0 || parsed.ignored.length > 0 || parsed.truncated > 0) && <div className="text-xs text-muted-foreground">
        {parsed.skipped > 0 && <div>{t("{n} rows skipped (empty, another site, or unreadable).", "跳过 {n} 行（空行、其他网站或无法识别）。", { n: parsed.skipped })}</div>}
        {parsed.truncated > 0 && <div>{t("{n} rows beyond the kept limit left out.", "超出保存上限的 {n} 行未保留。", { n: parsed.truncated })}</div>}
        {parsed.ignored.length > 0 && <div>{t("Not a report table: {files}", "不是报表表格：{files}", { files: parsed.ignored.join(", ") })}</div>}
      </div>}
      <div className="flex gap-2">
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void send("POST")}>{busy ? t("Saving…", "保存中…") : stored ? t("Replace the saved report", "替换已保存的报表") : t("Save", "保存")}</button>
        <button type="button" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted" onClick={() => setParsed(null)}>{t("Cancel", "取消")}</button>
      </div>
    </div>}
    {error && <p className="text-sm text-danger" role="alert">{error}</p>}
  </div>;
}

export default function GeoReports({ siteId, domain }: Props) {
  const { t } = useI18n();
  const [reports, setReports] = useState<AiReports | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sites/${siteId}/geo/reports`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("Could not load the reports.", "无法加载报表。")));
      setReports(body as AiReports);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [siteId, t]);
  useEffect(() => { void load(); }, [load]);

  return <section className="panel space-y-4 p-5">
    <div>
      <h2 className="font-semibold">{t("Platform AI reports", "平台官方 AI 报表")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Google and Microsoft report how their AI answers use the site. Import the exports here; the files are read in this browser and only the report rows are saved.", "Google 和微软会报告其 AI 回答如何使用网站。在这里导入导出文件；文件在浏览器中读取，只保存报表数据行。")}</p>
    </div>
    {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    {reports && <div className="grid gap-4 lg:grid-cols-2">
      <ReportCard kind="GSC_AI" siteId={siteId} domain={domain} stored={reports.GSC_AI} onSaved={setReports} />
      <ReportCard kind="BING_AI" siteId={siteId} domain={domain} stored={reports.BING_AI} onSaved={setReports} />
    </div>}
  </section>;
}
