import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { ReportAnalysisLink } from "@/components/ai-workbench/report-analysis-link";
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
        description={t("PageSpeed Insights for your top pages: Lighthouse lab values, and real-user field data (Chrome UX Report, p75 of the last 28 days) where Chrome has enough visits. Lighthouse cannot measure INP; TBT is its lab stand-in, and only field data can pass Core Web Vitals. Set GOOGLE_PAGESPEED_KEY for a higher quota.", "主要页面的 PageSpeed Insights 数据：Lighthouse 实验室数据，以及 Chrome 访问量足够时的真实用户数据（Chrome 用户体验报告，过去 28 天的第 75 百分位）。Lighthouse 无法测量 INP，TBT 是它的实验室替代指标；只有真实用户数据才能判定核心网页指标是否达标。配置 GOOGLE_PAGESPEED_KEY 可提高配额。")}
        actions={<>
          <VitalsButton siteId={siteId} />
          <ReportAnalysisLink siteId={siteId} scope="performance" t={t} />
        </>}
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
            tbt: r.tbt,
            fieldSource: r.fieldSource === "URL" || r.fieldSource === "ORIGIN" ? r.fieldSource : null,
            fieldLcp: r.fieldLcp,
            fieldInp: r.fieldInp,
            fieldCls: r.fieldCls,
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
