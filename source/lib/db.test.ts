import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ constructed: vi.fn() }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(options: unknown) { fixture.constructed(options); }
  },
}));

const prismaGlobal = globalThis as typeof globalThis & { prisma?: unknown };
let previous: unknown;

beforeEach(() => {
  previous = prismaGlobal.prisma;
  delete prismaGlobal.prisma;
  fixture.constructed.mockClear();
  vi.resetModules();
});
afterEach(() => {
  if (previous === undefined) delete prismaGlobal.prisma;
  else prismaGlobal.prisma = previous;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(["production", "development"])("database client in %s", mode => {
  it("keeps one pool when separate route bundles load the module", async () => {
    vi.stubEnv("NODE_ENV", mode);
    const first = (await import("./db")).db;
    vi.resetModules();
    const second = (await import("./db")).db;
    vi.resetModules();
    const third = (await import("./db")).db;

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(prismaGlobal.prisma).toBe(first);
    expect(fixture.constructed).toHaveBeenCalledTimes(1);
    expect(fixture.constructed).toHaveBeenCalledWith({
      log: mode === "development" ? ["error", "warn"] : ["error"],
    });
  });
});
