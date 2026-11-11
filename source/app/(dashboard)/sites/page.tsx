import { getI18n } from "@/lib/i18n/server";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSitePeriodMetrics, formatCompact } from "@/lib/seo-metrics";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowRight } from "lucide-react";
import { AddSiteModal } from "@/components/sites/add-site-modal";
import { SyncButton } from "@/components/sites/sync-button";
import { OnboardingChecklist } from "@/components/dashboard/onboarding-checklist";
import { formatDay, formatDeltaPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The home: onboarding, then every site with its last 28 days. */
export default async function AllSitesPage() {
  const { t, locale } = await getI18n();
  const session = await auth();

  const sites = await db.site.findMany({
    where: { userId: session?.user?.id },
    select: {
      id: true,
      domain: true,
      gscProperty: true,
      createdAt: true,
      _count: { select: { keywords: true, pages: true, crawls: true } },
    },
    orderBy: { domain: "asc" },
  });

  // Search Console anonymises the query dimension on low-traffic sites, so a
  // synced site can have pages but no keywords. Either one means data arrived.
  const hasData = (s: (typeof sites)[number]) =>
    s._count.keywords > 0 || s._count.pages > 0;

  if (sites.length === 0) {
    return (
      <div>
        <PageHeader
          title={t("All sites", "全部站点")}
          description={t("Connect Google Search Console properties to track rankings, traffic, and opportunity.", "连接 Google Search Console 资源，跟踪排名、流量和优化机会。")}
        />
        <OnboardingChecklist
          hasSites={false}
          hasGscConnected={false}
          hasSyncedData={false}
          hasCrawled={false}
        />
        <EmptyState
          illustration="empty-sites"
          title={t("No sites connected", "尚未连接站点")}
          description={t("Choose a domain or URL-prefix property from Search Console. A-Border SEO stores your metrics locally and asks for read-only access.", "从 Search Console 选择网域或网址前缀资源。A-Border SEO 在本地保存指标，仅申请只读权限。")}
          action={<AddSiteModal triggerLabel={t("Connect first site", "连接第一个站点")} />}
        />
      </div>
    );
  }

  const siteCards = await Promise.all(
    sites.map(async (site) => {
      // Metrics are computed from the Page model (see seo-metrics), so a site
      // whose sync stored pages but no keywords still has real data to show.
      if (!hasData(site)) {
        return {
          site,
          metrics: null as Awaited<ReturnType<typeof getSitePeriodMetrics>> | null,
        };
      }
      try {
        const metrics = await getSitePeriodMetrics(site.id, 28);
        return { site, metrics };
      } catch {
        return { site, metrics: null };
      }
    })
  );

  return (
    <div>
      <PageHeader
        title={t("All sites", "全部站点")}
        description={t(sites.length === 1 ? "{count} site · last 28 days vs prior period" : "{count} sites · last 28 days vs prior period", "{count} 个站点 · 最近 28 天与上一周期对比", { count: sites.length })}
        actions={<AddSiteModal />}
      />

      <OnboardingChecklist
        hasSites
        hasGscConnected={sites.some((s) => s.gscProperty)}
        hasSyncedData={sites.some(hasData)}
        hasCrawled={sites.some((s) => s._count.crawls > 0)}
        firstSiteId={sites[0].id}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {siteCards.map(({ site, metrics }) => (
          <div key={site.id} className="panel flex h-full flex-col p-5">
            <Link href={`/sites/${site.id}`} className="group block min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-data text-[17px] leading-6 font-medium text-text-strong decoration-brand-500 underline-offset-4 group-hover:underline">
                    {site.domain}
                  </h2>
                  <p className="mt-0.5 truncate font-data text-[12px] text-muted-foreground">
                    {site.gscProperty}
                  </p>
                </div>
                <ArrowRight
                  aria-hidden
                  className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-text-strong"
                />
              </div>

              {!metrics ? (
                <div className="mt-5 rounded-md border border-dashed border-line-strong px-3 py-4 text-sm text-muted-foreground">
                  {t("Waiting for first GSC sync…", "等待首次 GSC 同步…")}</div>
              ) : (
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Stat
                    label={t("Clicks", "点击量")}
                    value={formatCompact(metrics.current.clicks)}
                    delta={metrics.deltas.clicks === null ? t("Not comparable", "暂不可比") : formatDeltaPercent(metrics.deltas.clicks)}
                    positive={metrics.deltas.clicks === null ? undefined : metrics.deltas.clicks >= 0}
                  />
                  <Stat
                    label={t("Impressions", "曝光量")}
                    value={formatCompact(metrics.current.impressions)}
                    delta={metrics.deltas.impressions === null ? t("Not comparable", "暂不可比") : formatDeltaPercent(metrics.deltas.impressions)}
                    positive={metrics.deltas.impressions === null ? undefined : metrics.deltas.impressions >= 0}
                  />
                  <Stat
                    label={t("Avg position", "平均排名")}
                    value={
                      metrics.current.avgPosition > 0
                        ? metrics.current.avgPosition.toFixed(1)
                        : t("n/a", "暂无")
                    }
                    delta={
                      metrics.deltas.avgPosition === null ? t("Not comparable", "暂不可比") : metrics.deltas.avgPosition === 0
                        ? "0"
                        : `${metrics.deltas.avgPosition > 0 ? "+" : ""}${metrics.deltas.avgPosition.toFixed(1)}`
                    }
                    positive={metrics.deltas.avgPosition === null ? undefined : metrics.deltas.avgPosition >= 0}
                  />
                  <Stat
                    label={t("Keywords", "关键词")}
                    value={metrics.current.uniqueKeywords.toLocaleString()}
                  />
                </div>
              )}

              <p className="mt-4 font-data text-[12px] text-muted-foreground">
                {t("{keywords} keyword rows · {pages} page rows · {crawls} crawls", "{keywords} 条关键词记录 · {pages} 条页面记录 · {crawls} 次抓取", { keywords: formatCompact(site._count.keywords), pages: formatCompact(site._count.pages), crawls: site._count.crawls })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Added", "添加时间")} {formatDay(site.createdAt, {locale,  year: true })}
              </p>
            </Link>

            <div className="mt-4 border-t border-border pt-4">
              <SyncButton siteId={site.id} variant="outline" size="sm" messageSide="end" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  delta,
  positive,
}: {
  label: string;
  value: string;
  delta?: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-md border border-border-soft bg-bg-soft px-3 py-2.5">
      <p className="mono-label text-[11px] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="font-data text-[16px] font-medium text-text-strong">{value}</p>
        {delta !== undefined && (
          <span
            className={cn(
              "font-data text-[12px]",
              positive === undefined ? "text-muted-foreground" : positive ? "text-success" : "text-danger"
            )}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}
