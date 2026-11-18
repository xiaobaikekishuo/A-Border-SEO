import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlCall, sendHostedReceipt, type HostedSnapshot } from "./control";

describe("internal policy response validation", () => {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = { v: 1, scope: "account", issuer: "https://issuer.example.test", productId: "a-border-seo", accountId: "a",
    installationId: null, username: null, label: "Fixture", checkedAt: now, validUntil: now + 30, revision: 1,
    allowed: true, reason: null, features: { jobs: true, codex: true, geo: true, manus: true }, maintenanceMessage: "", release: null };
  beforeEach(() => vi.stubEnv("ABORDER_CONTROL_INTERNAL_SECRET", "fixture-internal-secret-at-least-32-characters"));
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it.each([
    { validUntil: now - 1 }, { validUntil: now + 1000 }, { checkedAt: now + 1000 }, { features: { jobs: true } }, { v: 2 },
  ])("rejects stale, future and incomplete snapshots: %j", async patch => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...snapshot, ...patch })));
    await expect(controlCall("account-policy", {})).rejects.toMatchObject({ status: 503, message: "hosted_verification_unavailable" });
  });
  it("rejects redirects and never forwards a client-supplied backend version", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal("fetch", fetcher);
    await controlCall("account-policy", { backendVersion: "999.0.0" });
    const options = fetcher.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(options[1].redirect).toBe("error"); expect(options[1].cache).toBe("no-store");
    expect(JSON.parse(String(options[1].body)).backendVersion).not.toBe("999.0.0");
  });
  it("sends an explicit executor component with each receipt", async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    for (const component of ["http_session", "http_api", "content_worker", "ordinary_worker"] as const) {
      await sendHostedReceipt({ ...snapshot, receiptTicket: "fixture-ticket" } as HostedSnapshot, component, "draining", "fixture_gate");
      expect(JSON.parse(String(fetcher.mock.lastCall![1].body))).toEqual({ ticket: "fixture-ticket", component, status: "draining", code: "fixture_gate" });
    }
  });
});
