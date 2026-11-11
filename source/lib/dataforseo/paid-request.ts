import type { ResearchMarket } from "./market";
export async function confirmedResearchRequest(
  url: string,
  market: ResearchMarket,
  operations: number,
  message: string,
  confirm: (message: string) => boolean,
  send: typeof fetch = fetch,
): Promise<Response | null> {
  if (!confirm(message)) return null;
  return send(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "dataforseo", confirmed: true, operations, ...market }) });
}
