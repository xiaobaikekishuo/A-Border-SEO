import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, tx, lookup, row } = vi.hoisted(() => {
  const row = {
    id: "site-1",
    userId: "user-1",
    domain: "quayline.app",
    gscProperty: "sc-domain:quayline.app" as string | null,
    bingSite: "https://quayline.app/old/" as string | null,
  };
  const update = vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
    Object.assign(row, data);
    return {
      id: row.id,
      domain: row.domain,
      gscProperty: row.gscProperty,
      bingSite: row.bingSite,
      updatedAt: new Date(),
    };
  });
  // What the PUT sees inside its locked transaction.
  const tx = {
    $queryRaw: vi.fn(),
    keyword: { deleteMany: vi.fn() },
    page: { deleteMany: vi.fn() },
    queryPage: { deleteMany: vi.fn() },
    gscSyncCoverage: { deleteMany: vi.fn() },
    bingSearchWeekly: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    bingDaily: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    site: { update },
  };
  return {
    row,
    tx,
    lookup: vi.fn(),
    db: {
      site: {
        findUnique: vi.fn(async () => ({ userId: row.userId, domain: row.domain, gscProperty: row.gscProperty })),
        update,
      },
      $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    },
  };
});

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
// Only DNS is faked, so the real assertPublicDomain decides what is private.
vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("@/lib/google", () => ({
  listGSCProperties: vi.fn(),
  ReauthRequiredError: class ReauthRequiredError extends Error {},
}));
vi.mock("@/lib/bing", () => ({
  listBingSites: vi.fn(),
  BingKeyMissingError: class BingKeyMissingError extends Error {},
}));
vi.mock("@/lib/managed/policy", () => ({ managedAllows: vi.fn(() => true) }));
vi.mock("@/lib/desktop/maintenance", () => ({ desktopMaintenanceActive: vi.fn(() => false) }));

import { setSitePolicy } from "@/lib/site-policy";
import { listGSCProperties, ReauthRequiredError } from "@/lib/google";
import { listBingSites, BingKeyMissingError } from "@/lib/bing";
import { managedAllows } from "@/lib/managed/policy";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { PUT } from "./route";

const DNS: Record<string, string> = {
  "internal.example": "10.0.0.5",
  "loopback.example": "127.0.0.1",
  "metadata.example": "169.254.169.254",
  "new-site.com": "93.184.216.34",
};

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/sites/site-1", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ siteId: "site-1" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listGSCProperties).mockResolvedValue([{ siteUrl: "sc-domain:quayline.app", permissionLevel: "siteOwner" }]);
  vi.mocked(listBingSites).mockResolvedValue([
    { url: "https://quayline.app/" }, { url: "https://quayline.app/old/" }, { url: "https://quayline.app/new/" },
  ]);
  vi.mocked(managedAllows).mockReturnValue(true);
  vi.mocked(desktopMaintenanceActive).mockReturnValue(false);
  setSitePolicy(null);
  Object.assign(row, {
    domain: "quayline.app",
    gscProperty: "sc-domain:quayline.app",
    bingSite: "https://quayline.app/old/",
  });
  tx.$queryRaw.mockImplementation(async () => [{ domain: row.domain, gscProperty: row.gscProperty, bingSite: row.bingSite }]);
  lookup.mockImplementation(async (host: string) => {
    const address = DNS[host] ?? host;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  });
});

