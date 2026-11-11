import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { ContentPlanner } from "@/components/content-planner/content-planner";

export default async function ContentPage({ params }: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true } });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");
  return <ContentPlanner key={siteId} siteId={siteId} domain={site.domain} />;
}
