import type { Locale } from "./i18n/shared";
export function cnDelta(value: number, invert = false): string {
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  if (good) return "text-signal";
  if (bad) return "text-danger";
  return "text-muted-foreground";
}

export function formatDeltaPercent(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0%";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function formatDeltaPosition(value: number): string {
  // value is previous - current; positive means improved (moved up)
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return "0.0";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The one date format of the app: "3 Oct", "3 Oct 2026" with the year,
 * "3 Oct 14:02 UTC" with the time. Read in UTC, like the GSC dates.
 * A plain "YYYY-MM-DD" string is taken as that calendar day.
 */
export function formatDay(
  value: Date | string,
  { year = false, time = false, locale = "en" }: { year?: boolean; time?: boolean; locale?: Locale } = {}
): string {
  const d =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`)
      : new Date(value);
  if (Number.isNaN(d.getTime())) return locale === "zh" ? "日期无效" : "Invalid date";
  let out = locale === "zh"
    ? `${year ? `${d.getUTCFullYear()}年` : ""}${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
  if (time) {
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    out += ` ${hh}:${mm} UTC`;
  }
  return out;
}

/** A signed delta with a real minus sign: "+8.3", "−3.5". */
export function signed(value: number, digits = 1): string {
  const abs = Math.abs(value).toFixed(digits);
  if (Number(abs) === 0) return abs;
  return value > 0 ? `+${abs}` : `−${abs}`;
}
