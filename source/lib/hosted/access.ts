import type { PrismaClient, HostedDevice } from "@prisma/client";
import { cache } from "react";
import { ContentError } from "@/lib/content-planner/http";
import { controlCall, HOSTED_COOKIE, hostedMode, sendHostedReceipt, usable, type HostedFeature, type HostedSnapshot } from "./control";
import { hostedContext } from "./context";
export { hostedMode } from "./control";
type HostedDb = Pick<PrismaClient, "managedIdentity" | "hostedDevice" | "session" | "site">;

export async function hostedDeviceById(db: HostedDb, id: string) {
  const device = await db.hostedDevice.findUnique({ where: { id } });
  if (!device) throw new ContentError("hosted_device_invalid", 401);
  const snapshot = await controlCall("device-policy", { productId: device.productId, accountId: device.accountId,
    installationId: device.installationId, sessionBinding: device.sessionBinding, desktopVersion: device.desktopVersion });
  if (snapshot.issuer !== device.issuer || snapshot.productId !== device.productId || snapshot.accountId !== device.accountId
    || snapshot.installationId !== device.installationId || snapshot.scope !== "device") throw new ContentError("hosted_device_invalid", 401);
  return { device, snapshot };
}

export async function hostedAccountDecision(db: Pick<PrismaClient, "managedIdentity">, userId: string): Promise<HostedSnapshot | null> {
  const owner = await db.managedIdentity.findUnique({ where: { userId } });
  if (!owner) return null;
  try {
    const snapshot = await controlCall("account-policy", { productId: owner.productId, accountId: owner.accountId });
    return snapshot.issuer === owner.issuer && snapshot.productId === owner.productId && snapshot.accountId === owner.accountId
      && snapshot.scope === "account" ? snapshot : null;
  } catch { return null; }
}

export async function hostedSiteAllows(db: HostedDb, siteId: string, feature?: HostedFeature, deviceId?: string | null): Promise<boolean> {
  if (!hostedMode()) return true;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true } });
  if (!site) return false;
  const context = hostedContext.getStore();
  if (context && (context.userId !== site.userId || !usable(context.snapshot, feature))) return false;
  try {
    if (deviceId) {
      const result = await hostedDeviceById(db, deviceId);
      return result.device.userId === site.userId && usable(result.snapshot, feature);
    }
    const policy = await hostedAccountDecision(db, site.userId);
    return Boolean(policy && usable(policy, feature));
  } catch { return false; }
}

// A valid binding authenticates the device even when its current policy denies access.
// React deduplicates this lookup only within the current server render.
export const boundHostedSession = cache(async (db: HostedDb, sessionToken: string) => {
  const session = await db.session.findUnique({ where: { sessionToken }, include: { user: true } });
  if (!session || session.expires <= new Date() || !session.hostedDeviceId) return null;
  try {
    const result = await hostedDeviceById(db, session.hostedDeviceId);
    if (result.device.userId !== session.userId || session.hostedBinding !== result.device.sessionBinding) return null;
    return { ...result, session };
  } catch (error) {
    if (error instanceof ContentError && error.status === 401) return null;
    throw error;
  }
});

export async function hostedSession(db: HostedDb, sessionToken: string) {
  const bound = await boundHostedSession(db, sessionToken).catch(() => null);
  return bound && (bound.snapshot.allowed || bound.snapshot.reason === "maintenance") ? bound : null;
}

export async function currentHostedPolicy() {
  const { cookies } = await import("next/headers");
  const { db } = await import("@/lib/db");
  const token = (await cookies()).get(HOSTED_COOKIE)?.value;
  return token ? (await boundHostedSession(db, token))?.snapshot ?? null : null;
}

export async function currentHostedFeatureAllowed(feature: HostedFeature, reportBlocked = false) {
  const snapshot = await currentHostedPolicy().catch(() => null);
  if (!snapshot) return false;
  if (usable(snapshot, feature)) return true;
  if (reportBlocked) await sendHostedReceipt(snapshot, "http_api", "blocked", snapshot.reason ?? "feature_disabled");
  return false;
}

export async function currentHostedDevice(): Promise<HostedDevice | null> {
  if (!hostedMode()) return null;
  try {
    const { cookies } = await import("next/headers");
    const { db } = await import("@/lib/db");
    const token = (await cookies()).get(HOSTED_COOKIE)?.value;
    return token ? (await hostedSession(db, token))?.device ?? null : null;
  } catch { return null; }
}