describe("connecting Search Console to a manual site", () => {
  beforeEach(() => { row.gscProperty = null; });

  it("connects only a matching property returned for the current user and preserves the domain", async () => {
    const response = await put({ gscProperty: "sc-domain:quayline.app" });
    expect(response.status).toBe(200);
    expect(listGSCProperties).toHaveBeenCalledWith("user-1");
    expect(row.domain).toBe("quayline.app");
    expect(row.gscProperty).toBe("sc-domain:quayline.app");
  });

  it("invalidates all four provider caches under the sync lock only on an actual rebind", async () => {
    row.gscProperty = "https://quayline.app/old/";
    expect((await put({ gscProperty: "sc-domain:quayline.app" })).status).toBe(200);
    expect(tx.$queryRaw.mock.calls[0][0].join("?")).toMatch(/FOR NO KEY UPDATE/);
    expect((await put({ gscProperty: "sc-domain:quayline.app" })).status).toBe(200);
    for (const table of [tx.keyword, tx.page, tx.queryPage, tx.gscSyncCoverage]) {
      expect(table.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { siteId: "site-1" } });
      expect(table.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(tx.site.update.mock.invocationCallOrder[0]);
    }
    expect(tx.bingDaily.deleteMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent GSC rebind made during property verification", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ ...row, gscProperty: "https://quayline.app/other/" }]);
    const response = await put({ gscProperty: "sc-domain:quayline.app" });
    expect(response.status).toBe(409);
    expect(tx.keyword.deleteMany).not.toHaveBeenCalled();
    expect(tx.site.update).not.toHaveBeenCalled();
  });

  it("rejects a property belonging to another domain before contacting Google", async () => {
    const response = await put({ gscProperty: "sc-domain:other.example" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "GSC_PROPERTY_MISMATCH" });
    expect(listGSCProperties).not.toHaveBeenCalled();
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it.each([{ properties: [] }, { properties: [{ siteUrl: "sc-domain:quayline.app", permissionLevel: "siteUnverifiedUser" }] }])("rejects unavailable or unverified properties", async ({ properties }) => {
    vi.mocked(listGSCProperties).mockResolvedValue(properties);
    const response = await put({ gscProperty: "sc-domain:quayline.app" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "GSC_PROPERTY_UNAVAILABLE" });
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it("asks for Google authorization without changing the site", async () => {
    vi.mocked(listGSCProperties).mockRejectedValueOnce(new ReauthRequiredError());
    const response = await put({ gscProperty: "sc-domain:quayline.app" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(row.gscProperty).toBeNull();
  });

  it.each([null, 1, {}, ""])("rejects malformed property %j", async gscProperty => {
    expect((await put({ gscProperty })).status).toBe(400);
    expect(db.site.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/sites/[siteId] domain", () => {
  it.each(["internal.example", "loopback.example", "metadata.example", "127.0.0.1", "http://127.0.0.1:8080"])(
    "rejects %s and leaves the row unchanged",
    async (domain) => {
      const res = await put({ domain });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Domain must resolve to a public IP address" });
      expect(db.site.update).not.toHaveBeenCalled();
      expect(row.domain).toBe("quayline.app");
    }
  );

  it("rejects a domain that does not resolve", async () => {
    lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));

    const res = await put({ domain: "nope.invalid" });

    expect(res.status).toBe(400);
    expect(db.site.update).not.toHaveBeenCalled();
    expect(row.domain).toBe("quayline.app");
  });

  it("accepts a domain that resolves to a public IP", async () => {
    const res = await put({ domain: "new-site.com" });

    expect(res.status).toBe(200);
    expect((await res.json()).domain).toBe("new-site.com");
    expect(row.domain).toBe("new-site.com");
  });

  it("checks and stores the normalized hostname, not the raw input", async () => {
    const blocked = await put({ domain: "https://internal.example/blog/" });

    expect(blocked.status).toBe(400);
    expect(lookup).toHaveBeenCalledWith("internal.example", { all: true });
    expect(row.domain).toBe("quayline.app");

    const allowed = await put({ domain: "https://new-site.com/blog/" });

    expect(allowed.status).toBe(200);
    expect(lookup).toHaveBeenLastCalledWith("new-site.com", { all: true });
    expect(row.domain).toBe("new-site.com");
  });

  it("does not resolve anything when only gscProperty changes", async () => {
    const res = await put({ gscProperty: "sc-domain:quayline.app" });

    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(row.domain).toBe("quayline.app");
  });
});

describe("PUT /api/sites/[siteId] and the site policy", () => {
  it("asks the policy about the site as it would be after the change, and refuses with its status", async () => {
    const canUpdate = vi.fn(async () => ({ ok: false as const, reason: "Verify this site in Search Console first", status: 403 }));
    setSitePolicy({ canUpdate });

    const res = await put({ domain: "new-site.com" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Verify this site in Search Console first" });
    expect(canUpdate).toHaveBeenCalledWith(
      { id: "user-1" },
      { id: "site-1", domain: "new-site.com", gscProperty: "sc-domain:quayline.app" }
    );
    expect(db.site.update).not.toHaveBeenCalled();
    expect(row.domain).toBe("quayline.app");
  });

  it("falls back to canAdd for a new property", async () => {
    const canAdd = vi.fn(async () => ({ ok: false as const, reason: "Not verified", status: 403 }));
    setSitePolicy({ canAdd });

    const res = await put({ gscProperty: "sc-domain:other.example" });

    expect(res.status).toBe(403);
    expect(canAdd).toHaveBeenCalledWith(
      { id: "user-1" },
      { domain: "quayline.app", gscProperty: "sc-domain:other.example", siteId: "site-1" }
    );
  });

  it("does not ask the policy when the values sent are the current ones", async () => {
    const canUpdate = vi.fn(async () => ({ ok: false as const, reason: "No", status: 403 }));
    setSitePolicy({ canUpdate });

    const res = await put({ gscProperty: "sc-domain:quayline.app" });

    expect(res.status).toBe(200);
    expect(canUpdate).not.toHaveBeenCalled();
  });

  it("does not ask the policy when only the Bing property changes", async () => {
    const canUpdate = vi.fn(async () => ({ ok: false as const, reason: "No", status: 403 }));
    setSitePolicy({ canUpdate });

    const res = await put({ bingSite: "https://quayline.app/" });

    expect(res.status).toBe(200);
    expect(canUpdate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/sites/[siteId] with a Bing property", () => {
  // Changing the Bing property wipes the old property's rows. The decision and
  // the wipe happen under the Site row lock, in the transaction that also
  // updates the row: a sync in flight (bing-sync.ts holds the same lock) and a
  // concurrent PUT both serialise against it, and a failed update (say a
  // duplicate domain) rolls the wipe back.
  it("wipes the old rows under the Site row lock, before the update", async () => {
    const res = await put({ bingSite: "https://quayline.app/new/" });

    expect(res.status).toBe(200);
    expect((await res.json()).bingSite).toBe("https://quayline.app/new/");
    expect(listBingSites).toHaveBeenCalledWith("user-1");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const [sql] = tx.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toMatch(/FOR NO KEY UPDATE/);
    expect(tx.bingDaily.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(tx.bingSearchWeekly.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(tx.bingDaily.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.site.update.mock.invocationCallOrder[0]
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("decides from the locked value, not from the earlier read", async () => {
    // Another request moved the property after the ownership read. Saving the
    // value that read returned is still a change, so the rows must go.
    tx.$queryRaw.mockResolvedValueOnce([{ bingSite: "https://quayline.app/another/" }]);

    const res = await put({ bingSite: "https://quayline.app/old/" });

    expect(res.status).toBe(200);
    expect(tx.bingDaily.deleteMany).toHaveBeenCalled();
    expect(row.bingSite).toBe("https://quayline.app/old/");
  });

  it("leaves the rows alone when the property does not change", async () => {
    const res = await put({ bingSite: "https://quayline.app/old/" });

    expect(res.status).toBe(200);
    expect(tx.bingDaily.deleteMany).not.toHaveBeenCalled();
    expect(tx.bingSearchWeekly.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a property that is not a string without touching the rows", async () => {
    expect((await put({ bingSite: 0 })).status).toBe(400);
    expect((await put({ bingSite: ["https://new.example/"] })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it("rejects a property that is not an http(s) URL", async () => {
    expect((await put({ bingSite: "ftp://new.example/" })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.example/", "https://www.quayline.app/", "https://quayline.app.attacker.example/",
  ])("rejects the different hostname %s before querying Bing", async (bingSite) => {
    const res = await put({ bingSite });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BING_PROPERTY_MISMATCH" });
    expect(listBingSites).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@quayline.app/", "https://user@quayline.app/", "https://quayline.app/#fragment",
    "https://quayline.app/?key=secret", "https:quayline.app", " https://quayline.app/ ",
    "javascript:alert(1)", "not a URL",
  ])("rejects malformed or credential-bearing URL %s before querying Bing", async (bingSite) => {
    const res = await put({ bingSite });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BING_PROPERTY" });
    expect(listBingSites).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("requires the exact property to be verified on this account", async () => {
    vi.mocked(listBingSites).mockResolvedValueOnce([{ url: "https://quayline.app/elsewhere/" }]);
    const res = await put({ bingSite: "https://quayline.app/new/" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "BING_PROPERTY_UNAVAILABLE" });
    expect(listBingSites).toHaveBeenCalledWith("user-1");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("matches the normalized hostname when changing domain and Bing property together", async () => {
    vi.mocked(listBingSites).mockResolvedValueOnce([{ url: "https://new-site.com/" }]);
    const res = await put({ domain: "HTTPS://NEW-SITE.COM/blog/", bingSite: "https://new-site.com/" });
    expect(res.status).toBe(200);
    expect(row.domain).toBe("new-site.com");
    expect(row.bingSite).toBe("https://new-site.com/");
  });

  it("never queries a Bing account for another local user's site", async () => {
    db.site.findUnique.mockResolvedValueOnce({ userId: "another-user", domain: row.domain, gscProperty: row.gscProperty });
    const res = await put({ bingSite: "https://quayline.app/" });
    expect(res.status).toBe(403);
    expect(listBingSites).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("clears a binding and its old rows without querying the provider", async () => {
    const res = await put({ bingSite: "" });
    expect(res.status).toBe(200);
    expect(row.bingSite).toBeNull();
    expect(listBingSites).not.toHaveBeenCalled();
    expect(tx.bingDaily.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(tx.bingSearchWeekly.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
  });

  it("asks to connect Bing when the account has no saved key", async () => {
    vi.mocked(listBingSites).mockRejectedValueOnce(new BingKeyMissingError());
    const res = await put({ bingSite: "https://quayline.app/" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BING_KEY_MISSING" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("does not return or log a provider error containing credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(listBingSites).mockRejectedValueOnce(new Error("request failed ?apikey=secret-marker"));
      const res = await put({ bingSite: "https://quayline.app/" });
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toContain("BING_PROPERTY_CHECK_FAILED");
      expect(body).not.toContain("secret-marker");
      expect(log).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each(["policy", "maintenance"])("refuses Bing changes during %s before provider access", async kind => {
    if (kind === "policy") vi.mocked(managedAllows).mockReturnValue(false);
    else vi.mocked(desktopMaintenanceActive).mockReturnValue(true);
    const res = await put({ bingSite: "https://quayline.app/" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "BING_CONNECTION_RESTRICTED" });
    expect(listBingSites).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rechecks management policy after the provider lookup before changing the binding", async () => {
    vi.mocked(listBingSites).mockImplementationOnce(async () => {
      vi.mocked(managedAllows).mockReturnValue(false);
      return [{ url: "https://quayline.app/" }];
    });
    const res = await put({ bingSite: "https://quayline.app/" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "BING_CONNECTION_RESTRICTED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
