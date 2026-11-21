import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Manus research templates on PGlite: the paid submission guard, replays,
// and reading a structured result back. Manus itself is a stubbed fetch.

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});

import { encrypt } from "@/lib/encryption";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { refreshResearch, researchList, submitResearch } from "./research";

let t: TestDb;
let db: PrismaClient;
const owner = { userId: "owner", siteId: "manus-site" };
const requestId = "6f1c3c1e-2b7a-4c55-9d1e-2f3a4b5c6d7e";

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
  t = await createTestDb();
  db = holder.db = t.db;
  await db.user.create({ data: { id: "owner", email: "owner@local.test" } });
  await db.site.create({ data: { id: "manus-site", userId: "owner", domain: "www.kammakhome.com" } });
  await db.apiKey.create({ data: { userId: "owner", provider: "manus", encryptedPassword: encrypt("manus-test-key") } });
}, 120_000);
afterAll(async () => { await t?.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function stubManus(calls: { url: string; body: unknown }[]) {
  vi.stubEnv("MANUS_HTTP_PROXY", "");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (href.endsWith("/v2/task.create")) return Response.json({ ok: true, task_id: "task_A1" });
    if (href.includes("/v2/task.detail")) return Response.json({ ok: true, task: { id: "task_A1", status: "stopped" } });
    if (href.includes("/v2/task.listMessages")) {
      return Response.json({
        ok: true, task_id: "task_A1", has_more: false,
        messages: [
          {
            type: "structured_output_result",
            structured_output_result: {
              success: true,
              value: {
                summary: "Two prospects.",
                prospects: [
                  { url: "https://design.example/resources", domain: "design.example", prospect_type: "resource_page", relevance: "Lists sofa makers", approach: "Email the editor", contact_url: null, pitch_angle: "Guide", effort: "low", priority: "high", evidence_urls: [], observed_on: "2026-11-19" },
                  { url: "https://kammakhome.com/blog", domain: "kammakhome.com", prospect_type: "other", relevance: "", approach: "", contact_url: null, pitch_angle: "", effort: "low", priority: "low", evidence_urls: [], observed_on: null },
                ],
              },
            },
          },
          { type: "assistant_message", assistant_message: { content: "Finished.", attachments: [] } },
        ],
      });
    }
    return new Response("unexpected", { status: 500 });
  }));
}

const body = { kind: "LINK_PROSPECTS", topic: "modular sofas", competitors: ["https://www.acme.test/"], audience: "UK renters", language: "English", profile: "lite" };

describe("Manus research templates", () => {
  it("needs a confirmation and, for GEO sources, prompt tracking with citation gaps", async () => {
    await expect(submitResearch(owner, "LINK_PROSPECTS", { ...body, requestId })).rejects.toMatchObject({ message: "confirmation_required", status: 409 });
    await expect(submitResearch(owner, "LINK_PROSPECTS", { ...body, confirmed: true, requestId: "nope" })).rejects.toMatchObject({ message: "invalid_request_id" });
    await expect(submitResearch(owner, "GEO_SOURCES", { kind: "GEO_SOURCES", domains: ["reddit.com"], language: "English", confirmed: true, requestId }))
      .rejects.toMatchObject({ message: "geo_not_set_up", status: 409 });
    await expect(submitResearch(owner, "LINK_PROSPECTS", { ...body, topic: "x", confirmed: true, requestId })).rejects.toMatchObject({ message: "invalid_input", status: 400 });
    expect(await db.manusResearchTask.count()).toBe(0);
  });

  it("creates one task per request id, replays a retry and refuses a different request under the same id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    stubManus(calls);
    const task = await submitResearch(owner, "LINK_PROSPECTS", { ...body, confirmed: true, requestId });
    expect(task).toMatchObject({ kind: "LINK_PROSPECTS", status: "pending", refreshable: true, input: { site: "kammakhome.com", competitors: ["acme.test"] } });
    expect(calls.filter(c => c.url.endsWith("/task.create"))).toHaveLength(1);
    expect(JSON.stringify(calls[0].body)).not.toContain("manus-test-key");

    expect(await submitResearch(owner, "LINK_PROSPECTS", { ...body, confirmed: true, requestId: requestId.toUpperCase() })).toMatchObject({ id: task.id });
    expect(calls.filter(c => c.url.endsWith("/task.create"))).toHaveLength(1);
    await expect(submitResearch(owner, "LINK_PROSPECTS", { ...body, topic: "other topic", confirmed: true, requestId })).rejects.toMatchObject({ message: "request_id_conflict" });

    const list = await researchList(owner, "LINK_PROSPECTS", null);
    expect(list).toMatchObject({ connected: true, nextCursor: null, options: { site: "kammakhome.com" } });
    expect(list.tasks.map(x => x.id)).toEqual([task.id]);
    expect((await researchList(owner, "GEO_SOURCES", null)).tasks).toEqual([]);
  });

  it("reads the structured rows once the task finished, leaving out the site's own pages", async () => {
    const calls: { url: string; body: unknown }[] = [];
    stubManus(calls);
    const [task] = (await researchList(owner, "LINK_PROSPECTS", null)).tasks;
    const updated = await refreshResearch(owner, task.id);
    expect(updated).toMatchObject({ status: "completed", extracted: true, summary: "Two prospects.", errorCode: null });
    expect(updated.rows).toHaveLength(1);
    expect(updated.rows[0]).toMatchObject({ url: "https://design.example/resources", priority: "high" });
    await expect(refreshResearch({ ...owner, userId: "nobody" }, task.id)).rejects.toMatchObject({ message: "task_not_found", status: 404 });
  });
});
