"use client";

import { useEffect, useState } from "react";

export function MaintenanceNotice({ hosted, initial, maintenanceText, unavailableText }: {
  hosted: boolean; initial: { maintenance: boolean; message: string }; maintenanceText: string; unavailableText: string;
}) {
  const [notice, setNotice] = useState(initial);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!hosted) return;
    const stop = new AbortController();
    let checking = false;
    async function check() {
      if (document.visibilityState !== "visible" || checking) return;
      checking = true;
      try {
        const res = await fetch("/api/hosted/session", { cache: "no-store", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]) });
        if (stop.signal.aborted) return;
        if (res.status === 401 || res.status === 403) {
          window.location.replace(res.status === 401 ? "/login" : "/managed-status");
          return;
        }
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (typeof data.maintenance !== "boolean" || typeof data.message !== "string") throw new Error();
        if (!stop.signal.aborted) { setNotice(data); setUnavailable(false); }
      } catch { if (!stop.signal.aborted) setUnavailable(true); }
      finally { checking = false; }
    }
    const timer = window.setInterval(check, 30000);
    document.addEventListener("visibilitychange", check);
    return () => { stop.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [hosted]);
  const current = hosted ? notice : initial;
  if (!current.maintenance && !current.message && !unavailable) return null;
  return <aside role="status" className="mb-4 rounded-md border px-4 py-3 text-sm">
    {unavailable && <p>{unavailableText}</p>}
    {current.maintenance && <p>{maintenanceText}</p>}
    {current.message && <p>{current.message}</p>}
  </aside>;
}
