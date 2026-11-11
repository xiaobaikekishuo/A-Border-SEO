"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useResearchControls } from "./research-controls";
import { ResearchAiModes } from "./research-ai-panel";
import { useState } from "react";
import {
  Globe,
  Search,
  Loader2,
  AlertTriangle,
  ArrowRightLeft,
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

type DomainData = {
  source: string;
  domain: string;
  overview: {
    organicKeywords: number;
    organicTraffic: number;
    organicCost: number | null;
    backlinks: number | null;
    referringDomains: number | null;
  } | null;
  backlinks: {
    totalBacklinks: number;
    referringDomains: number;
    dofollow: number;
    nofollow: number;
  } | null;
  metrics?: {
    current: { clicks: number; impressions: number; avgPosition: number | null };
    previous: { clicks: number; impressions: number; avgPosition: number | null };
    deltas: { clicks: number | null; impressions: number | null; avgPosition: number | null };
  };
};

export function DomainOverviewClient({
  siteId,
  domain,
  hasDataForSEO,
}: {
  siteId: string;
  domain: string;
  hasDataForSEO: boolean;
}) {
  return <ResearchAiModes key={siteId} siteId={siteId} domain={domain} kind="DOMAIN_ANALYSIS"><DomainSourceData siteId={siteId} domain={domain} hasDataForSEO={hasDataForSEO} /></ResearchAiModes>;
}

function DomainSourceData({ siteId, domain, hasDataForSEO }: { siteId: string; domain: string; hasDataForSEO: boolean }) {
  const ui = useUiText();
  const research = useResearchControls(siteId, hasDataForSEO, "domain");
  const [ownData, setOwnData] = useState<DomainData | null>(null);
  const [competitorDomain, setCompetitorDomain] = useState("");
  const [competitorData, setCompetitorData] = useState<DomainData | null>(null);
  const [loadingOwn, setLoadingOwn] = useState(false);
  const [loadingCompetitor, setLoadingCompetitor] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(null);
  const [competitorError, setCompetitorError] = useState<string | null>(null);

  async function loadOwnDomain() {
    setLoadingOwn(true);
    setOwnError(null);
    try {
      const res = await research.request(`/api/sites/${siteId}/domain-overview`, 2, domain);
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(research.errorText(data, ui("Domain analysis failed")));
      setOwnData(data);
      setLoaded(true);
    } catch (error) {
      setOwnData(null);
      setLoaded(false);
      setOwnError(error instanceof Error ? error.message : ui("Domain analysis failed"));
    } finally {
      setLoadingOwn(false);
    }
  }

  async function handleCompare(e: React.FormEvent) {
    e.preventDefault();
    if (!competitorDomain.trim()) return;

    setLoadingCompetitor(true);
    setCompetitorData(null);
    setCompetitorError(null);
    try {
      const res = await research.request(
        `/api/sites/${siteId}/domain-overview?domain=${encodeURIComponent(competitorDomain.trim())}`, 2, competitorDomain.trim(), true
      );
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(research.errorText(data, ui("Domain comparison failed")));
      setCompetitorData(data);
    } catch (error) {
      setCompetitorError(error instanceof Error ? error.message : ui("Domain comparison failed"));
    } finally {
      setLoadingCompetitor(false);
    }
  }

  return (
    <div className="space-y-6">
      {research.controls}
      {!hasDataForSEO && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-bg p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-text-strong">
              {ui("Limited data: GSC metrics only")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {ui("Add a DataForSEO API key in")}{" "}
              <Link
                href="/settings?connect=dataforseo#connections"
                className="text-link"
              >
                {ui("Settings")}</Link>{" "}
              {ui("for full domain analysis and competitor comparison.")}</p>
          </div>
        </div>
      )}

      {/* Load own domain / Compare competitor */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <button
          type="button"
          onClick={loadOwnDomain}
          disabled={loadingOwn}
          className={buttonVariants()}
        >
          {loadingOwn ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Globe className="size-4" />
          )}
          {ui("Analyze ")}{domain}
        </button>

        {hasDataForSEO && (
          <form onSubmit={handleCompare} className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <ArrowRightLeft className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={competitorDomain}
                onChange={(e) => setCompetitorDomain(e.target.value)}
                placeholder={ui("Enter competitor domain...")}
                className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-500 focus:bg-bg focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!competitorDomain.trim() || loadingCompetitor}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-text-strong transition hover:bg-muted disabled:opacity-50"
            >
              {loadingCompetitor ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              {ui("Compare")}</button>
          </form>
        )}
      </div>

      {ownError && <p role="alert" className="text-sm text-danger">{ownError}</p>}
      {competitorError && <p role="alert" className="text-sm text-danger">{competitorError}</p>}

      {/* Results - side by side */}
      {(ownData || competitorData) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {ownData && (
            <DomainCard data={ownData} label={ui("Your domain")} />
          )}
          {competitorData && (
            <DomainCard data={competitorData} label={ui("Competitor")} />
          )}
        </div>
      )}
    </div>
  );
}

