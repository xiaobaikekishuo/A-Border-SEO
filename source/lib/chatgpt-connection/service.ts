import { openaiFetch } from "@/lib/chatgpt-connection/openai-fetch";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { ContentError } from "@/lib/content-planner/http";
import { APP_NAME, CALLBACK, ISSUER, RESOURCE, authorizationUrl, callbackClientId, hashState, hasPlanPermission, newTransaction, parseTokenSet, tokenRequest, verifyIdentity, type TokenSet } from "./protocol";

const id = z.string().min(1).max(200);
export const connectionAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), profileId: id.optional(), newProfile: z.boolean().optional(), returnPath: z.string().max(500) }).strict(),
  z.object({ action: z.literal("select"), profileId: id }).strict(),
  z.object({ action: z.literal("disconnect"), profileId: id }).strict(),
]);
function user(userId: string | null | undefined): string { if (!userId) throw new ContentError("Unauthorized", 401); return userId; }
async function lockUser(tx: Prisma.TransactionClient, userId: string) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`); }
async function lockProfile(tx: Prisma.TransactionClient, userId: string, profileId: string) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ChatGptProfile" WHERE "id" = ${profileId} AND "userId" = ${userId} FOR UPDATE`); }
function storedTokens(raw: string): TokenSet { try { return JSON.parse(decrypt(raw)) as TokenSet; } catch { throw new ContentError("chatgpt_sign_in_required", 409); } }
export async function assertPlanConnection(userId: string, profileId: string, expectedEpoch?: number): Promise<{ epoch: number }> {
  const profile = await db.chatGptProfile.findFirst({ where: { id: profileId, userId } });
  if (!profile?.encryptedTokens || !profile.subject || !profile.clientId) throw new ContentError("chatgpt_sign_in_required", 409);
  if (!hasPlanPermission(profile.scopes)) throw new ContentError("chatgpt_plan_permission_required", 409);
  if (expectedEpoch !== undefined && profile.epoch !== expectedEpoch) throw new ContentError("chatgpt_connection_changed", 409);
  return { epoch: profile.epoch };
}
export async function getPlanAccessToken(userId: string, profileId: string, expectedEpoch?: number): Promise<string> {
  const outcome = await db.$transaction(async tx => {
    await lockProfile(tx, userId, profileId);
    const profile = await tx.chatGptProfile.findFirst({ where: { id: profileId, userId } });
    if (!profile?.encryptedTokens || !profile.subject || !profile.clientId) throw new ContentError("chatgpt_sign_in_required", 409);
    if (!hasPlanPermission(profile.scopes)) throw new ContentError("chatgpt_plan_permission_required", 409);
    if (expectedEpoch !== undefined && profile.epoch !== expectedEpoch) throw new ContentError("chatgpt_connection_changed", 409);
    let tokens = storedTokens(profile.encryptedTokens);
    if (tokens.expiresAt > Date.now() + 60000) return { token: tokens.accessToken };
    if (tokens.earliestRefreshAt && tokens.earliestRefreshAt > Date.now()) return tokens.expiresAt > Date.now() + 5000 ? { token: tokens.accessToken } : { error: "chatgpt_refresh_not_ready" };
    const clear = async () => {
      await tx.chatGptProfile.update({ where: { id: profile.id }, data: { encryptedTokens: null, scopes: [], expiresAt: null, epoch: { increment: 1 } } });
      return { error: "chatgpt_sign_in_required" };
    };
    if (!tokens.refreshToken) return clear();
    let raw: Record<string, unknown>;
    try { raw = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: profile.clientId, refresh_token: tokens.refreshToken, resource: RESOURCE })); }
    catch (error) { if (error instanceof ContentError && error.message === "chatgpt_sign_in_required") return clear(); throw error; }
    try {
      const renewed = parseTokenSet(raw, tokens);
      if (raw.id_token) await verifyIdentity(renewed.idToken, profile.clientId, undefined, profile.subject);
      tokens = renewed;
    } catch { return clear(); }
    await tx.chatGptProfile.update({ where: { id: profile.id }, data: { encryptedTokens: encrypt(JSON.stringify(tokens)), scopes: tokens.scopes, expiresAt: new Date(tokens.expiresAt) } });
    return hasPlanPermission(tokens.scopes) ? { token: tokens.accessToken } : { error: "chatgpt_plan_permission_required" };
  }, { timeout: 40000, maxWait: 5000 });
  if (!outcome.token) throw new ContentError(outcome.error ?? "chatgpt_sign_in_required", 409);
  return outcome.token;
}
export async function listPlanModels(token: string): Promise<{ slug: string; displayName: string }[]> {
  let response: Response;
  try { response = await openaiFetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" }); }
  catch { throw new ContentError("chatgpt_models_unavailable", 502); }
  if (!response.ok) throw new ContentError(response.status === 401 ? "chatgpt_sign_in_required" : "chatgpt_models_unavailable", 502);
  try {
    const text = await response.text(); if (text.length > 1000000) throw new Error();
    const body = JSON.parse(text);
    if (!Array.isArray(body.models)) throw new Error();
    return body.models.filter((m: Record<string, unknown>) => m.visibility === "list" && typeof m.slug === "string" && m.slug.length < 200 && typeof m.display_name === "string")
      .slice(0, 200).map((m: { slug: string; display_name: string }) => ({ slug: m.slug, displayName: m.display_name.slice(0, 200) }));
  } catch { throw new ContentError("chatgpt_models_unavailable", 502); }
}
export async function getConnectionStatus(userId: string | null | undefined, includeModels = false) {
  const owner = user(userId);
  const rows = await db.chatGptProfile.findMany({ where: { userId: owner }, orderBy: { createdAt: "asc" } });
  const profiles = rows.map((p, index) => ({ id: p.id, label: `${APP_NAME} ${index + 1}`, email: p.email,
    connected: !!p.encryptedTokens && !!p.subject, sharing: !!p.encryptedTokens && !!p.subject && hasPlanPermission(p.scopes) }));
  const selected = rows.find(p => p.selected);
  const active = profiles.find(p => p.id === selected?.id);
  let models: { slug: string; displayName: string }[] = [], modelError: string | undefined;
  if (includeModels && active?.sharing) {
    try { models = await listPlanModels(await getPlanAccessToken(owner, active.id)); }
    catch (error) {
      modelError = error instanceof ContentError ? error.message : "chatgpt_models_unavailable";
      // Refresh can clear a revoked grant or reduce scopes. Display its current
      // state, rather than the snapshot taken before token renewal.
      const current = await db.chatGptProfile.findFirst({ where: { id: active.id, userId: owner } });
      active.connected = !!current?.encryptedTokens && !!current?.subject;
      active.sharing = active.connected && hasPlanPermission(current?.scopes ?? []);
    }
  }
  return { connected: active?.connected ?? false, sharing: active?.sharing ?? false, profileId: active?.id ?? null, email: active?.email ?? null, profiles, models, ...(modelError ? { modelError } : {}) };
}
export async function runConnectionAction(userId: string | null | undefined, raw: unknown) {
  const owner = user(userId), action = connectionAction.parse(raw);
  if (action.action === "connect") {
    const match = /^\/sites\/([A-Za-z0-9_-]{1,200})\/(?:assistant|keyword-research|domain-overview|backlinks)$/.exec(action.returnPath);
    if (!match || !await db.site.findFirst({ where: { id: match[1], userId: owner }, select: { id: true } })) throw new ContentError("Invalid return destination", 400);
    if (action.newProfile && action.profileId) throw new ContentError("Choose one ChatGPT connection", 400);
    const values = newTransaction();
    return db.$transaction(async tx => {
      await lockUser(tx, owner);
      await tx.chatGptLoginAttempt.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      const host = await tx.chatGptHost.upsert({ where: { id: "local" }, create: { id: "local", hostId: `urn:uuid:${randomUUID()}` }, update: {} });
      let profile = action.newProfile ? null : await tx.chatGptProfile.findFirst({ where: { userId: owner, ...(action.profileId ? { id: action.profileId } : { selected: true }) } });
      if (action.profileId && !profile) throw new ContentError("ChatGPT connection not found", 404);
      if (!profile && !action.newProfile && !action.profileId) profile = await tx.chatGptProfile.findFirst({ where: { userId: owner }, orderBy: { createdAt: "desc" } });
      if (!profile) {
        if (await tx.chatGptProfile.count({ where: { userId: owner } }) >= 10) throw new ContentError("ChatGPT connection limit reached", 409);
        profile = await tx.chatGptProfile.create({ data: { userId: owner } });
      }
      profile = await tx.chatGptProfile.update({ where: { id: profile.id }, data: { epoch: { increment: 1 } } });
      await tx.chatGptLoginAttempt.deleteMany({ where: { profileId: profile.id } });
      await tx.chatGptLoginAttempt.create({ data: { stateHash: hashState(values.state), userId: owner, profileId: profile.id, epoch: profile.epoch,
        encryptedPending: encrypt(JSON.stringify({ nonce: values.nonce, verifier: values.verifier, clientId: profile.clientId })),
        expiresAt: new Date(Date.now() + 10 * 60000), returnPath: action.returnPath } });
      return { url: authorizationUrl({ clientId: profile.clientId, hostId: host.hostId, consent: !!profile.clientId && !hasPlanPermission(profile.scopes), ...values }) };
    });
  }
  if (action.action === "select") {
    await db.$transaction(async tx => {
      await lockUser(tx, owner);
      if (!await tx.chatGptProfile.findFirst({ where: { id: action.profileId, userId: owner } })) throw new ContentError("ChatGPT connection not found", 404);
      await tx.chatGptProfile.updateMany({ where: { userId: owner }, data: { selected: false } });
      await tx.chatGptProfile.update({ where: { id: action.profileId }, data: { selected: true } });
    });
    return { ok: true };
  }
  const captured = await db.$transaction(async tx => {
    await lockProfile(tx, owner, action.profileId);
    const profile = await tx.chatGptProfile.findFirst({ where: { id: action.profileId, userId: owner } });
    if (!profile) throw new ContentError("ChatGPT connection not found", 404);
    await tx.chatGptLoginAttempt.deleteMany({ where: { profileId: profile.id } });
    await tx.chatGptProfile.update({ where: { id: profile.id }, data: { encryptedTokens: null, scopes: [], expiresAt: null, epoch: { increment: 1 } } });
    return profile;
  });
  let remoteRevocationConfirmed = !captured.encryptedTokens;
  if (captured.encryptedTokens && captured.clientId) {
    try {
      const tokens = storedTokens(captured.encryptedTokens);
      if (tokens.refreshToken) {
        const discovery = await openaiFetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: "error" });
        const config = await discovery.json();
        const endpoint = new URL(config.revocation_endpoint);
        if (config.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw new Error();
        const response = await openaiFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: captured.clientId }), signal: AbortSignal.timeout(10000), redirect: "error" });
        remoteRevocationConfirmed = response.status === 200;
      }
    } catch { remoteRevocationConfirmed = false; }
  }
  return { ok: true, remoteRevocationConfirmed };
}

