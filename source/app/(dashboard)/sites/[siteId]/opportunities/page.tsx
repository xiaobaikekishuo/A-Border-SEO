import { localizedObservation } from "@/lib/i18n/audit";
import type { Translator } from "@/lib/i18n/shared";
import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getAllOpportunities } from "@/lib/seo-opportunities";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { CsvExportButton } from "@/components/ui/csv-export-button";
import { PositionBadge, NumCell, CtrCell } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { opportunityWorkbenchHref } from "@/components/ai-workbench/opportunity-link";
import type { DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function OpportunitiesPage({ params }: Props) {
  const { t, locale } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, _count: { select: { keywords: true } } },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  if (site._count.keywords === 0) {
    return (
      <div>
        <PageHeader
          title={t("Opportunities", "优化机会")}
          description={t("Quick wins from your GSC data.", "从 GSC 数据中发现可优先改进的机会。")}
        />
        <EmptyState
          illustration="empty-gsc-wait"
          title={t("Sync GSC first", "请先同步 GSC")}
          description={t("Opportunities are computed from keyword and page performance.", "根据关键词和页面表现计算优化机会。")}
          actionLabel={t("Back to overview", "返回概览")}
          actionHref={`/sites/${siteId}`}
        />
      </div>
    );
  }

  const data = await getAllOpportunities(siteId);

  return (
    <div>
      <PageHeader
        title={t("Opportunities", "优化机会")}
        description={t("Striking distance, low CTR, content decay and keyword cannibalization.", "发现接近首页的关键词、低点击率、内容衰退和关键词内耗。")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CsvExportButton siteId={siteId} type="keywords" />
            <CsvExportButton siteId={siteId} type="pages" />
          </div>
        }
      />

      {(!data.coverage.comparable || !data.coverage.queryPagesComplete) && <div className="panel mb-4 p-4 text-sm text-muted-foreground">
        {t("Sync GSC to complete the two 28-day periods and query-page details. Incomplete data cannot establish content decay or page competition.", "请同步 GSC 补齐两个 28 天周期及关键词与页面明细。数据不完整时，暂不判断内容衰退或页面竞争。")}
      </div>}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Mini label={t("Striking distance", "接近首页的关键词")} value={data.summary.strikingDistance} />
        <Mini label={t("Low CTR", "低点击率")} value={data.summary.lowCtr} />
        <Mini label={t("Content decay", "内容衰退")} value={data.coverage.comparable ? data.summary.contentDecay : null} />
        <Mini label={t("Cannibalization", "多页面查询")} value={data.coverage.queryPagesComplete ? data.summary.cannibalization : null} />
      </div>

      {data.feed.length > 0 && (
        <div className="panel mb-6 p-5">
          <h2 className="text-[15px] leading-5 font-semibold">{t("Priority feed", "优先处理")}</h2>
          <ul className="mt-4 space-y-3">
            {data.feed.map((item, i) => (
              <li
                key={`${item.type}-${item.title}-${i}`}
                className="flex flex-col gap-1 border-b border-border pb-3 last:border-0 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <TypeBadge type={item.type} t={t} />
                    <span
                      className={cn(
                        "mono-label rounded-md border px-2 py-0.5 text-[11px]",
                        item.severity === "high" && "border-danger/30 bg-danger-bg text-danger",
                        item.severity === "medium" && "border-warning/30 bg-warning-bg text-warning",
                        item.severity === "low" && "border-border text-text"
                      )}
                    >
                      {({ high: t("high", "高"), medium: t("medium", "中"), low: t("low", "低") } as Record<string, string>)[item.severity] ?? item.severity}
                    </span>
                  </div>
                  <p className="mt-1 font-medium text-text-strong break-all">{item.title}</p>
                  <p className="text-sm text-muted-foreground">{localizedObservation(item.detail, locale)}</p>
                </div>
                <OpportunityTaskLink siteId={siteId} query={item.query} url={item.url} opportunity={item.type} t={t} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-6">
        <Section title={t("Striking distance (pos 4–20)", "接近首页的关键词（排名 4–20）")}>
          {data.striking.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("None right now", "目前没有")}</p>
          ) : (
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="mono-label text-[11px] text-muted-foreground">
                  <th className="py-2 text-left">{t("Query", "搜索查询")}</th>
                  <th className="py-2 text-right">{t("Pos", "排名")}</th>
                  <th className="py-2 text-right">{t("Impr.", "曝光量")}</th>
                  <th className="py-2 text-right">{t("Clicks", "点击量")}</th>
                  <th className="py-2 text-right">{t("Action", "操作")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {data.striking.map((k) => (
                  <tr key={k.query}>
                    <td className="py-2 font-medium">{k.query}</td>
                    <td className="py-2 text-right">
                      <PositionBadge position={k.position} />
                    </td>
                    <td className="py-2 text-right">
                      <NumCell value={k.impressions} />
                    </td>
                    <td className="py-2 text-right">
                      <NumCell value={k.clicks} />
                    </td>
                    <td className="py-2 text-right"><OpportunityTaskLink siteId={siteId} query={k.query} opportunity="striking_distance" t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t("Low CTR vs expected", "点击率低于预期")}>
          {data.lowCtr.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("None right now", "目前没有")}</p>
          ) : (
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="mono-label text-[11px] text-muted-foreground">
                  <th className="py-2 text-left">{t("Query", "搜索查询")}</th>
                  <th className="py-2 text-right">{t("Pos", "排名")}</th>
                  <th className="py-2 text-right">{t("CTR", "点击率")}</th>
                  <th className="py-2 text-right">{t("Expected", "预期值")}</th>
                  <th className="py-2 text-right">{t("Action", "操作")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {data.lowCtr.map((k) => (
                  <tr key={k.query}>
                    <td className="py-2 font-medium">{k.query}</td>
                    <td className="py-2 text-right">
                      <PositionBadge position={k.position} />
                    </td>
                    <td className="py-2 text-right">
                      <CtrCell ctr={k.ctr} />
                    </td>
                    <td className="py-2 text-right font-data text-muted-foreground">
                      {(k.expectedCtr * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 text-right"><OpportunityTaskLink siteId={siteId} query={k.query} opportunity="low_ctr" t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t("Content decay (pages −25%+ clicks)", "内容衰退（页面点击量下降 25% 以上）")}>
          {data.decay.length === 0 ? (
            <p className="text-sm text-muted-foreground">{!data.coverage.comparable ? t("Insufficient comparable data", "可比数据不足，暂不判断") : t("No decaying pages", "未发现内容衰退页面")}</p>
          ) : (
            <ul className="space-y-2">
              {data.decay.map((p) => (
                <li key={p.url} className="flex justify-between gap-4 text-sm">
                  <span className="truncate break-all text-foreground">{p.url}</span>
                  <span className="shrink-0 font-data text-danger">
                    {p.changePct.toFixed(0)}%
                  </span>
                  <OpportunityTaskLink siteId={siteId} url={p.url} opportunity="content_decay" t={t} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("Queries with multiple pages", "多页面查询")}>
          <p className="mb-3 text-xs text-muted-foreground">{t("Multiple pages can satisfy different intents. Review their content before merging or removing anything.", "同一查询对应多个页面可能是正常的不同需求覆盖。请先检查内容与意图，再决定是否合并。")}</p>
          {data.cannibal.length === 0 ? (
            <p className="text-sm text-muted-foreground">{!data.coverage.queryPagesComplete ? t("Query-page detail is not yet complete", "关键词与页面明细尚不完整") : t("No multi-URL queries detected", "未发现多个网址竞争同一查询")}</p>
          ) : (
            <ul className="space-y-4">
              {data.cannibal.map((c) => (
                <li key={c.query}>
                  <p className="font-medium text-text-strong">{c.query}</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {c.pages.map((p) => (
                      <li key={p.url} className="flex justify-between gap-2">
                        <span className="truncate">{p.url}</span>
                        <span className="font-data shrink-0">
                          {t("pos {position} · {clicks} clk", "排名 {position} · {clicks} 次点击", {position: p.position.toFixed(1), clicks: p.clicks})}
                        </span>
                        <OpportunityTaskLink siteId={siteId} url={p.url} query={c.query} opportunity="cannibalization" t={t} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="panel p-4">
      <p className="mono-label text-[11px] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-text-strong">{value ?? "n/a"}</p>
    </div>
  );
}

function OpportunityTaskLink({ siteId, url, query, opportunity, t }: { siteId: string; url?: string; query?: string; opportunity: DiagnosticSelection["opportunity"]; t: Translator }) {
  if (!url && !query) return null;
  return <Link className="inline-flex shrink-0 items-center rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20" href={opportunityWorkbenchHref(siteId, { url, query, opportunity })}>{t("Review page", "分析页面")}</Link>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel overflow-x-auto p-5">
      <h3 className="mb-4 text-[15px] leading-5 font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function TypeBadge({ type, t }: { type: string; t: Translator }) {
  const labels: Record<string, string> = {
    striking_distance: t("Striking", "接近首页"),
    low_ctr: t("Low CTR", "低点击率"),
    content_decay: t("Decay", "内容衰退"),
    cannibalization: t("Cannibal", "多页面查询"),
  };
  return (
    <span className="mono-label rounded-md border border-border bg-bg-section px-2 py-0.5 text-[11px] text-text-strong">
      {labels[type] || type}
    </span>
  );
}
