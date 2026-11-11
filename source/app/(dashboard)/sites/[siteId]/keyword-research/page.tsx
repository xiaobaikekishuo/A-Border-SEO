import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { KeywordResearchClient } from "@/components/research/keyword-research-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function KeywordResearchPage({ params }: Props) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  const hasDataForSEO = !!(await db.apiKey.findUnique({
    where: { userId_provider: { userId: session.user.id, provider: "dataforseo" } },
    select: { id: true },
  }));

  return (
    <div>
      <PageHeader
        title={t("Keyword research", "关键词研究")}
        description={t("Explore search data, get keyword ideas with ChatGPT, or run in-depth research with Manus.", "查看搜索数据，用 ChatGPT 扩展关键词，或使用 Manus 进行深度研究。")}
      />
      <KeywordResearchClient siteId={siteId} hasDataForSEO={hasDataForSEO} />
    </div>
  );
}
