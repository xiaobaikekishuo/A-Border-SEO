import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { CodexWorkbench } from "@/components/ai-workbench/workbench";
import type { DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";

export default async function AssistantPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true } });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");
  const query = await searchParams;
  const initialSelection: DiagnosticSelection = {};
  for (const key of ["pageId", "url", "query"] as const) if (typeof query[key] === "string") initialSelection[key] = query[key].slice(0, key === "url" ? 2048 : key === "query" ? 250 : 200);
  if (typeof query.opportunity === "string" && ["striking_distance", "low_ctr", "content_decay", "cannibalization"].includes(query.opportunity)) initialSelection.opportunity = query.opportunity as DiagnosticSelection["opportunity"];
  return <CodexWorkbench key={`${siteId}:${JSON.stringify(initialSelection)}`} siteId={siteId} domain={site.domain} initialSelection={initialSelection} />;
}
