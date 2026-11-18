import type { PrismaClient } from "@prisma/client";
import { hostedAccountDecision, hostedDeviceById, hostedMode } from "@/lib/hosted/access";
import { sendHostedReceipt, type HostedSnapshot } from "@/lib/hosted/control";

/** A receipt describes this worker's gate, not completion of any user's task. */
export function ordinaryReceiptStatus(snapshot: HostedSnapshot, running: { type: string }[]) {
  const affected = (type: string) => !snapshot.allowed || !snapshot.features.jobs
    || (type.startsWith("geo-") && !snapshot.features.geo);
  if (running.some(job => affected(job.type))) return "draining" as const;
  return !snapshot.allowed || !snapshot.features.jobs || !snapshot.features.geo ? "blocked" as const : "effective" as const;
}

export async function reportHostedJobPolicies(db: PrismaClient) {
  if (!hostedMode()) return;
  const owners = await db.managedIdentity.findMany({ select: { userId: true } });
  for (const owner of owners) {
    const snapshot = await hostedAccountDecision(db, owner.userId);
    if (!snapshot) continue;
    // Include work held by other ordinary workers, so one idle process cannot
    // claim that the account has stopped while another is still draining.
    const jobs = await db.job.findMany({ where: { site: { userId: owner.userId }, status: { in: ["QUEUED", "RUNNING"] } },
      select: { type: true, status: true, hostedDeviceId: true } });
    const running = jobs.filter(job => job.status === "RUNNING");
    await sendHostedReceipt(snapshot, "ordinary_worker", ordinaryReceiptStatus(snapshot, running), "ordinary_worker");
    for (const deviceId of new Set(jobs.flatMap(job => job.hostedDeviceId ? [job.hostedDeviceId] : []))) {
      try {
        const device = await hostedDeviceById(db, deviceId);
        if (device.device.userId !== owner.userId) continue;
        await sendHostedReceipt(device.snapshot, "ordinary_worker",
          ordinaryReceiptStatus(device.snapshot, running.filter(job => job.hostedDeviceId === deviceId)), "ordinary_worker");
      } catch { /* Revoked bindings cannot produce a fresh valid receipt. */ }
    }
  }
}
