import { paidConfirmation } from "@/lib/dataforseo/confirmation";
import { siteMarket } from "@/lib/dataforseo/market";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { domainOverview, backlinksOverview } from "@/lib/dataforseo/client";
import { getSitePeriodMetrics } from "@/lib/seo-metrics";
import { comparableDomain, isPublicDomainName } from "@/lib/site-domain";

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

    // A typed domain is compared with the stored site normalized the same
    // way (no scheme, path or www), so your own domain, typed with or without
    // www, is your own site. DataForSEO expects a hostname without a scheme,
    // path or www prefix for a competitor; the own site is looked up as stored.
    const requestedDomain = new URL(req.url).searchParams.get("domain");
    const requested = requestedDomain === null ? null : comparableDomain(requestedDomain);
    if (requestedDomain !== null && !requested) {
      return Response.json({ error: "Invalid comparison domain" }, { status: 400 });
    }
    const isOwnSite = requested === null || requested === comparableDomain(site.domain);
    // Each lookup costs the user DataForSEO calls on their own key: refuse
    // names that can have no public data before calling the provider.
    if (!isOwnSite && !isPublicDomainName(requested)) {
      return Response.json(
        {
          error:
            "Enter a public domain such as example.com. Local names, IP addresses and reserved domains (.local, .test, .invalid, .example, .internal) have no search data.",
        },
        { status: 400 }
      );
    }
    const targetDomain = isOwnSite ? site.domain : requested;

    if (req.method === "POST") {
      const market = siteMarket(site);
      const denied = await paidConfirmation(req, market, 2);
      if (denied) return denied;
      const [domainData, backlinksData] = await Promise.all([
        domainOverview(session.user.id, targetDomain, market.language, market.location),
        backlinksOverview(session.user.id, targetDomain),
      ]);
      if (domainData === null && backlinksData === null) return Response.json({ error: "Paid research unavailable. Check credentials and provider status.", code: "PAID_RESEARCH_FAILED" }, { status: 502 });
      return Response.json({ source: "dataforseo", domain: targetDomain, overview: domainData, backlinks: backlinksData, market });
    }
    if (!isOwnSite) return Response.json({ error: "Competitor data requires a confirmed paid request", code: "PAYMENT_CONFIRMATION_REQUIRED" }, { status: 409 });

    // Fallback to GSC data
    const metrics = await getSitePeriodMetrics(siteId, 28);

    return Response.json({
      source: "gsc",
      domain: targetDomain,
      overview: {
        organicKeywords: metrics.current.uniqueKeywords,
        organicTraffic: metrics.current.clicks,
        organicCost: null,
        backlinks: null,
        referringDomains: null,
      },
      backlinks: null,
      metrics,
    });
  } catch (error) {
    console.error("Domain overview error:", error);
    return Response.json(
      { error: "Domain overview failed" },
      { status: 500 }
    );
  }
}

export const GET = handle;
export const POST = handle;
