"use client";

import { useI18n } from "@/lib/i18n/client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, FileText, Layers, Lightbulb, X } from "lucide-react";
import { getPlannerLabels, safeSiteUrl, type Brief, type Funnel } from "./model";
import s from "./planner.module.css";

export function Modal({ title, eyebrow, description, children, onClose, wide = false }: {
  title: string; eyebrow?: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
    className={`${s.dialog} ${wide ? s.dialogWide : ""}`} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className={s.modalHeader}><div>{eyebrow && <span className={s.eyebrow}>{eyebrow}</span>}<h2 id={`${id}-title`}>{title}</h2>
      {description && <p id={`${id}-description`}>{description}</p>}</div>
      <button type="button" className={s.iconButton} aria-label={t("Close dialog", "关闭弹窗")} onClick={onClose}><X size={19} /></button>
    </header><div className={s.modalBody}>{children}</div>
  </dialog>;
}

export function FunnelBadge({ funnel }: { funnel: Funnel }) {
  const { t } = useI18n();
  const { FUNNELS } = getPlannerLabels(t);
  return <span className={`${s.funnel} ${s[funnel]}`} title={FUNNELS[funnel].description}>{funnel}<span>{FUNNELS[funnel].label}</span></span>;
}

export function BriefContent({ brief, domain }: { brief: Brief; domain: string }) {
  const { t } = useI18n();
  return <div className={s.brief}>
    <div className={s.briefLead}><span className={s.eyebrow}>{t("Summary", "内容概述")}</span><p>{brief.summary || t("To be added", "待补充")}</p></div>
    <div className={s.briefGrid}>
      <section><h3>{t("Target audience", "目标读者")}</h3><p>{brief.audience || t("To be added", "待补充")}</p></section>
      <section><h3>{t("Search intent", "搜索意图")}</h3><p>{brief.searchIntent || t("To be added", "待补充")}</p></section>
    </div>
    <section><h3>{t("Content angle", "切入角度")}</h3><p>{brief.angle || t("To be added", "待补充")}</p></section>
    <section><h3>{t("Suggested outline", "建议大纲")}</h3>{brief.outline.length ? <ol className={s.outline}>{brief.outline.map((line, i) => <li key={i}><span>{String(i + 1).padStart(2, "0")}</span>{line}</li>)}</ol> : <p>{t("To be added", "待补充")}</p>}</section>
    <section><h3>{t("Key points to answer", "必须回答的要点")}</h3><ul className={s.checkList}>{brief.keyPoints.map((point, i) => <li key={i}><Check size={16} />{point}</li>)}</ul>{!brief.keyPoints.length && <p>{t("To be added", "待补充")}</p>}</section>
    <section><h3>{t("Call to action", "行动引导")}</h3><p>{brief.cta || t("To be added", "待补充")}</p></section>
    <section><h3>{t("Suggested internal links", "建议站内链接")}</h3>{brief.internalLinks.length ? brief.internalLinks.map((link, i) => {
      const href = safeSiteUrl(link.target, domain);
      return <div className={s.linkSuggestion} key={i}><div>{href ? <a href={href} target="_blank" rel="noreferrer">{link.title || link.target} <ArrowRight size={14} /></a> : <strong>{link.title || link.target}</strong>}<code>{link.target}</code></div><p>{link.reason}</p></div>;
    }) : <p>{t("No internal link suggestions yet.", "尚未填写站内链接建议。")}</p>}</section>
    <section className={s.evidence}><h3><Lightbulb size={17} />{t("Evidence and items to verify", "依据与待核实项")}</h3>{brief.evidenceNotes.length ? <ul>{brief.evidenceNotes.map((note, i) => <li key={i}>{note}</li>)}</ul> : <p>{t("Verify facts, sources, and product applicability before publishing.", "发布前请核实事实、来源和产品适用范围。")}</p>}</section>
  </div>;
}

export function ConceptGuide() {
  const { t } = useI18n();
  const { FUNNELS } = getPlannerLabels(t);
  return <div className={s.guide}>
    <div className={s.sectionHeading}><div><span className={s.eyebrow}>{t("From one topic to a useful collection of content", "从一个主题，到一组有用的内容")}</span><h2>{t("Build the topic structure, then the reading journey", "先搭主题结构，再安排阅读路径")}</h2><p>{t("The topic structure defines what to write. Funnel labels identify the reader's stage.", "主题结构回答“写什么”，漏斗标签回答“为哪个阶段的读者写”。")}</p></div><BookOpen size={27} /></div>
    <div className={s.guideDefinition}>
      <article><div className={s.guideIcon}><Layers size={23} /></div><h3>{t("Pillar · Overview page", "Pillar · 总览主题页")}</h3><p>{t("Cover a broad topic, guide readers through it, and link to content about specific questions.", "围绕一个较大的主题，给读者完整导航，并链接到具体问题的内容。")}</p><strong>{t("Example: Apple ID regions and usage guide", "例如：Apple ID 地区与使用指南")}</strong><small>{t("This plans an overview page. Start with a topic and link its actual URL later.", "它是一页内容的规划，也可以暂时只有选题，稍后再关联实际 URL。")}</small></article>
      <article><div className={`${s.guideIcon} ${s.cyanIcon}`}><FileText size={23} /></div><h3>{t("Cluster · Focused content", "Cluster · 具体问题内容")}</h3><p>{t("Answer one question within a pillar in depth. Link to and from the overview page to help readers explore.", "深入回答支柱主题下的一个问题；与总览页相互链接，方便读者继续了解。")}</p><strong>{t("Example: What is the difference between App Store and iCloud?", "例如：App Store 与 iCloud 有什么区别？")}</strong><small>{t("Each article can have its own keyword, reader intent, brief, schedule, and publishing status.", "每篇可以有自己的关键词、读者意图、简报、排期和发布状态。")}</small></article>
    </div>
    <div className={s.guideJourney}>
      {(Object.keys(FUNNELS) as Funnel[]).map((key, index) => <article key={key}>
        <span className={s.stepNumber}>0{index + 1}</span><FunnelBadge funnel={key} /><h3>{FUNNELS[key].label}</h3><p>{FUNNELS[key].description}</p><div>{FUNNELS[key].example}</div>
      </article>)}
    </div>
    <div className={s.guideNote}><Lightbulb size={21} /><p><strong>{t("The funnel is not a ranking tier or a three-level URL structure.", "漏斗不是排名等级，也不是三级网址结构。")}</strong> {t("TOFU / MOFU / BOFU describe stages of awareness and decision-making. Readers can move between stages. Labels alone do not guarantee higher rankings.", "TOFU / MOFU / BOFU 描述读者的认知与决策阶段。读者可以跨阶段阅读；标签本身不会保证排名提升。")}</p></div>
    <div className={s.guideSteps}><h3>{t("How to get started", "在这里如何开始")}</h3><ol><li>{t("Create a pillar and describe its audience and content goal.", "新建一个总览主题，说明读者和内容目标。")}</li><li>{t("Add focused topics manually, or ask AI for topics and briefs.", "手动添加具体选题，或让 AI 提出选题与简报。")}</li><li>{t("Review AI suggestions before selecting content to import.", "先审阅 AI 建议，再选择要导入的内容。")}</li><li>{t("Schedule writing and review. After publishing, add the URL from the same site.", "安排撰写和审核，发布后填入同一站点的 URL。")}</li><li>{t("Review performance using synced GSC data. An unlinked page does not mean zero traffic.", "用已同步的真实 GSC 数据复盘，不把“未关联”当成零流量。")}</li></ol></div>
    <div className={s.guideSteps} style={{ marginTop: 18 }}><h3>{t("Already have articles? Organize them in three steps", "网站已经有文章？三步整理进来")}</h3><ol><li>{t("Select Import existing articles, then search and select pages from the latest crawl inventory.", "点击“导入已有文章”，从最近抓取的库存搜索、勾选页面。")}</li><li>{t("Choose a pillar and review titles, keywords, and TOFU / MOFU / BOFU stages manually.", "选择总览主题，人工确认标题、关键词和 TOFU / MOFU / BOFU 阶段。")}</li><li>{t("Continue organizing articles in Articles, or add a brief to guide revisions.", "在“文章规划”继续编辑归类，或补充用于改稿的内容简报。")}</li></ol><p className={s.muted}>{t("Import records existing articles as Published. It does not generate briefs or edit remote content. Changes to local planning do not update your website.", "导入仅记录已有文章，默认已发布；不会生成简报或修改远程正文。本地规划修改不等于网站内容更新。")}</p></div>
    <footer className={s.guideFooter}>{t("References: ", "概念参考：")}<a href="https://knowledge.hubspot.com/content-strategy/pillar-pages-topics-and-subtopics" target="_blank" rel="noreferrer">{t("Topics and content clusters", "主题与内容集群")}</a><span>·</span><a href="https://blog.hubspot.com/marketing/i-took-a-deep-dive-into-the-marketing-funnel-heres-what-i-learned" target="_blank" rel="noreferrer">{t("Marketing funnel", "营销漏斗")}</a></footer>
  </div>;
}