export function DomainCard({ data, label }: { data: DomainData; label: string }) {
  const ui = useUiText();
  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="eyebrow text-[12px]">
            {ui(label)}
          </p>
          <h3 className="text-[15px] leading-5 font-semibold text-text-strong">
            {data.domain}
          </h3>
        </div>
        <span className="mono-label rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {sourceLabel(data.source, ui)}
        </span>
      </div>

      {data.overview ? (
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            label={data.source === "gsc" ? (ui.locale === "zh" ? "GSC 已观察查询数" : "GSC observed queries") : ui("Organic keywords")}
            value={data.overview.organicKeywords.toLocaleString()}
          />
          <MetricCard
            label={data.source === "gsc" ? (ui.locale === "zh" ? "GSC 点击量" : "GSC clicks") : ui("Organic traffic")}
            value={data.overview.organicTraffic.toLocaleString()}
          />
          {data.overview.organicCost != null && (
            <MetricCard
              label={ui("Traffic cost")}
              value={`$${data.overview.organicCost.toLocaleString()}`}
            />
          )}
          {data.overview.backlinks != null && (
            <MetricCard
              label={ui("Backlinks")}
              value={data.overview.backlinks.toLocaleString()}
            />
          )}
          {data.overview.referringDomains != null && (
            <MetricCard
              label={ui("Referring domains")}
              value={data.overview.referringDomains.toLocaleString()}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center py-8 text-center">
          <Globe className="size-8 text-text-faint" />
          <p className="mt-2 text-sm text-muted-foreground">
            {ui("No data available for this domain")}</p>
        </div>
      )}

      {data.source === "gsc" && <p className="mt-4 text-xs leading-6 text-muted-foreground">{ui.locale === "zh" ? "已观察查询数是当前统计时段内 GSC 返回的不同查询，不是全市场关键词数量；点击量不是全站访问量或预估流量。已保存数据可能不完整，请结合概览中的 GSC 覆盖情况核对。" : "Observed queries are distinct queries returned by GSC for the current period, not the market's total keywords. Clicks are not total visits or estimated traffic. Saved data may be incomplete; check GSC coverage in Overview."}</p>}
      {data.backlinks && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 mono-label text-[12px] text-muted-foreground">
            {ui("Backlink Summary")}</p>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard
              label={ui("Total backlinks")}
              value={data.backlinks.totalBacklinks.toLocaleString()}
            />
            <MetricCard
              label={ui("Referring domains")}
              value={data.backlinks.referringDomains.toLocaleString()}
            />
            <MetricCard
              label="Dofollow"
              value={data.backlinks.dofollow.toLocaleString()}
            />
            <MetricCard
              label="Nofollow"
              value={data.backlinks.nofollow.toLocaleString()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  const ui = useUiText();
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
      <p className="mono-label text-[11px] text-muted-foreground">
        {ui(label)}
      </p>
      <p className="mt-1 font-data text-lg font-medium text-text-strong">
        {value}
      </p>
    </div>
  );
}

/** The source badge: "none" means no provider had data for the domain. */
export function sourceLabel(source: string, ui: UiTranslator = identityUiText): string {
  return source === "none" ? (ui.locale === "zh" ? "暂无数据" : "UNAVAILABLE") : source.toUpperCase();
}
