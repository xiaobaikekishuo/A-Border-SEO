import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { ContentError } from "@/lib/content-planner/http";
import { boundAttempt, desktopOrigin, oauthValue } from "@/lib/desktop/oauth";
import { currentManagedIdentity, managedOwnsLocalUser } from "@/lib/desktop/managed-session";
import { managedAllows } from "@/lib/managed/policy";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { decrypt, encrypt } from "@/lib/encryption";
import { RateLimiter } from "@/lib/rate-limit";
import { googleFetch } from "./google-fetch";
import { openGoogleTokens, sealGoogleTokens } from "./token-store";
import { GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK, GOOGLE_CONNECTION_STATE_PREFIX } from "./connection-protocol";
import { currentHostedDevice, hostedDeviceById, hostedMode } from "@/lib/hosted/access";

export { GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK, GOOGLE_CONNECTION_STATE_PREFIX } from "./connection-protocol";
export const GSC_CONNECTION_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const purpose = "gsc_connection";
const startLimit = new RateLimiter(8);
const credentials = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret && ![clientId, clientSecret].some(value => /^(?:REPLACE_WITH_|YOUR_|TODO)/i.test(value))
    ? { clientId, clientSecret } : null;
};
export const googleConnectionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), challenge: oauthValue }).strict(),
  z.object({ action: z.enum(["status", "claim", "cancel"]), id: oauthValue, verifier: oauthValue }).strict(),
]);
type Input = z.infer<typeof googleConnectionInput>;
const bindingSchema = z.object({
  issuer: z.string(), productId: z.string(), accountId: z.string(), installationId: z.string(), nonceHash: z.string(),
}).strict();
const reportSchema = z.object({ v: z.literal(1), origin: z.string(), updatedAt: z.string().datetime(), redirectUri: z.string().url().optional(),
  managed: bindingSchema.nullable() }).strict();

async function binding() {
  if (hostedMode()) {
    const device = await currentHostedDevice();
    if (!device) throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
    return { issuer: device.issuer, productId: device.productId, accountId: device.accountId,
      installationId: device.installationId, nonceHash: device.sessionBinding };
  }
  if (process.env.ABORDER_MANAGED !== "1") return null;
  const identity = currentManagedIdentity();
  if (!identity) throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
  const { sequence: _sequence, ...stable } = identity;
  return stable;
}
function requireAvailable() {
  if (!managedAllows("jobs") || desktopMaintenanceActive()) throw new ContentError("GOOGLE_CONNECTION_RESTRICTED", 403);
}
async function checkBinding(report: unknown, userId: string, origin: string, callback = false) {
  requireAvailable();
  const parsed = reportSchema.safeParse(report);
  let expected;
  if (hostedMode() && callback && parsed.success && parsed.data.managed) {
    const stored = parsed.data.managed;
    const device = await db.hostedDevice.findUnique({ where: { issuer_productId_installationId: {
      issuer: stored.issuer, productId: stored.productId, installationId: stored.installationId } } });
    const current = device && await hostedDeviceById(db, device.id);
    if (!current || current.device.userId !== userId || !current.snapshot.allowed || !current.snapshot.features.jobs
      || current.device.sessionBinding !== stored.nonceHash || current.device.accountId !== stored.accountId) throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
    expected = stored;
  } else expected = await binding();
  if (!parsed.success || parsed.data.origin !== origin || JSON.stringify(parsed.data.managed) !== JSON.stringify(expected)
    || !await managedOwnsLocalUser(db, userId)) throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
  // Transactions created before 1.4.2 used the dedicated callback. Never
  // exchange their codes with a different redirect URI after an update.
  const redirectUri = parsed.data.redirectUri ?? origin + GOOGLE_CONNECTION_LEGACY_CALLBACK;
  if (![origin + GOOGLE_CONNECTION_CALLBACK, origin + GOOGLE_CONNECTION_LEGACY_CALLBACK].includes(redirectUri)) {
    throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
  }
  return { ...parsed.data, redirectUri };
}

export async function googleConnectionStatus(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { googleTokens: true } });
  if (!user) throw new ContentError("Unauthorized", 401);
  let connected = false;
  try {
    const tokens = openGoogleTokens(user.googleTokens);
    connected = Boolean(tokens?.refreshToken && tokens.accessToken
      && tokens.scope?.split(/\s+/).includes(GSC_CONNECTION_SCOPE));
  } catch { /* A changed encryption key requires a new explicit connection. */ }
  const origin = desktopOrigin();
  const configured = Boolean(credentials() && origin);
  return { configured, connected,
    reason: configured ? (connected ? null : "GOOGLE_CONNECTION_REQUIRED") : "GOOGLE_CONNECTION_NOT_CONFIGURED",
    redirectUri: origin ? origin + GOOGLE_CONNECTION_CALLBACK : null };
}

