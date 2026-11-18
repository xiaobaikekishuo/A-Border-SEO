import { expect, it } from "vitest";
import { LIMITS, validateClaim } from "../../local-worker/lib.mjs";
import { fitPlanReferences, requiredPlanContext } from "./claim-size";
import { buildContentPrompt, type ContentPromptContext } from "./prompt";
import { outputSchema } from "./schema";

const domain = "example.test";
const input = {
  domain, topicCount: 3, pillar: { title: "Cup guide", keyword: "cup", description: "", audience: "", goal: "", url: null },
  reviewedKeywordIdeas: Array.from({ length: 24 }, (_, i) => ({
    keyword: `杯子 "${i}"`, intent: "INFORMATIONAL" as const, funnel: "TOFU" as const,
    angle: '杯"\\'.repeat(45), cluster: "Cup guides",
  })),
};
function envelope(context: ContentPromptContext) {
  return { managedProtocol: 2, job: { jobId: "x".repeat(100), leaseToken: "x".repeat(36), leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    prompt: buildContentPrompt(context), outputSchema } };
}

it("fits the installed worker's serialized response limit with URLs, escaped text and all 24 reviewed suggestions", () => {
  const urls = Array.from({ length: 300 }, (_, i) => `https://example.test/article/${i}/${"a".repeat(1900)}`);
  const refs = {
    knownPages: urls.map(url => ({ url, title: 'Guide "A"'.repeat(20) })),
    existingTopics: urls.slice(0, 100).map(url => ({ url, title: "Topic", keyword: '值"\\'.repeat(70) })),
    searchEvidence: urls.slice(0, 50).map(url => ({ url, clicks: 1, impressions: 2, position: 9 })),
    metricsPeriod: { startDate: "2026-10-01", endDate: "2026-10-28" },
  };
  expect(JSON.stringify(envelope({ ...input, ...refs, allowedInternalLinks: urls })).length).toBeGreaterThan(1_000_000);
  const fitted = fitPlanReferences(input, refs);
  const response = envelope(fitted);
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(LIMITS.apiResponseBytes);
  expect(validateClaim(response)).toMatchObject({ prompt: response.job.prompt });
  expect(fitted.reviewedKeywordIdeas).toEqual(input.reviewedKeywordIdeas);
  expect(fitted.referenceSampleLimited).toBe(true);
  expect(fitted.knownPages.length).toBeGreaterThan(0);
  expect(fitted.allowedInternalLinks).toEqual([...new Set([...fitted.knownPages, ...fitted.searchEvidence].map(row => row.url))]);
});

it("rejects oversized mandatory selections intact and does not drop a reviewed keyword to fit", () => {
  const ideas = input.reviewedKeywordIdeas.map(idea => ({ ...idea, keyword: idea.keyword + '"'.repeat(210), angle: '"'.repeat(500), cluster: '"'.repeat(200) }));
  expect(() => requiredPlanContext({ ...input, reviewedKeywordIdeas: ideas })).toThrow(/select fewer research keywords/);
});
