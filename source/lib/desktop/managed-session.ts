import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { Adapter } from "next-auth/adapters";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { verifiedManagedIdentity } from "@/lib/managed/identity";
import { hostedMode, hostedAccountDecision, hostedSession } from "@/lib/hosted/access";
import { hostedContext } from "@/lib/hosted/context";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const managedLoginInput = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  installationId: id,
  accountId: id,
  sequence: z.number().int().positive(),
}).strict();

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function currentManagedIdentity() {
  if (hostedMode()) return null;
  if (process.env.ABORDER_MANAGED !== "1" || process.env.ABORDER_DESKTOP_MODE !== "1") return null;
  try {
    const nonceFile = process.env.ABORDER_DESKTOP_LOGIN_NONCE_FILE;
    if (!nonceFile) return null;
    const nonce = readFileSync(nonceFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(nonce)) return null;
    const identity = verifiedManagedIdentity();
    return identity ? { ...identity, nonceHash: digest(nonce) } : null;
  } catch { return null; }
}

export async function createManagedSession(db: PrismaClient, input: z.infer<typeof managedLoginInput>) {
  const identity = currentManagedIdentity();
  if (!identity || input.installationId !== identity.installationId || input.accountId !== identity.accountId
    || input.sequence !== identity.sequence
    || !timingSafeEqual(Buffer.from(digest(input.nonce), "hex"), Buffer.from(identity.nonceHash, "hex"))) {
    throw new ContentError("managed_login_denied", 403);
  }
  const key = { issuer: identity.issuer, productId: identity.productId, accountId: identity.accountId };
  const identityHash = digest(JSON.stringify([key.issuer, key.productId, key.accountId]));
  return db.$transaction(async tx => {
    const owner = await tx.managedIdentity.upsert({
      where: { issuer_productId_accountId: key }, update: {},
      create: { ...key, user: { create: { email: `${identityHash}@managed.invalid`, name: "A-Border SEO" } } },
    });
    // Replace the previous desktop session for this installation. Do not touch
    // another user's data or unrelated self-hosted Google sessions.
    await tx.session.deleteMany({ where: { userId: owner.userId, managedInstallationId: identity.installationId } });
    const sessionToken = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await tx.session.create({ data: { sessionToken, expires, userId: owner.userId,
      managedNonceHash: identity.nonceHash, managedInstallationId: identity.installationId } });
    return { sessionToken, expires };
  });
}

export async function managedOwnsLocalUser(db: Pick<PrismaClient, "managedIdentity">, userId: string) {
  if (hostedMode()) {
    const context = hostedContext.getStore();
    if (context && context.userId !== userId) return false;
    return Boolean((await hostedAccountDecision(db, userId))?.allowed);
  }
  if (process.env.ABORDER_MANAGED !== "1") return true;
  const identity = currentManagedIdentity();
  if (!identity) return false;
  const owner = await db.managedIdentity.findUnique({ where: { userId } });
  return Boolean(owner && owner.issuer === identity.issuer && owner.productId === identity.productId
    && owner.accountId === identity.accountId);
}

// Enforce the account binding when Auth.js reads a cookie, including direct
// browser API access. A lease change, logout nonce rotation or expiry cannot
// leave a previously signed-in user's database session usable.
export function managedSessionAdapter(adapter: Adapter, db: PrismaClient): Adapter {
  return { ...adapter, async getSessionAndUser(sessionToken) {
    if (hostedMode()) {
      const result = await hostedSession(db, sessionToken);
      if (!result) return null;
      const { user, ...session } = result.session;
      return { user, session };
    }
    if (process.env.ABORDER_MANAGED !== "1") return adapter.getSessionAndUser!(sessionToken);
    const identity = currentManagedIdentity();
    if (!identity) return null;
    const row = await db.session.findUnique({ where: { sessionToken }, include: { user: { include: { managedIdentity: true } } } });
    const owner = row?.user.managedIdentity;
    if (!row || !owner || row.expires <= new Date() || row.managedNonceHash !== identity.nonceHash
      || row.managedInstallationId !== identity.installationId || owner.issuer !== identity.issuer
      || owner.productId !== identity.productId || owner.accountId !== identity.accountId) return null;
    const { user, ...session } = row;
    return { user, session };
  } };
}