export async function handleGoogleConnection(input: Input, userId: string, origin: string) {
  if (input.action === "start") {
    requireAvailable();
    const config = credentials();
    if (!config) throw new ContentError("GOOGLE_CONNECTION_NOT_CONFIGURED", 503);
    if (!await managedOwnsLocalUser(db, userId)) throw new ContentError("GOOGLE_CONNECTION_SESSION_CHANGED", 403);
    if (!startLimit.hit(userId).ok) throw new ContentError("GOOGLE_CONNECTION_RATE_LIMIT", 429);
    const user = await db.user.findUnique({ where: { id: userId }, select: { updatedAt: true } });
    if (!user) throw new ContentError("Unauthorized", 401);
    await db.desktopOAuthAttempt.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, { userId, purpose }] } });
    const id = randomBytes(32).toString("base64url");
    await db.desktopOAuthAttempt.create({ data: {
      id, purpose, userId, challenge: input.challenge, expiresAt: new Date(Date.now() + 10 * 60_000),
      report: { v: 1, origin, redirectUri: origin + GOOGLE_CONNECTION_CALLBACK, updatedAt: user.updatedAt.toISOString(), managed: await binding() } as Prisma.InputJsonObject,
    } });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: origin + GOOGLE_CONNECTION_CALLBACK,
      response_type: "code", scope: GSC_CONNECTION_SCOPE, access_type: "offline", prompt: "consent select_account",
      include_granted_scopes: "false", state: GOOGLE_CONNECTION_STATE_PREFIX + id, code_challenge: input.challenge, code_challenge_method: "S256" }).toString();
    return { id, url: url.href };
  }
  const where = { ...boundAttempt(input.id, input.verifier), userId, purpose };
  const attempt = await db.desktopOAuthAttempt.findFirst({ where });
  if (!attempt) throw new ContentError("GOOGLE_CONNECTION_EXPIRED", 410);
  if (input.action === "cancel") {
    await db.desktopOAuthAttempt.deleteMany({ where });
    return { cancelled: true };
  }
  const report = await checkBinding(attempt.report, userId, origin);
  if (input.action === "status") return { status: attempt.status };
  if (attempt.status !== "approved" || !attempt.code) throw new ContentError("GOOGLE_CONNECTION_NOT_APPROVED", 409);
  const config = credentials();
  if (!config) throw new ContentError("GOOGLE_CONNECTION_NOT_CONFIGURED", 503);
  // Consume before exchange so two tabs cannot exchange or attach the same grant.
  if ((await db.desktopOAuthAttempt.deleteMany({ where: { ...where, status: "approved" } })).count !== 1) {
    throw new ContentError("GOOGLE_CONNECTION_EXPIRED", 410);
  }
  let tokens: { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
  try {
    const response = await googleFetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: decrypt(attempt.code),
        code_verifier: input.verifier, grant_type: "authorization_code", redirect_uri: report.redirectUri }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("exchange_failed");
    const raw = await response.text();
    if (raw.length > 64_000) throw new Error("response_too_large");
    const parsed = z.object({ access_token: z.string().min(1).max(16_000), refresh_token: z.string().min(1).max(16_000),
      expires_in: z.number().int().positive().max(86400), token_type: z.string().regex(/^Bearer$/i), scope: z.string().max(16_000) }).safeParse(JSON.parse(raw));
    if (!parsed.success || !parsed.data.scope.split(/\s+/).includes(GSC_CONNECTION_SCOPE)) throw new Error("grant_incomplete");
    tokens = parsed.data;
  } catch {
    // Google error bodies and exchange errors can contain grants or tokens.
    throw new ContentError("GOOGLE_CONNECTION_EXCHANGE_FAILED", 502);
  }
  await checkBinding(report, userId, origin);
  const saved = await db.user.updateMany({ where: { id: userId, updatedAt: new Date(report.updatedAt) }, data: {
    googleTokens: sealGoogleTokens({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000, tokenType: tokens.token_type, scope: tokens.scope }),
  } });
  if (saved.count !== 1) throw new ContentError("GOOGLE_CONNECTION_CHANGED", 409);
  return { connected: true };
}

export async function completeGoogleConnection(id: string, grant: string | null, origin: string, redirectUri: string) {
  const where = { id, purpose, status: "pending", expiresAt: { gt: new Date() } };
  const attempt = await db.desktopOAuthAttempt.findFirst({ where });
  if (!attempt) return false;
  const report = await checkBinding(attempt.report, attempt.userId, origin, true);
  if (report.redirectUri !== redirectUri) return false;
  return (await db.desktopOAuthAttempt.updateMany({ where,
    data: grant ? { status: "approved", code: encrypt(grant) } : { status: "declined" },
  })).count === 1;
}
