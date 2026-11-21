import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { ContentPlanner } from "@/components/content-planner/content-planner";
import { QueryClusterPanel } from "@/components/ai-workbench/query-cluster-panel";
import { parseKeywordSelection, reviewedKeywords } from "@/lib/content-planner/keyword-selection";
import { jobParam } from "@/lib/ai-workbench/job-link";

export default async function ContentPage({ params, searchParams }: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ researchJob?: string | string[]; ideas?: string | string[]; job?: string | string[] }>;
}) {
  const session = await auth();
  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true } });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");
  const { researchJob, ideas, job: jobValue } = await searchParams;
  // ?job=: open that clustering's result (links from the background pool).
  const job = jobParam(jobValue);
  const reference = parseKeywordSelection(researchJob, ideas);
  const research = reference ? await reviewedKeywords(db, siteId, reference) :
    (researchJob !== undefined || ideas !== undefined ? null : undefined);
  const key = research ? [siteId, research.reference.jobId, ...research.reference.indexes].join("/") : siteId;
  return <>
    <ContentPlanner key={key} siteId={siteId} domain={site.domain} research={research} />
    <div className="mt-6"><QueryClusterPanel key={`clusters-${siteId}:${job ?? ""}`} siteId={siteId} initialJobId={job} /></div>
  </>;
}
