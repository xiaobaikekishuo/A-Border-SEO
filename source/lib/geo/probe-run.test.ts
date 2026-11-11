import { describe, expect, it } from "vitest";
import { BROWSER_USER_AGENT } from "./platforms";
import type { ProbeResponse } from "./probe-rules";
import { PROBE_BUDGET_MS, runProbe } from "./probe-run";

const ok = (over: Partial<ProbeResponse> = {}): ProbeResponse => ({ status: 200, headers: {}, body: "<title>Shop</title>", error: null, finalUrl: "https://example.com/", ...over });

describe("live access check run", () => {
  it("compares every AI crawler with the browser, per page, and names the CDN", async () => {
    const seen: string[] = [];
    const run = await runProbe(["https://example.com/", "https://example.com/guide"], async (url, ua) => {
      seen.push(ua);
      if (ua.includes("PerplexityBot")) return ok({ status: 403, headers: { server: "cloudflare", "cf-mitigated": "challenge" }, body: "<title>Just a moment...</title>" });
      return ok({ headers: { server: "cloudflare" } });
    });
    expect(run.cdn).toBe("Cloudflare");
    expect(run.browser.map(b => b.outcome)).toEqual(["OK", "OK"]);
    expect(seen.filter(ua => ua === BROWSER_USER_AGENT)).toHaveLength(2);
    expect(seen.some(ua => /googlebot|bingbot/i.test(ua))).toBe(false);
    const perplexity = run.checks.filter(c => c.token === "PerplexityBot");
    expect(perplexity.map(c => c.verdict)).toEqual(["BLOCKED_FOR_BOT", "BLOCKED_FOR_BOT"]);
    expect(run.checks.find(c => c.token === "OAI-SearchBot")?.verdict).toBe("OK");
    expect(run.checks).toHaveLength(20);
  });

  it("tells a site that refuses this server from one that refuses a crawler", async () => {
    const run = await runProbe(["https://example.com/"], async () => ok({ status: 403, body: "Forbidden" }));
    expect(new Set(run.checks.map(c => c.verdict))).toEqual(new Set(["BLOCKED_FOR_ALL"]));
  });

  it("marks what it had no time for instead of waiting", async () => {
    let clock = 0;
    const run = await runProbe(["https://example.com/"], async () => { clock += PROBE_BUDGET_MS; return ok(); }, () => clock);
    expect(run.checks.some(c => c.error === "Not checked: time limit")).toBe(true);
  });
});
