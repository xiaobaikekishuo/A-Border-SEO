"use client";

import { desktopBridge } from "@/lib/desktop/client";
import { GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK } from "./connection-protocol";

export class GoogleConnectionError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function request(body: object, signal?: AbortSignal) {
  const response = await fetch("/api/google/connection", { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new GoogleConnectionError(typeof result?.error === "string" ? result.error : "GOOGLE_CONNECTION_FAILED");
  return result;
}
function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Links Google data to the current app user, never performs an app sign-in. */
export async function connectGoogleInBrowser(signal: AbortSignal) {
  const bridge = desktopBridge();
  // Reserve a browser tab in the original click gesture to avoid popup blockers.
  const popup = bridge ? null : window.open("about:blank", "_blank");
  if (!bridge && !popup) throw new GoogleConnectionError("GOOGLE_CONNECTION_POPUP_BLOCKED");
  if (popup) popup.opener = null;
  let proof: { id: string; verifier: string } | undefined;
  let finished = false;
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const { id, url } = await request({ action: "start", challenge }, signal);
    if (typeof id !== "string" || typeof url !== "string") throw new GoogleConnectionError("GOOGLE_CONNECTION_FAILED");
    const target = new URL(url);
    if (target.origin !== "https://accounts.google.com" || target.pathname !== "/o/oauth2/v2/auth"
      || target.searchParams.getAll("redirect_uri").length !== 1
      || ![GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK].some(path => target.searchParams.get("redirect_uri") === location.origin + path)) {
      throw new GoogleConnectionError("GOOGLE_CONNECTION_FAILED");
    }
    proof = { id, verifier };
    signal.throwIfAborted();
    if (bridge) await bridge.openExternal(target.href);
    else popup!.location.replace(target.href);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const { status } = await request({ action: "status", ...proof }, signal);
      if (status === "approved") {
        await request({ action: "claim", ...proof }, signal);
        finished = true;
        return;
      }
      if (status !== "pending") throw new GoogleConnectionError("GOOGLE_CONNECTION_DECLINED");
      await wait(signal);
    }
    throw new GoogleConnectionError("GOOGLE_CONNECTION_EXPIRED");
  } finally {
    if (!finished && proof) void request({ action: "cancel", ...proof }).catch(() => {});
    if (popup && !finished && !proof) popup.close();
  }
}
