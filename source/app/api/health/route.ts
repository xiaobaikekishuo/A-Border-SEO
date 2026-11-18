import { db } from "@/lib/db";
import { desktopOrigin } from "@/lib/desktop/oauth";
import { APP_VERSION } from "@/lib/version";
import { managedHealth } from "@/lib/managed/health";

export async function GET() {
  try {
    // Test database connection
    await db.$queryRaw`SELECT 1`;

    return Response.json({
      status: "ok",
      version: APP_VERSION,
      hostedMode: process.env.ABORDER_HOSTED === "1",
      desktopMode: desktopOrigin() !== null,
      managed: await managedHealth(db),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return Response.json(
      {
        status: "error",
        message: "Database unavailable",
      },
      { status: 503 }
    );
  }
}
