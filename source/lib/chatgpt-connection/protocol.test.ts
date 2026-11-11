import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { APP_NAME, CALLBACK, ISSUER, PLAN_SCOPE, authorizationUrl, callbackClientId, hashState, localAppPort, localRequest, newTransaction, parseTokenSet, tokenRequest, verifyIdentity } from "./protocol";

describe("local ChatGPT OAuth protocol", () => {
  it("uses isolated registration, exact loopback callback, fresh PKCE and no credential hints", () => {
    const a = newTransaction(), b = newTransaction();
    expect(a.state).not.toBe(b.state); expect(a.nonce).not.toBe(b.nonce); expect(a.verifier).not.toBe(b.verifier);
    expect(hashState(a.state)).toHaveLength(64);
    const url = new URL(authorizationUrl({ clientId: null, hostId: "urn:uuid:test", ...a }));
    expect(url.origin).toBe(ISSUER); expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe(APP_NAME); expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.has("id_token_hint")).toBe(false); expect(url.searchParams.has("code_verifier")).toBe(false);
    const returning = new URL(authorizationUrl({ clientId: "oaiapp_existing", hostId: "urn:uuid:test", ...b }));
    expect(returning.searchParams.has("agent_name_hint")).toBe(false);
  });
  it("requires issued client identity and rejects a different returning registration", () => {
    expect(callbackClientId(null, "oaiapp_one")).toBe("oaiapp_one");
    expect(callbackClientId("oaiapp_one", null)).toBe("oaiapp_one");
    for (const value of [null, "dynamic_agent_client", "other"]) expect(() => callbackClientId(null, value)).toThrow();
    expect(() => callbackClientId("oaiapp_one", "oaiapp_two")).toThrow();
  });
  it("granted scopes are authoritative, preserving omission only on refresh", () => {
    const token = { token_type: "Bearer", access_token: "test-access", id_token: "test-id", refresh_token: "test-refresh", expires_in: 3600, scope: PLAN_SCOPE };
    const first = parseTokenSet(token); expect(first.scopes).toContain(PLAN_SCOPE);
    expect(parseTokenSet({ ...token, scope: undefined }).scopes).toEqual([]);
    expect(parseTokenSet({ ...token, scope: undefined, refresh_token: "rotated" }, first).scopes).toEqual([PLAN_SCOPE]);
    expect(() => parseTokenSet({ ...token, refresh_token: undefined }, first)).toThrow();
    expect(() => parseTokenSet({ ...token, refresh_token: token.refresh_token }, first)).toThrow();
    expect(parseTokenSet({ ...token, scope: "openid", refresh_token: "rotated" }, first)).toMatchObject({ scopes: ["openid"], refreshToken: "rotated" });
    expect(() => parseTokenSet({ ...token, expires_in: -1 })).toThrow();
    expect(parseTokenSet({ ...token, token_type: "bearer" }).accessToken).toBe("test-access");
    expect(() => parseTokenSet({ ...token, scope: false })).toThrow();
    for (const earliest_refresh_at of [null, false, "invalid", Infinity, -2]) expect(() => parseTokenSet({ ...token, earliest_refresh_at })).toThrow();
    expect(parseTokenSet({ ...token, earliest_refresh_at: "2027-01-01T00:00:00Z" }).earliestRefreshAt).toBe(Date.parse("2027-01-01T00:00:00Z"));
  });
  it("clears only explicitly terminal token errors, never generic HTTP status alone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      for (const error of ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]) {
        fetchMock.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
        await expect(tokenRequest(new URLSearchParams())).rejects.toThrow("chatgpt_sign_in_required");
      }
      fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "invalid_grant" } }, { status: 401 }));
      await expect(tokenRequest(new URLSearchParams())).rejects.toThrow("chatgpt_sign_in_required");
      for (const error of ["invalid_client", "invalid_request", "server_error", "temporarily_unavailable", undefined]) {
        fetchMock.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
        await expect(tokenRequest(new URLSearchParams())).rejects.toThrow("chatgpt_connection_unavailable");
      }
      fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 503 }));
      await expect(tokenRequest(new URLSearchParams())).rejects.toThrow("chatgpt_connection_unavailable");
      fetchMock.mockResolvedValueOnce(new Response("x".repeat(100001), { status: 400 }));
      await expect(tokenRequest(new URLSearchParams())).rejects.toThrow("chatgpt_connection_unavailable");
    } finally { fetchMock.mockRestore(); }
  });
  it("restricts connecting requests to local browser origins", () => {
    expect(() => localRequest(new Request("http://localhost:3300/api/chatgpt-connection", { headers: { origin: "http://localhost:3300" } }), true)).not.toThrow();
    expect(() => localRequest(new Request("http://evil.example/api", { headers: { origin: "http://evil.example" } }), true)).toThrow();
    expect(() => localRequest(new Request("http://localhost:3300/api"), true)).toThrow();
  });
  it("reads the local port from LOCAL_APP_PORT and falls back to 3300", () => {
    expect(localAppPort({})).toBe(3300);
    expect(localAppPort({ LOCAL_APP_PORT: " 3400 " })).toBe(3400);
    for (const value of ["0", "70000", "33.5", "abc", "-1"]) expect(localAppPort({ LOCAL_APP_PORT: value }), value).toBe(3300);
    expect(CALLBACK).toBe("http://127.0.0.1:3300/auth/chatgpt/callback");
  });
});

describe("ChatGPT identity verification", () => {
  let pair: Awaited<ReturnType<typeof generateKeyPair>>, resolver: JWTVerifyGetKey;
  beforeAll(async () => { pair = await generateKeyPair("RS256"); const key = await exportJWK(pair.publicKey); resolver = createLocalJWKSet({ keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] }); });
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({ nonce: "expected", email: "owner@example.test", ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(ISSUER).setAudience("oaiapp_test").setSubject("subject").setIssuedAt().setExpirationTime("1h").sign(pair.privateKey);
  it("accepts only the bound nonce and returning subject", async () => {
    const token = await sign();
    await expect(verifyIdentity(token, "oaiapp_test", "expected", "subject", resolver)).resolves.toMatchObject({ subject: "subject" });
    await expect(verifyIdentity(token, "oaiapp_test", "wrong", "subject", resolver)).rejects.toThrow("chatgpt_identity_invalid");
    await expect(verifyIdentity(token, "oaiapp_test", "expected", "other", resolver)).rejects.toThrow();
    await expect(verifyIdentity(token, "oaiapp_other", "expected", "subject", resolver)).rejects.toThrow();
  });
  it("rejects invalid signature, issuer, expiry and missing nonce", async () => {
    const wrongIssuer = await new SignJWT({ nonce: "expected" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://other.test").setAudience("oaiapp_test").setSubject("subject").setIssuedAt().setExpirationTime("1h").sign(pair.privateKey);
    const expired = await new SignJWT({ nonce: "expected" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(ISSUER).setAudience("oaiapp_test").setSubject("subject").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) - 100).sign(pair.privateKey);
    for (const token of [wrongIssuer, expired, await sign({ nonce: undefined }), `${(await sign()).slice(0, -15)}invalidsignature`]) await expect(verifyIdentity(token, "oaiapp_test", "expected", "subject", resolver)).rejects.toThrow();
  });
});
