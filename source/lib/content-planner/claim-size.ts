import { ContentError } from "./http";
import { buildContentPrompt, type ContentPromptContext } from "./prompt";
import { outputSchema, siteUrl } from "./schema";

// Already-installed workers limit the serialized response text, including JSON escaping.
const MAX_CLAIM_CHARS = 65_536;
export const PLAN_TOO_LARGE = "Shorten the pillar details or select fewer research keywords, then generate again.";
type PlanInputs = Pick<ContentPromptContext, "domain" | "pillar" | "topicCount" | "funnelCounts" | "reviewedKeywordIdeas">;
type References = Pick<ContentPromptContext, "existingTopics" | "knownPages" | "searchEvidence" | "metricsPeriod">;

function fitsWorker(context: ContentPromptContext) {
  const envelope = { managedProtocol: 2, job: {
    jobId: "x".repeat(100), leaseToken: "x".repeat(36), leaseExpiresAt: "9999-12-31T23:59:59.999Z",
    prompt: buildContentPrompt(context), outputSchema,
  } };
  return JSON.stringify(envelope).length <= MAX_CLAIM_CHARS;
}

export function requiredPlanContext(input: PlanInputs): ContentPromptContext {
  const context: ContentPromptContext = { ...input, existingTopics: [], knownPages: [], searchEvidence: [],
    metricsPeriod: null, allowedInternalLinks: [], referenceSampleLimited: true };
  if (!fitsWorker(context)) throw new ContentError(PLAN_TOO_LARGE, 422);
  return context;
}

export function fitPlanReferences(input: PlanInputs, refs: References): ContentPromptContext {
  const minimum = requiredPlanContext(input);
  const maxRows = Math.max(refs.existingTopics.length, refs.knownPages.length, refs.searchEvidence.length);
  function sample(rows: number): ContentPromptContext {
    const count = (total: number) => maxRows ? Math.ceil(total * rows / maxRows) : 0;
    const existingTopics = refs.existingTopics.slice(0, count(refs.existingTopics.length));
    const knownPages = refs.knownPages.slice(0, count(refs.knownPages.length));
    const searchEvidence = refs.searchEvidence.slice(0, count(refs.searchEvidence.length));
    const urls = [...knownPages, ...searchEvidence].flatMap(row => {
      try { const url = siteUrl(row.url, input.domain); return url ? [url] : []; } catch { return []; }
    });
    return { ...input, existingTopics, knownPages, searchEvidence, metricsPeriod: searchEvidence.length ? refs.metricsPeriod : null,
      allowedInternalLinks: [...new Set(urls)], ...(rows < maxRows && { referenceSampleLimited: true }) };
  }
  const complete = sample(maxRows);
  if (fitsWorker(complete)) return complete;
  let best = minimum, low = 1, high = maxRows - 1;
  while (low <= high) {
    const rows = Math.floor((low + high) / 2);
    const candidate = sample(rows);
    if (fitsWorker(candidate)) { best = candidate; low = rows + 1; }
    else high = rows - 1;
  }
  return best;
}
