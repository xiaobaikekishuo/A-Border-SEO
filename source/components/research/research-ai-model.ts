import type { AccountExecution } from "@/components/ai-workbench/chatgpt-connection";
import type { ResearchEvidence } from "@/lib/ai-workbench/research-analysis";

export type ResearchKind = "DOMAIN_ANALYSIS" | "BACKLINK_ANALYSIS";
export type ResearchInput = { title: string; targetMarket: string; language: "zh-CN" | "en"; instructions: string; body: string };
export type ResearchJob = {
  id: string; kind: string; title: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  createdAt: string; updatedAt: string; error: string | null; researchEvidence?: ResearchEvidence;
  result: { summary: string; contentMarkdown: string; changeNotes: string[]; factChecks: string[] } | null;
};
export type ResearchWorkspace = {
  site: { id: string; domain: string }; worker: { online: boolean }; jobs: ResearchJob[];
  activeTask?: { id: string; kind: string; title: string } | null;
};
export function backlinkSampleShape(body: string): "length" | "rows" | "columns" | null {
  if (body.length > 24000) return "length";
  const rows = body.split(/\r?\n/).filter(row => row.trim());
  if (rows.length > 50) return "rows";
  if (rows.some(row => { const parts = row.split("\t"); return parts.length < 2 || parts.length > 3 || !parts[0].trim() || !parts[1].trim(); })) return "columns";
  return null;
}
export function canGenerateResearch(kind: ResearchKind, input: ResearchInput, execution: AccountExecution, state: {
  online: boolean; active: boolean; busy: boolean; loading: boolean; uncertain: boolean;
}) {
  return execution.ready && execution.provider === "CHATGPT_APP" && !!execution.profileId && !!execution.model
    && execution.planOnlyConfirmed === true && state.online && !state.active && !state.busy && !state.loading && !state.uncertain
    && input.title.trim().length > 0 && input.title.trim().length <= 250
    && input.targetMarket.trim().length > 0 && input.targetMarket.trim().length <= 120 && input.instructions.length <= 6000
    && (kind !== "BACKLINK_ANALYSIS" || backlinkSampleShape(input.body) === null);
}
export function researchTaskPayload(kind: ResearchKind, input: ResearchInput, execution: AccountExecution) {
  return { action: "start", kind, provider: "CHATGPT_APP", profileId: execution.profileId, model: execution.model,
    planOnlyConfirmed: execution.planOnlyConfirmed === true, title: input.title.trim(), language: input.language,
    instructions: input.instructions.trim(), researchAnalysis: { targetMarket: input.targetMarket.trim() },
    ...(kind === "BACKLINK_ANALYSIS" && input.body.trim() ? { body: input.body.trim() } : {}) };
}
export function researchReport(job: ResearchJob | undefined, kind: ResearchKind) {
  return job?.kind === kind && job.status === "SUCCEEDED" && job.result ? job.result : null;
}
export function researchFilename(title: string) {
  return `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "seo-research"}.md`;
}
