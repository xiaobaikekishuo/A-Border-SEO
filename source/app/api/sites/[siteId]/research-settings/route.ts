import { checkOrigin } from "@/lib/content-planner/http";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { siteMarket, validMarket } from "@/lib/dataforseo/market";
import { checkMarket } from "@/lib/dataforseo/labs-catalog";
type Context = { params: Promise<{ siteId: string }> };
async function owned(context: Context) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { siteId } = await context.params;
  return db.site.findFirst({ where: { id: siteId, userId: session.user.id }, select: { id: true, userId: true, researchLanguage: true, researchLocation: true } });
}
export async function GET(_req: Request, context: Context) {
  const site = await owned(context);
  return site ? Response.json(siteMarket(site)) : Response.json({ error: "Not found" }, { status: 404 });
}
export async function PUT(req: Request, context: Context) {
  try { checkOrigin(req); }
  catch { return Response.json({ error: "Invalid origin" }, { status: 403 }); }
  const site = await owned(context);
  if (!site) return Response.json({ error: "Not found" }, { status: 404 });
  const market = await req.json().catch(() => null);
  if (!validMarket(market)) return Response.json({ error: "Invalid research market" }, { status: 400 });
  // With a DataForSEO login saved, the pair must be one the live Labs catalog offers.
  if (await checkMarket(site.userId, { language: market.language, location: market.location }) === "UNSUPPORTED") {
    return Response.json({ error: "DataForSEO does not offer this country and language pair", code: "MARKET_UNSUPPORTED" }, { status: 422 });
  }
  await db.site.update({ where: { id: site.id }, data: { researchLanguage: market.language, researchLocation: market.location } });
  return Response.json({ language: market.language, location: market.location });
}
