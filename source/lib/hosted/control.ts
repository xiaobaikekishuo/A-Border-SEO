import { z } from "zod";
import { APP_VERSION } from "@/lib/version";
import { ContentError } from "@/lib/content-planner/http";

export const hostedMode = () => process.env.ABORDER_HOSTED === "1";
export const HOSTED_COOKIE = "__Secure-authjs.session-token";
export const deviceInput = z.object({ productId: z.string().min(1).max(128), installationId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128).optional(), desktopVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();
const snapshotSchema = z.object({ v: z.literal(1), scope: z.enum(["device", "account"]), issuer: z.string().url(),
  productId: z.string().min(1), accountId: z.string().min(1), installationId: z.string().nullable(),
  username: z.string().nullable(), label: z.string(), checkedAt: z.number(), validUntil: z.number(), revision: z.number(),
  allowed: z.boolean(), reason: z.string().nullable(), features: z.object({ jobs: z.boolean(), codex: z.boolean(), manus: z.boolean(), geo: z.boolean() }),
  maintenanceMessage: z.string(), release: z.unknown().nullable(), sessionBinding: z.string().optional(), receiptTicket: z.string().optional(),
});
export type HostedSnapshot = z.infer<typeof snapshotSchema>;
export type HostedFeature = "jobs" | "codex" | "manus" | "geo";
export type HostedReceiptComponent = "http_session" | "http_api" | "content_worker" | "ordinary_worker";

export async function controlCall(action: string, body: object): Promise<HostedSnapshot> {
  try {
    const base = new URL(process.env.ABORDER_CONTROL_INTERNAL_URL || "http://127.0.0.1:18086");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error();
    const secret = process.env.ABORDER_CONTROL_INTERNAL_SECRET;
    if (!secret || secret.length < 32) throw new Error();
    const response = await fetch(new URL(`/internal/v1/workbench/${action}`, base), { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ...body, backendVersion: APP_VERSION }), signal: AbortSignal.timeout(5000), cache: "no-store" });
    const text = await response.text();
    if (text.length > 64000) throw new Error();
    if (!response.ok) {
      if (response.status === 401 && JSON.parse(text)?.error === "device_authentication_failed") throw new ContentError("hosted_device_invalid", 401);
      throw new Error();
    }
    const result = snapshotSchema.parse(JSON.parse(text));
    const now = Math.floor(Date.now() / 1000);
    if (result.checkedAt > now + 10 || result.validUntil <= now || result.validUntil > now + 120) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof ContentError && error.status === 401) throw error;
    throw new ContentError("hosted_verification_unavailable", 503);
  }
}

export function usable(snapshot: HostedSnapshot, feature?: HostedFeature) {
  return snapshot.allowed && (!feature || snapshot.features[feature]);
}

export async function sendHostedReceipt(snapshot: HostedSnapshot, component: HostedReceiptComponent, status: "effective" | "blocked" | "draining" | "failed", code?: string) {
  if (!snapshot.receiptTicket) return;
  try {
    const base = process.env.ABORDER_CONTROL_INTERNAL_URL || "http://127.0.0.1:18086";
    await fetch(new URL("/internal/v1/workbench/receipt", base), { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.ABORDER_CONTROL_INTERNAL_SECRET}` },
      body: JSON.stringify({ ticket: snapshot.receiptTicket, component, status, ...(code && /^[a-z0-9_-]{1,64}$/.test(code) ? { code } : {}) }),
      signal: AbortSignal.timeout(2000) });
  } catch { /* Receipt failure never widens access or reveals internal credentials. */ }
}
