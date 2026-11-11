import type { Translator } from "@/lib/i18n/shared";
import { getI18n } from "@/lib/i18n/server";
import { getSitePeriodMetrics, formatCompact, formatCtr } from "@/lib/seo-metrics";
import { signed } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MetricsProps {
  siteId: string;
  days?: number;
}

/**
 * KPI card from the Overview board: label, mono value, and the change as a
 * one-line mono uppercase value. The page meta line already says which two
 * periods are compared, so the delta carries no words beyond its unit.
 */
function MetricCard({
  t,
  label,
  value,
  delta,
  deltaLabel,
}: {
  t: Translator;
  label: string;
  value: string;
  /** Positive is better. */
  delta: number | null;
  deltaLabel: string;
}) {
  const isFlat = delta === null || !Number.isFinite(delta) || Math.abs(delta) < 0.05;

  return (
    <div className="panel flex min-w-0 flex-col gap-2 px-5 py-[18px]">
      <p className="text-[13px] leading-5 text-muted-foreground">{label}</p>
      <p className="font-data text-[30px] leading-9 font-medium tracking-[-0.02em] text-text-strong">
        {value}
      </p>
      <p
        className={cn(
          "mono-label truncate text-[12px] leading-4 whitespace-nowrap",
          isFlat ? "text-muted-foreground" : (delta ?? 0) > 0 ? "text-success" : "text-danger"
        )}
      >
        {delta === null ? deltaLabel : isFlat ? t("No change", "无变化") : deltaLabel}
      </p>
    </div>
  );
}

export async function DashboardMetrics({ siteId, days = 28 }: MetricsProps) {
  const { t } = await getI18n();
  const { current, previous, deltas, coverage } = await getSitePeriodMetrics(siteId, days);
  // CTR moves in percentage points, not as a percent of itself.
  const ctrPoints = coverage.comparable && current.impressions > 0 && previous.impressions > 0 ? (current.avgCtr - previous.avgCtr) * 100 : null;
  const insufficient = t("Insufficient history", "历史不足，暂不比较");
  const percentLabel = (delta: number | null, previousValue: number, currentValue: number) => delta !== null
    ? `${signed(delta)}%` : coverage.comparable && previousValue === 0 && currentValue > 0
      ? t("New activity (zero baseline)", "新增（上期为零）") : insufficient;

  return (
    <>
    <p className="mb-3 text-xs text-muted-foreground">{coverage.current.start} ~ {coverage.current.end} · {t("compared with", "对比")} {coverage.previous.start} ~ {coverage.previous.end} · {t("Synced days", "已确认同步天数")} {coverage.currentDays}/{days} + {coverage.previousDays}/{days}{!coverage.comparable && ` · ${t("Sync GSC to complete both periods; totals shown are the records available locally.", "请同步 GSC 补齐两个周期；当前数值为本地已有记录合计。")}`}</p>
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard t={t}
        label={t("Clicks", "点击量")}
        value={formatCompact(current.clicks)}
        delta={deltas.clicks}
        deltaLabel={percentLabel(deltas.clicks, previous.clicks, current.clicks)}
      />
      <MetricCard t={t}
        label={t("Impressions", "曝光量")}
        value={formatCompact(current.impressions)}
        delta={deltas.impressions}
        deltaLabel={percentLabel(deltas.impressions, previous.impressions, current.impressions)}
      />
      <MetricCard t={t}
        label={t("Average position", "平均排名")}
        value={current.avgPosition > 0 ? current.avgPosition.toFixed(1) : t("n/a", "暂无")}
        delta={deltas.avgPosition}
        deltaLabel={deltas.avgPosition === null ? insufficient : t("{value} places", "{value} 位", {value: signed(deltas.avgPosition)})}
      />
      <MetricCard t={t}
        label={t("CTR", "点击率")}
        value={current.impressions > 0 ? formatCtr(current.avgCtr) : t("n/a", "暂无")}
        delta={ctrPoints}
        deltaLabel={ctrPoints === null ? insufficient : t("{value} pt", "{value} 个百分点", {value: signed(ctrPoints)})}
      />
    </div>
    </>
  );
}
