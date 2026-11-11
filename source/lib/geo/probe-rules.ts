/*
 * Reading the answers of the live access check: the site requested once with
 * an ordinary browser user agent and once with each crawler's user agent.
 * Pure functions; lib/geo/probe.ts makes the requests.
 *
 * The check runs from this server, not from the crawlers' own addresses. CDNs
 * verify real crawlers by IP address or signature, so a block seen here shows
 * a rule that matches the user agent (or bot protection that distrusts this
 * server); it does not prove the real crawler is blocked, and a pass does not
 * prove it gets through.
 */

export type ProbeOutcome = "OK" | "CHALLENGE" | "BLOCKED" | "NOT_FOUND" | "SERVER_ERROR" | "ERROR";
export type ProbeVerdict = "OK" | "BLOCKED_FOR_BOT" | "BLOCKED_FOR_ALL" | "ERROR";

export type ProbeResponse = {
  status: number | null;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The start of the body (a few KB), for challenge pages. */
  body: string;
  /** Network failure, timeout or a refused address; status is null then. */
  error: string | null;
  finalUrl: string | null;
};

/** Interstitials that only a challenge or block page shows, even with status 200. */
const STRONG_MARKERS = [
  /<title>\s*just a moment/i, /<title>\s*attention required!?\s*\|\s*cloudflare/i, /vercel security checkpoint/i,
  /captcha-delivery\.com/i, /px-captcha/i, /incapsula incident id/i, /sucuri website firewall/i,
  /<title>[^<]{0,80}(?:access denied|verify you are human|robot check)/i,
];
/**
 * Signs of bot protection that also appear on ordinary pages (Cloudflare's
 * JavaScript detections, a reCAPTCHA form), so they only count with a 4xx/5xx.
 */
const WEAK_MARKERS = [
  /cf-chl-|\/cdn-cgi\/challenge-platform|challenges\.cloudflare/i, /checking (?:your|if the site connection is) (?:browser|secure)/i,
  /g-recaptcha|hcaptcha|turnstile/i, /verify (?:you are|that you are) (?:a )?human/i,
];

/** The CDN or bot protection in front of the site, from response headers. */
export function detectCdn(headers: Record<string, string>): string | null {
  const server = headers["server"]?.toLowerCase() ?? "";
  const via = headers["via"]?.toLowerCase() ?? "";
  if (server.includes("cloudflare") || "cf-ray" in headers) return "Cloudflare";
  if (server.includes("akamai") || Object.keys(headers).some(h => h.startsWith("x-akamai"))) return "Akamai";
  if ("x-amz-cf-id" in headers || via.includes("cloudfront")) return "Amazon CloudFront";
  if ("x-sucuri-id" in headers || server.includes("sucuri")) return "Sucuri";
  if ("x-iinfo" in headers || (headers["x-cdn"] ?? "").toLowerCase().includes("incapsula")) return "Imperva";
  if ("x-fastly-request-id" in headers || (via.includes("varnish") && "x-served-by" in headers)) return "Fastly";
  if ("x-vercel-id" in headers || server.includes("vercel")) return "Vercel";
  if (server.includes("netlify") || "x-nf-request-id" in headers) return "Netlify";
  if ("x-datadome" in headers || "x-datadome-cid" in headers) return "DataDome";
  return null;
}

/** What one response means for a visitor that wants the page. */
export function classifyProbe(response: ProbeResponse): ProbeOutcome {
  if (response.error || response.status === null) return "ERROR";
  const { status, headers, body } = response;
  const mitigated = (headers["cf-mitigated"] ?? "").toLowerCase() === "challenge";
  const strong = mitigated || STRONG_MARKERS.some(pattern => pattern.test(body));
  if (status >= 200 && status < 300) return strong ? "CHALLENGE" : "OK";
  const challenge = strong || WEAK_MARKERS.some(pattern => pattern.test(body));
  if (challenge && [401, 403, 429, 503].includes(status)) return "CHALLENGE";
  if ([401, 403, 406, 407, 429, 451].includes(status)) return "BLOCKED";
  if (status === 404 || status === 410) return "NOT_FOUND";
  if (status >= 500) return "SERVER_ERROR";
  return "BLOCKED";
}

/** A crawler's result read against the browser baseline for the same URL. */
export function probeVerdict(bot: ProbeOutcome, browser: ProbeOutcome): ProbeVerdict {
  if (bot === "OK" || bot === "NOT_FOUND") return "OK";
  if (bot === "ERROR" || bot === "SERVER_ERROR") return browser === "OK" ? "BLOCKED_FOR_BOT" : "ERROR";
  return browser === "OK" || browser === "NOT_FOUND" ? "BLOCKED_FOR_BOT" : "BLOCKED_FOR_ALL";
}

export type ProbeCheck = {
  token: string;
  url: string;
  outcome: ProbeOutcome;
  verdict: ProbeVerdict;
  status: number | null;
  error: string | null;
};

/** The worst verdict among a crawler's URLs. */
export function worstVerdict(verdicts: readonly ProbeVerdict[]): ProbeVerdict | null {
  const order: ProbeVerdict[] = ["BLOCKED_FOR_BOT", "BLOCKED_FOR_ALL", "ERROR", "OK"];
  for (const v of order) if (verdicts.includes(v)) return v;
  return null;
}
