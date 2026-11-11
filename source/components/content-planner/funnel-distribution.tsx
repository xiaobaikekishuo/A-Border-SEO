"use client";

import { FUNNEL_STAGES, TOPIC_COUNTS, validFunnelCounts, type FunnelCounts, type FunnelPreset } from "@/lib/content-planner/funnel";
import { useI18n } from "@/lib/i18n/client";
import s from "./funnel-distribution.module.css";

export function FunnelSummary({ counts, label }: { counts: FunnelCounts; label: string }) {
  return <p className={s.summary}>{label}: {FUNNEL_STAGES.map(stage => `${stage} ${counts[stage]}`).join(" · ")}</p>;
}

export function FunnelDistribution({ total, counts, preset, onTotal, onPreset, onCount, disabled }: {
  total: number; counts: FunnelCounts; preset: FunnelPreset | "custom"; disabled: boolean;
  onTotal: (total: number) => void; onPreset: (preset: FunnelPreset | "custom") => void;
  onCount: (stage: (typeof FUNNEL_STAGES)[number], count: number) => void;
}) {
  const { t } = useI18n();
  const valid = validFunnelCounts(counts, total);
  const sum = FUNNEL_STAGES.reduce((value, stage) => value + counts[stage], 0);
  const labels = { TOFU: t("Awareness", "认识问题"), MOFU: t("Consideration", "比较方案"), BOFU: t("Decision", "做出决策") };
  return <fieldset className={s.distribution} disabled={disabled}>
    <legend>{t("Topic count and funnel mix", "选题数量与读者阶段分配")}</legend>
    <div className={s.settings}>
      <label>{t("Number of suggestions", "本次建议数量")}<select value={total} onChange={event => onTotal(Number(event.target.value))}>{TOPIC_COUNTS.map(value => <option value={value} key={value}>{t("{n} topics", "{n} 个选题", { n: value })}</option>)}</select></label>
      <label>{t("Distribution preset", "分配方式")}<select value={preset} onChange={event => onPreset(event.target.value as FunnelPreset | "custom")}>
        <option value="balanced">{t("Balanced", "均衡覆盖")}</option>
        <option value="awareness">{t("Awareness first", "认知优先")}</option>
        <option value="decision">{t("Decision first", "决策优先")}</option>
        <option value="custom">{t("Custom counts", "自定义数量")}</option>
      </select></label>
    </div>
    <div className={s.counts}>{FUNNEL_STAGES.map(stage => <label key={stage}><span>{stage} · {labels[stage]}</span><input type="number" min={0} max={total} step={1} value={Number.isFinite(counts[stage]) ? counts[stage] : ""} onChange={event => onCount(stage, event.target.value === "" ? NaN : Number(event.target.value))} /><small>{Number.isFinite(counts[stage]) ? `${(counts[stage] / total * 100).toFixed(1)}%` : t("Not set", "未填写")}</small></label>)}</div>
    <p className={s.summary} role="status">{t("Allocated {n} / {total} topics", "已分配 {n} / {total} 个选题", { n: Number.isFinite(sum) ? sum : t("Not set", "未填写"), total })}</p>
    {!valid && <p className={s.error} role="alert">{t("Use whole numbers from 0 to the total. The three counts must add up to the number of suggestions.", "请填写 0 到总数之间的整数，三个阶段的数量之和必须等于本次建议数量。")}</p>}
    <p className={s.hint}>{t("Presets round to whole topics; the counts above are the exact request. You may set a stage to zero. Custom counts stay unchanged when the total changes, so adjust them before generating.", "预设会换算为整数，以上数量就是本次生成要求。允许某阶段为 0。自定义数量不会随总数自动变化，请调整后再生成。")}</p>
    <p className={s.hint}>{t("Funnel stages describe the reader's decision stage, while search intent describes what a query needs to answer. This editorial mix does not guarantee search demand, traffic or rankings.", "漏斗描述读者的决策阶段，搜索意图描述查询要解决的问题，两者分别判断。此分配是编辑规划，不代表搜索需求，也不保证流量或排名。")}</p>
  </fieldset>;
}
