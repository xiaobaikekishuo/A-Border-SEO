"use client";

import { useI18n } from "@/lib/i18n/client";
import { applyParagraphEdit, type ParagraphEdit } from "./model";
import s from "./workbench.module.css";

export function ParagraphReview({ edits, text, disabled, onApply }: { edits: ParagraphEdit[]; text: string; disabled: boolean; onApply: (edit: ParagraphEdit) => void }) {
  const { t } = useI18n();
  if (!edits.length) return null;
  return <section className={s.paragraphReview} aria-label={t("Review paragraph changes", "逐段审阅修改")}>
    <h4>{t("Review paragraph changes", "逐段审阅修改")}</h4>
    <p>{t("The editor starts with the original text. Apply individual changes, then save your local draft. Edited or repeated source text requires manual review.", "编辑框以原文开始。逐条采纳后，再保存本地草稿。已编辑或重复出现的原文需要手动核对。")}</p>
    {edits.map((edit, index) => {
      const preview = applyParagraphEdit(text, edit);
      const label = preview.ok ? t("Apply to draft", "采纳到草稿") : ({ already: t("Already present or unchanged", "草稿中已存在或无变化"), missing: t("Source changed: review manually", "原文已变化，请手动核对"), ambiguous: t("Repeated source: review manually", "原文重复，请手动核对"), too_long: t("Draft length limit reached", "超过草稿长度限制") })[preview.reason];
      return <details key={edit.id} className={s.paragraphCard} open={index === 0}>
        <summary>{t("Change {n}", "修改 {n}", { n: index + 1 })}<span>{edit.reason}</span></summary>
        <div className={s.paragraphColumns}><div><h5>{t("Original passage", "原段落")}</h5><pre>{edit.sourceText}</pre></div><div><h5>{t("Proposed passage", "建议修改")}</h5><pre>{edit.replacementText || t("Remove this passage", "删除此段落")}</pre></div></div>
        <h5>{t("Supporting evidence", "修改依据")}</h5><ul>{edit.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>
        <h5>{t("Checks before use", "使用前核查")}</h5><ul>{edit.verification.map((item, i) => <li key={i}>{item}</li>)}</ul>
        <button type="button" className={s.reviewButton} disabled={disabled || !preview.ok} onClick={() => onApply(edit)}>{label}</button>
      </details>;
    })}
  </section>;
}
