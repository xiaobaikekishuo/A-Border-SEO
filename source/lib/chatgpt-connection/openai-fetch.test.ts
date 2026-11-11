import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createProxy } = vi.hoisted(() => ({ createProxy: vi.fn() }));
vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(url: string) { createProxy(url); }
    async close() {}
  },
}));

const models = "https://api.openai.com/v1/models";
const token = "https://auth.openai.com/api/accounts/oauth/token";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_HTTP_PROXY", "");
  vi.stubEnv("GOOGLE_HTTP_PROXY", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ChatGPT connection transport", () => {
  it("goes direct when only Google has a proxy and forbids redirects", async () => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", "http://localhost:8001");
    const nativeFetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", nativeFetch);
    const { openaiFetch } = await import("./openai-fetch");
    const signal = new AbortController().signal;
    const body = new URLSearchParams({ grant_type: "refresh_token" });
    await openaiFetch(token, { method: "POST", body, signal, redirect: "follow" });
    expect(nativeFetch).toHaveBeenCalledWith(token, { method: "POST", body, signal, redirect: "error" });
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("reuses a local dispatcher for auth and API and keeps the Google pool separate", async () => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", "http://host.docker.internal:7890");
    vi.stubEnv("OPENAI_HTTP_PROXY", "http://host.docker.internal:7890");
    const nativeFetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", nativeFetch);
    const { openaiFetch } = await import("./openai-fetch");
    const { googleFetch } = await import("@/lib/google/google-fetch");
    await googleFetch("https://oauth2.googleapis.com/token");
    await openaiFetch(token);
    const request = new Request(models);
    await openaiFetch(request);
    expect(nativeFetch.mock.calls[2][0]).toBe(request);
    expect(nativeFetch.mock.calls[1][1].dispatcher).toBe(nativeFetch.mock.calls[2][1].dispatcher);
    expect(nativeFetch.mock.calls[0][1].dispatcher).not.toBe(nativeFetch.mock.calls[1][1].dispatcher);
    expect(createProxy).toHaveBeenCalledTimes(2);
  });

  it.each(["http://api.openai.com/", "https://api.openai.com:8443/", "https://auth.openai.com.example.org/", "https://u@auth.openai.com/"])("rejects unapproved OpenAI destinations", async url => {
    const nativeFetch = vi.fn();
    vi.stubGlobal("fetch", nativeFetch);
    const { openaiFetch } = await import("./openai-fetch");
    await expect(openaiFetch(url)).rejects.toThrow("approved HTTPS endpoint");
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("rejects an external proxy before sending", async () => {
    vi.stubEnv("OPENAI_HTTP_PROXY", "http://external.example/");
    const nativeFetch = vi.fn();
    vi.stubGlobal("fetch", nativeFetch);
    const { openaiFetch } = await import("./openai-fetch");
    await expect(openaiFetch(models)).rejects.toThrow("OPENAI_HTTP_PROXY");
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
