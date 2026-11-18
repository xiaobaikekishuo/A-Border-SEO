"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/client";

export type BingChartPoint = { date: string; value: number | null };

/** Range navigation can replace the series without remounting its chart. */
export function chartActiveIndex(active: number | null, pointCount: number): number | null {
  if (active === null || !Number.isFinite(active) || pointCount < 1) return null;
  return Math.max(0, Math.min(Math.trunc(active), pointCount - 1));
}

/** A missing observation starts a new segment; a reported zero stays on the axis. */
export function chartSegments(points: BingChartPoint[], maximum: number) {
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = 52 + (index / Math.max(1, points.length - 1)) * 660;
    const y = 172 - (point.value / maximum) * 148;
    current.push(`${current.length ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments;
}

export function BingReportChart({ title, description, points, color = "var(--chart-1)", controls }: {
  title: string;
  description: string;
  points: BingChartPoint[];
  color?: string;
  controls?: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const available = points.filter(point => point.value !== null && Number.isFinite(point.value));
  const actualMax = Math.max(0, ...available.map(point => point.value!));
  const maximum = Math.max(1, Math.ceil(actualMax / (10 ** Math.floor(Math.log10(actualMax || 1)))) * (10 ** Math.floor(Math.log10(actualMax || 1))));
  const format = (value: number) => value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 1 });
  const activeIndex = chartActiveIndex(active, points.length);
  const selected = activeIndex === null ? null : points[activeIndex];
  const last = available.at(-1);
  const shown = selected ?? last;
  const ticks = maximum <= 1 ? [0, maximum] : [0, Math.round(maximum / 2), maximum];

  return <section className="panel min-w-0 p-5" aria-labelledby={id}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id={id} className="text-[15px] font-semibold text-text-strong">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {controls}
    </div>
    <p className="mt-3 min-h-5 font-data text-xs text-muted-foreground" aria-live="polite">
      {shown ? <>{shown.date} <span aria-hidden>·</span> <span className="font-semibold text-text-strong">{shown.value === null ? t("Not reported", "尚未报告") : format(shown.value)}</span>
        {!selected && <span className="ml-2">{t("latest reported value in period", "区间内最近报告值")}</span>}</>
        : t("No observations in this period", "所选区间没有观测数据")}
    </p>
    {available.length ? <>
      <svg viewBox="0 0 740 202" className="mt-2 block w-full" role="img"
        aria-label={t("{title}: {count} reported days. Gaps mean missing data, not zero.", "{title}：有 {count} 天报告数据，断点表示缺失，不代表零。", { title, count: available.length })}
        onMouseMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const plotX = (event.clientX - bounds.left) / bounds.width * 740;
          setActive(Math.max(0, Math.min(points.length - 1, Math.round((plotX - 52) / 660 * (points.length - 1)))));
        }} onMouseLeave={() => setActive(null)}>
        {ticks.map(value => {
          const y = 172 - value / maximum * 148;
          return <g key={value}><line x1="52" x2="712" y1={y} y2={y} stroke="var(--border)" strokeDasharray={value === 0 ? undefined : "4 5"} />
            <text x="42" y={y + 4} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">{format(value)}</text></g>;
        })}
        {chartSegments(points, maximum).map((path, index) => <path key={index} data-bing-series d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />)}
        {points.map((point, index) => point.value !== null && Number.isFinite(point.value) ? <circle key={point.date}
          cx={52 + index / Math.max(1, points.length - 1) * 660} cy={172 - point.value / maximum * 148}
          r={activeIndex === index ? 4 : points.length > 90 ? 1.6 : 2.2} fill={color}>
          <title>{`${point.date}: ${format(point.value)}`}</title>
        </circle> : null)}
        {activeIndex !== null && <line x1={52 + activeIndex / Math.max(1, points.length - 1) * 660} x2={52 + activeIndex / Math.max(1, points.length - 1) * 660}
          y1="24" y2="172" stroke="var(--muted-foreground)" strokeDasharray="3 4" />}
        <text x="52" y="196" fontSize="11" fill="var(--muted-foreground)">{points[0]?.date}</text>
        <text x="712" y="196" textAnchor="end" fontSize="11" fill="var(--muted-foreground)">{points.at(-1)?.date}</text>
      </svg>
      <label className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="shrink-0">{t("Inspect a day", "逐日查看")}</span>
        <input type="range" className="min-w-0 flex-1 accent-primary" min="0" max={Math.max(0, points.length - 1)}
          value={activeIndex ?? Math.max(0, points.findLastIndex(point => point.value !== null))}
          aria-label={t("Inspect {title} by date", "按日期查看{title}", { title })}
          aria-valuetext={shown ? `${shown.date}: ${shown.value === null ? t("Not reported", "尚未报告") : format(shown.value)}` : undefined}
          onChange={event => setActive(Number(event.target.value))} />
      </label>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{t("Gaps mean missing reports. A point on the baseline is a reported zero.", "断点表示尚无报告；基线上的数据点表示已报告为零。")}</p>
    </> : <div className="mt-3 flex min-h-44 items-center justify-center rounded-lg border border-dashed border-border px-5 text-center text-sm text-muted-foreground">
      {t("Bing has not supplied this metric for the selected period.", "Bing 尚未提供所选区间的这项指标。")}
    </div>}
  </section>;
}
