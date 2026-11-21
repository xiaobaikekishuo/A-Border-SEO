/*
 * Field data from a PageSpeed Insights response: the Chrome UX Report's 75th
 * percentile of real visits over the last 28 days, for this URL or, when the
 * URL has too few visits, for the whole origin.
 *
 * Lighthouse (the lab run in the same response) loads the page without a
 * user, so it cannot measure Interaction to Next Paint; its Total Blocking
 * Time is the lab stand-in. Whether a page passes Core Web Vitals is a field
 * question: LCP, INP and CLS at p75 all "good". A metric without field data
 * is not a pass.
 */

export type FieldCategory = "FAST" | "AVERAGE" | "SLOW";

export type FieldVitals = {
  /** URL: this page's own visits. ORIGIN: the site as a whole, as a fallback. */
  source: "URL" | "ORIGIN";
  lcp?: number; // seconds
  inp?: number; // milliseconds
  cls?: number; // score
  /** PageSpeed Insights' overall verdict for the data set. */
  category?: FieldCategory;
};

type Experience = {
  metrics?: Record<string, { percentile?: unknown; category?: unknown } | undefined>;
  overall_category?: unknown;
  origin_fallback?: unknown;
} | undefined | null;

export type FieldResponse = { loadingExperience?: Experience; originLoadingExperience?: Experience };

/** Google's "good" thresholds at p75. */
export const GOOD_VITALS = { lcp: 2.5, inp: 200, cls: 0.1 } as const;

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const category = (value: unknown): FieldCategory | undefined => (value === "FAST" || value === "AVERAGE" || value === "SLOW" ? value : undefined);

function read(experience: Experience, source: FieldVitals["source"]): FieldVitals | null {
  const metrics = experience?.metrics;
  if (!metrics) return null;
  const lcp = finite(metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile);
  const inp = finite(metrics.INTERACTION_TO_NEXT_PAINT?.percentile);
  // The API reports the CLS percentile multiplied by 100.
  const cls = finite(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile);
  if (lcp === undefined && inp === undefined && cls === undefined) return null;
  const overall = category(experience?.overall_category);
  return {
    source,
    ...(lcp !== undefined ? { lcp: lcp / 1000 } : {}),
    ...(inp !== undefined ? { inp } : {}),
    ...(cls !== undefined ? { cls: Math.round(cls) / 100 } : {}),
    ...(overall ? { category: overall } : {}),
  };
}

/** The field data of a response: the URL's own when there is enough, else the origin's; null when Chrome has too few visits for either. */
export function parseFieldVitals(data: FieldResponse): FieldVitals | null {
  const page = data.loadingExperience;
  // With too few visits to the URL, loadingExperience itself carries the origin's data.
  return read(page, page?.origin_fallback === true ? "ORIGIN" : "URL") ?? read(data.originLoadingExperience, "ORIGIN");
}

export type VitalsAssessment = {
  /**
   * PASS: all three metrics good. FAIL: at least one is not. INCOMPLETE: the
   * ones measured are good but some have no field data (often INP on pages
   * with few interactions). NO_FIELD_DATA: Chrome has too few visits.
   */
  status: "PASS" | "FAIL" | "INCOMPLETE" | "NO_FIELD_DATA";
  source: FieldVitals["source"] | null;
  missing: ("lcp" | "inp" | "cls")[];
};

export function assessCoreWebVitals(field: Pick<FieldVitals, "lcp" | "inp" | "cls"> & { source?: FieldVitals["source"] | null } | null): VitalsAssessment {
  if (!field || (field.lcp == null && field.inp == null && field.cls == null)) {
    return { status: "NO_FIELD_DATA", source: null, missing: ["lcp", "inp", "cls"] };
  }
  const missing = (["lcp", "inp", "cls"] as const).filter(key => field[key] == null);
  const failing = (field.lcp != null && field.lcp > GOOD_VITALS.lcp) ||
    (field.inp != null && field.inp > GOOD_VITALS.inp) ||
    (field.cls != null && field.cls > GOOD_VITALS.cls);
  return { status: failing ? "FAIL" : missing.length ? "INCOMPLETE" : "PASS", source: field.source ?? null, missing };
}
