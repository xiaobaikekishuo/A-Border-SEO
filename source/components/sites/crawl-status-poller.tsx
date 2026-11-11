"use client";

import { localizedPendingNote as pendingNote } from "@/components/ui/job-text";
import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { fetchJob, isFinished, isSettled, type JobView } from "@/lib/jobs/client";
import { CrawlFailedNotice } from "./crawl-failed-notice";

/**
 * A crawl job queued or running: its state, polled until it finished or
 * failed. `status` is what the server saw when it rendered the page.
 */
export function CrawlStatusPoller({ jobId, status }: { jobId: string; status: "QUEUED" | "RUNNING" }) {
  const ui = useUiText();
  const router = useRouter();
  const [job, setJob] = useState<JobView | null>(null);

  const poll = useCallback(async () => {
    try {
      const data = await fetchJob(jobId);
      if (!data) return;
      setJob(data);
      if (isFinished(data)) router.refresh();
    } catch {
      // ignore
    }
  }, [jobId, router, ui]);

  const done = job ? isFinished(job) : false;
  // Waiting for an attempt nothing will start: stop polling; Run crawl retries now.
  const settled = job ? isSettled(job) : false;

  useEffect(() => {
    // Stop once the job has finished or failed (a job whose process died is
    // queued again or failed by recovery).
    if (settled) return;
    // First poll right away (from a timer, so no state is set during the effect), then every 3 s.
    const first = setTimeout(poll, 0);
    const interval = setInterval(poll, 3000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [poll, settled, ui]);

  if (job?.status === "FAILED") {
    return (
      <CrawlFailedNotice
        error={job.crawl?.error ?? job.lastError}
        finishedAt={job.crawl?.finishedAt ?? job.finishedAt}
      />
    );
  }
  if (done) return null;

  const queued = (job?.status ?? status) === "QUEUED";
  const note = job && pendingNote(job, ui);

  return (
    <div role="status"
      className="mb-6 flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-5 py-4">
      <Loader2 className="size-5 animate-spin text-brand-500" aria-hidden />
      <div>
        <p className="text-sm font-medium text-text-strong">
          {queued ? ui("Crawl queued") : ui("Crawl in progress…")}
        </p>
        <p className="text-xs text-muted-foreground">
          {note ??
            (queued
              ? ui("It starts when the crawler is free.")
              : ui("{0} pages found · {1} issues", { "0": job?.crawl?.pagesFound ?? 0, "1": job?.crawl?.issuesFound ?? 0 }))}
        </p>
      </div>
    </div>
  );
}
