import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SaveKeywordForm } from "@/components/sites/saved-keyword-actions";
import { SavedKeywordsTable } from "@/components/sites/saved-keywords-table";
import { getTopKeywords } from "@/lib/seo-metrics";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function SavedKeywordsPage({ params }: Props) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  const saved = await db.savedKeyword.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
  });

  const keywordData = await getTopKeywords(siteId, 28, saved.length, saved.map(row => row.query));
  const dataMap = new Map(keywordData.map(row => [row.query, row]));

  return (
    <div>
      <PageHeader
        title={t("Saved keywords", "已保存关键词")}
        description={t("Track specific keywords over time.", "持续跟踪指定关键词的表现。")}
        actions={<SaveKeywordForm siteId={siteId} />}
      />

      {saved.length === 0 ? (
        <EmptyState
          illustration="empty-saved"
          title={t("No saved keywords", "暂无已保存关键词")}
          description={t("Save keywords you want to track closely. Use the form above to add your first keyword.", "保存需要持续跟踪的关键词，使用上方表单添加第一个关键词。")}
        />
      ) : (
        <SavedKeywordsTable
          siteId={siteId}
          rows={saved.map((kw) => {
            const data = dataMap.get(kw.query);
            return {
              id: kw.id,
              query: kw.query,
              notes: kw.notes,
              position: data?.position ?? null,
              clicks: data?.clicks ?? null,
              impressions: data?.impressions ?? null,
              ctr: data?.ctr ?? null,
            };
          })}
        />
      )}
    </div>
  );
}