export async function finishConnection(callback: URL): Promise<{ path: string; error?: string }> {
  if (["state", "code", "client_id", "error"].some(key => callback.searchParams.getAll(key).length > 1)) return { path: "/sites", error: "chatgpt_state_invalid" };
  const state = callback.searchParams.get("state");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return { path: "/sites", error: "chatgpt_state_invalid" };
  const attempt = await db.$transaction(async tx => {
    const pending = await tx.chatGptLoginAttempt.findUnique({ where: { stateHash: hashState(state) } });
    if (!pending) return null;
    const deleted = await tx.chatGptLoginAttempt.deleteMany({ where: { stateHash: pending.stateHash } });
    return deleted.count ? pending : null;
  });
  if (!attempt || attempt.expiresAt.getTime() <= Date.now()) return { path: attempt?.returnPath ?? "/sites", error: "chatgpt_state_expired" };
  try {
    if (callback.searchParams.has("error")) throw new ContentError("chatgpt_authorization_declined", 400);
    const code = callback.searchParams.get("code");
    if (!code || code.length > 10000) throw new ContentError("chatgpt_code_missing", 400);
    const pending = JSON.parse(decrypt(attempt.encryptedPending)) as { nonce: string; verifier: string; clientId: string | null };
    const clientId = callbackClientId(pending.clientId, callback.searchParams.get("client_id"));
    const saved = await db.chatGptProfile.updateMany({ where: { id: attempt.profileId, userId: attempt.userId, epoch: attempt.epoch }, data: { clientId } });
    if (!saved.count) throw new ContentError("chatgpt_connection_changed", 409);
    const profile = await db.chatGptProfile.findUniqueOrThrow({ where: { id: attempt.profileId } });
    const raw = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: CALLBACK, resource: RESOURCE }));
    const tokens = parseTokenSet(raw);
    const identity = await verifyIdentity(tokens.idToken, clientId, pending.nonce, profile.subject);
    await db.$transaction(async tx => {
      await lockUser(tx, attempt.userId);
      const changed = await tx.chatGptProfile.updateMany({ where: { id: profile.id, userId: attempt.userId, epoch: attempt.epoch }, data: {
        subject: identity.subject, email: identity.email, encryptedTokens: encrypt(JSON.stringify(tokens)), scopes: tokens.scopes, expiresAt: new Date(tokens.expiresAt), selected: true } });
      if (!changed.count) throw new ContentError("chatgpt_connection_changed", 409);
      await tx.chatGptProfile.updateMany({ where: { userId: attempt.userId, id: { not: profile.id } }, data: { selected: false } });
    });
    return { path: attempt.returnPath };
  } catch (error) { return { path: attempt.returnPath, error: error instanceof ContentError ? error.message : "chatgpt_connection_failed" }; }
}
