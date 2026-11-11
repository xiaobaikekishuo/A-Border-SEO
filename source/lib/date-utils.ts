/**
 * Format date to YYYY-MM-DD for Google APIs
 */
export function formatDateForAPI(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Get date N days ago in YYYY-MM-DD format
 */
export function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateForAPI(date);
}

/**
 * Get date range for last N days
 */
export function getDateRange(days: number): { start: string; end: string } {
  return dateWindow(days, formatDateForAPI(new Date()));
}

/** Inclusive UTC date-label window. GSC labels are Pacific dates, stored at UTC midnight. */
export function dateWindow(days: number, end: string): { start: string; end: string } {
  if (!Number.isInteger(days) || days < 1) throw new Error("Invalid day count");
  const start = new Date(`${end}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return {
    start: formatDateForAPI(start), end,
  };
}

/** Conservative cutoff in the reporting timezone used by GSC (America/Los_Angeles). */
export function getGscDateRange(days: number) {
  return dateWindow(days, getDataLagDate());
}

/**
 * Calculate percentage change between two values
 */
export function calculatePercentChange(
  current: number,
  previous: number
): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100 * 100) / 100;
}

/**
 * Returns the approximate latest date (YYYY-MM-DD) for which GSC data
 * is available. Google typically has a ~3-day lag.
 */
export function getDataLagDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const day = new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 3);
  return formatDateForAPI(day);
}

/**
 * Format large numbers with K/M suffix
 */
export function formatLargeNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toString();
}
