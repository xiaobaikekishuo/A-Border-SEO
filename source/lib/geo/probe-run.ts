import { BROWSER_USER_AGENT, probeCrawlers } from "./platforms";
import { classifyProbe, detectCdn, probeVerdict, type ProbeCheck, type ProbeOutcome, type ProbeResponse } from "./probe-rules";

/*
 * The live access check over a list of URLs, with the request function
 * passed in (lib/geo/probe.ts sends the real requests): the browser request
 * first, then each AI crawler, a few at a time, none started after the time
 * budget. Pure apart from the requests, so it is tested with stubs.
 */

export const PROBE_CONCURRENCY = 3;
/** The whole check stops starting requests after this long. */
export const PROBE_BUDGET_MS = 90_000;

export type ProbeRun = {
  urls: string[];
  cdn: string | null;
  browser: { url: string; outcome: ProbeOutcome; status: number | null; error: string | null; finalUrl: string | null }[];
  checks: ProbeCheck[];
};

/** Runs `tasks` with at most `limit` at once, none started after `stopAt`. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number, stopAt: number, skipped: () => T, clock: () => number = Date.now): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = clock() > stopAt ? skipped() : await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** The live check for one URL list. Exported for tests with a stubbed request function. */
export async function runProbe(urls: string[], fetcher: (url: string, userAgent: string) => Promise<ProbeResponse>, now = Date.now): Promise<ProbeRun> {
  const stopAt = now() + PROBE_BUDGET_MS;
  const crawlers = probeCrawlers();
  const browser: ProbeRun["browser"] = [];
  const checks: ProbeCheck[] = [];
  let cdn: string | null = null;
  for (const url of urls) {
    const base = await fetcher(url, BROWSER_USER_AGENT);
    const baseOutcome = classifyProbe(base);
    cdn ??= detectCdn(base.headers);
    browser.push({ url, outcome: baseOutcome, status: base.status, error: base.error, finalUrl: base.finalUrl });
    const results = await pool(
      crawlers.map(crawler => async () => ({ crawler, response: await fetcher(url, crawler.userAgent) })),
      PROBE_CONCURRENCY,
      stopAt,
      () => null,
      now,
    );
    results.forEach((result, i) => {
      const token = crawlers[i].token;
      if (!result) {
        checks.push({ token, url, outcome: "ERROR", verdict: "ERROR", status: null, error: "Not checked: time limit" });
        return;
      }
      cdn ??= detectCdn(result.response.headers);
      const outcome = classifyProbe(result.response);
      checks.push({ token, url, outcome, verdict: probeVerdict(outcome, baseOutcome), status: result.response.status, error: result.response.error });
    });
  }
  return { urls, cdn, browser, checks };
}
