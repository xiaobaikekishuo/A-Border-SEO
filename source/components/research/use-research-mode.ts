"use client";

import { useSyncExternalStore } from "react";

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}

export function useResearchMode() {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const query = new URLSearchParams(search);
  if (query.get("mode") === "manus") return "manus";
  return query.get("mode") === "chatgpt" || query.has("chatgpt") ? "chatgpt" : "sources";
}
