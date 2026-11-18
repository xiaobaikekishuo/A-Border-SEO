import type { Job, PrismaClient } from "@prisma/client";
import { currentHostedDevice, hostedMode, hostedSiteAllows } from "@/lib/hosted/access";
import { JobError, type JobSource } from "./types";

type JobPolicyInput = Pick<Job, "siteId" | "type"> & { hostedDeviceId?: string | null };

/** Background work keeps its originating device; schedules belong to the account. */
export async function hostedJobAllows(db: PrismaClient, job: JobPolicyInput): Promise<boolean> {
  if (!hostedMode()) return true;
  if (!await hostedSiteAllows(db, job.siteId, "jobs", job.hostedDeviceId)) return false;
  return !job.type.startsWith("geo-") || hostedSiteAllows(db, job.siteId, "geo", job.hostedDeviceId);
}

/** Device IDs are obtained from the verified session, never from an HTTP body. */
export async function enqueueHostedDevice(db: PrismaClient, input: JobPolicyInput & { source: JobSource }) {
  if (!hostedMode()) return null;
  if (input.source === "chain") return input.hostedDeviceId ?? null;
  const device = input.source === "schedule" ? null : await currentHostedDevice();
  if (input.source !== "schedule" && !device) {
    throw new JobError("A verified workspace session is required.", { code: "HOSTED_SESSION_REQUIRED" });
  }
  if (!await hostedJobAllows(db, { ...input, hostedDeviceId: device?.id ?? null })) {
    throw new JobError("The management policy paused this job.", { code: "HOSTED_POLICY_RESTRICTED" });
  }
  return device?.id ?? null;
}
