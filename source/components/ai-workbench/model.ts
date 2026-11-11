import type { DiagnosticEvidence } from "@/lib/ai-workbench/diagnostic-types";
export type TaskKind = "WRITE_ARTICLE" | "REWRITE_ARTICLE" | "SEO_FIX_PLAN";
export type TaskDiagnosticEvidence = Omit<DiagnosticEvidence, "pages" | "page"> & { page: Omit<NonNullable<DiagnosticEvidence["page"]>, "body"> | null };
export type ParagraphEdit = { id: string; sourceText: string; replacementText: string; reason: string; evidence: string[]; verification: string[] };
export type WorkbenchResult = {
  title: string; summary: string; contentMarkdown: string; metaTitle: string; metaDescription: string;
  changeNotes: string[]; factChecks: string[]; internalLinks: { target: string; anchor: string; reason: string }[];
  paragraphEdits?: ParagraphEdit[];
};
export type WorkbenchJob = {
  id: string; kind: TaskKind; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  title: string; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; draftText: string | null; result: WorkbenchResult | null;
  diagnosis?: TaskDiagnosticEvidence;
};
export type WorkbenchData = {
  site: { id: string; domain: string }; worker: { online: boolean; lastSeenAt: string | null };
  activeTask?: { id: string; kind: string; title: string } | null;
  pages: { id: string; url: string; title: string | null; hasBody: boolean }[];
  clusters: { id: string; title: string; keyword: string; url: string | null; pillarTitle: string }[];
  jobs: WorkbenchJob[];
};
export type DraftEditor = { jobId: string; text: string; baseline: string; updatedAt: string };
export const isActiveJob = (job: WorkbenchJob) => job.status === "QUEUED" || job.status === "RUNNING";
export function isAccountLimitError(message: string) {
  return !/^Canceled by user/i.test(message) && /chatgpt_usage_limit|subscription_sharing_usage_limit_exceeded|usage limit|quota|rate limit/i.test(message);
}
export function syncDraftEditor(current: DraftEditor | null, job: WorkbenchJob | undefined): DraftEditor | null {
  if (!job) return current;
  if (job.status !== "SUCCEEDED" || !job.result) return null;
  // A background status refresh must never replace locally edited text or its concurrency token.
  if (current?.jobId === job.id && (current.text !== current.baseline || current.updatedAt === job.updatedAt)) return current;
  const text = job.draftText ?? job.result.contentMarkdown;
  return { jobId: job.id, text, baseline: text, updatedAt: job.updatedAt };
}
export function hasRewriteBody(body: string, pageId: string, pages: WorkbenchData["pages"]) {
  return body.trim() ? body.trim().length >= 100 : !!pages.find(page => page.id === pageId)?.hasBody;
}

/** Apply only to a unique, unchanged source fragment. Never rebase an owner's edits. */
export function applyParagraphEdit(text: string, edit: ParagraphEdit): { ok: true; text: string } | { ok: false; reason: "missing" | "ambiguous" | "already" | "too_long" } {
  if (!edit.sourceText || edit.sourceText === edit.replacementText) return { ok: false, reason: "already" };
  const at = text.indexOf(edit.sourceText);
  if (at < 0) return { ok: false, reason: edit.replacementText && text.includes(edit.replacementText) ? "already" : "missing" };
  if (text.indexOf(edit.sourceText, at + 1) >= 0) return { ok: false, reason: "ambiguous" };
  // An expanded replacement may still contain the original. Detect only a replacement
  // enclosing this occurrence, not an unrelated matching phrase elsewhere in the draft.
  if (edit.replacementText.length > edit.sourceText.length) {
    let replacementAt = text.indexOf(edit.replacementText);
    while (replacementAt >= 0 && replacementAt <= at) {
      if (replacementAt + edit.replacementText.length >= at + edit.sourceText.length) return { ok: false, reason: "already" };
      replacementAt = text.indexOf(edit.replacementText, replacementAt + 1);
    }
  }
  const next = text.slice(0, at) + edit.replacementText + text.slice(at + edit.sourceText.length);
  if (next.length > 60000) return { ok: false, reason: "too_long" };
  return { ok: true, text: next };
}
