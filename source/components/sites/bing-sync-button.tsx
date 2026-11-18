"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHeaderStatus } from "@/components/ui/header-status";
import { useI18n } from "@/lib/i18n/client";

type Outcome = "success" | "empty" | "partial" | "failed" | "pending" | "restricted" | "connection";
type Job = { status?: string; waiting?: boolean; stalled?: boolean; result?: unknown };

/** Provider omissions and an empty response must not look like a full sync. */
export function bingSyncOutcome(job: Job): Outcome | null {
  if (job.waiting || job.stalled) return "pending";
  if (job.status === "FAILED") return "failed";
  if (job.status !== "SUCCEEDED") return null;
  const result = job.result && typeof job.result === "object" ? job.result as Record<string, unknown> : {};
  if (Array.isArray(result.partial) && result.partial.some(value => ["traffic", "queries", "pages", "crawl"].includes(value))) return "partial";
  return [result.daysUpserted, result.queriesUpserted, result.pagesUpserted].some(value => typeof value === "number" && value > 0)
    ? "success" : "empty";
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function BingSyncButton({ siteId, disabled = false }: { siteId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const headerStatus = useHeaderStatus();
  const controller = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<"queued" | "running" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    setPhase(null); setOutcome(null);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [siteId]);

  const text = phase === "queued" ? t("Bing sync is queued.", "Bing 同步已排队。")
    : phase === "running" ? t("Syncing Bing data…", "正在同步 Bing 数据…")
    : outcome === "success" ? t("Bing data synced. The report has been refreshed.", "Bing 数据已同步，报表已刷新。")
    : outcome === "empty" ? t("Bing returned no data. Check the selected property or try again later.", "Bing 尚未返回数据，请检查绑定资源或稍后再试。")
    : outcome === "partial" ? t("Some Bing data synced. Other endpoints did not respond; retry to complete the report.", "已同步部分 Bing 数据，部分接口未返回结果，可重试补全报表。")
    : outcome === "restricted" ? t("Sync is paused. Check account access and workspace maintenance status.", "同步已暂停，请检查账号授权和工作台维护状态。")
    : outcome === "pending" ? t("The sync is still queued or waiting for a worker. You can check again later.", "同步仍在排队或等待 Worker，请稍后刷新查看结果。")
    : outcome === "failed" ? t("Bing sync failed. Check your Bing connection and retry.", "Bing 同步失败，请检查 Bing 连接后重试。")
    : outcome === "connection" ? t("Could not confirm the sync result. Check your connection, then refresh or retry.", "暂时无法确认同步结果，请检查连接后刷新或重试。") : null;
  const tone = ["partial", "failed", "restricted", "connection"].includes(outcome ?? "") ? "text-warning" : "text-muted-foreground";
  useEffect(() => {
    headerStatus?.(text ? <p role="status" className={`text-xs leading-5 ${tone}`}>{text}</p> : null);
    return () => headerStatus?.(null);
  }, [text, tone, headerStatus]);

  async function sync() {
    if (controller.current || disabled) return;
    const active = new AbortController();
    controller.current = active;
    const { signal } = active;
    setPhase("queued"); setOutcome(null);
    try {
      const response = await fetch("/api/bing/sync", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" }, body: JSON.stringify({ siteId }) });
      if ([401, 403, 503].includes(response.status)) { setOutcome("restricted"); return; }
      if (!response.ok) { setOutcome("failed"); return; }
      const result = await response.json();
      if (typeof result.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.jobId)) throw new Error();
      for (let attempt = 0; attempt < 90; attempt++) {
        signal.throwIfAborted();
        const status = await fetch(`/api/jobs/${result.jobId}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        if ([401, 403, 503].includes(status.status)) { setOutcome("restricted"); return; }
        if (!status.ok) throw new Error();
        const job = await status.json() as Job;
        const next = bingSyncOutcome(job);
        if (next) { setOutcome(next); router.refresh(); return; }
        setPhase(job.status === "RUNNING" ? "running" : "queued");
        await pause(signal);
      }
      setOutcome("pending"); router.refresh();
    } catch {
      if (!signal.aborted) setOutcome("connection");
    } finally {
      if (!signal.aborted) setPhase(null);
      if (controller.current === active) controller.current = null;
    }
  }

  return <div className="flex max-w-sm flex-col gap-2">
    <Button disabled={disabled || phase !== null} onClick={() => void sync()}>
      <RefreshCw aria-hidden className={`size-4 ${phase ? "animate-spin" : ""}`} />
      {phase ? t("Syncing…", "同步中…") : t("Sync Bing", "同步 Bing")}
    </Button>
    {!headerStatus && text && <p role="status" className={`text-xs ${tone}`}>{text}</p>}
  </div>;
}
