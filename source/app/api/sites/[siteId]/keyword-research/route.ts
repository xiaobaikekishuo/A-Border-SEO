import { paidConfirmation } from "@/lib/dataforseo/confirmation";
import { siteMarket } from "@/lib/dataforseo/market";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { keywordResearch } from "@/lib/dataforseo/client";
import { fetchSuggestions } from "@/lib/google/autocomplete";

async function handle(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, domain: true, researchLanguage: true, researchLocation: true },
    });
    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const query = url.searchParams.get("q");
    if (!query) {
      return Response.json({ error: "Missing query parameter: q" }, { status: 400 });
    }

    if (req.method === "POST") {
      const market = siteMarket(site);
      const denied = await paidConfirmation(req, market, 1);
      if (denied) return denied;
      const results = await keywordResearch(session.user.id, query, market.language, market.location);
      if (results === null) return Response.json({ error: "Paid research unavailable. Check credentials and provider status.", code: "PAID_RESEARCH_FAILED" }, { status: 502 });
      return Response.json({ source: "dataforseo", keywords: results, market });
    }

    // Fallback to Google Autocomplete
    const suggestions = await fetchSuggestions(query);
    return Response.json({
      source: "autocomplete",
      keywords: suggestions.map((s) => ({
        keyword: s,
        volume: null,
        difficulty: null,
        cpc: null,
        competition: null,
        trend: null,
      })),
    });
  } catch (error) {
    console.error("Keyword research error:", error);
    return Response.json(
      { error: "Keyword research failed" },
      { status: 500 }
    );
  }
}

export const GET = handle;
export const POST = handle;
