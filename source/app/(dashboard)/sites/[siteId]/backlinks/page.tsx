import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { BacklinksClient } from "@/components/research/backlinks-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function BacklinksPage({ params }: Props) {
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
        title={t("Backlinks", "外链")}
        description={t("Review link sources, distinguish outgoing links from backlinks, and ask ChatGPT for analysis.", "查看链接来源、区分出站链接与反向链接，并用 ChatGPT 生成诊断建议。")}
      />
      <BacklinksClient
        siteId={siteId}
        domain={site.domain}
        hasDataForSEO={hasDataForSEO}
      />
    </div>
  );
}
