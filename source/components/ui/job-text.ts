"use client";

import { pageSpeedGuidance } from "@/lib/google/pagespeed-errors";
import { pendingNote } from "@/lib/jobs/client";
import type { JobView } from "@/lib/jobs/client";
import { formatDay } from "@/lib/format";
import type { UiTranslator } from "./ui-text";

/** Display only: job status, scheduling and external error details are unchanged. */
export function localizedPendingNote(job: JobView, ui: UiTranslator): string | null {
  if (job.lastError) job = { ...job, lastError: pageSpeedGuidance(job.lastError, ui.locale)?.text ?? job.lastError };
  if (ui.locale !== "zh") return pendingNote(job);
  if (job.stalled) return "任务已排队，但没有 Worker 正在处理。请检查 Worker 服务是否运行。";
  const error = job.lastError ?? "未知错误";
  if (job.waiting) return `第 ${job.attempts}/${job.maxAttempts} 次尝试失败：${error}。下次尝试：${formatDay(job.nextAttemptAt ?? job.runAt, { time: true, locale: "zh" })}，也可以立即重试。`;
  if (job.status === "QUEUED" && job.attempts > 0 && job.lastError) return `第 ${job.attempts}/${job.maxAttempts} 次尝试失败：${error}。将于 ${formatDay(job.runAt, { time: true, locale: "zh" })} 重试。`;
  return null;
}
