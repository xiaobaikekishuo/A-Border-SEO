import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DomainOverviewClient } from "@/components/research/domain-overview-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function DomainOverviewPage({ params }: Props) {
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
        title={t("Domain overview", "域名概览")}
        description={t("Review source data or use your ChatGPT plan to interpret saved site evidence.", "查看来源数据，或用 ChatGPT 账号额度解读已保存的站点证据。")}
      />
      <DomainOverviewClient
        siteId={siteId}
        domain={site.domain}
        hasDataForSEO={hasDataForSEO}
      />
    </div>
  );
}
