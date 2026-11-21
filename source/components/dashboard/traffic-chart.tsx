"use client";

import { useI18n } from "@/lib/i18n/client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { areaPath, linePath, niceMax, percentChange, weekTicks } from "./chart-geometry";

interface TrafficChartProps {
  siteId: string;
  /** Days in a period; the chart loads twice as many to draw the previous period too. */
  days?: number;
}

interface ChartData {
  date: string;
  clicks: number;
  impressions: number;
}

type Day = { date: string; clicks: number | null; impressions: number | null };

/** Use the requested GSC date window; a missing row is never a reported zero. */
function fillDays(data: ChartData[], start: string, end: string): Day[] {
  if (!start || !end) return [];
  const byDate = new Map(data.map((d) => [d.date, d]));
  const out: Day[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    new Date(t).toISOString().slice(0, 10) <= end;
    t += 86_400_000
  ) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(date);
    out.push({ date, clicks: row?.clicks ?? null, impressions: row?.impressions ?? null });
  }
  return out;
}

// The plot's own coordinates: the SVG stretches to the card's width at a fixed height.
const WIDTH = 1000;
const HEIGHT = 200;
const HATCH = "repeating-linear-gradient(45deg, var(--border-color) 0 2px, transparent 2px 7px)";

/**
 * Clicks per day in this period as a line, with the previous period dashed on
 * the same days of the week. A day Search Console has not reported yet breaks
 * the line over a hatched band, never a zero. Hover, or focus the chart and
 * use the arrow keys, to read one day against the same day of the previous period.
 */
