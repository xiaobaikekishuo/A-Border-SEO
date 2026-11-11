import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { VitalsButton, IndexCheckButton } from "@/components/sites/action-buttons";
import { VitalsTable } from "@/components/sites/vitals-table";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function VitalsPage({ params }: Props) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  const reports = await db.vitalsReport.findMany({
    where: { siteId },
    orderBy: { date: "desc" },
    take: 40,
  });

  return (
    <div>
      <PageHeader
        title={t("Core Web Vitals", "核心网页指标")}
        description={t("PageSpeed Insights lab data for your top pages. Set GOOGLE_PAGESPEED_KEY for a higher quota.", "主要页面的 PageSpeed Insights 实验室数据。配置 GOOGLE_PAGESPEED_KEY 可提高配额。")}
        actions={<VitalsButton siteId={siteId} />}
      />

      {reports.length === 0 ? (
        <EmptyState
          illustration="empty-vitals"
          title={t("No vitals yet", "暂无核心指标")}
          description={t("Run a check on your top landing pages (mobile Lighthouse).", "检查主要落地页（移动端 Lighthouse）。")}
        />
      ) : (
        <VitalsTable
          rows={reports.map((r) => ({
            id: r.id,
            url: r.url,
            perfScore: r.perfScore,
            lcp: r.lcp,
            cls: r.cls,
            inp: r.inp,
            ttfb: r.ttfb,
            date: r.date.toISOString(),
          }))}
        />
      )}

      <div className="panel mt-6 p-5">
        <h3 className="text-[15px] leading-5 font-semibold">{t("Index coverage", "收录覆盖")}</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("Live URL Inspection for top pages (uses your GSC OAuth token)", "实时检查主要页面的收录情况（使用你的 GSC OAuth 令牌）")}</p>
        <IndexCheckButton siteId={siteId} />
      </div>
    </div>
  );
}
