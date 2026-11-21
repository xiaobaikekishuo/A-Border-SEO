"use client";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Info, XCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { AdLawJudgement, QualityItem, QualityKey, QualityStatus, ReviewSignals } from "@/lib/content-planner/review-quality";
import { unjudgedAdLaw } from "@/lib/content-planner/ad-law-coverage";
import s from "./planner.module.css";

// The order of QUALITY_KEYS in lib/content-planner/review-quality.ts, kept here so the client bundle needs no server module.
const ORDER: QualityKey[] = ["DIRECT_ANSWER", "FIRST_HAND", "SOURCED", "AUTHOR_DATE", "QUESTION_HEADINGS", "AD_LAW"];
const ICON: Record<QualityStatus, { icon: ReactNode; className: string }> = {
  PASS: { icon: <CheckCircle2 size={14} aria-hidden />, className: s.qualityPass },
  PARTIAL: { icon: <AlertTriangle size={14} aria-hidden />, className: s.qualityPartial },
  FAIL: { icon: <XCircle size={14} aria-hidden />, className: s.qualityFail },
  UNKNOWN: { icon: <CircleHelp size={14} aria-hidden />, className: s.qualityMuted },
  NOT_APPLICABLE: { icon: <Info size={14} aria-hidden />, className: s.qualityMuted },
};

/** The six-item checklist of one reviewed article: hints for the owner, never a gate on applying. */
export function QualityChecklist({ quality, adLaw, signals, shortened }: {
  quality?: QualityItem[]; adLaw?: AdLawJudgement[]; signals?: ReviewSignals | null; shortened?: boolean;
}) {
  const { t } = useI18n();
  if (!quality?.length) return null;
  const label: Record<QualityKey, string> = {
    DIRECT_ANSWER: t("Opening answers the question", "首段直接给答案"),
    FIRST_HAND: t("First-hand experience", "一手经验"),
    SOURCED: t("Claims name their sources", "结论有出处"),
    AUTHOR_DATE: t("Author and date", "作者和日期"),
    QUESTION_HEADINGS: t("Question-style subheadings", "问题式小标题"),
    AD_LAW: t("Absolute terms (PRC Advertising Law)", "绝对化用语（广告法）"),
  };
  const status: Record<QualityStatus, string> = {
    PASS: t("Pass", "通过"), PARTIAL: t("Partly", "部分做到"), FAIL: t("Missing", "未做到"),
    UNKNOWN: t("Cannot tell", "无法判断"), NOT_APPLICABLE: t("Not applicable", "不适用"),
  };
  const details = (entry: QualityItem): ReactNode => {
    if (entry.key === "AUTHOR_DATE") {
      if (!signals || entry.status === "UNKNOWN") return <p>{t("This crawl has no author or date evidence. Crawl again, then review.", "这次抓取没有作者和日期的依据，重新抓取后再复核。")}</p>;
      const dates = [signals.published && t("published {v0}", "发布 {v0}", { v0: signals.published }), signals.modified && t("updated {v0}", "更新 {v0}", { v0: signals.modified })].filter(Boolean).join(" · ");
      return <p>
        {signals.author === null ? t("Author: not collected", "作者：未采集") : signals.author ? t("Author in the markup", "标记中有作者") : t("No author in the markup", "标记中没有作者")}
        {" · "}{dates || t("no date found", "未找到日期")}
        {signals.fresh === false && dates ? t(" · older than 12 months", " · 已超过 12 个月") : null}
      </p>;
    }
    if (entry.key === "QUESTION_HEADINGS") {
      return signals?.headings
        ? <p>{t("{v0} of {v1} subheadings are questions.", "{v1} 个小标题中有 {v0} 个是问题式。", { v0: signals.headings.questions, v1: signals.headings.total })}</p>
        : <p>{t("No subheadings are known for this text.", "这段正文没有可用的小标题信息。")}</p>;
    }
    if (entry.key === "AD_LAW") {
      if (!signals?.adLaw) return null;
      if (!signals.adLaw.length) return <p>{t("No absolute terms found.", "未发现绝对化用语。")}</p>;
      const open = unjudgedAdLaw(signals.adLaw, adLaw ?? []);
      return <>
        {(adLaw ?? []).map((value, index) => <p key={index}>
          <strong>{value.term}</strong> · {value.verdict === "RISK" ? t("risk", "有风险") : t("likely exempt", "可能属于豁免情形")}
          <span className={s.qualityQuote}>{value.quote}</span>
          {value.rewrite && <span>{t("Suggested: ", "建议改为：")}{value.rewrite}</span>}
        </p>)}
        {!!open.length && <p>{t("Not judged, check by hand:", "未判断，请人工确认：")}
          {open.map((value, index) => <span key={index} className={s.qualityQuote}><strong>{value.term}</strong> · {value.context}</span>)}
        </p>}
        <p>{t("A risk hint based on Article 9(3) and the SAMR enforcement guideline, not legal advice.", "依据广告法第九条第三项和市场监管总局执法指南给出的风险提示，不是法律意见。")}</p>
      </>;
    }
    return <>
      {entry.evidence && <span className={s.qualityQuote}>{entry.evidence}</span>}
      {entry.key === "SOURCED" && signals?.sourceLinks != null && <p>{t("The crawled article links to {v0} other sites.", "抓取的正文链接到 {v0} 个外部网站。", { v0: signals.sourceLinks })}</p>}
      {entry.fix && <p>{t("Suggested: ", "建议：")}{entry.fix}</p>}
    </>;
  };
  return <div className={s.quality}>
    <h4>{t("Quality checks", "质量检查")}</h4>
    <p className={s.qualityNote}>{t("Hints for your edit. They do not block accepting the review.", "供修改时参考，不影响采纳。")}{shortened ? t(" The excerpt was shortened to fit the local worker.", "正文摘录为适应本机生成服务已缩短。") : ""}</p>
    <ul className={s.qualityList}>
      {ORDER.map(key => {
        const entry = quality.find(value => value.key === key);
        if (!entry) return null;
        const look = ICON[entry.status];
        return <li key={key} className={s.qualityItem}>
          <span className={look.className}>{look.icon}</span>
          <div><strong>{label[key]}</strong> · <span className={look.className}>{status[entry.status]}</span>{details(entry)}</div>
        </li>;
      })}
    </ul>
  </div>;
}
