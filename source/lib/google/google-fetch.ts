import type { ProxyAgent } from "undici";
import { createLocalProxy } from "@/lib/http/local-proxy";

const GOOGLE_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "www.googleapis.com",
  "searchconsole.googleapis.com",
  "analyticsdata.googleapis.com",
  "suggestqueries.google.com",
]);
const OAUTH_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
]);
const localProxy = createLocalProxy("GOOGLE_HTTP_PROXY");

/** Google-only transport. The local proxy never changes other services' fetches. */
export const googleFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : String(input));
  if (
    url.protocol !== "https:" || !GOOGLE_HOSTS.has(url.hostname) ||
    url.port || url.username || url.password
  ) {
    throw new Error("Google requests require an approved HTTPS endpoint");
  }

  // OAuth must not hang if the proxy is unavailable. Preserve explicit caller deadlines.
  const signal = init?.signal ?? (OAUTH_HOSTS.has(url.hostname)
    ? request
      ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000)
    : request?.signal);
  const proxy = process.env.GOOGLE_HTTP_PROXY?.trim();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    ...init,
    ...(signal ? { signal } : {}),
    // Do not forward OAuth tokens or API keys through redirects, even to another Google host.
    redirect: "error",
    ...(proxy ? { dispatcher: localProxy(proxy) } : {}),
  };
  // Node's native fetch accepts an Undici dispatcher and preserves native Request/Response objects.
  // With no proxy configured this remains the normal, mockable global fetch.
  return globalThis.fetch(input, options);
};
