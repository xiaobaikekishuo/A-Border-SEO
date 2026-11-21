import type { WorkbenchResult } from "@/lib/ai-workbench/schema";

/* The client side of the structured Codex tasks (lib/ai-workbench/tools). */

export type ToolJob = {
  id: string;
  kind: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  title: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: WorkbenchResult | null;
};
export type ToolWorkspace = {
  site: { id: string; domain: string };
  worker: { online: boolean; lastSeenAt: string | null };
  activeTask?: { id: string; kind: string; title: string; background?: boolean } | null;
  pages: { id: string; url: string; title: string | null; hasBody: boolean; hasSchema: boolean }[];
  jobs: ToolJob[];
};
export const isActiveTool = (job: Pick<ToolJob, "status">) => job.status === "QUEUED" || job.status === "RUNNING";

type Cell = string | number | boolean | null | undefined;
/**
 * Spreadsheet text that Excel opens without garbled characters: a byte order
 * mark, every cell quoted, and a cell that starts like a formula prefixed
 * with an apostrophe so it stays text.
 */
export function csvText(rows: Cell[][]): string {
  const cell = (value: Cell) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "﻿" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function datedName(prefix: string, extension: string, now = new Date()) {
  return `${prefix}-${now.toISOString().slice(0, 10)}.${extension}`;
}

/** Which known failure a server or job error is, for a readable message. */
export function toolErrorKind(message: string) {
  if (/tool_context_too_large/.test(message)) return "too_large" as const;
  if (/meta_no_search_data/.test(message)) return "no_search_data" as const;
  if (/cluster_not_enough_queries/.test(message)) return "few_queries" as const;
  if (/outreach_task_unavailable/.test(message)) return "manus_task" as const;
  if (/outreach_rows_changed/.test(message)) return "rows_changed" as const;
  if (/^Codex did not (return|group)/.test(message)) return "unusable" as const;
  if (/^Canceled by user/i.test(message)) return "canceled" as const;
  if (
    !/^Canceled by user/i.test(message) &&
    /chatgpt_usage_limit|subscription_sharing_usage_limit_exceeded|usage limit|quota|rate limit/i.test(message)
  )
    return "usage" as const;
  if (/timed out|generation_timeout/i.test(message)) return "timeout" as const;
  if (/already has an active/i.test(message)) return "busy" as const;
  if (/worker.*offline|helper.*offline|worker.*online|codex_executable_missing/i.test(message)) return "offline" as const;
  if (/codex_generation_failed|generation_failed|invalid_model_output/i.test(message)) return "unusable" as const;
  return null;
}
