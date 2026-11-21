export type GeoKind = "GA4" | "BOT";
export type GeoRow = {
  day: string; platform: string; path: string;
  /** Sessions (GA4) or requests (access log). */
  count: number;
  /** GA4 engaged sessions and key events, when the report or export has them. */
  engaged?: number;
  keyEvents?: number;
};
export type GeoSnapshot = {
  source: "GA4_CSV" | "GA4_API" | "ACCESS_LOG";
  updatedAt: string;
  start: string | null;
  end: string | null;
  skipped: number;
  processed: number;
  notes: string[];
  rows: GeoRow[];
};
export type GeoWorkspace = { siteId: string; snapshots: Record<GeoKind, GeoSnapshot | null> };
