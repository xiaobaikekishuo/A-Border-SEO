/*
 * Small-sample statistics for prompt tracking. A rate from a few dozen AI
 * answers moves a lot by chance alone: the same prompt asked twice can name
 * a brand once and not the next time. These helpers put a range on a rate
 * and tell a change between two runs from noise.
 *
 * Answers to the same prompt are not independent of each other, so the
 * ranges and tests count prompts, not answers, as the observations. With one
 * answer per prompt the two are the same; with several (GeoTracking.samples)
 * this keeps the range honest, if a little wide.
 */

/** Below this many prompts a rate is shown as rough. */
export const SMALL_SAMPLE = 30;

const Z95 = 1.959963984540054;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The 95% Wilson score interval of `successes` out of `trials`; null without trials. */
export function wilsonInterval(successes: number, trials: number, z = Z95): { low: number; high: number } | null {
  if (!(trials > 0)) return null;
  const k = Math.min(Math.max(successes, 0), trials);
  const p = k / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

/** The range of a rate observed over `observations` prompts (rate × observations successes, rounded). */
export function rateInterval(rate: number | null, observations: number): { low: number; high: number } | null {
  if (rate === null || !(observations > 0)) return null;
  return wilsonInterval(Math.round(rate * observations), observations);
}

/** erf by Abramowitz and Stegun 7.1.26 (absolute error below 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export type RateChange = {
  /** current − previous, as a share (0.1 = 10 points). */
  change: number;
  /** Two-sided p-value of the pooled two-proportion z-test. */
  p: number;
  /** p < 0.05: unlikely to be chance alone. */
  significant: boolean;
};

/**
 * Whether a rate changed between two runs beyond what chance explains: a
 * two-sided two-proportion z-test at the 5% level. Null when either run has
 * no observations.
 */
export function compareRates(previous: { rate: number | null; n: number }, current: { rate: number | null; n: number }): RateChange | null {
  if (previous.rate === null || current.rate === null || !(previous.n > 0) || !(current.n > 0)) return null;
  const k1 = Math.round(previous.rate * previous.n);
  const k2 = Math.round(current.rate * current.n);
  const p1 = k1 / previous.n;
  const p2 = k2 / current.n;
  const pooled = (k1 + k2) / (previous.n + current.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / previous.n + 1 / current.n));
  const change = round(current.rate - previous.rate);
  if (se === 0) return { change, p: p1 === p2 ? 1 : 0, significant: p1 !== p2 };
  const z = (p2 - p1) / se;
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
  return { change, p: Math.round(p * 10000) / 10000, significant: p < 0.05 };
}