export function TrafficChart({ siteId, days = 28 }: TrafficChartProps) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ChartData[]>([]);
  const [period, setPeriod] = useState({ start: "", end: "", basis: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  // Only keyboard reading is announced; a passing mouse would make the live region chatter.
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/sites/${siteId}/traffic?days=${days * 2}`);
        if (!res.ok) throw new Error(t("Failed to load traffic", "流量数据加载失败"));
        const json = (await res.json()) as ChartData[];
        if (!cancelled) {
          setData(json);
          setPeriod({ start: res.headers.get("X-GSC-Start") ?? "", end: res.headers.get("X-GSC-End") ?? "",
            basis: res.headers.get("X-GSC-Basis") ?? "" });
        }
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

  const series = useMemo(() => fillDays(data, period.start, period.end), [data, period]);
  const current = series.slice(Math.max(0, series.length - days));
  const previous = series.slice(0, Math.max(0, series.length - days));
  // The previous period lines up day by day, counted back from this period's last day.
  const previousAt = (index: number) => previous[previous.length - current.length + index] ?? null;

  if (loading) {
    return (
      <div aria-busy="true" className="panel flex h-[330px] items-center justify-center">
        <p className="text-atom-body text-muted-foreground">{t("Loading traffic…", "正在加载流量数据…")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel flex h-[330px] items-center justify-center">
        <p className="text-atom-body text-danger">{error}</p>
      </div>
    );
  }

  if (current.length === 0 || data.length === 0) {
    return (
      <div className="panel flex h-[330px] flex-col items-center justify-center gap-2">
        <p className="text-atom-subheader font-medium text-text-strong">{t("No traffic yet", "暂无流量数据")}</p>
        <p className="text-atom-body text-muted-foreground">
          {t("Sync GSC data to populate the last {days} days.", "同步 GSC，获取最近 {days} 天的数据。", {days})}
        </p>
      </div>
    );
  }

  const values = current.map((day) => day.clicks);
  const before = current.map((_, index) => previousAt(index)?.clicks ?? null);
  const top = niceMax(Math.max(0, ...values.map((value) => value ?? 0), ...before.map((value) => value ?? 0)));
  const x = (index: number) => (current.length > 1 ? (index / (current.length - 1)) * WIDTH : WIDTH / 2);
  const y = (value: number) => HEIGHT - (value / top) * (HEIGHT - 8);
  const percentX = (index: number) => (x(index) / WIDTH) * 100;
  const gridValues = [top, (top * 3) / 4, top / 2, top / 4, 0];
  const missing = values.filter((value) => value === null).length;
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const step = current.length > 1 ? 100 / (current.length - 1) : 100;

  const shown = active === null ? null : current[active];
  const shownBefore = active === null ? null : before[active];
  const change = active === null ? null : percentChange(values[active], shownBefore);
  const readout = shown
    ? `${formatDay(shown.date, { locale })} · ${shown.clicks === null
      ? t("not in GSC yet", "GSC 尚未报告")
      : t("{clicks} clicks", "{clicks} 次点击", { clicks: shown.clicks.toLocaleString() })}${shownBefore === null ? ""
      : ` · ${t("previous period {clicks}", "上期 {clicks}", { clicks: shownBefore.toLocaleString() })}`}`
    : "";

  const pick = (event: { currentTarget: HTMLDivElement; clientX: number }) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setActive(Math.round(share * (current.length - 1)));
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = current.length - 1;
    setActive((index) => {
      if (event.key === "Home") return 0;
      if (event.key === "End") return last;
      const from = index ?? last;
      return Math.min(last, Math.max(0, from + (event.key === "ArrowRight" ? 1 : -1)));
    });
  };

  return (
    <section className="panel flex flex-col gap-4 px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-[14px] leading-5 font-semibold">{t("Clicks per day", "每日点击量")}</h2>
          <p className="text-[12.5px] leading-5 text-muted-foreground">
            {t("{start} – {end}, against the previous {days} days on the same weekdays", "{start} – {end}，与上一个 {days} 天按星期对齐", {
              start: formatDay(current[0].date, { locale }), end: formatDay(current[current.length - 1].date, { locale }), days })}
            {" · "}{period.basis === "property" ? t("GSC property totals (Web, final)", "GSC 资源汇总（网页搜索，最终数据）") : t("GSC page-detail totals", "GSC 页面明细合计")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12.5px] leading-4 text-muted-foreground">
          <span className="flex items-center gap-2">
            <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden><path d="M1 4h16" stroke="var(--chart-1)" strokeWidth="2" strokeLinecap="round" /></svg>
            {t("This period", "本期")}</span>
          <span className="flex items-center gap-2">
            <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden><path d="M1 4h16" stroke="var(--chart-previous)" strokeWidth="1.5" strokeDasharray="3 3" /></svg>
            {t("Previous period", "上期")}</span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3.5 rounded-[3px] border border-border" style={{ backgroundImage: HATCH }} />
            {t("Not synced or not reported; not a zero", "未同步或尚未报告，不代表零")}</span>
        </div>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div aria-hidden className="relative h-[200px] w-10">
          {gridValues.map((value) => (
            <span key={value} className="absolute right-0 -translate-y-1/2 font-data text-[11px] leading-4 text-muted-foreground" style={{ top: y(value) }}>
              {value.toLocaleString()}
            </span>
          ))}
        </div>

        <div
          tabIndex={0}
          aria-label={t("Clicks per day, {start} to {end}: {total} clicks, {missing} days not synced or not reported. Use the arrow keys to read each day.", "每日点击量，{start} 至 {end}：共 {total} 次点击，有 {missing} 天未同步或尚未报告。用方向键逐日查看。", {
            start: formatDay(current[0].date, { locale }), end: formatDay(current[current.length - 1].date, { locale }), total: total.toLocaleString(), missing })}
          className="relative h-[200px] rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onFocus={() => { setFocused(true); setActive((index) => index ?? current.length - 1); }}
          onBlur={() => { setFocused(false); setActive(null); }}
          onKeyDown={move}
        >
          {values.map((value, index) => value === null ? (
            <span key={current[index].date} aria-hidden className="absolute top-0 bottom-0 opacity-80"
              style={{ left: `${Math.max(0, percentX(index) - step / 2)}%`, width: `${Math.min(step, 100 - Math.max(0, percentX(index) - step / 2))}%`, backgroundImage: HATCH }} />
          ) : null)}

          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 h-full w-full overflow-visible">
            {gridValues.map((value) => (
              <path key={value} d={`M0 ${y(value).toFixed(1)}H${WIDTH}`} stroke={value === 0 ? "var(--line-strong)" : "var(--chart-grid)"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            <path d={areaPath(values, x, y, HEIGHT)} fill="var(--chart-1)" fillOpacity="0.1" />
            <path d={linePath(before, x, y)} fill="none" stroke="var(--chart-previous)" strokeWidth="1.5" strokeDasharray="4 4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={linePath(values, x, y)} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>

          {active !== null && (
            <>
              <span aria-hidden className="absolute top-0 bottom-0 w-px bg-line-strong" style={{ left: `${percentX(active)}%` }} />
              {shownBefore !== null && (
                <span aria-hidden className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-text-muted bg-card"
                  style={{ left: `${percentX(active)}%`, top: y(shownBefore) }} />
              )}
              {values[active] !== null && (
                <span aria-hidden className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-chart-1 bg-card"
                  style={{ left: `${percentX(active)}%`, top: y(values[active]!) }} />
              )}
              <div aria-hidden
                className={cn("pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-lg border border-border bg-popover px-3 py-2.5 text-[12px] leading-5 shadow-atom-2",
                  percentX(active) > 60 ? "-translate-x-full" : "")}
                style={{ left: `calc(${percentX(active)}% ${percentX(active) > 60 ? "- 12px" : "+ 12px"})` }}>
                <p className="font-semibold text-text-strong">{formatDay(current[active].date, { locale })}</p>
                <p className="flex items-center justify-between gap-4 text-text">
                  <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-chart-1" />{t("This period", "本期")}</span>
                  <span className="font-data font-semibold text-text-strong">{values[active] === null ? t("not reported", "未报告") : values[active]!.toLocaleString()}</span>
                </p>
                <p className="flex items-center justify-between gap-4 text-text">
                  <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full border-[1.5px] border-text-muted" />{t("Previous", "上期")}</span>
                  <span className="font-data">{shownBefore === null ? t("not reported", "未报告") : shownBefore.toLocaleString()}</span>
                </p>
                {change !== null && (
                  <p className={cn("font-data font-medium", change >= 0 ? "text-success" : "text-danger")}>
                    {`${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <span aria-hidden />
        <div aria-hidden className="relative mt-2 h-4">
          {weekTicks(current.length).map((index, position, ticks) => (
            <span key={index}
              className={cn("absolute font-data text-[11px] leading-4 whitespace-nowrap text-muted-foreground",
                position === 0 ? "" : position === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")}
              style={{ left: `${percentX(index)}%` }}>
              {formatDay(current[index].date, { locale })}
            </span>
          ))}
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">{focused ? readout : ""}</p>
    </section>
  );
}
