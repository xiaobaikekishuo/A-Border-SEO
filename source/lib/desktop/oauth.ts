import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { GA_SCOPE, gaReportRequest } from "@/lib/geo/ga-report";
import { RateLimiter } from "@/lib/rate-limit";

export const DESKTOP_LOGIN_PATH = "/desktop/oauth/login";
export const DESKTOP_GA_CALLBACK = "/desktop/oauth/ga4/callback";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const SESSION_COOKIE = "authjs.session-token";
export const OAUTH_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export const oauthValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const oauthInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), challenge: oauthValue }).strict(),
  z.object({
    action: z.literal("ga4"),
    challenge: oauthValue,
    siteId: z.string().min(1).max(128),
    report: gaReportRequest,
  }).strict(),
  z.object({ action: z.enum(["status", "claim", "cancel"]), id: oauthValue, verifier: oauthValue }).strict(),
]);

const attemptLifetime = 10 * 60_000;
const startLimit = new RateLimiter(8);
type Attempt = z.infer<typeof oauthInput>;
type Start = Extract<Attempt, { action: "login" | "ga4" }>;

export function desktopOrigin() {
  if (process.env.ABORDER_HOSTED === "1") {
    try {
      const url = new URL(process.env.ABORDER_WORKSPACE_ORIGIN ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "");
      return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
    } catch { return null; }
  }
  if (process.env.ABORDER_DESKTOP_MODE !== "1") return null;
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      ? url.origin : null;
  } catch {
    return null;
  }
}

export function requireDesktopOrigin(headers: Headers, mutation = false) {
  const origin = desktopOrigin();
  if (!origin) throw new ContentError("Desktop authorization is disabled", 404);
  if (headers.get("host") !== new URL(origin).host ||
      (mutation && (headers.get("origin") !== origin || headers.get("x-requested-with") !== "XmlHttpRequest"))) {
    throw new ContentError("Invalid desktop authorization origin", 403);
  }
  return origin;
}

export function desktopLoginPath(id: string) {
  return `${DESKTOP_LOGIN_PATH}?id=${id}`;
}

export async function beginAttempt(input: Start, origin: string, userId?: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new ContentError(input.action === "ga4" ? "GA_CONFIG" : "DESKTOP_CONFIG", 503);
  }
  if (!startLimit.hit(userId ?? "login").ok) throw new ContentError("DESKTOP_RATE_LIMIT", 429);
  await db.desktopOAuthAttempt.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const id = randomBytes(32).toString("base64url");
  const proof = { id, challenge: input.challenge, expiresAt: new Date(Date.now() + attemptLifetime) };

  if (input.action === "login") {
    await db.desktopLoginChallenge.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await db.desktopLoginChallenge.create({ data: proof });
    return { id, url: origin + desktopLoginPath(id) };
  }
  if (!userId) throw new ContentError("GA_SESSION", 401);
  await db.desktopOAuthAttempt.create({
    data: {
      ...proof,
      purpose: "ga4",
      userId,
      siteId: input.siteId,
      report: input.report,
    },
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: origin + DESKTOP_GA_CALLBACK,
    response_type: "code",
    scope: GA_SCOPE,
    access_type: "online",
    include_granted_scopes: "false",
    prompt: "select_account",
    state: id,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return { id, url: url.toString() };
}

export function loginAttemptIsPending(id: string) {
  return db.desktopLoginChallenge.findFirst({ where: { id, expiresAt: { gt: new Date() } }, select: { id: true } });
}

export async function completeDesktopLogin(id: string, userId: string) {
  try {
    return await db.$transaction(async tx => {
      const where = { id, expiresAt: { gt: new Date() } };
      const proof = await tx.desktopLoginChallenge.findUnique({ where });
      if (!proof || (await tx.desktopLoginChallenge.deleteMany({ where })).count !== 1) return false;
      await tx.desktopOAuthAttempt.create({ data: { ...proof, purpose: "login", status: "approved", userId } });
      return true;
    });
  } catch (error) {
    // The browser session can disappear between auth() and approval.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return false;
    throw error;
  }
}

export async function completeDesktopGa4(id: string, grant: string | null) {
  const result = await db.desktopOAuthAttempt.updateMany({
    where: { id, purpose: "ga4", status: "pending", expiresAt: { gt: new Date() } },
    data: grant ? { status: "approved", code: encrypt(grant) } : { status: "declined" },
  });
  return result.count === 1;
}

export function boundAttempt(id: string, verifier: string) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { id, challenge, expiresAt: { gt: new Date() } };
}

export async function exchangeDesktopSession(id: string, verifier: string, userId: string) {
  return db.$transaction(async tx => {
    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000);
    // Take the session's User foreign key lock first. Concurrent account
    // deletion then serializes with the exchange before cascading to the proof.
    await tx.session.create({ data: { sessionToken, expires, userId } });
    const removed = await tx.desktopOAuthAttempt.deleteMany({
      where: { ...boundAttempt(id, verifier), purpose: "login", status: "approved", userId },
    });
    if (removed.count !== 1) throw new ContentError("DESKTOP_ATTEMPT_EXPIRED", 410);
    return { sessionToken, expires };
  });
}
