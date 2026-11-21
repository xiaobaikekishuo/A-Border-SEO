import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getI18n } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/page-header";
import RankTracking from "@/components/rank-tracking/rank-tracking";
import { ReportAnalysisLink } from "@/components/ai-workbench/report-analysis-link";

export default async function RankingsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const userId = (await auth())?.user?.id;
  if (!userId) redirect("/login");
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { domain: true } });
  if (!site) redirect("/sites");
  const { t } = await getI18n();
  return <main className="space-y-5">
    <PageHeader title={t("Rank tracking", "排名追踪")} meta={site.domain}
      description={t("Measured Google positions of the keywords you track, checked through your DataForSEO account on a schedule or by hand.", "通过你的 DataForSEO 账户，定期或手动检查所追踪关键词在 Google 上的实际名次。")}
      actions={<>
        <Link className="text-sm text-link" href={`/sites/${siteId}/saved-keywords`}>{t("Saved keywords", "已保存关键词")} →</Link>
        <ReportAnalysisLink siteId={siteId} scope="rankings" t={t} />
      </>} />
    <RankTracking key={siteId} siteId={siteId} />
  </main>;
}
