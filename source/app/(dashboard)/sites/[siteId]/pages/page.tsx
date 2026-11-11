import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getTopPages } from "@/lib/seo-metrics";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SyncButton } from "@/components/sites/sync-button";
import { CsvExportButton } from "@/components/ui/csv-export-button";
import { PagesTable } from "@/components/sites/pages-table";

interface PagesPageProps {
  params: Promise<{ siteId: string }>;
}

export default async function PagesPage({ params }: PagesPageProps) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });

  if (!site || site.userId !== session?.user?.id) {
    redirect("/sites");
  }

  const pages = await getTopPages(siteId, 28, 100);

  return (
    <div>
      <PageHeader
        title={t("Pages", "页面")}
        description={t("Landing pages from Search Console, aggregated over the last 28 days.", "来自 Search Console 的落地页数据，汇总最近 28 天。")}
        reserveStatus
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CsvExportButton siteId={siteId} type="pages" />
            <SyncButton siteId={siteId} />
          </div>
        }
      />

      {pages.length === 0 ? (
        <EmptyState
          illustration="empty-pages"
          title={t("No pages yet", "暂无页面")}
          description={t("Sync GSC to pull page-level clicks, impressions, and positions.", "同步 GSC，获取页面级点击量、曝光量和排名。")}
        />
      ) : (
        <PagesTable
          domain={site.domain}
          rows={pages.map((p) => ({
            url: p.url,
            position: p.position,
            clicks: p.clicks,
            impressions: p.impressions,
            ctr: p.ctr,
          }))}
        />
      )}
    </div>
  );
}
