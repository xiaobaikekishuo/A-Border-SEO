import { auth } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { assertPublicDomain } from "@/lib/crawler/engine";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { GSC_SYNC_JOB } from "@/lib/jobs/handlers";
import { requestSiteJob } from "@/lib/jobs/site-jobs";
import { ensureDefaultAlerts } from "@/lib/alerts/evaluate";
import { isPublicDomainName, siteDomainFromProperty } from "@/lib/site-domain";
import { canAddSite, siteCreated } from "@/lib/site-policy";
import { listGSCProperties, ReauthRequiredError } from "@/lib/google";

// On a serverless host the first GSC sync runs after the response, within this
// limit (SERVERLESS_MAX_DURATION_S in lib/jobs/config.ts; Next needs a literal here).
export const maxDuration = 300;

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sites = await db.site.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            keywords: true,
            crawls: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return Response.json(sites);
  } catch (error) {
    console.error("Error fetching sites:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch sites",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid site request" }, { status: 400 });
    }
    const input = body as { domain?: unknown; gscProperty?: unknown };
    const hasProperty = input.gscProperty !== undefined && input.gscProperty !== null;
    if (hasProperty && (typeof input.gscProperty !== "string" || !input.gscProperty.trim() || input.gscProperty.length > 2048)) {
      return Response.json({ error: "Invalid gscProperty" }, { status: 400 });
    }
    const gscProperty = hasProperty ? (input.gscProperty as string).trim() : null;
    if (!gscProperty && (typeof input.domain !== "string" || !input.domain.trim() || input.domain.length > 2048)) {
      return Response.json({ error: "Enter a website domain or URL" }, { status: 400 });
    }

    // A connected property is authoritative. Manual sites keep no GSC
    // property, so they can use crawls and the workbench without Google.
    const domain = siteDomainFromProperty(gscProperty ?? input.domain as string);

    if (!domain || !isPublicDomainName(domain)) {
      return Response.json(
        { error: "Enter a valid public website domain or URL" },
        { status: 400 }
      );
    }

    // Reject domains that resolve to private/internal IPs (SSRF protection)
    try {
      await assertPublicDomain(domain);
    } catch {
      return Response.json(
        { error: "Domain must resolve to a public IP address" },
        { status: 400 }
      );
    }

    // Check if site already exists
    const existing = await db.site.findUnique({
      where: {
        userId_domain: {
          userId: session.user.id,
          domain,
        },
      },
    });

    if (existing) {
      return Response.json(
        { error: "Site already exists" },
        { status: 409 }
      );
    }

    const permission = await canAddSite({ id: session.user.id }, { domain, gscProperty });
    if (!permission.ok) {
      return Response.json({ error: permission.reason }, { status: permission.status });
    }

    if (gscProperty) {
      try {
        const properties = await listGSCProperties(session.user.id);
        if (!properties.some(property => property.siteUrl === gscProperty && property.permissionLevel !== "siteUnverifiedUser")) {
          return Response.json({ error: "This Google account cannot access that Search Console property", code: "GSC_PROPERTY_UNAVAILABLE" }, { status: 403 });
        }
      } catch (error) {
        if (error instanceof ReauthRequiredError) {
          return Response.json({ error: "Connect Google before choosing a Search Console property", code: "REAUTH_REQUIRED" }, { status: 401 });
        }
        return Response.json({ error: "Could not verify Search Console access. Please try again.", code: "GSC_PROPERTIES_UNAVAILABLE" }, { status: 502 });
      }
    }

    // Create the site
    const site = await db.site.create({
      data: {
        userId: session.user.id,
        domain,
        gscProperty,
      },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        createdAt: true,
      },
    });

    await ensureDefaultAlerts(session.user.id, site.id);

    // The first GSC sync runs as a job, so the response does not wait for it.
    if (site.gscProperty) {
      try {
        const { job } = await requestSiteJob(db, { type: GSC_SYNC_JOB, siteId: site.id, source: "site-added" });
        dispatchJob(db, job);
      } catch (err) {
        console.error("Could not queue the initial GSC sync:", err);
      }
    }

    await siteCreated({ ...site, userId: session.user.id });

    return Response.json(site, { status: 201 });
  } catch (error) {
    // The same account can submit twice before the initial duplicate read.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return Response.json({ error: "Site already exists" }, { status: 409 });
    }
    console.error("Error creating site:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to create site",
      },
      { status: 500 }
    );
  }
}
