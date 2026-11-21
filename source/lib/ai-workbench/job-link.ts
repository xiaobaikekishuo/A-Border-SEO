/*
 * Links straight to a task's result (1.9.1): the page whose panel shows that
 * kind of task, with ?job= so the panel opens that task (and keeps it in its
 * list even when it is older than the latest 20), and an anchor that scrolls
 * to the panel. Used by the background pool and the weekly action list.
 */

const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** A task id from a page's or request's ?job= parameter, or undefined. */
export function jobParam(value: string | string[] | null | undefined): string | undefined {
  return typeof value === "string" && JOB_ID.test(value) ? value : undefined;
}

/** The anchor of a structured task panel on its page. */
export function toolAnchor(kind: string): string {
  return `ai-${kind.toLowerCase().replace(/_/g, "-")}`;
}
/** The anchor of the workbench's results. */
export const WORKBENCH_RESULTS = "workbench-results";

/** Where a task's result is read. Tasks without a panel of their own open in the Codex workbench. */
export function resultHref(siteId: string, kind: string, jobId: string): string {
  const site = `/sites/${encodeURIComponent(siteId)}`;
  const job = `job=${encodeURIComponent(jobId)}`;
  if (kind === "META_REWRITE") return `${site}/opportunities?${job}#${toolAnchor(kind)}`;
  if (kind === "QUERY_CLUSTERS") return `${site}/content?${job}#${toolAnchor(kind)}`;
  if (kind === "OUTREACH_EMAILS") return `${site}/backlinks?${job}#${toolAnchor(kind)}`;
  return `${site}/assistant?${job}#${WORKBENCH_RESULTS}`;
}
