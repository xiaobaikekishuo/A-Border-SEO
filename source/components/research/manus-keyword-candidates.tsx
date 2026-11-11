"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileUp, Loader2, Table2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { ManusKeywordCandidate } from "@/lib/manus/keyword-workbook";
import { MAX_WORKBOOK_BYTES } from "@/lib/manus/workbook-limits";

type Preview = {
  rows: ManusKeywordCandidate[];
  source: "manus" | "upload" | null;
  filename: string | null;
  revision: number;
  saved: string[];
};
type Column = "keyword" | "alternateKeyword";
const pageSize = 20;
const maxSelection = 500;
const smallButton = buttonVariants({ size: "sm", variant: "outline" });
const field = "min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const normalize = (word: string) => word.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");

export function filterManusCandidates(rows: ManusKeywordCandidate[], search: string, cluster: string) {
  const needle = normalize(search);
  return rows.filter(row => (!cluster || row.cluster === cluster) && (!needle ||
    [row.keyword, row.alternateKeyword, row.cluster, row.intent, row.priority].some(value => value && normalize(value).includes(needle))));
}

export function selectablePageWords(rows: ManusKeywordCandidate[], column: Column, saved: Set<string>) {
  const unique = new Map<string, string>();
  for (const row of rows) {
    const word = row[column];
    if (!word) continue;
    const key = normalize(word);
    if (!saved.has(key) && !unique.has(key)) unique.set(key, word);
  }
  return [...unique.values()];
}

function previewError(code: string, t: Translator) {
  switch (code) {
    case "missing_key": case "unreadable_key": case "unauthorized": case "forbidden":
      return t("Check your Manus connection or upload the workbook from the private task.", "请检查 Manus 连接，或从私有任务下载工作簿后上传。");
    case "no_workbook": case "not_found":
      return t("No downloadable workbook was found. Open the private task, download the .xlsx file and upload it here.", "未找到可下载的工作簿。请打开私有任务，下载 .xlsx 文件后在此上传。");
    case "workbook_too_large": return t("Use a smaller workbook with fewer rows (up to 5 MiB).", "请减少工作簿行数或大小后重试（最大 5 MiB）。");
    case "invalid_workbook": case "unsupported_workbook":
      return t("This workbook could not be read. Choose an Excel .xlsx file.", "无法读取这份工作簿，请选择 Excel .xlsx 文件。");
    case "no_keyword_rows":
      return t("No keyword rows were recognized. Check that the worksheet includes a keyword column.", "未识别到候选词，请检查工作表是否包含关键词列。");
    case "no_preview": case "preview_changed": case "invalid_selection":
      return t("The preview changed. Review the current rows and select your keywords again.", "预览已更新，请核对当前候选词后重新勾选。");
    case "selection_too_large": return t("Select up to 500 keywords at a time.", "每次最多可勾选 500 个关键词。");
    case "sign_in_required": return t("Sign in again to access the keywords for this site.", "请重新登录以访问此站点的关键词。");
    case "site_not_found": case "task_not_found": return t("This task is no longer available for this site.", "当前站点无法访问此任务。");
    case "save_failed": return t("Could not confirm the save. Retry with the selected keywords.", "未能确认保存结果，可重试保存已勾选的关键词。");
    case "read_failed": return t("Could not read the saved preview. Try loading the preview again.", "未能读取已保存的预览，请重试。");
    default: return t("Could not load the workbook. Try again or upload the .xlsx file from the private task.", "未能加载工作簿，请重试或从 Manus 私有任务下载 .xlsx 文件后上传。");
  }
}

async function readPreview(url: string, init?: RequestInit): Promise<Preview> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "workbook_failed");
  if (!Array.isArray(data.rows) || !Array.isArray(data.saved) || !Number.isInteger(data.revision)) throw new Error("read_failed");
  return data;
}

function CandidateDetails({ row }: { row: ManusKeywordCandidate }) {
  const { t } = useI18n();
  const fields = [
    [t("Content angle", "内容角度"), row.angle],
    [t("Rationale", "推荐理由"), row.rationale],
    [t("Priority basis", "优先级依据"), row.priorityBasis],
    [t("Search volume", "搜索量"), row.volume],
    [t("Difficulty", "难度"), row.difficulty],
    [t("CPC", "每次点击费用"), row.cpc],
    [t("Source", "来源"), row.source],
    [t("Evidence status", "证据状态"), row.evidenceStatus],
    [t("Metric evidence", "指标依据"), row.metricEvidence],
    [t("Demand level", "需求等级"), row.demand],
    [t("Estimated competition", "预估竞争强度"), row.competitionEstimate],
    [t("Notes", "备注"), row.notes],
  ].filter(([, value]) => value);
  if (!fields.length) return null;
  return <details className="mt-1 text-xs">
    <summary className="cursor-pointer text-link">{t("Workbook details", "工作簿详情")}</summary>
    <dl className="mt-2 space-y-2">{fields.map(([label, value]) => <div key={label}>
      <dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words text-muted-foreground">{value}</dd>
    </div>)}</dl>
  </details>;
}

