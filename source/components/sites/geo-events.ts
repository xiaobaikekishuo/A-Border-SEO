/** The GEO panels reload when another panel's import, check or run changes what they show. */
export const GEO_UPDATED_EVENT = "aborder:geo-updated";

export function announceGeoUpdate(): void {
  window.dispatchEvent(new Event(GEO_UPDATED_EVENT));
}

/** Calls `reload` on each update; returns the cleanup for useEffect. */
export function onGeoUpdate(reload: () => void): () => void {
  const handler = () => reload();
  window.addEventListener(GEO_UPDATED_EVENT, handler);
  return () => window.removeEventListener(GEO_UPDATED_EVENT, handler);
}
