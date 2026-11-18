import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertPublicDomain } from "@/lib/crawler/engine";
import { siteDomainFromProperty } from "@/lib/site-domain";
import { canUpdateSite, siteDeleted } from "@/lib/site-policy";
import { listGSCProperties, ReauthRequiredError } from "@/lib/google";
import { BingKeyMissingError, listBingSites } from "@/lib/bing";
import { managedAllows } from "@/lib/managed/policy";
import { currentHostedFeatureAllowed, hostedMode } from "@/lib/hosted/access";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;

  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const site = await db.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        _count: {
          select: {
            keywords: true,
            pages: true,
            crawls: true,
            vitals: true,
          },
        },
      },
    });

    if (!site) {
      return Response.json({ error: "Site not found" }, { status: 404 });
    }

    // Verify ownership
    if (site.userId !== session.user.id) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Remove userId from response
    const { userId, ...siteData } = site;

    return Response.json(siteData);
  } catch (error) {
    console.error("Error fetching site:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch site",
      },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;

  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, domain: true, gscProperty: true },
    });

    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    const { domain, gscProperty, bingSite } = (await req.json()) as {
      domain?: string;
      gscProperty?: string;
      bingSite?: string;
    };

    if (gscProperty !== undefined && (typeof gscProperty !== "string" || !gscProperty.trim())) {
      return Response.json({ error: "gscProperty must be a nonempty string", code: "INVALID_GSC_PROPERTY" }, { status: 400 });
    }

    const normalizedDomain = domain ? siteDomainFromProperty(domain) : null;
    if (domain && !normalizedDomain) {
      return Response.json({ error: "Invalid domain" }, { status: 400 });
    }

    // Same SSRF guard as POST /api/sites: the crawler fetches
    // https://${site.domain}, so a changed domain must be public too.
    if (normalizedDomain) {
      try {
        await assertPublicDomain(normalizedDomain);
      } catch {
        return Response.json(
          { error: "Domain must resolve to a public IP address" },
          { status: 400 }
        );
      }
    }

    // Only a real change: resending the current values must not be refused.
    const nextDomain = normalizedDomain || site.domain;
    const nextProperty = gscProperty || site.gscProperty;
    if (nextDomain !== site.domain || nextProperty !== site.gscProperty) {
      const permission = await canUpdateSite(
        { id: session.user.id },
        { id: siteId, domain: nextDomain, gscProperty: nextProperty }
      );
      if (!permission.ok) {
        return Response.json({ error: permission.reason }, { status: permission.status });
      }
    }

    if (gscProperty && gscProperty !== site.gscProperty) {
      if (siteDomainFromProperty(gscProperty) !== nextDomain) {
        return Response.json({ error: "Choose a Search Console property for this site's domain", code: "GSC_PROPERTY_MISMATCH" }, { status: 400 });
      }
      const properties = await listGSCProperties(session.user.id);
      if (!properties.some(property => property.siteUrl === gscProperty && property.permissionLevel !== "siteUnverifiedUser")) {
        return Response.json({ error: "This Google account cannot access that Search Console property", code: "GSC_PROPERTY_UNAVAILABLE" }, { status: 403 });
      }
    }

    // Stored Bing rows are keyed by site, not by property, so pointing the site
    // at a different property would blend two properties' history - and page
    // URLs from both would normalise to the same key and count twice.
    if (bingSite !== undefined && typeof bingSite !== "string") {
      return Response.json({ error: "bingSite must be a string" }, { status: 400 });
    }
    const nextBingSite = bingSite === undefined ? undefined : bingSite || null;
    const bingRestricted = async () => desktopMaintenanceActive()
      || !(hostedMode() ? await currentHostedFeatureAllowed("jobs", true) : managedAllows("jobs"));
    const bingRestrictedResponse = () => Response.json({
      error: "Bing connection is unavailable under the current policy or during an update",
      code: "BING_CONNECTION_RESTRICTED",
    }, { status: 403 });
    if (bingSite !== undefined && await bingRestricted()) return bingRestrictedResponse();
    // Validate direct requests too: the selected property must belong to this
    // account and this exact site's hostname, including any www. prefix.
    if (nextBingSite) {
      let url: URL | null = null;
      try {
        url = new URL(nextBingSite);
      } catch {}
      if (!url || !/^https?:\/\//i.test(nextBingSite) || !/^https?:$/.test(url.protocol)
        || nextBingSite !== nextBingSite.trim() || nextBingSite.length > 2048
        || url.username || url.password || url.hash || url.search) {
        return Response.json(
          { error: "bingSite must be an http(s) URL without credentials, a query or a fragment", code: "INVALID_BING_PROPERTY" },
          { status: 400 }
        );
      }
      if (siteDomainFromProperty(nextBingSite) !== nextDomain) {
        return Response.json({ error: "Choose a Bing property for this site's domain", code: "BING_PROPERTY_MISMATCH" }, { status: 400 });
      }
      let properties: Awaited<ReturnType<typeof listBingSites>>;
      try {
        properties = await listBingSites(session.user.id);
      } catch (error) {
        // Provider errors may contain request URLs or API keys. Return only
        // stable public messages and never log the provider error itself.
        if (error instanceof BingKeyMissingError) {
          return Response.json({ error: "Connect Bing Webmaster Tools before choosing a site", code: "BING_KEY_MISSING" }, { status: 400 });
        }
        return Response.json({ error: "Unable to verify Bing sites. Check the Bing connection and try again.", code: "BING_PROPERTY_CHECK_FAILED" }, { status: 502 });
      }
      if (await bingRestricted()) return bingRestrictedResponse();
      if (!properties.some(property => property.url === nextBingSite)) {
        return Response.json({ error: "This Bing account cannot access that verified property", code: "BING_PROPERTY_UNAVAILABLE" }, { status: 403 });
      }
    }
    const change = {
      where: { id: siteId },
      data: {
        ...(normalizedDomain && { domain: normalizedDomain }),
        ...(gscProperty && { gscProperty }),
        // An empty string clears the connection; undefined leaves it alone.
        ...(nextBingSite !== undefined && { bingSite: nextBingSite }),
      },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        bingSite: true,
        updatedAt: true,
      },
    };
    const updated =
      nextBingSite === undefined && gscProperty === undefined
        ? await db.site.update(change)
        : await db.$transaction(async (tx) => {
            // Both provider syncs take this same site lock before writing their rows.
            const [current] = await tx.$queryRaw<{ domain: string; gscProperty: string | null; bingSite: string | null }[]>`
              SELECT "domain", "gscProperty", "bingSite" FROM "Site"
              WHERE "id" = ${siteId} AND "userId" = ${site.userId} FOR NO KEY UPDATE
            `;
            if (!current) return null;
            if (gscProperty !== undefined && (current.domain !== site.domain ||
              (current.gscProperty !== site.gscProperty && current.gscProperty !== gscProperty))) return null;
            if (gscProperty !== undefined && gscProperty !== current.gscProperty) {
              // These four tables are provider caches. Saved keywords, notes and crawls belong to the user.
              await tx.queryPage.deleteMany({ where: { siteId } });
              await tx.keyword.deleteMany({ where: { siteId } });
              await tx.page.deleteMany({ where: { siteId } });
              await tx.gscSyncCoverage.deleteMany({ where: { siteId } });
            }
            if (nextBingSite !== undefined && nextBingSite !== current.bingSite) {
              await tx.bingSearchWeekly.deleteMany({ where: { siteId } });
              await tx.bingDaily.deleteMany({ where: { siteId } });
            }
            return tx.site.update(change);
          });

    if (!updated) return Response.json({ error: "Site connection changed. Refresh the site and try again.", code: "SITE_CONNECTION_CHANGED" }, { status: 409 });
    return Response.json(updated);
  } catch (error) {
    if (error instanceof ReauthRequiredError) {
      return Response.json({ error: "Connect Google before choosing a Search Console property", code: "REAUTH_REQUIRED" }, { status: 401 });
    }
    console.error("Error updating site:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to update site",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;

  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, domain: true },
    });

    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Delete site and cascade deletes keywords, pages, crawls, vitals, alerts
    await db.site.delete({
      where: { id: siteId },
    });

    await siteDeleted({ id: siteId, userId: site.userId, domain: site.domain });

    return Response.json({ success: true });
  } catch (error) {
    console.error("Error deleting site:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete site",
      },
      { status: 500 }
    );
  }
}
