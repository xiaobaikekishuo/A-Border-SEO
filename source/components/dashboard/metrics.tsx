import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { Translator } from "@/lib/i18n/shared";
import { getI18n } from "@/lib/i18n/server";
import { gscComparisonWindows } from "@/lib/gsc-coverage";
import { getDailySearchRows, getSitePeriodMetrics, formatCompact, formatCtr } from "@/lib/seo-metrics";
import { signed } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MetricsProps {
  siteId: string;
  days?: number;
}

/** The current period's daily values as a small line; `invert` puts lower values higher (position). */
function Sparkline({ values, invert = false, muted = false }: { values: number[]; invert?: boolean; muted?: boolean }) {
  const width = 112;
  const height = 30;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const points = values.map((value, index) => {
    const share = high > low ? (value - low) / (high - low) : 0.5;
    const y = 2 + (invert ? share : 1 - share) * (height - 4);
    return `${((index * width) / (values.length - 1)).toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="hidden shrink-0 sm:block">
      <polyline points={points} fill="none" stroke={muted ? "var(--chart-previous)" : "var(--chart-1)"}
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * KPI card from the Overview board: label, value with the period's daily line,
 * and the change as a coloured pill against the previous period.
 */
function MetricCard({
  t,
  label,
  value,
  delta,
  deltaLabel,
  days,
  spark,
  invert,
}: {
  t: Translator;
  label: string;
  value: string;
  /** Positive is better. */
  delta: number | null;
  deltaLabel: string;
  days: number;
  spark: number[];
  /** Lower values are better, as for position. */
  invert?: boolean;
}) {
  const isFlat = delta === null || !Number.isFinite(delta) || Math.abs(delta) < 0.05;
  const Icon = isFlat ? Minus : (delta ?? 0) > 0 ? TrendingUp : TrendingDown;

  return (
    <div className="panel flex min-w-0 flex-col gap-2.5 px-5 pt-[18px] pb-4">
      <p className="text-[13px] leading-5 text-muted-foreground">{label}</p>
      <div className="flex items-end justify-between gap-3">
        <p className="font-data text-[30px] leading-9 font-semibold tracking-[-0.02em] text-text-strong">
          {value}
        </p>
        {spark.length > 1 && <Sparkline values={spark} invert={invert} muted={isFlat} />}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-muted-foreground">
        {delta === null ? <span className="truncate">{deltaLabel}</span> : (
          <>
            <span className={cn(
              "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md px-2 font-data font-medium whitespace-nowrap",
              isFlat ? "bg-bg-section text-muted-foreground" : delta > 0 ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
            )}>
              <Icon className="size-3" aria-hidden />
              {isFlat ? t("No change", "无变化") : deltaLabel}
            </span>
            <span className="truncate">{t("vs the previous {days} days", "较上一个 {days} 天", { days })}</span>
          </>
        )}
      </div>
    </div>
  );
}

export async function DashboardMetrics({ siteId, days = 28 }: MetricsProps) {
  const { t } = await getI18n();
  const windows = gscComparisonWindows(days);
  const [{ current, previous, deltas, coverage, basis }, daily] = await Promise.all([
    getSitePeriodMetrics(siteId, days),
    getDailySearchRows(siteId, { startDate: windows.current.start, endDate: windows.current.end }),
  ]);
  const reported = daily.filter((day) => day.impressions > 0);
  const spark = {
    clicks: daily.map((day) => day.clicks),
    impressions: daily.map((day) => day.impressions),
    position: reported.map((day) => day.position),
    ctr: reported.map((day) => day.clicks / day.impressions),
  };
  // CTR moves in percentage points, not as a percent of itself.
  const ctrPoints = coverage.comparable && current.impressions > 0 && previous.impressions > 0 ? (current.avgCtr - previous.avgCtr) * 100 : null;
  const insufficient = t("Insufficient history", "历史不足，暂不比较");
  const percentLabel = (delta: number | null, previousValue: number, currentValue: number) => delta !== null
    ? `${signed(delta)}%` : coverage.comparable && previousValue === 0 && currentValue > 0
      ? t("New activity (zero baseline)", "新增（上期为零）") : insufficient;

  return (
    <>
    <p className="mb-3 text-xs text-muted-foreground">{coverage.current.start} ~ {coverage.current.end} · {t("compared with", "对比")} {coverage.previous.start} ~ {coverage.previous.end} · {basis === "property" ? t("GSC property totals (Web, final)", "GSC 资源汇总（网页搜索，最终数据）") : t("GSC page-detail totals; sync for property totals", "GSC 页面明细合计；同步后可获取资源汇总")} · {t("Days with reported data", "有报告数据的天数")} {coverage.currentReportedDays}/{days} + {coverage.previousReportedDays}/{days}{!coverage.comparable && ` · ${t("Totals include only reported days; no comparison for incomplete periods.", "仅合计有数据的日期，周期不完整时不作环比。")}`}</p>
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard t={t}
        label={t("Clicks", "点击量")}
        value={coverage.currentReportedDays ? formatCompact(current.clicks) : t("Not reported", "尚未报告")}
        delta={deltas.clicks}
        deltaLabel={percentLabel(deltas.clicks, previous.clicks, current.clicks)}
        days={days} spark={spark.clicks}
      />
      <MetricCard t={t}
        label={t("Impressions", "曝光量")}
        value={coverage.currentReportedDays ? formatCompact(current.impressions) : t("Not reported", "尚未报告")}
        delta={deltas.impressions}
        deltaLabel={percentLabel(deltas.impressions, previous.impressions, current.impressions)}
        days={days} spark={spark.impressions}
      />
      <MetricCard t={t}
        label={t("Average position", "平均排名")}
        value={current.avgPosition > 0 ? current.avgPosition.toFixed(1) : t("n/a", "暂无")}
        delta={deltas.avgPosition}
        deltaLabel={deltas.avgPosition === null ? insufficient : t("{value} places", "{value} 位", {value: signed(deltas.avgPosition)})}
        days={days} spark={spark.position} invert
      />
      <MetricCard t={t}
        label={t("CTR", "点击率")}
        value={current.impressions > 0 ? formatCtr(current.avgCtr) : t("n/a", "暂无")}
        delta={ctrPoints}
        deltaLabel={ctrPoints === null ? insufficient : t("{value} pt", "{value} 个百分点", {value: signed(ctrPoints)})}
        days={days} spark={spark.ctr}
      />
    </div>
    </>
  );
}
