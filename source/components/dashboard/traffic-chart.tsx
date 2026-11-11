"use client";

import { useI18n } from "@/lib/i18n/client";

import { useEffect, useMemo, useState } from "react";
import { formatDay } from "@/lib/format";

interface TrafficChartProps {
  siteId: string;
  days?: number;
}

interface ChartData {
  date: string;
  clicks: number;
  impressions: number;
}

type Day = { date: string; clicks: number | null; impressions: number | null };


/** Every calendar day from the first synced day to today; days GSC has not reported stay null. */
function fillDays(data: ChartData[]): Day[] {
  if (data.length === 0) return [];
  const byDate = new Map(data.map((d) => [d.date, d]));
  const out: Day[] = [];
  const end = new Date().toISOString().slice(0, 10);
  for (
    let t = Date.parse(`${data[0].date}T00:00:00Z`);
    new Date(t).toISOString().slice(0, 10) <= end;
    t += 86_400_000
  ) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(date);
    out.push({ date, clicks: row?.clicks ?? null, impressions: row?.impressions ?? null });
  }
  return out;
}

/**
 * Clicks per day as bars, as on the Overview board. A day Search Console has
 * not reported yet is an empty dashed bar, never a zero.
 */
export function TrafficChart({ siteId, days = 90 }: TrafficChartProps) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ChartData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/sites/${siteId}/traffic?days=${days}`);
        if (!res.ok) throw new Error(t("Failed to load traffic", "流量数据加载失败"));
        const json = (await res.json()) as ChartData[];
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("Failed to load chart", "图表加载失败"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [siteId, days, t]);

  const series = useMemo(() => fillDays(data), [data]);
  const max = Math.max(1, ...series.map((d) => d.clicks ?? 0));
  const missing = series.filter((d) => d.clicks === null).length;

  if (loading) {
    return (
      <div className="panel flex h-[262px] items-center justify-center">
        <p className="text-atom-body text-muted-foreground">{t("Loading traffic…", "正在加载流量数据…")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel flex h-[262px] items-center justify-center">
        <p className="text-atom-body text-danger">{error}</p>
      </div>
    );
  }

  if (series.length === 0) {
    return (
      <div className="panel flex h-[262px] flex-col items-center justify-center gap-2">
        <p className="text-atom-subheader font-medium text-text-strong">{t("No traffic yet", "暂无流量数据")}</p>
        <p className="text-atom-body text-muted-foreground">
          {t("Sync GSC data to populate the last {days} days.", "同步 GSC，获取最近 {days} 天的数据。", {days})}
        </p>
      </div>
    );
  }

  const shown = hover !== null ? series[hover] : null;
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1];

  return (
    <section className="panel flex flex-col gap-4 px-[22px] py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] leading-5 font-semibold">{t("Clicks per day", "每日点击量")}</h2>
        <div className="flex flex-wrap gap-[18px] text-[12px] leading-4 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px] bg-chart-1" />
            {t("Synced", "已同步")}</span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px] border border-dashed border-text-soft" />
            {t("Not synced or not reported; not a zero", "未同步或尚未报告，不代表零")}</span>
        </div>
      </div>

      <div
        role="img"
        aria-label={t("Clicks per day, {start} to {end}. Highest day {max} clicks. {missing} days not synced or not reported.", "每日点击量，{start} 至 {end}。单日最高 {max} 次点击。有 {missing} 天未同步或尚未报告。", {start: formatDay(series[0].date, {locale}), end: formatDay(series[series.length - 1].date, {locale}), max: max.toLocaleString(), missing})}
        className="flex h-[170px] items-end gap-[3px] border-b border-border sm:gap-1.5"
        onMouseLeave={() => setHover(null)}
      >
        {series.map((d, i) => (
          <div
            key={d.date}
            className="flex h-full min-w-0 flex-1 items-end justify-center"
            onMouseEnter={() => setHover(i)}
          >
            {d.clicks === null ? (
              <div className="h-[160px] w-full max-w-2.5 rounded-t-[2px] border border-b-0 border-dashed border-text-soft" />
            ) : (
              <div
                className="w-full max-w-2.5 rounded-t-[2px] bg-chart-1 transition-opacity"
                style={{
                  height: `${Math.max(1, Math.round((d.clicks / max) * 160))}px`,
                  opacity: hover === null || hover === i ? 1 : 0.55,
                }}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 text-[11px] leading-4 text-muted-foreground">
        {shown ? (
          <span className="mono-label">
            {formatDay(shown.date, {locale})} ·{" "}
            {shown.clicks === null
              ? t("not in GSC yet", "GSC 尚未报告")
              : t("{clicks} clicks · {impressions} impressions", "{clicks} 次点击 · {impressions} 次曝光", {clicks: shown.clicks.toLocaleString(), impressions: shown.impressions?.toLocaleString() ?? "0"})}
          </span>
        ) : (
          ticks.map((i) => (
            <span key={i} className="mono-label">
              {formatDay(series[i].date, {locale})}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
