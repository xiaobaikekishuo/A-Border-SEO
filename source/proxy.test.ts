import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

describe("desktop maintenance", () => {
  let directory: string;
  let marker: string;
  const request = (path: string, method = "GET") => new NextRequest(`http://localhost:3300${path}`, { method });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aborder-maintenance-"));
    marker = join(directory, "maintenance");
    vi.stubEnv("ABORDER_DESKTOP_MAINTENANCE_FILE", marker);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(marker, { force: true });
    rmdirSync(directory);
  });

  it("pauses new writes and cron while preserving health and the lease bridge", async () => {
    const submit = request("/api/sites/site/manus-keywords", "POST");
    expect((await proxy(submit)).headers.get("x-middleware-next")).toBe("1");
    writeFileSync(marker, "maintenance");
    expect((await proxy(submit)).status).toBe(503);
    expect((await proxy(request("/api/cron/tick"))).status).toBe(503);
    expect((await proxy(request("/api/health"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/local-content-worker/chatgpt", "POST"))).headers.get("x-middleware-next")).toBe("1");
  });
});
