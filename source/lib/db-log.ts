/*
 * The opt-in slow query log of lib/db.ts. Set ABORDER_SLOW_QUERY_MS (say 200)
 * to log every database query that takes that long or longer, to find what
 * makes a page slow on real data. Kept apart from the client so it can be
 * tested without a database.
 */

/** Milliseconds from ABORDER_SLOW_QUERY_MS, or null when the log is off. */
export function slowQueryThreshold(value: string | undefined = process.env.ABORDER_SLOW_QUERY_MS): number | null {
  if (!value?.trim()) return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** One log line: the time and the SQL, never the parameters, which hold user data. */
export function slowQueryLine(event: { duration: number; query: string }): string {
  return `[slow query] ${Math.round(event.duration)} ms ${event.query.replace(/\s+/g, " ").trim().slice(0, 600)}`;
}