export function ManusCandidateTable({ preview, siteId, disabled, onSave }: {
  preview: Preview; siteId: string; disabled: boolean; onSave: (keywords: string[]) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [cluster, setCluster] = useState("");
  const [column, setColumn] = useState<Column>("keyword");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const saved = new Set(preview.saved.map(normalize));
  const clusters = [...new Set(preview.rows.map(row => row.cluster).filter((value): value is string => !!value))];
  const hasEnglish = preview.rows.some(row => row.alternateKeyword);
  const matches = filterManusCandidates(preview.rows, search, cluster);
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
  const pageWords = selectablePageWords(visible, column, saved).filter(word => !selected.has(normalize(word)));
  const canAddPage = pageWords.length > 0 && selected.size + pageWords.length <= maxSelection;

  function toggle(word: string) {
    const key = normalize(word);
    setSelected(previous => {
      const next = new Map(previous);
      if (next.has(key)) next.delete(key);
      else if (next.size < maxSelection) next.set(key, word);
      return next;
    });
  }

  async function save() {
    if (selected.size && await onSave([...selected.values()])) setSelected(new Map());
  }

  return <div className="space-y-3">
    <p className="break-words text-xs text-muted-foreground">{preview.source === "upload" ? t("Uploaded workbook", "上传的工作簿") : t("Manus attachment", "Manus 附件")} · {preview.filename} · {t("{n} candidates", "{n} 个候选词", { n: preview.rows.length })}</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid min-w-40 flex-1 gap-1 text-xs">{t("Filter keywords", "筛选关键词")}
        <input className={field} type="search" value={search} placeholder={t("Keyword, topic or intent", "关键词、主题或意图")} onChange={e => { setSearch(e.target.value); setPage(0); }} />
      </label>
      {!!clusters.length && <label className="grid max-w-full gap-1 text-xs">{t("Topic cluster", "主题分组")}
        <select className={field} value={cluster} onChange={e => { setCluster(e.target.value); setPage(0); }}>
          <option value="">{t("All topics", "全部主题")}</option>{clusters.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>}
      {hasEnglish && <label className="grid max-w-full gap-1 text-xs">{t("Column to save", "要保存的词列")}
        <select className={field} disabled={disabled} value={column} onChange={e => { setColumn(e.target.value as Column); setSelected(new Map()); }}>
          <option value="keyword">{t("Main keyword", "主要关键词")}</option>
          <option value="alternateKeyword">{t("English keyword", "英文关键词")}</option>
        </select>
      </label>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={smallButton} onClick={() => setSelected(previous => new Map([...previous, ...pageWords.map(word => [normalize(word), word] as const)]))}
        disabled={disabled || !canAddPage}>{t("Select this page", "勾选本页")}</button>
      <button type="button" className={smallButton} onClick={() => setSelected(new Map())} disabled={disabled || !selected.size}>{t("Clear selection", "清空勾选")}</button>
      <button type="button" className={buttonVariants({ size: "sm" })} onClick={() => void save()} disabled={disabled || !selected.size}>
        {t("Save selected ({n})", "保存已选关键词（{n}）", { n: selected.size })}
      </button>
      <Link className="text-xs text-link" href={`/sites/${encodeURIComponent(siteId)}/saved-keywords`}>{t("View saved keywords", "查看已保存关键词")}</Link>
    </div>
    {hasEnglish && selected.size > 0 && <p className="text-xs text-muted-foreground">{t("Switching the keyword column clears the selection.", "切换要保存的词列会清空勾选。")}</p>}
    {selected.size >= maxSelection && <p role="status" className="text-xs text-muted-foreground">{previewError("selection_too_large", t)}</p>}
    {visible.length ? <div className="max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-bg-soft text-xs text-muted-foreground"><tr>
          <th scope="col" className="p-2"><span className="sr-only">{t("Select", "勾选")}</span></th>
          <th scope="col" className="px-2 py-2">{t("Keyword", "关键词")}</th>
          {hasEnglish && <th scope="col" className="px-2 py-2">{t("English keyword", "英文关键词")}</th>}
          <th scope="col" className="px-2 py-2">{t("Topic / intent", "主题 / 意图")}</th>
          <th scope="col" className="px-2 py-2">{t("Priority", "优先级")}</th>
        </tr></thead>
        <tbody>{visible.map(row => {
          const word = row[column];
          const key = word && normalize(word);
          const alreadySaved = !!key && saved.has(key);
          const checked = !!key && selected.has(key);
          return <tr key={JSON.stringify([row.keyword, row.alternateKeyword])} className="border-t border-border-soft align-top">
            <td className="p-2"><input type="checkbox" aria-label={word ? t("Select {word}", "勾选 {word}", { word }) : t("No English keyword", "无英文关键词")}
              disabled={disabled || !word || alreadySaved || (!checked && selected.size >= maxSelection)} checked={checked} onChange={() => word && toggle(word)} /></td>
            <td className="min-w-32 break-words px-2 py-2"><span className="font-medium">{row.keyword}</span>{saved.has(normalize(row.keyword)) && <div className="text-xs text-muted-foreground">{t("Already saved", "已保存")}</div>}<CandidateDetails row={row} /></td>
            {hasEnglish && <td className="min-w-32 break-words px-2 py-2">{row.alternateKeyword}{row.alternateKeyword && saved.has(normalize(row.alternateKeyword)) && <div className="text-xs text-muted-foreground">{t("Already saved", "已保存")}</div>}</td>}
            <td className="min-w-24 px-2 py-2">{row.cluster}<div className="text-xs text-muted-foreground">{row.intent}</div></td>
            <td className="px-2 py-2">{row.priority}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">{t("No keywords match these filters.", "没有符合筛选条件的关键词。")}</p>}
    {!!visible.length && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>{t("{from}–{to} of {n}", "第 {from} 至 {to} 条，共 {n} 条", { from: page * pageSize + 1, to: page * pageSize + visible.length, n: matches.length })}</span>
      {pages > 1 && <><button type="button" className={smallButton} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("Previous", "上一页")}</button>
        <button type="button" className={smallButton} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t("Next", "下一页")}</button></>}
    </div>}
  </div>;
}

export function ManusKeywordCandidates({ siteId, taskId, connected }: { siteId: string; taskId: string; connected: boolean }) {
  const { t } = useI18n();
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/manus-keywords/${encodeURIComponent(taskId)}`;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ added: number; skipped: number } | null>(null);
  const lock = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    lock.current = true;
    readPreview(`${endpoint}/candidates`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setPreview(data); })
      .catch(() => { if (!controller.signal.aborted) setError("read_failed"); })
      .finally(() => { if (!controller.signal.aborted) { lock.current = false; setBusy(false); } });
    return () => controller.abort();
  }, [endpoint]);

  async function load(mode: "cached" | "manus" | "upload", file?: File) {
    if (lock.current) return;
    setError("");
    setReceipt(null);
    if (file && (!/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_WORKBOOK_BYTES)) {
      setError(file.size > MAX_WORKBOOK_BYTES ? "workbook_too_large" : "invalid_workbook");
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const response = await readPreview(`${endpoint}/candidates`, file ? {
        method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "x-workbook-name": encodeURIComponent(file.name) },
      } : { method: mode === "cached" ? "GET" : "POST" });
      setPreview(response);
    } catch (err) { setError(err instanceof Error ? err.message : "workbook_failed"); }
    finally { lock.current = false; setBusy(false); }
  }

  async function save(keywords: string[]) {
    if (lock.current || !preview?.revision || !keywords.length) return false;
    lock.current = true;
    setBusy(true); setError(""); setReceipt(null);
    try {
      const response = await fetch(`${endpoint}/save`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: preview.revision, keywords }) });
      const data = await response.json();
      if (!response.ok) {
        if (["preview_changed", "no_preview", "invalid_selection"].includes(data.error)) {
          setPreview(await readPreview(`${endpoint}/candidates`));
        }
        setError(data.error || "save_failed"); return false;
      }
      setPreview({ ...preview, saved: [...preview.saved, ...keywords] });
      setReceipt({ added: data.added, skipped: data.skipped });
      return true;
    } catch { setError("save_failed"); return false; }
    finally { lock.current = false; setBusy(false); }
  }

  const hasRows = !!preview?.rows.length;
  return <section aria-busy={busy} className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-semibold text-text-strong">{t("Keyword candidates", "候选关键词")}</h4>
      <div className="flex flex-wrap items-center gap-2">
        {error === "read_failed" && <button type="button" className={smallButton} disabled={busy} onClick={() => void load("cached")}>{t("Retry preview", "重试读取预览")}</button>}
        <button type="button" disabled={busy || !connected} className={smallButton} onClick={() => void load("manus")}><Table2 />
          {hasRows ? t("Reload Manus workbook", "重新读取 Manus 工作簿") : t("Load keywords from task", "读取任务关键词")}</button>
        <label className={`${smallButton} cursor-pointer focus-within:outline-2 focus-within:outline-ring has-disabled:opacity-60`}><FileUp />{t("Upload .xlsx", "上传 .xlsx")}
          <input type="file" className="sr-only" disabled={busy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void load("upload", file);
          }} />
        </label>
      </div>
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Updating keywords…", "正在更新关键词…")}</p>}
    {error && <p role="alert" className="text-sm text-danger">{previewError(error, t)}</p>}
    {receipt && <p role="status" className="text-sm">{t("Saved {added} to this site. {skipped} already saved.", "已向本站保存 {added} 个关键词，另有 {skipped} 个已保存。", receipt)}</p>}
    {!hasRows && !busy && <p className="text-sm text-muted-foreground">{t("Read this task’s workbook, or download it from the private task and upload it here (up to 5 MiB).", "可读取此任务的工作簿，也可以从 Manus 私有任务下载后上传（最大 5 MiB）。")}</p>}
    {preview && hasRows && <ManusCandidateTable key={preview.revision} preview={preview} siteId={siteId} disabled={busy} onSave={save} />}
  </section>;
}
