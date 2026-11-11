import type { AccountExecution } from "@/components/ai-workbench/chatgpt-connection";

export type KeywordIdea = {
  keyword: string; intent: "INFORMATIONAL" | "COMMERCIAL" | "TRANSACTIONAL" | "NAVIGATIONAL";
  funnel: "TOFU" | "MOFU" | "BOFU"; cluster: string; angle: string; rationale: string;
};
export type KeywordJob = {
  id: string; kind: string; title: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  createdAt: string; updatedAt: string; error: string | null;
  result: { summary: string; factChecks: string[]; keywordIdeas?: KeywordIdea[] } | null;
};
export type KeywordWorkspace = {
  site: { id: string; domain: string }; worker: { online: boolean };
  jobs: KeywordJob[]; activeTask?: { id: string; kind: string; title: string } | null;
};
export type KeywordInput = { seed: string; targetMarket: string; count: 12 | 24; language: "zh-CN" | "en"; instructions: string };

export function canGenerateKeywords(input: KeywordInput, execution: AccountExecution, state: {
  online: boolean; active: boolean; busy: boolean; loading: boolean; uncertain: boolean;
}) {
  return execution.ready && execution.provider === "CHATGPT_APP" && !!execution.profileId && !!execution.model
    && execution.planOnlyConfirmed === true && state.online && !state.active && !state.busy && !state.loading && !state.uncertain
    && input.seed.trim().length > 0 && input.seed.trim().length <= 250
    && input.targetMarket.trim().length > 0 && input.targetMarket.trim().length <= 120 && input.instructions.length <= 6000;
}
export function keywordTaskPayload(input: KeywordInput, execution: AccountExecution) {
  return { action: "start", kind: "KEYWORD_RESEARCH", provider: "CHATGPT_APP", profileId: execution.profileId,
    model: execution.model, planOnlyConfirmed: execution.planOnlyConfirmed === true, title: input.seed.trim(), keyword: input.seed.trim(),
    language: input.language, instructions: input.instructions.trim(), keywordResearch: { count: input.count, targetMarket: input.targetMarket.trim() } };
}
export function visibleKeywordIdeas(job: KeywordJob | undefined, query: string, funnel: string): KeywordIdea[] {
  if (job?.status !== "SUCCEEDED" || job.kind !== "KEYWORD_RESEARCH") return [];
  const needle = query.trim().toLocaleLowerCase();
  return (job.result?.keywordIdeas ?? []).filter(idea => (!funnel || idea.funnel === funnel)
    && (!needle || `${idea.keyword} ${idea.cluster} ${idea.angle}`.toLocaleLowerCase().includes(needle)));
}
