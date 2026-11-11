"use client";

import { useI18n } from "@/lib/i18n/client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ExternalLink, FileText, Info, ListChecks, Pencil, Save, Search, Trash2 } from "lucide-react";
import { Modal, FunnelBadge } from "./planner-ui";
import { getPlannerLabels, formatCount, linkEvidenceLabel, safeSiteUrl, shortDate, type Cluster, type ClusterRow, type ContentStatus, type Funnel, type Pillar } from "./model";
import type { Mutation } from "./planner-forms";
import { BULK_LIMIT, addLimitedSelection, bulkUpdateData } from "./bulk-model";
import { plannerApiError } from "./api-messages";
import s from "./planner.module.css";
import b from "./bulk.module.css";

type Submit = (mutation: Mutation) => Promise<Record<string, unknown> | null>;
function SelectionCheckbox({ checked, partial, disabled, onChange }: { checked: boolean; partial: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" aria-label={t("Select filtered results, up to 50 items", "勾选当前筛选结果，最多 50 条")} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}

export function ManagedArticleTable({ rows, allRows, pillars, domain, busy, error, onBrief, onEdit, onDelete, onStatus, onSubmit, onClearError, onUpdated }: {
  rows: ClusterRow[]; allRows: ClusterRow[]; pillars: Pillar[]; domain: string; busy: boolean; error: string | null;
  onBrief: (row: Cluster) => void; onEdit: (row: Cluster) => void; onDelete: (row: Cluster) => void;
  onStatus: (row: Cluster, status: ContentStatus) => Promise<void>; onSubmit: Submit; onClearError: () => void; onUpdated: (count: number) => void;
}) {
  const { t } = useI18n();
  const { STATUSES, SOURCE_LABELS } = getPlannerLabels(t);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const selectedRows = useMemo(() => allRows.filter(row => selectedIds.includes(row.id)), [allRows, selectedIds]);
  const selected = new Set(selectedRows.map(row => row.id));
  const visibleSelected = rows.filter(row => selected.has(row.id)).length;
  const allVisibleSelected = rows.length > 0 && visibleSelected === rows.length;
  const hiddenSelected = selectedRows.length - visibleSelected;
  function add(ids: string[]) {
    const merged = addLimitedSelection(selectedRows.map(row => row.id), ids);
    setSelectedIds(merged.ids);
    setSelectionNotice(merged.omitted ? t("Each batch allows up to {v0} items. {v1} additional items were not selected; narrow the filter or use another batch.", "每批最多 {v0} 条。已勾选当前可容纳的条目，另有 {v1} 条未勾选；请缩小筛选或分批处理。", { v0: BULK_LIMIT, v1: merged.omitted }) : null);
  }
  function toggleVisible(checked: boolean) {
    if (checked) add(rows.map(row => row.id));
    else { const visibleIds = new Set(rows.map(row => row.id)); setSelectedIds(previous => previous.filter(id => !visibleIds.has(id))); setSelectionNotice(null); }
  }
  return <>
    <div className={b.manageBar} role="region" aria-label={t("Bulk article actions", "文章批量操作")}><div><ListChecks size={18} /><span>{t("Selected ", "已选")} <strong>{selectedRows.length}</strong> / {BULK_LIMIT} {t(" items", "条")}{hiddenSelected > 0 && <small>{t("Including ", "其中")} {hiddenSelected} {t(" outside the current filter", "条不在当前筛选中")}</small>}</span></div><div><button className={s.textButton} onClick={() => add(rows.map(row => row.id))} disabled={busy || !rows.length}>{t("Select filtered results", "勾选当前筛选结果")}</button><button className={s.textButton} disabled={busy || !selectedRows.length} onClick={() => { setSelectedIds([]); setSelectionNotice(null); }}>{t("Clear selection", "清空勾选")}</button><button className={s.secondary} disabled={busy || !selectedRows.length} onClick={() => { onClearError(); setEditing(true); }}><Pencil size={14} />{t("Bulk edit (", "批量修改（")}{selectedRows.length}{t(")", "）")}</button></div></div>
    {selectionNotice && <p className={b.warning} role="status">{selectionNotice}</p>}
    {!rows.length ? <div className={b.empty}><Search size={27} /><h3>{allRows.length ? t("No articles match the current filter", "没有符合当前筛选的文章") : t("No topics or articles yet", "还没有选题或已有文章")}</h3><p>{allRows.length ? t("Adjust the filters; earlier selections are preserved.", "可以调整筛选；之前勾选的文章仍然保留。") : t("Add a topic or import existing articles from the crawl inventory.", "可添加选题，或从抓取库存导入已有文章。")}</p></div> : <div className={s.tableScroll}><table className={`${s.table} ${b.manageTable}`}><thead><tr><th className={b.selectionCell}><SelectionCheckbox checked={allVisibleSelected} partial={visibleSelected > 0 && !allVisibleSelected} disabled={busy} onChange={toggleVisible} /></th><th>{t("Article / Schedule", "文章信息 / 排期")}</th><th>{t("Pillar / Keyword", "所属主题 / 目标词")}</th><th>{t("Funnel stage", "读者阶段")}</th><th>{t("Actual GSC data", "真实 GSC 数据")}</th><th>{t("Page / Link observations", "页面与内链观察")}</th><th>{t("Production status", "生产状态")}</th><th>{t("Actions", "操作")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={selected.has(row.id) ? b.selectedTableRow : ""}><td className={b.selectionCell}><input type="checkbox" aria-label={t("Select article: {v0}", "勾选文章：{v0}", { v0: row.title })} checked={selected.has(row.id)} disabled={busy || (!selected.has(row.id) && selectedRows.length >= BULK_LIMIT)} onChange={event => event.target.checked ? add([row.id]) : setSelectedIds(previous => previous.filter(id => id !== row.id))} /></td><td><button className={s.rowTitle} onClick={() => onBrief(row)}>{row.title}</button><div className={s.rowMeta}><span className={row.source === "EXAMPLE" ? s.exampleBadge : s.subtleBadge}>{SOURCE_LABELS[row.source]}</span><span><CalendarDays size={12} />{shortDate(row.scheduledFor, t)}</span></div></td><td><span className={s.pillarName}>{row.pillarTitle}</span><span className={s.keyword}>{row.keyword}</span></td><td><FunnelBadge funnel={row.funnel} /><small className={s.cellHint}>{row.intent || t("Intent not specified", "未填写具体意图")}</small></td><td>{row.performance ? <><strong className={s.gscValue}>{formatCount(row.performance.clicks, t)} <small>{t("Clicks", "点击")}</small> / {formatCount(row.performance.impressions, t)} <small>{t("Impressions", "曝光")}</small></strong><small className={s.cellHint}>{t("Average position ", "平均位置")} {row.performance.position == null ? t("Unknown", "未知") : row.performance.position.toFixed(1)}</small><small className={s.cellHint}>{shortDate(row.performance.period.startDate, t)} {t("to", "至")} {shortDate(row.performance.period.endDate, t)}</small></> : <><span className={s.muted}>{t("No data", "暂无数据")}</span><small className={s.cellHint}>{row.url ? t("No saved GSC data for the linked URL", "关联 URL 尚无已存 GSC 记录") : t("Link a page to match its data", "关联页面后可匹配数据")}</small></>}</td><td>{safeSiteUrl(row.url, domain) ? <a className={s.pageLink} href={safeSiteUrl(row.url, domain)!} target="_blank" rel="noreferrer">{t("Linked page", "已有关联页面")}<ExternalLink size={12} /></a> : <span className={s.muted}>{t("No linked URL", "尚未关联 URL")}</span>}<small className={s.cellHint}>{linkEvidenceLabel(row.linkEvidence, t)}</small>{row.linkEvidence && <small className={s.cellHint}>{shortDate(row.linkEvidence.crawlAt, t)}{row.linkEvidence.sampleLimited ? t(" · Limited sample", " · 有限样本") : t(" · Crawl observation", " · 抓取观察")}</small>}</td><td><select className={s.statusSelect} aria-label={t("Update status for “{v0}”", "更新“{v0}”的状态", { v0: row.title })} value={row.status} disabled={busy} onChange={event => { void onStatus(row, event.target.value as ContentStatus); }}>{(Object.keys(STATUSES) as ContentStatus[]).map(key => <option key={key} value={key}>{STATUSES[key]}</option>)}</select></td><td><div className={s.rowActions}><button className={s.briefButton} onClick={() => onBrief(row)}><FileText size={14} />{t("Brief", "简报")}</button><button className={s.iconButton} aria-label={t("Edit topic: {v0}", "编辑选题：{v0}", { v0: row.title })} onClick={() => onEdit(row)}><Pencil size={14} /></button><button className={s.iconButton} aria-label={t("Delete topic: {v0}", "删除选题：{v0}", { v0: row.title })} onClick={() => onDelete(row)}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>}
    {editing && <BulkUpdateDialog selectedRows={selectedRows} pillars={pillars} busy={busy} error={error} onClose={() => { if (!busy) setEditing(false); }} onSubmit={onSubmit} onSuccess={count => { setSelectedIds([]); setSelectionNotice(null); setEditing(false); onUpdated(count); }} />}
  </>;
}

export function BulkUpdateDialog({ selectedRows, pillars, busy, error, onClose, onSubmit, onSuccess }: {
  selectedRows: ClusterRow[]; pillars: Pillar[]; busy: boolean; error: string | null; onClose: () => void; onSubmit: Submit; onSuccess: (count: number) => void;
}) {
  const { t } = useI18n();
  const { FUNNELS, STATUSES } = getPlannerLabels(t);
  const [fields, setFields] = useState({ pillarId: "", funnel: "", status: "" });
  const [resultError, setResultError] = useState<string | null>(null);
  const changes = bulkUpdateData(fields);
  return <Modal title={t("Bulk edit {v0} articles", "批量修改 {v0} 条文章", { v0: selectedRows.length })} eyebrow={t("BULK MANAGE · Manual organization", "BULK MANAGE · 人工归类")} description={t("Only selected fields are changed. Fields left unchanged are not submitted.", "仅修改明确选择的字段；留为“不变”的字段不会提交。")} onClose={busy ? () => {} : onClose}>
    {(error || resultError) && <div className={`${s.notice} ${s.noticeError}`} role="alert"><Info size={17} /><div>{plannerApiError(error || resultError || "", t)}<p>{t("Your selection and settings are preserved. A conflict prevents the entire batch update; adjust the pillar or selection.", "勾选和设置仍保留。冲突时整批不更新，可调整目标主题或返回修改勾选。")}</p></div></div>}
    <form className={s.form} onSubmit={async event => {
      event.preventDefault(); if (!Object.keys(changes).length || !selectedRows.length) return;
      setResultError(null);
      const response = await onSubmit({ action: "bulkUpdateClusters", clusterIds: selectedRows.map(row => row.id), data: changes });
      if (!response) return;
      if (typeof response.updated !== "number") { setResultError(t("The server responded without an update count. Reload planning to check the result.", "服务器已响应，但更新数量缺失。请重新读取规划确认结果。")); return; }
      onSuccess(response.updated);
    }}>
      <label>{t("Assigned pillar", "归属总览主题")}<select aria-label={t("Move selected articles to pillar", "批量移动到主题")} value={fields.pillarId} onChange={event => setFields({ ...fields, pillarId: event.target.value })} disabled={busy}><option value="">{t("Unchanged · Keep existing pillars", "不变 · 保留各自主题")}</option>{pillars.map(pillar => <option key={pillar.id} value={pillar.id}>{pillar.title}</option>)}</select></label>
      <label>{t("Funnel stage", "读者阶段")}<select aria-label={t("Change funnel stage in bulk", "批量修改读者阶段")} value={fields.funnel} onChange={event => setFields({ ...fields, funnel: event.target.value })} disabled={busy}><option value="">{t("Unchanged · Keep existing stages", "不变 · 保留各自阶段")}</option>{(Object.keys(FUNNELS) as Funnel[]).map(funnel => <option key={funnel} value={funnel}>{funnel} · {FUNNELS[funnel].label}</option>)}</select></label>
      <label>{t("Production status", "生产状态")}<select aria-label={t("Change production status in bulk", "批量修改生产状态")} value={fields.status} onChange={event => setFields({ ...fields, status: event.target.value })} disabled={busy}><option value="">{t("Unchanged · Keep existing statuses", "不变 · 保留各自状态")}</option>{(Object.keys(STATUSES) as ContentStatus[]).map(status => <option key={status} value={status}>{STATUSES[status]}</option>)}</select></label>
      <p className={b.help}>{t("Titles, keywords, URLs, schedules, and briefs stay unchanged. This updates local planning only, not published content.", "标题、关键词、URL、排期和简报保持不变。本次仅调整本地规划，不会更新远程正文。")}</p>
      <details className={b.selectedDetails}><summary>{t("View selected ", "查看已选")} {selectedRows.length} {t(" articles", "条文章")}</summary><ul>{selectedRows.map(row => <li key={row.id}><strong>{row.title}</strong><small>{row.pillarTitle} · {row.keyword}</small></li>)}</ul></details>
      <div className={s.formActions}><button type="button" className={s.secondary} onClick={onClose} disabled={busy}>{t("Back, keep selection", "返回保留勾选")}</button><button className={s.primary} disabled={busy || !selectedRows.length || !Object.keys(changes).length}><Save size={15} />{busy ? t("Updating…", "正在更新…") : t("Update {v0} articles", "更新 {v0} 条文章", { v0: selectedRows.length })}</button></div>
    </form>
  </Modal>;
}
