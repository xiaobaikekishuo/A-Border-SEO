import { openaiFetch } from "@/lib/chatgpt-connection/openai-fetch";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ContentError } from "@/lib/content-planner/http";

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = "https://api.openai.com/v1";
/**
 * The host port the browser uses for this local app (Docker publishes it as
 * 127.0.0.1:<port>:3000). LOCAL_APP_PORT changes it; 3300 by default. The
 * ChatGPT registration remembers its callback URL, so after changing the port
 * disconnect and connect ChatGPT again.
 */
export function localAppPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LOCAL_APP_PORT?.trim();
  const port = raw ? Number(raw) : 3300;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3300;
}
const LOCAL_PORT = localAppPort();
/** Origins the local ChatGPT connection accepts, localhost first. */
export const LOCAL_ORIGINS = [`http://localhost:${LOCAL_PORT}`, `http://127.0.0.1:${LOCAL_PORT}`] as const;
export const CALLBACK = `http://127.0.0.1:${LOCAL_PORT}/auth/chatgpt/callback`;
export const APP_NAME = "A-Border SEO Local";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const hasPlanPermission = (scopes: string[]) => scopes.includes(PLAN_SCOPE) && scopes.includes("resource.invoke");
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { timeoutDuration: 10000, [customFetch]: openaiFetch });
export const hashState = (state: string) => createHash("sha256").update(state).digest("hex");
export const randomValue = () => randomBytes(32).toString("base64url");
export function safeEqual(a: unknown, b: string) {
  return typeof a === "string" && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
export function newTransaction() {
  const state = randomValue(), nonce = randomValue(), verifier = randomValue();
  return { state, nonce, verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function authorizationUrl(values: { clientId: string | null; hostId: string; state: string; nonce: string; challenge: string; consent?: boolean }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: values.clientId ?? "dynamic_agent_client", ext_agent_host_id: values.hostId,
    ...(!values.clientId ? { agent_name_hint: APP_NAME } : {}), ...(values.clientId && values.consent ? { prompt: "consent" } : {}), response_type: "code", redirect_uri: CALLBACK,
    scope: SCOPES, resource: RESOURCE, state: values.state, nonce: values.nonce, code_challenge_method: "S256", code_challenge: values.challenge }).toString();
  return url.toString();
}
export function callbackClientId(savedClientId: string | null, returned: string | null) {
  if (savedClientId && returned && returned !== savedClientId) throw new ContentError("chatgpt_registration_mismatch", 400);
  const clientId = savedClientId ?? returned;
  if (!clientId || !/^oaiapp_[A-Za-z0-9_-]{3,200}$/.test(clientId)) throw new ContentError("chatgpt_registration_incomplete", 400);
  return clientId;
}
export async function verifyIdentity(idToken: string, clientId: string, nonce?: string, expectedSubject?: string | null, key: JWTVerifyGetKey = jwks) {
  try {
    const { payload } = await jwtVerify(idToken, key, { issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], algorithms: ["RS256", "ES256"], clockTolerance: 5 });
    if (typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && !safeEqual(payload.nonce, nonce)) || (expectedSubject && payload.sub !== expectedSubject)) throw new Error();
    if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error();
    if (typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 5) throw new Error();
    return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email.slice(0, 320) : null };
  } catch { throw new ContentError("chatgpt_identity_invalid", 400); }
}
export type TokenSet = { accessToken: string; refreshToken: string | null; idToken: string; scopes: string[]; expiresAt: number; earliestRefreshAt?: number };
export function parseTokenSet(value: unknown, previous?: TokenSet): TokenSet {
  const body = value as Record<string, unknown> | null;
  if (!body || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" || typeof body.access_token !== "string" || !body.access_token || /\s|[\u0000-\u001f\u007f]/.test(body.access_token) || body.access_token.length > 32000 || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86400 * 90) throw new ContentError("chatgpt_token_invalid", 502);
  if (body.scope !== undefined && typeof body.scope !== "string") throw new ContentError("chatgpt_token_invalid", 502);
  const idToken = typeof body.id_token === "string" ? body.id_token : previous?.idToken;
  if (!idToken || idToken.length > 32000) throw new ContentError("chatgpt_identity_missing", 502);
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
  if (previous && (typeof body.refresh_token !== "string" || !body.refresh_token || body.refresh_token === previous.refreshToken)) throw new ContentError("chatgpt_token_invalid", 502);
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
  if (refreshToken && refreshToken.length > 32000) throw new ContentError("chatgpt_token_invalid", 502);
  const earliest = typeof body.earliest_refresh_at === "number" ? body.earliest_refresh_at * (body.earliest_refresh_at < 1e12 ? 1000 : 1) : typeof body.earliest_refresh_at === "string" ? Date.parse(body.earliest_refresh_at) : NaN;
  if (body.earliest_refresh_at !== undefined && (!Number.isFinite(earliest) || earliest <= 0)) throw new ContentError("chatgpt_token_invalid", 502);
  return { accessToken: body.access_token, refreshToken, idToken, scopes, expiresAt: Date.now() + body.expires_in * 1000, ...(Number.isFinite(earliest) && earliest > 0 ? { earliestRefreshAt: earliest } : {}) };
}
export async function tokenRequest(form: URLSearchParams) {
  let response: Response;
  try { response = await openaiFetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form, signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" }); }
  catch { throw new ContentError("chatgpt_connection_unavailable", 502); }
  let body: unknown;
  try { body = JSON.parse(await readTokenBody(response)); }
  catch { throw new ContentError(response.ok ? "chatgpt_token_invalid" : "chatgpt_connection_unavailable", 502); }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
    const error = record?.error;
    const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? error.code : undefined;
    const terminal = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(typeof code === "string" ? code : "");
    throw new ContentError((response.status === 400 || response.status === 401) && terminal ? "chatgpt_sign_in_required" : "chatgpt_connection_unavailable", 502);
  }
  return body as Record<string, unknown>;
}
async function readTokenBody(response: Response): Promise<string> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 100000) { await reader.cancel(); throw new Error(); }
      parts.push(value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally { reader.releaseLock(); }
}
export function localRequest(req: Request, mutation = false) {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_ORIGINS.some(origin => origin.slice("http://".length) === host)) throw new ContentError("Local A-Border SEO connection required", 403);
  if (mutation && !(LOCAL_ORIGINS as readonly string[]).includes(req.headers.get("origin") ?? "")) throw new ContentError("Local A-Border SEO origin required", 403);
}
