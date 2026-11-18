import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { controlCall, deviceInput, hostedMode, sendHostedReceipt, type HostedReceiptComponent } from "./control";
import { hostedContext } from "./context";
import { contentReceiptStatus } from "./receipts";

async function verifyHostedDevice(headers: Headers, input: unknown) {
  if (!hostedMode()) throw new ContentError("hosted_disabled", 404);
  const parsed = deviceInput.parse(input);
  const authorization = headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._~-]{20,2048}$/.test(authorization)) throw new ContentError("hosted_credentials_required", 401);
  const snapshot = await controlCall("authenticate", { ...parsed, deviceToken: authorization.slice(7) });
  if (snapshot.scope !== "device" || snapshot.installationId !== parsed.installationId || snapshot.productId !== parsed.productId
    || (parsed.accountId && snapshot.accountId !== parsed.accountId) || !snapshot.sessionBinding) throw new ContentError("hosted_device_invalid", 401);
  return { parsed, snapshot };
}

export async function authenticateHostedDevice(db: PrismaClient, headers: Headers, input: unknown, allowMaintenance = false, component: HostedReceiptComponent = "http_session") {
  const { parsed, snapshot } = await verifyHostedDevice(headers, input);
  if (!snapshot.allowed && !(allowMaintenance && snapshot.reason === "maintenance")) {
    const status = component === "content_worker" ? await contentReceiptStatus(db, snapshot) : "blocked";
    await sendHostedReceipt(snapshot, component, status, status === "failed" ? "content_state_unknown" : snapshot.reason ?? "policy_denied");
    throw new ContentError(snapshot.reason ?? "policy_denied", 403);
  }
  const key = { issuer: snapshot.issuer, productId: snapshot.productId, accountId: snapshot.accountId };
  const identityHash = createHash("sha256").update(JSON.stringify([key.issuer, key.productId, key.accountId])).digest("hex");
  const device = await db.$transaction(async tx => {
    const owner = await tx.managedIdentity.upsert({ where: { issuer_productId_accountId: key }, update: {},
      create: { ...key, user: { create: { email: `${identityHash}@managed.invalid`, name: snapshot.label || "A-Border SEO" } } } });
    const deviceKey = { issuer: key.issuer, productId: key.productId, installationId: parsed.installationId };
    const previous = await tx.hostedDevice.findUnique({ where: { issuer_productId_installationId: deviceKey } });
    if (previous && (previous.sessionBinding !== snapshot.sessionBinding || previous.userId !== owner.userId)) {
      await tx.session.deleteMany({ where: { hostedDeviceId: previous.id } });
    }
    const fields = { accountId: key.accountId, userId: owner.userId, sessionBinding: snapshot.sessionBinding!, desktopVersion: parsed.desktopVersion, lastSeenAt: new Date() };
    return tx.hostedDevice.upsert({ where: { issuer_productId_installationId: deviceKey },
      create: { ...deviceKey, ...fields }, update: { ...fields, ...(previous?.sessionBinding !== snapshot.sessionBinding ? { codexLogin: false } : {}) } });
  });
  return { device, snapshot };
}

export async function createHostedSession(db: PrismaClient, headers: Headers, input: unknown) {
  const context = await authenticateHostedDevice(db, headers, input, true);
  const sessionToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 30 * 86400000);
  await db.$transaction(async tx => {
    await tx.session.deleteMany({ where: { hostedDeviceId: context.device.id } });
    await tx.session.create({ data: { sessionToken, expires, userId: context.device.userId,
      hostedDeviceId: context.device.id, hostedBinding: context.device.sessionBinding } });
  });
  await sendHostedReceipt(context.snapshot, "http_session", context.snapshot.allowed ? "effective" : "blocked", context.snapshot.reason ?? undefined);
  return { sessionToken, expires };
}

/** Logout proves ownership but does not require permission to keep using the product. */
export async function revokeHostedSessions(db: PrismaClient, headers: Headers, input: unknown) {
  const { snapshot } = await verifyHostedDevice(headers, input);
  await db.$transaction(async tx => {
    const owner = await tx.managedIdentity.findUnique({ where: { issuer_productId_accountId: {
      issuer: snapshot.issuer, productId: snapshot.productId, accountId: snapshot.accountId } } });
    const device = await tx.hostedDevice.findUnique({ where: { issuer_productId_installationId: {
      issuer: snapshot.issuer, productId: snapshot.productId, installationId: snapshot.installationId! } } });
    if (!owner || !device || device.userId !== owner.userId || device.accountId !== snapshot.accountId) return;
    await tx.session.deleteMany({ where: { hostedDeviceId: device.id, userId: owner.userId } });
  });
  return { ok: true };
}

export async function withHostedWorker<T>(db: PrismaClient, req: Request, input: unknown, run: () => Promise<T>) {
  const context = await authenticateHostedDevice(db, req.headers, {
    productId: req.headers.get("x-aborder-product-id"), installationId: req.headers.get("x-aborder-installation-id"),
    desktopVersion: req.headers.get("x-aborder-desktop-version"),
  }, true, "content_worker");
  const raw = input as { action?: string; metadata?: { codexLogin?: unknown } } | null;
  const signedIn = typeof raw?.metadata?.codexLogin === "boolean" ? raw.metadata.codexLogin : context.device.codexLogin;
  if (typeof raw?.metadata?.codexLogin === "boolean") {
    await db.hostedDevice.update({ where: { id: context.device.id }, data: { codexLogin: signedIn } });
  }
  if (raw?.action === "claim" && !signedIn) {
    const status = await contentReceiptStatus(db, context.snapshot, context.device);
    await sendHostedReceipt(context.snapshot, "content_worker", status, status === "failed" ? "content_state_unknown" : context.snapshot.reason ?? undefined);
    return { managedProtocol: 2, job: null } as T;
  }
  const result = await hostedContext.run({ userId: context.device.userId, deviceId: context.device.id, snapshot: context.snapshot }, run);
  const status = await contentReceiptStatus(db, context.snapshot, context.device);
  await sendHostedReceipt(context.snapshot, "content_worker", status, status === "failed" ? "content_state_unknown" : context.snapshot.reason ?? undefined);
  return result;
}
