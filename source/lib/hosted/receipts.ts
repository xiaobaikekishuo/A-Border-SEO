import type { PrismaClient } from "@prisma/client";
import { RUN_TIMEOUT_MS } from "@/lib/content-planner/data";
import type { HostedSnapshot } from "./control";

type DeviceOwner = { id: string; userId: string };

/** Valid in-flight leases can still consume a desktop's quota until it stops or the lease expires. */
export async function contentReceiptStatus(db: PrismaClient, snapshot: HostedSnapshot, device?: DeviceOwner, now = new Date()) {
  if (snapshot.allowed && snapshot.features.codex) return "effective" as const;
  try {
    if (!device) {
      if (snapshot.scope !== "device" || !snapshot.installationId) return "blocked" as const;
      const [owner, candidate] = await Promise.all([
        db.managedIdentity.findUnique({ where: { issuer_productId_accountId: {
          issuer: snapshot.issuer, productId: snapshot.productId, accountId: snapshot.accountId } } }),
        db.hostedDevice.findUnique({ where: { issuer_productId_installationId: {
          issuer: snapshot.issuer, productId: snapshot.productId, installationId: snapshot.installationId } } }),
      ]);
      if (!owner || !candidate || candidate.userId !== owner.userId || candidate.accountId !== snapshot.accountId) return "blocked" as const;
      device = candidate;
    }
    const where = { hostedDeviceId: device.id, site: { userId: device.userId }, status: "RUNNING" as const,
      leaseToken: { not: null }, leaseExpiresAt: { gt: now }, startedAt: { gt: new Date(now.getTime() - RUN_TIMEOUT_MS) } };
    const active = await Promise.all([db.contentPlanJob.count({ where }), db.aiWorkbenchJob.count({ where })]);
    return active.some(count => count > 0) ? "draining" as const : "blocked" as const;
  } catch {
    // Missing state is never evidence that all affected desktop executions stopped.
    return "failed" as const;
  }
}
