import { afterEach, describe, expect, it, vi } from "vitest";
import { canAddSite, canUpdateSite, setSitePolicy, siteCreated, siteDeleted } from "./site-policy";

const site = { id: "s1", userId: "u1", domain: "quayline.app", gscProperty: "sc-domain:quayline.app" };

afterEach(() => {
  setSitePolicy(null);
  vi.restoreAllMocks();
});

describe("site policy", () => {
  it("allows every site and does nothing by default", async () => {
    await expect(canAddSite({ id: "u1" }, site)).resolves.toEqual({ ok: true });
    await expect(siteCreated(site)).resolves.toBeUndefined();
    await expect(siteDeleted(site)).resolves.toBeUndefined();
  });

  it("asks the registered policy whether a site may be added", async () => {
    const canAdd = vi.fn(async () => ({ ok: false as const, reason: "Limit reached", status: 402 }));
    setSitePolicy({ canAdd });
    await expect(canAddSite({ id: "u1" }, site)).resolves.toEqual({ ok: false, reason: "Limit reached", status: 402 });
    expect(canAdd).toHaveBeenCalledWith({ id: "u1" }, site);
  });

  it("asks canUpdate about a changed site, or canAdd when there is no canUpdate", async () => {
    await expect(canUpdateSite({ id: "u1" }, site)).resolves.toEqual({ ok: true });

    const canAdd = vi.fn(async () => ({ ok: false as const, reason: "Not verified", status: 403 }));
    setSitePolicy({ canAdd });
    await expect(canUpdateSite({ id: "u1" }, site)).resolves.toEqual({ ok: false, reason: "Not verified", status: 403 });
    expect(canAdd).toHaveBeenCalledWith({ id: "u1" }, { domain: site.domain, gscProperty: site.gscProperty, siteId: site.id });

    const canUpdate = vi.fn(async () => ({ ok: true as const }));
    setSitePolicy({ canAdd, canUpdate });
    await expect(canUpdateSite({ id: "u1" }, site)).resolves.toEqual({ ok: true });
    expect(canUpdate).toHaveBeenCalledWith({ id: "u1" }, site);
    expect(canAdd).toHaveBeenCalledTimes(1);
  });

  it("calls the after hooks with the site", async () => {
    const afterCreate = vi.fn(async () => {});
    const afterDelete = vi.fn(async () => {});
    setSitePolicy({ afterCreate, afterDelete });
    await siteCreated(site);
    await siteDeleted(site);
    expect(afterCreate).toHaveBeenCalledWith(site);
    expect(afterDelete).toHaveBeenCalledWith(site);
  });

  it("logs a failing after hook instead of throwing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    setSitePolicy({
      afterCreate: async () => {
        throw new Error("boom");
      },
      afterDelete: async () => {
        throw new Error("boom");
      },
    });
    await expect(siteCreated(site)).resolves.toBeUndefined();
    await expect(siteDeleted(site)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("goes back to the default when reset", async () => {
    setSitePolicy({ canAdd: async () => ({ ok: false, reason: "No", status: 403 }) });
    setSitePolicy(null);
    await expect(canAddSite({ id: "u1" }, site)).resolves.toEqual({ ok: true });
  });
});
