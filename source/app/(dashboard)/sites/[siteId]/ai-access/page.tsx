import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AiAccessPanel } from "@/components/sites/ai-access-panel";

export default async function AiAccessPage({ params }: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true, gscProperty: true } });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");
  const initialUrl = site.gscProperty?.startsWith("http") ? site.gscProperty : `https://${site.domain}/`;
  return <AiAccessPanel key={siteId} siteId={siteId} domain={site.domain} initialUrl={initialUrl} />;
}
