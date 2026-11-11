import { checkOrigin } from "@/lib/content-planner/http";
import { validMarket, type ResearchMarket } from "./market";

/** Every paid batch uses an explicit POST acknowledgement tied to its market and call count. */
export async function paidConfirmation(req: Request, market: ResearchMarket, operations: number): Promise<Response | null> {
  if (req.method !== "POST") return Response.json({ error: "Paid research requires confirmation", code: "PAYMENT_CONFIRMATION_REQUIRED" }, { status: 409 });
  try { checkOrigin(req); }
  catch { return Response.json({ error: "Invalid origin" }, { status: 403 }); }
  const value = await req.json().catch(() => null);
  if (!value || value.confirmed !== true || value.provider !== "dataforseo" || value.operations !== operations) {
    return Response.json({ error: "Paid research requires confirmation", code: "PAYMENT_CONFIRMATION_REQUIRED" }, { status: 409 });
  }
  if (!validMarket(value) || value.language !== market.language || value.location !== market.location) {
    return Response.json({ error: "Research market changed. Reload and confirm again.", code: "MARKET_CHANGED" }, { status: 409 });
  }
  return null;
}
