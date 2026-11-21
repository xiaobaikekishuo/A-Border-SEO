import { describe, expect, it } from "vitest";
import { assessCoreWebVitals, parseFieldVitals } from "./pagespeed-field";

const metrics = (lcp?: number, inp?: number, cls?: number) => ({
  ...(lcp !== undefined ? { LARGEST_CONTENTFUL_PAINT_MS: { percentile: lcp, category: "FAST" } } : {}),
  ...(inp !== undefined ? { INTERACTION_TO_NEXT_PAINT: { percentile: inp, category: "FAST" } } : {}),
  ...(cls !== undefined ? { CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: cls, category: "FAST" } } : {}),
  FIRST_CONTENTFUL_PAINT_MS: { percentile: 900 },
});

describe("PageSpeed field data", () => {
  it("reads the URL's p75 values in the units the app stores", () => {
    expect(parseFieldVitals({ loadingExperience: { metrics: metrics(2300, 180, 5), overall_category: "FAST" } }))
      .toEqual({ source: "URL", lcp: 2.3, inp: 180, cls: 0.05, category: "FAST" });
  });

  it("labels origin data, whether PageSpeed falls back inside loadingExperience or only sends the origin", () => {
    expect(parseFieldVitals({ loadingExperience: { metrics: metrics(3100, 250, 12), origin_fallback: true, overall_category: "AVERAGE" } }))
      .toEqual({ source: "ORIGIN", lcp: 3.1, inp: 250, cls: 0.12, category: "AVERAGE" });
    expect(parseFieldVitals({ loadingExperience: { metrics: {} }, originLoadingExperience: { metrics: metrics(2000, undefined, 3) } }))
      .toEqual({ source: "ORIGIN", lcp: 2, cls: 0.03 });
  });

  it("returns null when Chrome has too few visits", () => {
    expect(parseFieldVitals({})).toBeNull();
    expect(parseFieldVitals({ loadingExperience: { metrics: { FIRST_CONTENTFUL_PAINT_MS: { percentile: 800 } } } })).toBeNull();
    expect(parseFieldVitals({ loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: "fast" } } } })).toBeNull();
  });
});

describe("Core Web Vitals assessment", () => {
  it("passes only with all three metrics good", () => {
    expect(assessCoreWebVitals({ source: "URL", lcp: 2.5, inp: 200, cls: 0.1 })).toEqual({ status: "PASS", source: "URL", missing: [] });
    expect(assessCoreWebVitals({ source: "URL", lcp: 2.6, inp: 100, cls: 0 }).status).toBe("FAIL");
    expect(assessCoreWebVitals({ source: "ORIGIN", lcp: 1.2, inp: 320, cls: 0 }).status).toBe("FAIL");
  });

  it("does not count a missing INP as a pass", () => {
    expect(assessCoreWebVitals({ source: "URL", lcp: 1.8, cls: 0.02 })).toEqual({ status: "INCOMPLETE", source: "URL", missing: ["inp"] });
    // A failing metric fails even when another one is missing.
    expect(assessCoreWebVitals({ source: "URL", lcp: 4.2, cls: 0.02 }).status).toBe("FAIL");
    expect(assessCoreWebVitals(null)).toEqual({ status: "NO_FIELD_DATA", source: null, missing: ["lcp", "inp", "cls"] });
  });
});
