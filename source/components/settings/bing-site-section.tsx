"use client";

import { localizedPendingNote as pendingNote } from "@/components/ui/job-text";
import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, RefreshCw, Save, XCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { waitForJob } from "@/lib/jobs/client";

interface BingSite {
  url: string;
}

export function BingSiteSection({
  siteId,
  bingSite,
}: {
  siteId: string;
  bingSite: string | null;
}) {
  const ui = useUiText();
  const { t } = useI18n();
  const router = useRouter();
  const [sites, setSites] = useState<BingSite[]>([]);
  const [selected, setSelected] = useState(bingSite ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  function connectionError(code: unknown) {
    if (code === "BING_PROPERTY_MISMATCH") return t("Choose a Bing property with the same hostname as this site, including www if present.", "请选择主机名与当前网站一致的 Bing 资源，包括是否带 www。");
    if (code === "BING_PROPERTY_UNAVAILABLE") return t("This Bing account cannot access that property. Refresh the list and choose a verified site.", "当前 Bing 账号无法访问该资源，请刷新列表并选择已验证的网站。");
    if (code === "BING_KEY_MISSING") return t("Connect Bing Webmaster Tools in account settings first.", "请先在账号设置中连接 Bing 站长工具。");
    if (code === "BING_CONNECTION_RESTRICTED") return t("Bing connection changes are paused by workspace policy or maintenance.", "当前工作台策略或维护状态暂停了 Bing 连接操作。");
    if (code === "INVALID_BING_PROPERTY") return t("Choose a valid Bing website URL.", "请选择有效的 Bing 网站资源地址。");
    return t("Could not verify the Bing connection. Check the saved API key and network, then retry.", "暂时无法验证 Bing 连接，请检查已保存的 API 密钥和网络后重试。");
  }

  async function loadSites() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/bing/sites");
      const data = await res.json();
      if (!res.ok) throw new Error(connectionError(data.code));
      setSites(data as BingSite[]);
      if (!data.length) setError(ui("This Bing account has no verified sites."));
    } catch (err) {
      setError(err instanceof Error ? err.message : ui("Failed to load Bing sites"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setError(null);
    setMessage(null);
    if (!selected) {
      setError(ui("Choose a Bing property first."));
      return;
    }
    if (selected === bingSite) {
      setMessage(ui("This property is already connected."));
      return;
    }
    setSaving(true);

    try {
      const res = await fetch(`/api/sites/${siteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bingSite: selected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(connectionError(data.code));
      }
      setMessage(ui("Bing property connected."));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : ui("Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setMessage(null);
    setCanRetry(false);

    try {
      const res = await fetch("/api/bing/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      });
      const queued = await res.json();
      if (!res.ok) throw new Error(connectionError(queued.code));
      // The sync runs as a job: wait for it, and say why when it waits or retries.
      const job = await waitForJob(queued.jobId, {
        onUpdate: (j) => setMessage(pendingNote(j, ui) ?? (j.status === "RUNNING" ? ui("Syncing…") : ui("Queued…"))),
      });
      if (job.waiting) {
        setMessage(null);
        setError(pendingNote(job, ui));
        setCanRetry(true);
        return;
      }
      if (job.status === "FAILED") throw new Error(t("Bing sync failed. Check the connection and retry.", "Bing 同步失败，请检查连接后重试。"));
      const data = (job.result ?? {}) as {
        daysUpserted?: number;
        queriesUpserted?: number;
        pagesUpserted?: number;
        partial?: string[];
      };
      setMessage(
        ui("Synced {0} days, {1} query weeks, ", { "0": data.daysUpserted ?? 0, "1": data.queriesUpserted ?? 0 }) +
          ui("{0} page weeks.", { "0": data.pagesUpserted ?? 0 })
      );
      if (data.partial?.length) {
        setError(
          ui("Bing did not answer for: {0}. Run the sync again.", { "0": data.partial.join(", ") })
        );
      }
      router.refresh();
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : ui("Sync failed"));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div id="bing-connection" className="panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] leading-5 font-semibold text-text-strong">
            {ui("Bing Webmaster property")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {ui("Bing reports its own queries, pages and crawl stats. The property URL often differs from the Search Console one, so pick it explicitly.")}</p>
        </div>
        {bingSite ? (
          <span className="flex shrink-0 items-center gap-1.5 mono-label rounded-md border border-success/30 bg-success-bg px-2 py-0.5 text-[11px] text-success">
            <CheckCircle2 className="size-3.5" />
            {ui("Connected")}</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 mono-label rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            <XCircle className="size-3.5" />
            {ui("Not connected")}</span>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selected}
            onValueChange={(value) => setSelected(String(value))}
            onOpenChange={(open) => {
              if (open) void loadSites();
            }}
          >
            <SelectTrigger className="min-w-64">
              <SelectValue
                placeholder={loading ? ui("Loading…") : ui("Choose a Bing property")}
              />
            </SelectTrigger>
            <SelectContent>
              {sites.map((site) => (
                <SelectItem key={site.url} value={site.url}>
                  {site.url}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button type="button" size="sm" onClick={handleSave} disabled={saving || syncing}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            {ui("Save")}</Button>

          {bingSite && (
            <Button type="button" size="sm" variant="outline" onClick={handleSync} disabled={syncing || saving}>
              {syncing ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden />
              )}
              {ui("Sync Bing")}</Button>
          )}
          {bingSite && <Link href={`/sites/${siteId}/bing`} className="text-link text-sm font-medium">
            {t("View Bing reports", "查看 Bing 报表")}
          </Link>}
        </div>

        {message && <p className="text-xs text-success">{message}</p>}
        {error && (
          <p className="text-xs text-danger">
            {error}
            {canRetry && (
              <>
                {" "}
                <button type="button" onClick={() => void handleSync()} className="text-link font-medium">
                  {ui("Retry")}</button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
