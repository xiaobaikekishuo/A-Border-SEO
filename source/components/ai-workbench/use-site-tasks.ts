"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { AccountExecution } from "./chatgpt-connection";
import { taskText } from "./task-messages";

/*
 * The task list of the assistant API as the AI panels use it: loading with
 * stale responses ignored, polling while a task runs, which task is selected,
 * whether the active task keeps the owner from starting another, and
 * starting and canceling one request at a time.
 */

export type TaskStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type SiteTask = { id: string; kind: string; status: TaskStatus };
export type ActiveTask = { id: string; kind: string; title: string; background?: boolean };
export type TaskListData<J extends SiteTask = SiteTask> = {
  site: { id: string };
  worker: { online: boolean };
  activeTask?: ActiveTask | null;
  jobs: J[];
};

export const isActiveTask = (job: Pick<SiteTask, "status">) => job.status === "QUEUED" || job.status === "RUNNING";

/**
 * The site's active task, and the one that keeps the owner from starting
 * another. A background pool task blocks nothing: it gives way when the owner
 * starts a task.
 */
export function activeTaskOf<J extends SiteTask>(data: Pick<TaskListData<J>, "activeTask" | "jobs"> | null | undefined) {
  const active: J | ActiveTask | null = data?.activeTask ?? data?.jobs.find(isActiveTask) ?? null;
  const background = !!active && !!data?.activeTask?.background && active.id === data.activeTask.id;
  return { active, blocking: background ? null : active };
}

/** Refreshes 5 seconds after each change of `data` while a task is active, until a load fails (`stopped`). */
export function usePollWhileActive(active: unknown, stopped: boolean, refresh: (signal?: AbortSignal) => unknown, data: unknown) {
  useEffect(() => {
    if (!active || stopped) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void refresh(controller.signal);
    }, 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, data, stopped, refresh]);
}

type StartOptions = {
  /** A server error as a readable message. */
  errorText: (message: string) => string;
  /** Shown once the task exists. */
  notice: string;
  onStarted?: (jobId: string) => void;
};

/**
 * The tasks of one kind for a site.
 * initialData: a workspace to show before the first load.
 * initialJobId: a task a link points at (?job=); it opens first and stays listed.
 * provider: the account a new task uses until the connection panel reports one.
 */
export function useSiteTasks<J extends SiteTask, W extends TaskListData<J>>({
  siteId,
  kind,
  initialData = null,
  initialJobId,
  provider = "CODEX_LOCAL",
}: {
  siteId: string;
  kind: string;
  initialData?: W | null;
  initialJobId?: string;
  provider?: AccountExecution["provider"];
}) {
  const { t } = useI18n();
  const [data, setData] = useState<W | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [execution, setExecution] = useState<AccountExecution>({ provider, ready: false });
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId ?? initialData?.jobs[0]?.id ?? null);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant`;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++sequence.current;
      setRefreshing(true);
      try {
        const linked = initialJobId ? `&job=${encodeURIComponent(initialJobId)}` : "";
        const response = await fetch(`${endpoint}?kind=${kind}${linked}`, { cache: "no-store", signal });
        const result = await response.json();
        if (!response.ok || result.site?.id !== siteId || !Array.isArray(result.jobs) || !result.worker) throw new Error("load_failed");
        if (signal?.aborted || sequence.current !== request) return false;
        setData(result as W);
        setSelectedId(current => (current && result.jobs.some((job: J) => job.id === current) ? current : (result.jobs[0]?.id ?? null)));
        setLoadError("");
        setUncertain(false);
        return true;
      } catch {
        if (!signal?.aborted && sequence.current === request) setLoadError(taskText.loadFailed(t));
        return false;
      } finally {
        if (!signal?.aborted && sequence.current === request) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [endpoint, initialJobId, kind, siteId, t],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
      sequence.current++;
    };
  }, [refresh]);

  const jobs = (data?.jobs ?? []).filter(job => job.kind === kind);
  const selected = jobs.find(job => job.id === selectedId) ?? null;
  const { active, blocking } = activeTaskOf(data);
  usePollWhileActive(active, !!loadError, refresh, data);
  const online = !!data?.worker.online;
  /** The panel state the generate checks of the research models take. */
  const gate = { online, active: !!blocking, busy, loading: loading || refreshing || !!loadError, uncertain };

  const post = (body: Record<string, unknown>) =>
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /**
   * Starts a task with this request body. A response that never arrives
   * leaves the panel uncertain until the next successful load: the task may
   * exist, and nothing is retried automatically.
   */
  async function start(body: Record<string, unknown>, { errorText, notice: started, onStarted }: StartOptions) {
    if (mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await post(body);
      const result = await response.json();
      if (!response.ok) {
        setError(errorText(result.error || taskText.createFailed(t)));
        return false;
      }
      if (typeof result.jobId !== "string") throw new Error("invalid_response");
      setSelectedId(result.jobId);
      onStarted?.(result.jobId);
      setNotice(started);
      await refresh();
      return true;
    } catch {
      setUncertain(true);
      setError(taskText.interrupted(t));
      return false;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }

  async function cancel(job: { id: string }) {
    if (busy || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await post({ action: "cancel", jobId: job.id });
      if (!response.ok) throw new Error();
      setNotice(taskText.canceled(t));
      await refresh();
    } catch {
      setError(taskText.cancelUnconfirmed(t));
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }

  return {
    kind,
    data,
    jobs,
    selected,
    setSelectedId,
    active,
    blocking,
    online,
    gate,
    loading,
    refreshing,
    loadError,
    error,
    setError,
    notice,
    setNotice,
    busy,
    uncertain,
    execution,
    setExecution,
    refresh,
    start,
    cancel,
  };
}
