import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { APP_VERSION } from "@/lib/version";
import { readManagedState, validateConfig, verifyLease, type ManagedState } from "./protocol.mjs";
import { hostedMode, hostedAccountDecision } from "@/lib/hosted/access";
import { hostedContext } from "@/lib/hosted/context";

// Worker processes have the signed policy mount but do not have access to the
// private desktop session nonce. Their own job/feature gates still apply.
export function verifiedManagedIdentity() {
  if (process.env.ABORDER_MANAGED !== "1") return null;
  try {
    const directory = process.env.ABORDER_MANAGED_POLICY_DIR;
    if (!directory) return null;
    const config = validateConfig(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")), { allowHttpLoopback: true });
    const state: ManagedState = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const decision = readManagedState(config, state, { backendVersion: APP_VERSION, now });
    if (!decision.allowed && decision.reason !== "maintenance") return null;
    const claims = verifyLease(state.lease, { config, installationId: state.installationId, accountId: state.accountId,
      now: Math.max(now, state.highestWallTime) });
    return { issuer: claims.iss, productId: claims.productId, accountId: claims.accountId,
      installationId: claims.installationId, sequence: claims.sequence };
  } catch { return null; }
}

export async function managedUserScope(db: Pick<PrismaClient, "managedIdentity">): Promise<{ managed: boolean; userId: string | null }> {
  if (hostedMode()) {
    const context = hostedContext.getStore();
    return context ? { managed: true, userId: context.userId } : { managed: false, userId: null };
  }
  if (process.env.ABORDER_MANAGED !== "1") return { managed: false, userId: null };
  const identity = verifiedManagedIdentity();
  if (!identity) return { managed: true, userId: null };
  const { issuer, productId, accountId } = identity;
  const owner = await db.managedIdentity.findUnique({ where: { issuer_productId_accountId: { issuer, productId, accountId } } });
  return { managed: true, userId: owner?.userId ?? null };
}

export async function managedOwnerAllows(db: Pick<PrismaClient, "managedIdentity">, userId: string): Promise<boolean> {
  if (hostedMode()) {
    const context = hostedContext.getStore();
    return context ? context.userId === userId && context.snapshot.allowed : Boolean((await hostedAccountDecision(db, userId))?.allowed);
  }
  const scope = await managedUserScope(db);
  return !scope.managed || scope.userId === userId;
}
