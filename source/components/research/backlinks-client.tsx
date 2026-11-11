"use client";

import { useUiText } from "@/components/ui/ui-text";


import { useResearchControls } from "./research-controls";
import { ResearchAiModes } from "./research-ai-panel";
import { useState } from "react";
import {
  Link as LinkIcon,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

type BacklinkItem = {
  referringDomain: string;
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  dofollow: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
};

type BacklinksOverview = {
  totalBacklinks: number;
  referringDomains: number;
  referringIps?: number;
  dofollow: number;
  nofollow: number;
};

export function BacklinksClient({
  siteId,
  domain,
  hasDataForSEO,
}: {
  siteId: string;
  domain: string;
  hasDataForSEO: boolean;
}) {
  return <ResearchAiModes key={siteId} siteId={siteId} domain={domain} kind="BACKLINK_ANALYSIS"><BacklinkSourceData siteId={siteId} domain={domain} hasDataForSEO={hasDataForSEO} /></ResearchAiModes>;
}

function BacklinkSourceData({ siteId, domain, hasDataForSEO }: { siteId: string; domain: string; hasDataForSEO: boolean }) {
  const ui = useUiText();
  const research = useResearchControls(siteId, hasDataForSEO, "backlinks");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [overview, setOverview] = useState<BacklinksOverview | null>(null);
  const [backlinks, setBacklinks] = useState<BacklinkItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function handleLoad() {
    setLoading(true); setError(null);
    try {
      const res = await research.request(`/api/sites/${siteId}/backlinks`, 2, domain);
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(research.errorText(data, ui("Backlinks fetch failed")));
      setSource(data.source);
      setOverview(data.overview);
      setBacklinks(data.backlinks ?? []);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : ui("Backlinks fetch failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {research.controls}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-sm text-muted-foreground">{ui.locale === "zh" ? "免费查询读取已抓取的出站链接；DataForSEO 查询反向链接并逐次确认费用。下方结果按实际返回的数据来源标注，切换选项不会改变已加载结果。" : "Free queries read crawled outgoing links. DataForSEO queries incoming backlinks with confirmation for each paid request. Results below retain their actual source label when you switch options."}</p>
      {!hasDataForSEO && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-bg p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-text-strong">
              {ui("Limited backlink data")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {ui("Add a DataForSEO API key in")}{" "}
              <Link
                href="/settings?connect=dataforseo#connections"
                className="text-link"
              >
                {ui("Settings")}</Link>{" "}
              {ui("for full backlink analysis with referring domains and anchor text.")}</p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleLoad}
        disabled={loading}
        className={buttonVariants()}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : loaded ? (
          <RefreshCw className="size-4" />
        ) : (
          <LinkIcon className="size-4" />
        )}
        {loaded ? ui("Refresh") : research.paid ? ui("Load backlinks") : (ui.locale === "zh" ? "查看抓取的外部链接" : "View crawled external links")}
      </button>

      {/* Overview stats */}
      {loaded && <p className="rounded-lg border border-border bg-card p-3 text-sm" role="status">{backlinkSourceLabel(source, ui.locale === "zh")}</p>}
      {overview && source === "dataforseo" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={ui("Total backlinks")}
            value={overview.totalBacklinks.toLocaleString()}
          />
          <StatCard
            label={ui("Referring domains")}
            value={overview.referringDomains.toLocaleString()}
          />
          <StatCard
            label="Dofollow"
            value={overview.dofollow.toLocaleString()}
          />
          <StatCard
            label="Nofollow"
            value={overview.nofollow.toLocaleString()}
          />
        </div>
      )}

      {/* Backlinks table */}
      {loaded && backlinks.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    {source === "crawl" ? (ui.locale === "zh" ? "来源页面" : "Source page") : ui("Referring Domain")}</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    {ui("Target URL")}</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    {ui("Anchor Text")}</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    {ui("Type")}</th>
                </tr>
              </thead>
              <tbody>
                {backlinks.map((link, i) => (
                  <tr
                    key={`${link.sourceUrl}-${i}`}
                    className="border-b border-border transition-colors hover:bg-bg-soft"
                  >
                    <td className="max-w-[200px] px-4 py-3">
                      <span className="block truncate font-medium text-text-strong">
                        {link.referringDomain || safeHostname(link.sourceUrl)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {link.sourceUrl}
                      </span>
                    </td>
                    <td className="max-w-[200px] px-4 py-3">
                      <span className="block truncate text-foreground">
                        {link.targetUrl}
                      </span>
                    </td>
                    <td className="max-w-[150px] px-4 py-3">
                      <span className="block truncate text-muted-foreground">
                        {link.anchorText || ui("n/a")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`mono-label rounded-md border px-2 py-0.5 text-[11px] ${
                          link.dofollow
                            ? "border-success/30 bg-success-bg text-success"
                            : "border-border text-muted-foreground"
                        }`}
                      >
                        {link.dofollow ? "dofollow" : "nofollow"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-bg-soft px-4 py-2 text-xs text-muted-foreground">
            {backlinks.length}{source === "crawl" ? (ui.locale === "zh" ? " 条出站链接样本" : " outgoing link samples") : (ui.locale === "zh" ? " 条反链记录" : " backlink records")}
            {source === "dataforseo" ? ui(" via DataForSEO") : ui(" from crawl data")}
          </div>
        </div>
      )}

      {/* Empty state */}
      {loaded && backlinks.length === 0 && (
        <div className="panel flex flex-col items-center py-12 text-center">
          <LinkIcon className="size-10 text-text-faint" />
          <p className="mt-3 font-medium text-text-strong">{source === "dataforseo" ? ui("No backlinks found") : (ui.locale === "zh" ? "当前样本没有出站链接" : "No outgoing links in this sample")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {source === "none"
              ? ui("Run a site crawl first to discover external links, or add a DataForSEO API key for full backlink data")
              : source === "crawl" ? (ui.locale === "zh" ? "这不能说明网站没有反向链接。" : "This does not establish that the site has no incoming backlinks.") : ui("No backlink data available")}
          </p>
        </div>
      )}
    </div>
  );
}

export function backlinkSourceLabel(source: string | null, zh = false) {
  if (source === "crawl") return zh ? "已加载：本地抓取的出站链接样本，不是反向链接" : "Loaded: outgoing link samples from the local crawl, not incoming backlinks";
  if (source === "dataforseo") return zh ? "已加载：DataForSEO 反向链接数据" : "Loaded: DataForSEO incoming backlink data";
  return zh ? "暂无可用链接数据，反链总量未知" : "No available link data; total incoming backlinks are unknown";
}
function safeHostname(url: string) { try { return new URL(url).hostname; } catch { return url; } }

function StatCard({ label, value }: { label: string; value: string }) {
  const ui = useUiText();
  return (
    <div className="panel px-4 py-3">
      <p className="mono-label text-[11px] text-muted-foreground">
        {ui(label)}
      </p>
      <p className="mt-1 font-data text-xl font-medium text-text-strong">
        {value}
      </p>
    </div>
  );
}
