import { db } from "@/lib/db";
import { currentHostedDevice, hostedMode } from "@/lib/hosted/access";
export async function GET() {
  if (!hostedMode()) return Response.json({ error: "hosted_disabled" }, { status: 404 });
  const device = await currentHostedDevice();
  if (!device) return Response.json({ error: "hosted_session_required" }, { status: 401 });
  const worker = await db.contentWorkerState.findUnique({ where: { id: `hosted:${device.id}` } });
  return Response.json({ connected: device.codexLogin, online: Boolean(worker && Date.now() - worker.lastSeenAt.getTime() < 90000),
    lastSeenAt: worker?.lastSeenAt.toISOString() ?? null }, { headers: { "Cache-Control": "no-store" } });
}
