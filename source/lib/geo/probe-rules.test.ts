import { describe, expect, it } from "vitest";
import { classifyProbe, detectCdn, probeVerdict, worstVerdict, type ProbeResponse } from "./probe-rules";

const response = (over: Partial<ProbeResponse> = {}): ProbeResponse => ({ status: 200, headers: {}, body: "<html><title>Shop</title></html>", error: null, finalUrl: "https://example.com/", ...over });

describe("live access classification", () => {
  it("reads statuses", () => {
    expect(classifyProbe(response())).toBe("OK");
    expect(classifyProbe(response({ status: 403 }))).toBe("BLOCKED");
    expect(classifyProbe(response({ status: 429 }))).toBe("BLOCKED");
    expect(classifyProbe(response({ status: 404 }))).toBe("NOT_FOUND");
    expect(classifyProbe(response({ status: 503 }))).toBe("SERVER_ERROR");
    expect(classifyProbe(response({ status: null, error: "Timed out" }))).toBe("ERROR");
  });

  it("finds challenge pages, even when they answer 200", () => {
    expect(classifyProbe(response({ body: "<title>Just a moment...</title>" }))).toBe("CHALLENGE");
    expect(classifyProbe(response({ headers: { "cf-mitigated": "challenge" } }))).toBe("CHALLENGE");
    expect(classifyProbe(response({ status: 403, body: '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>' }))).toBe("CHALLENGE");
  });

  it("does not take an ordinary page that mentions a captcha for a challenge", () => {
    expect(classifyProbe(response({ body: "<p>We use reCAPTCHA on our contact form.</p>" }))).toBe("OK");
  });

  it("names the CDN from response headers", () => {
    expect(detectCdn({ server: "cloudflare", "cf-ray": "8a-LAX" })).toBe("Cloudflare");
    expect(detectCdn({ "x-vercel-id": "sfo1::abc" })).toBe("Vercel");
    expect(detectCdn({ server: "nginx" })).toBeNull();
  });

  it("compares each crawler with the browser request", () => {
    expect(probeVerdict("OK", "OK")).toBe("OK");
    expect(probeVerdict("NOT_FOUND", "NOT_FOUND")).toBe("OK");
    expect(probeVerdict("BLOCKED", "OK")).toBe("BLOCKED_FOR_BOT");
    expect(probeVerdict("CHALLENGE", "OK")).toBe("BLOCKED_FOR_BOT");
    expect(probeVerdict("BLOCKED", "BLOCKED")).toBe("BLOCKED_FOR_ALL");
    expect(probeVerdict("ERROR", "OK")).toBe("BLOCKED_FOR_BOT");
    expect(probeVerdict("ERROR", "ERROR")).toBe("ERROR");
  });

  it("keeps the worst verdict over several pages", () => {
    expect(worstVerdict([])).toBeNull();
    expect(worstVerdict(["OK", "BLOCKED_FOR_BOT", "OK"])).toBe("BLOCKED_FOR_BOT");
    expect(worstVerdict(["OK", "ERROR"])).toBe("ERROR");
  });
});
