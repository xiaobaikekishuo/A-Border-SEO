import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDailyTrafficSeries } from "@/lib/seo-metrics";
import { getGscDateRange } from "@/lib/date-utils";

export async function GET(
  _req: Request,
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
      select: { userId: true },
    });

    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(_req.url);
    const days = Math.min(
      Math.max(Number(url.searchParams.get("days") || 90), 7),
      180
    );

    if (!Number.isInteger(days)) return Response.json({ error: "Invalid day count" }, { status: 400 });
    const range = getGscDateRange(days);
    const data = await getDailyTrafficSeries(siteId, { startDate: range.start, endDate: range.end });
    return Response.json(data.days, { headers: {
      "Cache-Control": "private, no-store", "X-GSC-Basis": data.basis, "X-GSC-Start": range.start, "X-GSC-End": range.end,
    } });
  } catch (error) {
    console.error("Error fetching traffic:", error);
    return Response.json({ error: "Failed to load traffic" }, { status: 500 });
  }
}
