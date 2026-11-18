"use client";

type DesktopBridge = {
  openExternal(url: string): Promise<void>;
  showSettings?(): Promise<void>;
  logout?(): Promise<void>;
};

declare global {
  interface Window {
    aborderDesktop?: DesktopBridge;
  }
}

export function desktopBridge() {
  return typeof window === "undefined" ? undefined : window.aborderDesktop;
}

export function hasDesktopBridge() {
  return Boolean(desktopBridge());
}

export class DesktopOAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Flow = { action: "login" } | {
  action: "ga4";
  siteId: string;
  report: { propertyId: string; start: string; end: string; expectedUpdatedAt: string | null };
};

async function request(body: object, signal?: AbortSignal) {
  const response = await fetch("/api/desktop/oauth", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" },
    body: JSON.stringify(body),
    signal,
    keepalive: !signal,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new DesktopOAuthError(typeof result?.error === "string" ? result.error : "DESKTOP_AUTH", response.status);
  }
  return result;
}

function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function authorizeInBrowser(flow: Flow, signal: AbortSignal, onApproved?: () => void) {
  const bridge = desktopBridge();
  if (!bridge) throw new DesktopOAuthError("DESKTOP_UNAVAILABLE", 503);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const { id, url } = await request({ ...flow, challenge: base64url(new Uint8Array(digest)) }, signal);
  if (typeof id !== "string" || typeof url !== "string") throw new DesktopOAuthError("DESKTOP_AUTH", 502);
  const proof = { id, verifier };
  try {
    signal.throwIfAborted();
    await bridge.openExternal(url);
    for (;;) {
      const { status } = await request({ action: "status", ...proof }, signal);
      if (status === "approved") {
        signal.throwIfAborted();
        onApproved?.();
        await request({ action: "claim", ...proof }, signal);
        return;
      }
      if (status !== "pending") throw new DesktopOAuthError("GA_AUTH", 403);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (error) {
    void request({ action: "cancel", ...proof }).catch(() => undefined);
    throw error;
  }
}
