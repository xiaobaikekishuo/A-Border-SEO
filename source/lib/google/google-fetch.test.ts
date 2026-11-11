import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createProxy, closeProxy } = vi.hoisted(() => ({
  createProxy: vi.fn(),
  closeProxy: vi.fn(async () => undefined),
}));
vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(url: string) { createProxy(url); }
    close = closeProxy;
  },
}));

const discovery = "https://accounts.google.com/.well-known/openid-configuration";
const tokenUrl = "https://oauth2.googleapis.com/token";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("GOOGLE_HTTP_PROXY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google transport", () => {
  it("uses the existing global fetch without a proxy and bounds OAuth requests", async () => {
    const response = Response.json({ issuer: "https://accounts.google.com" });
    const nativeFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");

    expect(await googleFetch(discovery)).toBe(response);
    expect(nativeFetch).toHaveBeenCalledWith(discovery, {
      redirect: "error", signal: expect.any(AbortSignal),
    });
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("only supplies the local dispatcher to Google calls and reuses its pool", async () => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", "http://host.docker.internal:7890");
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    const controller = new AbortController();
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "test-only" });
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    await googleFetch(tokenUrl, {
      method: "POST", headers, body, signal: controller.signal, cache: "no-store", redirect: "follow",
    });
    await googleFetch(discovery);
    const firstOptions = nativeFetch.mock.calls[0][1];
    expect(firstOptions).toMatchObject({
      method: "POST", headers, body, signal: controller.signal, cache: "no-store", redirect: "error",
    });
    expect(firstOptions.dispatcher).toBe(nativeFetch.mock.calls[1][1].dispatcher);
    expect(createProxy).toHaveBeenCalledExactlyOnceWith("http://host.docker.internal:7890/");
    expect(globalThis.fetch).toBe(nativeFetch);

    // Other services still call global fetch without inheriting a dispatcher.
    await fetch("https://example.test/", { method: "GET" });
    expect(nativeFetch.mock.calls[2][1]).toEqual({ method: "GET" });
  });

  it("preserves native Request bodies and cancellation", async () => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", "http://127.0.0.1:7890");
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    const controller = new AbortController();
    const request = new Request(tokenUrl, { method: "POST", body: "test-only", signal: controller.signal });
    await googleFetch(request);
    expect(nativeFetch.mock.calls[0][0]).toBe(request);
    expect(await request.text()).toBe("test-only");
    const signal = nativeFetch.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("does not add an OAuth timeout to long PageSpeed requests", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    const url = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fexample.test";
    await googleFetch(url);
    expect(nativeFetch).toHaveBeenCalledWith(url, { redirect: "error" });
  });

  it.each([
    "http://accounts.google.com/token",
    "https://accounts.google.com.attacker.test/token",
    "https://attacker.test/token",
    "https://oauth2.googleapis.com:444/token",
    "https://user:secret@oauth2.googleapis.com/token",
  ])("refuses unapproved destinations before sending: %s", async url => {
    const nativeFetch = vi.fn();
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    await expect(googleFetch(url)).rejects.toThrow("approved HTTPS endpoint");
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(createProxy).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-url", "socks5://localhost:7890", "http://remote.test:7890",
    "http://user:secret@localhost:7890", "http://localhost:7890/proxy",
    "http://localhost:7890/?secret=test", "http://localhost:7890/#fragment",
  ])("fails closed for invalid proxy configuration: %s", async proxy => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", proxy);
    const nativeFetch = vi.fn();
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    const failure: unknown = await googleFetch(discovery).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("GOOGLE_HTTP_PROXY must be");
    expect((failure as Error).message).not.toContain(proxy);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("propagates proxy failures without retrying directly", async () => {
    vi.stubEnv("GOOGLE_HTTP_PROXY", "http://host.docker.internal:7890");
    const failure = new TypeError("fetch failed");
    const nativeFetch = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", nativeFetch);
    const { googleFetch } = await import("./google-fetch");
    await expect(googleFetch(tokenUrl)).rejects.toBe(failure);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
