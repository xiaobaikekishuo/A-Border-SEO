import type { PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { currentHostedDevice } from "./access";
import { hostedMode } from "./control";
import { hostedContext } from "./context";

export function hostedLeaseScope() {
  if (!hostedMode()) return {};
  const context = hostedContext.getStore();
  if (!context) throw new ContentError("hosted_worker_identity_required", 401);
  return { hostedDeviceId: context.deviceId, site: { userId: context.userId } };
}
export function hostedClaimScope() {
  if (!hostedMode()) return {};
  const { hostedDeviceId, site } = hostedLeaseScope();
  return { site, OR: [{ hostedDeviceId: null }, { hostedDeviceId }] };
}
export async function hostedRequestDeviceId(userId: string) {
  if (!hostedMode()) return undefined;
  const device = await currentHostedDevice();
  if (!device || device.userId !== userId) throw new ContentError("hosted_device_invalid", 401);
  return device.id;
}
export async function hostedWorkerStatus(db: Pick<PrismaClient, "hostedDevice" | "contentWorkerState">, userId: string) {
  if (!hostedMode()) return db.contentWorkerState.findFirst({ orderBy: { lastSeenAt: "desc" } });
  const deviceId = await hostedRequestDeviceId(userId);
  const device = await db.hostedDevice.findUnique({ where: { id: deviceId }, select: { codexLogin: true } });
  if (!device?.codexLogin) return null;
  return db.contentWorkerState.findUnique({ where: { id: `hosted:${deviceId}` } });
}
