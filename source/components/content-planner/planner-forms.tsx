"use client";

import { useI18n } from "@/lib/i18n/client";

import { useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { getPlannerLabels, type Brief, type Cluster, type ContentStatus, type Funnel, type Pillar } from "./model";
import s from "./planner.module.css";

export type Mutation = { action: string; [key: string]: unknown };
type SaveHandler = (mutation: Mutation) => Promise<void>;
export function PillarForm({ item, domain, busy, onSave, onCancel }: { item?: Pillar; domain: string; busy: boolean; onSave: SaveHandler; onCancel: () => void }) {
  const { t } = useI18n();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = Object.fromEntries(["title", "keyword", "description", "audience", "goal", "url"].map(key => [key, String(form.get(key) ?? "").trim()]));
    await onSave({ action: item ? "updatePillar" : "createPillar", ...(item ? { pillarId: item.id } : {}), data });
  }
  return <form onSubmit={submit} className={s.form}>
    <label>{t("Pillar title", "总览主题名称")} <span>*</span><input name="title" defaultValue={item?.title} required maxLength={200} placeholder={t("Example: Apple ID regions and usage guide", "例如：Apple ID 地区与使用指南")} autoFocus /></label>
    <label>{t("Core keyword", "核心关键词")} <span>*</span><input name="keyword" defaultValue={item?.keyword} required maxLength={200} placeholder={t("Example: Apple ID regions", "例如：Apple ID 地区")} /></label>
    <label>{t("Pillar description", "主题说明")}<textarea name="description" rows={3} defaultValue={item?.description} placeholder={t("Describe which questions this pillar covers and what is outside its scope.", "说明这个主题覆盖哪些问题，以及不覆盖哪些内容。")} /></label>
    <div className={s.formGrid}><label>{t("Target audience", "目标读者")}<input name="audience" defaultValue={item?.audience} placeholder={t("Example: People learning about App Store regions", "例如：初次了解不同地区 App Store 的用户")} /></label><label>{t("Content goal", "内容目标")}<input name="goal" defaultValue={item?.goal} placeholder={t("Example: Help readers understand differences and check requirements", "例如：帮助读者理解差异并确认适用条件")} /></label></div>
    <label>{t("Published pillar page URL", "已发布的总览页 URL")}<input name="url" type="url" defaultValue={item?.url ?? ""} placeholder={`https://${domain}/article/your-guide`} /><small>{t("You can add this later. Link pages on this site only. GSC data comes from saved sync records.", "可稍后填写。仅关联本网站页面，GSC 数据来自已保存的同步记录。")}</small></label>
    <div className={s.formActions}><button type="button" className={s.secondary} onClick={onCancel} disabled={busy}>{t("Cancel", "取消")}</button><button className={s.primary} disabled={busy}><Save size={16} />{busy ? t("Saving…", "保存中…") : t("Save pillar", "保存主题")}</button></div>
  </form>;
}

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function ClusterForm({ item, pillars, initialPillarId, initialFunnel, domain, busy, onSave, onCancel }: {
  item?: Cluster; pillars: Pillar[]; initialPillarId?: string; initialFunnel?: Funnel; domain: string; busy: boolean; onSave: SaveHandler; onCancel: () => void;
}) {
  const { t } = useI18n();
  const { FUNNELS, STATUSES } = getPlannerLabels(t);
  const [editBrief, setEditBrief] = useState(Boolean(item?.brief));
  const [formError, setFormError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const linkLines = lines(form.get("internalLinks"));
    if (editBrief && linkLines.some(line => { const parts = line.split("|"); return parts.length < 3 || parts.some(part => !part.trim()); })) {
      setFormError(t("Enter each internal link as: Title | URL | Reason.", "每条站内链接请填写完整的“标题 | URL | 关联理由”。"));
      return;
    }
    setFormError(null);
    let brief: Brief | null = item?.brief ?? null;
    if (editBrief) brief = {
      summary: text("summary"), audience: text("briefAudience"), searchIntent: text("searchIntent"), angle: text("angle"),
      outline: lines(form.get("outline")), keyPoints: lines(form.get("keyPoints")), cta: text("cta"),
      internalLinks: lines(form.get("internalLinks")).map(line => { const [title = "", target = "", ...rest] = line.split("|").map(part => part.trim()); return { title, target, reason: rest.join(" | ") }; }).filter(link => link.target),
      evidenceNotes: lines(form.get("evidenceNotes")),
    };
    const data = { title: text("title"), keyword: text("keyword"), funnel: text("funnel") as Funnel,
      intent: text("intent"), contentType: text("contentType"), status: text("status") as ContentStatus,
      url: text("url") || null, scheduledFor: text("scheduledFor") ? `${text("scheduledFor")}T00:00:00.000Z` : null, brief };
    await onSave({ action: item ? "updateCluster" : "createCluster", ...(item ? { clusterId: item.id } : { pillarId: text("pillarId") }), data });
  }
  return <form onSubmit={submit} className={s.form}>
    {formError && <p role="alert" className={s.formError}>{formError}</p>}
    <label>{t("Parent pillar", "所属总览主题")} <span>*</span><select name="pillarId" defaultValue={item?.pillarId ?? initialPillarId ?? pillars[0]?.id} disabled={Boolean(item)} required>{pillars.map(pillar => <option value={pillar.id} key={pillar.id}>{pillar.title}</option>)}</select></label>
    <label>{t("Topic title", "选题标题")} <span>*</span><input name="title" defaultValue={item?.title} required maxLength={250} placeholder={t("Example: How do App Store and iCloud accounts differ?", "例如：App Store 与 iCloud 账号有什么区别？")} autoFocus /></label>
    <div className={s.formGrid}><label>{t("Target keyword", "目标关键词")} <span>*</span><input name="keyword" defaultValue={item?.keyword} required maxLength={200} placeholder={t("App Store vs iCloud", "App Store 与 iCloud 区别")} /></label><label>{t("Funnel stage", "读者阶段")}<select name="funnel" defaultValue={item?.funnel ?? initialFunnel ?? "TOFU"}>{(Object.keys(FUNNELS) as Funnel[]).map(key => <option value={key} key={key}>{key} · {FUNNELS[key].label}</option>)}</select></label></div>
    <div className={s.formGrid}><label>{t("Search intent", "搜索意图")}<input name="intent" defaultValue={item?.intent ?? t("Informational", "信息了解")} placeholder={t("Example: Understand differences, compare options, check steps", "例如：了解区别、比较方案、核对步骤")} /></label><label>{t("Content format", "内容形式")}<input name="contentType" defaultValue={item?.contentType ?? t("Guide", "指南")} placeholder={t("Guide / Comparison / Checklist / FAQ", "指南 / 对比 / 检查清单 / FAQ")} /></label></div>
    <div className={s.formGrid}><label>{t("Production status", "生产状态")}<select name="status" defaultValue={item?.status ?? "PLANNED"}>{(Object.keys(STATUSES) as ContentStatus[]).map(key => <option key={key} value={key}>{STATUSES[key]}</option>)}</select></label><label>{t("Scheduled date", "计划日期")}<input type="date" name="scheduledFor" defaultValue={item?.scheduledFor?.slice(0, 10) ?? ""} /></label></div>
    <label>{t("Published page URL", "实际页面 URL")}<input type="url" name="url" defaultValue={item?.url ?? ""} placeholder={`https://${domain}/article/your-topic`} /><small>{t("Status records local work progress only; it does not publish content.", "状态只记录本地工作进度，不会向网站发布内容。")}</small></label>
    <label className={s.checkboxLabel}><input type="checkbox" checked={editBrief} onChange={event => setEditBrief(event.target.checked)} />{item?.brief ? t("Edit existing content brief", "编辑已有内容简报") : t("Add a content brief manually", "手动补充内容简报")}</label>
    {editBrief && <fieldset className={s.briefFields}><legend>{t("Content brief", "内容简报")}</legend><p>{t("A writing guide with an outline and key points. This does not generate a full article.", "一份写作指引，包含大纲和要点；这里不生成整篇文章。")}</p>
      <label>{t("Summary", "内容概述")}<textarea name="summary" rows={3} defaultValue={item?.brief?.summary} required /></label>
      <div className={s.formGrid}><label>{t("Target audience", "目标读者")}<input name="briefAudience" defaultValue={item?.brief?.audience} required /></label><label>{t("What question does the reader want to answer?", "读者想解决什么问题")}<input name="searchIntent" defaultValue={item?.brief?.searchIntent} required /></label></div>
      <label>{t("Content angle", "内容角度")}<textarea name="angle" rows={2} defaultValue={item?.brief?.angle} required /></label>
      <label>{t("Suggested outline", "建议大纲")} <small>{t("One section per line, up to 15", "每行一个章节，最多 15 项")}</small><textarea name="outline" rows={5} defaultValue={item?.brief?.outline.join("\n")} required /></label>
      <label>{t("Key points to answer", "必须回答的要点")} <small>{t("One point per line, up to 15", "每行一个要点，最多 15 项")}</small><textarea name="keyPoints" rows={4} defaultValue={item?.brief?.keyPoints.join("\n")} required /></label>
      <label>{t("Call to action", "行动引导")}<textarea name="cta" rows={2} defaultValue={item?.brief?.cta} placeholder={t("An appropriate next step after reading.", "读者了解完后，适合进行的下一步。")} required /></label>
      <label>{t("Internal links", "站内链接")} <small>{t("Each line: Title | URL | Reason", "每行：标题 | URL | 关联理由")}</small><textarea name="internalLinks" rows={3} defaultValue={item?.brief?.internalLinks.map(link => `${link.title} | ${link.target} | ${link.reason}`).join("\n")} /></label>
      <label>{t("Evidence and items to verify", "依据与待核实项")} <small>{t("One item per line, up to 15", "每行一项，最多 15 项")}</small><textarea name="evidenceNotes" rows={3} defaultValue={item?.brief?.evidenceNotes.join("\n")} required placeholder={t("Example: Verify region-change restrictions using Apple's official guidance before publishing.", "例如：发布前按 Apple 官方说明核实地区切换限制。")} /></label>
    </fieldset>}
    <div className={s.formActions}><button type="button" className={s.secondary} onClick={onCancel} disabled={busy}>{t("Cancel", "取消")}</button><button className={s.primary} disabled={busy}><Save size={16} />{busy ? t("Saving…", "保存中…") : t("Save topic", "保存选题")}</button></div>
  </form>;
}
