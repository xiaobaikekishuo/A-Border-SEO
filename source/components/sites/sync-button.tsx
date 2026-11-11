"use client";

import { localizedPendingNote as pendingNote } from "@/components/ui/job-text";
import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useHeaderStatus } from "@/components/ui/header-status";
import { formatDay } from "@/lib/format";
import { waitForJob, type JobView } from "@/lib/jobs/client";
import { cn } from "@/lib/utils";

export type SyncOutcome =
  | { tone: "success" | "empty" | "error"; text: string }
  | { tone: "reauth"; text: string }
  | { tone: "waiting"; text: string };

type SyncResponse = {
  error?: string;
  code?: string;
  keywordsInserted?: number;
  pagesInserted?: number;
  uniqueKeywords?: number;
  uniquePages?: number;
  startDate?: string;
  endDate?: string;
};

/** What a finished sync says. Zero keywords and zero pages is not a success: Search Console sent nothing. */
export function syncOutcome(status: number, data: SyncResponse, ui: UiTranslator = identityUiText): SyncOutcome {
  if (status === 401 && data.code === "REAUTH_REQUIRED") {
    return { tone: "reauth", text: ui("Your Google connection expired.") };
  }
  if (status < 200 || status >= 300) {
    return { tone: "error", text: data.error || ui("Sync failed") };
  }
  const keywords = data.keywordsInserted ?? 0;
  const pages = data.pagesInserted ?? 0;
  if (keywords === 0 && pages === 0) {
    const range =
      data.startDate && data.endDate
        ? ui(" for {0} to {1}", { "0": formatDay(data.startDate, { locale: ui.locale, year: true }), "1": formatDay(data.endDate, { locale: ui.locale, year: true }) })
        : "";
    return { tone: "empty", text: ui("GSC returned no data{0}. Check the property in Site settings.", { "0": range }) };
  }
  const counts = ui.locale === "zh"
    ? `同步了 ${keywords} 条关键词记录、${pages} 条页面记录`
    : `Synced ${keywords} keyword records · ${pages} page records`;
  const unique = data.uniqueKeywords !== undefined && data.uniquePages !== undefined
    ? (ui.locale === "zh" ? `（${data.uniqueKeywords} 个不同关键词、${data.uniquePages} 个唯一网址）` : ` (${data.uniqueKeywords} distinct queries · ${data.uniquePages} unique URLs)`)
    : "";
  return { tone: "success", text: counts + unique };
}

/** The outcome of a finished sync job, in the same terms as the old synchronous response. */
export function syncJobOutcome(job: JobView, ui: UiTranslator = identityUiText): SyncOutcome {
  // An attempt failed and nothing will start the next one by itself.
  if (job.waiting) return { tone: "waiting", text: pendingNote(job, ui) ?? ui("Sync failed, retry now.") };
  if (job.status === "SUCCEEDED") return syncOutcome(200, (job.result ?? {}) as SyncResponse, ui);
  if (job.errorCode === "REAUTH_REQUIRED") return syncOutcome(401, { code: "REAUTH_REQUIRED" }, ui);
  return syncOutcome(500, { error: job.lastError ?? undefined }, ui);
}

const TONE: Record<SyncOutcome["tone"], string> = {
  success: "text-success",
  empty: "text-muted-foreground",
  error: "text-danger",
  reauth: "text-warning",
  waiting: "text-warning",
};

/**
 * Sync GSC with its result in a fixed slot, so a message never moves the
 * button or the layout around it. In a page header the message goes to the
 * header's status row (PageHeader reserveStatus keeps that row's height); on a
 * card it sits after the button (three lines, reserved).
 */
export function SyncButton({
  siteId,
  className,
  variant = "default",
  size = "default",
  messageSide = "start",
}: {
  siteId: string;
  className?: string;
  variant?: "default" | "outline";
  size?: "default" | "sm";
  messageSide?: "start" | "end";
}) {
  const ui = useUiText();
  const router = useRouter();
  const setHeaderStatus = useHeaderStatus();
  const [loading, setLoading] = useState<false | "queued" | "running">(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const handleSync = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await runSync();
  };

  const runSync = async () => {
    setLoading("queued");
    setOutcome(null);

    try {
      const response = await fetch("/api/gsc/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      });
      const data = (await response.json().catch(() => ({}))) as SyncResponse & { jobId?: string };
      let next: SyncOutcome;
      if (response.status === 202 && data.jobId) {
        // Queued: wait for the job, and say why when it waits or retries.
        const job = await waitForJob(data.jobId, {
          onUpdate: (j) => {
            setLoading(j.status === "RUNNING" ? "running" : "queued");
            const note = pendingNote(j, ui);
            setOutcome(note ? { tone: "empty", text: note } : null);
          },
        });
        next = syncJobOutcome(job, ui);
      } else {
        next = syncOutcome(response.status, data, ui);
      }
      setOutcome(next);

      if (next.tone === "success" || next.tone === "empty") router.refresh();
      // Only a plain success fades; an empty result or an error stays until the next sync.
      if (next.tone === "success") setTimeout(() => setOutcome(null), 4000);
    } catch {
      setOutcome({ tone: "error", text: ui("Sync failed") });
    } finally {
      setLoading(false);
    }
  };

  const message = outcome && (
    <>
      {outcome.text}
      {outcome.tone === "waiting" && (
        <>
          {" "}
          <button type="button" onClick={() => void runSync()} className="text-link font-medium">
            {ui("Retry")}</button>
        </>
      )}
      {outcome.tone === "reauth" && (
        <>
          {" "}
          <button type="button" onClick={() => signIn("google")} className="text-link font-medium">
            {ui("Reconnect")}</button>
        </>
      )}
    </>
  );

  useEffect(() => {
    if (!setHeaderStatus) return;
    setHeaderStatus(
      outcome ? (
        <p
          role="status"
          title={outcome.text}
          className={cn("line-clamp-2 text-[12px] leading-4 sm:line-clamp-1", TONE[outcome.tone])}
        >
          {message}
        </p>
      ) : null
    );
    // message is derived from outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHeaderStatus, outcome, ui]);
  useEffect(() => () => setHeaderStatus?.(null), [setHeaderStatus, ui]);

  const button = (
    <Button onClick={handleSync} disabled={loading !== false} variant={variant} size={size} className={className}>
      {loading === "queued" ? ui("Queued…") : loading ? ui("Syncing…") : ui("Sync GSC")}
    </Button>
  );

  if (setHeaderStatus) return button;

  return (
    <div
      className={cn(
        "flex min-w-0 gap-3",
        messageSide === "start" ? "flex-row-reverse items-center" : "flex-row items-start"
      )}
    >
      {button}
      <p
        role="status"
        title={outcome?.text}
        className={cn(
          "min-w-0 max-w-[340px] flex-1 text-[12px] leading-4",
          // Beside the button: two lines fit the 38px height. Card: three lines are always reserved under the top of the button.
          messageSide === "start" ? "line-clamp-2 text-right" : "line-clamp-3 h-12",
          outcome && TONE[outcome.tone]
        )}
      >
        {message}
      </p>
    </div>
  );
}
