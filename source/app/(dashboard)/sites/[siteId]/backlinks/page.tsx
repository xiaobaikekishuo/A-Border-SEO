import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { BacklinksClient } from "@/components/research/backlinks-client";
import { ManusResearchPanel } from "@/components/research/manus-research-panel";
import { OutreachPanel } from "@/components/ai-workbench/outreach-panel";
import { jobParam } from "@/lib/ai-workbench/job-link";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ job?: string | string[] }>;
}

export default async function BacklinksPage({ params, searchParams }: Props) {
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

  // ?job=: open that outreach task's result (links from the background pool).
  const job = jobParam((await searchParams).job);

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
      <div className="mt-5">
        <ManusResearchPanel key={siteId} siteId={siteId} kind="LINK_PROSPECTS" />
      </div>
      <div className="mt-5">
        <OutreachPanel key={`outreach-${siteId}:${job ?? ""}`} siteId={siteId} initialJobId={job} />
      </div>
    </div>
  );
}
