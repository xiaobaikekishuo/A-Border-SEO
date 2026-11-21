import { classifyPageSpeedError, pageSpeedMessage, type PageSpeedErrorCode } from "./pagespeed-errors";
export type { PageSpeedErrorCode } from "./pagespeed-errors";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { googleFetch } from "./google-fetch";
import { parseFieldVitals, type FieldResponse, type FieldVitals } from "./pagespeed-field";
export { assessCoreWebVitals, GOOD_VITALS, parseFieldVitals, type FieldVitals, type VitalsAssessment } from "./pagespeed-field";

const PAGESPEED_API_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

async function resolveApiKey(userId?: string): Promise<string | undefined> {
  if (userId) {
    const stored = await db.apiKey.findUnique({
      where: { userId_provider: { userId, provider: "google_pagespeed" } },
    });
    if (stored) return decrypt(stored.encryptedPassword);
  }
  return process.env.GOOGLE_PAGESPEED_KEY;
}

/** Lab values from Lighthouse. Lighthouse does not interact with the page, so `inp` stays empty; see `field`. */
export interface CoreWebVitals {
  lcp?: number; // Largest Contentful Paint (seconds)
  fid?: number; // First Input Delay (milliseconds) - deprecated
  cls?: number; // Cumulative Layout Shift (score)
  inp?: number; // Interaction to Next Paint (milliseconds)
}

export interface PerformanceMetrics {
  perfScore: number; // 0-100
  speedIndex?: number; // seconds
  ttfb?: number; // Time to First Byte (seconds)
  fcp?: number; // First Contentful Paint (seconds)
  tbt?: number; // Total Blocking Time (milliseconds), the lab stand-in for INP
}

export interface PageSpeedResult {
  url: string;
  strategy: "MOBILE" | "DESKTOP";
  lighthouseScore: number;
  vitals: CoreWebVitals;
  metrics: PerformanceMetrics;
  /** Chrome UX Report p75 of real visits (last 28 days), or null when Chrome has too few. */
  field: FieldVitals | null;
  fetchTime: string;
}


export class PageSpeedError extends Error {
  constructor(
    readonly status: number,
    readonly code: PageSpeedErrorCode
  ) {
    super(pageSpeedMessage(code, status));
    this.name = "PageSpeedError";
  }
}

/**
 * Converts milliseconds to seconds
 */
function msToSeconds(ms?: number): number | undefined {
  return ms ? ms / 1000 : undefined;
}

/**
 * Fetches PageSpeed Insights data for a URL
 */
export async function fetchPageSpeed(
  url: string,
  strategy: "MOBILE" | "DESKTOP" = "MOBILE",
  userId?: string
): Promise<PageSpeedResult> {
  const params = new URLSearchParams({
    url,
    category: "PERFORMANCE",
    strategy,
  });
  const apiKey = await resolveApiKey(userId);
  if (apiKey) {
    params.set("key", apiKey);
  }

  const response = await googleFetch(`${PAGESPEED_API_BASE}?${params}`, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const code = classifyPageSpeedError(response.status, body);
    // Only stable status and category are logged; upstream bodies may contain credentials.
    console.error("PageSpeed request failed", { status: response.status, code });
    throw new PageSpeedError(response.status, code);
  }

  const data = (await response.json()) as FieldResponse & {
    lighthouseResult?: {
      categories?: {
        performance?: {
          score?: number;
        };
      };
      audits?: Record<
        string,
        {
          numericValue?: number;
        }
      >;
    };
  };

  const lighthouseResult = data.lighthouseResult;

  if (!lighthouseResult) {
    throw new Error("Invalid PageSpeed response: missing lighthouseResult");
  }

  const audits = lighthouseResult.audits || {};

  // Extract Core Web Vitals
  const vitals: CoreWebVitals = {
    lcp: msToSeconds(audits["largest-contentful-paint"]?.numericValue),
    cls: audits["cumulative-layout-shift"]?.numericValue,
    inp: audits["interaction-to-next-paint"]?.numericValue,
  };

  // Extract performance metrics
  const metrics: PerformanceMetrics = {
    perfScore: Math.round(
      (lighthouseResult.categories?.performance?.score || 0) * 100
    ),
    speedIndex: msToSeconds(audits["speed-index"]?.numericValue),
    ttfb: msToSeconds(audits["server-response-time"]?.numericValue),
    fcp: msToSeconds(audits["first-contentful-paint"]?.numericValue),
    tbt: audits["total-blocking-time"]?.numericValue,
  };

  return {
    url,
    strategy,
    lighthouseScore: metrics.perfScore,
    vitals,
    metrics,
    field: parseFieldVitals(data),
    fetchTime: new Date().toISOString(),
  };
}

/**
 * Fetches PageSpeed data for both mobile and desktop
 */
export async function fetchPageSpeedBoth(
  url: string
): Promise<{ mobile: PageSpeedResult; desktop: PageSpeedResult }> {
  const [mobile, desktop] = await Promise.all([
    fetchPageSpeed(url, "MOBILE"),
    fetchPageSpeed(url, "DESKTOP"),
  ]);

  return { mobile, desktop };
}

/**
 * Whether all three Core Web Vitals are "good": LCP <= 2.5 s, INP <= 200 ms,
 * CLS <= 0.1. A missing metric is not a pass (a lab run never has INP), and
 * a CLS of 0 is a measured, perfect value. For field data, use
 * assessCoreWebVitals, which also tells "incomplete" from "failing".
 */
export function isVitalsGood(vitals: CoreWebVitals): boolean {
  return vitals.lcp != null && vitals.lcp <= 2.5 &&
    vitals.cls != null && vitals.cls <= 0.1 &&
    vitals.inp != null && vitals.inp <= 200;
}

/**
 * Gets a performance grade from score
 */
export function getPerformanceGrade(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 50) return "Needs Improvement";
  return "Poor";
}
