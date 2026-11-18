import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), site: vi.fn(), key: vi.fn(), report: vi.fn(),
  allows: vi.fn(), maintenance: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.site }, apiKey: { findUnique: mocks.key } } }));
vi.mock("@/lib/bing/report", () => ({ getBingReport: mocks.report }));
vi.mock("@/lib/managed/policy", () => ({ managedAllows: mocks.allows }));
vi.mock("@/lib/desktop/maintenance", () => ({ desktopMaintenanceActive: mocks.maintenance }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/i18n/server", async () => {
  const { createTranslator } = await import("@/lib/i18n/shared");
  return { getI18n: async () => ({ locale: "en", t: createTranslator("en") }) };
});
vi.mock("@/components/bing/report-view", () => ({ BingReportView: () => <div>saved-bing-report</div> }));
vi.mock("@/components/sites/bing-sync-button", () => ({
  BingSyncButton: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>Sync Bing</button>,
}));
const { default: Page } = await import("./page");
const render = (days?: string | string[]) => Page({ params: Promise.resolve({ siteId: "site-1" }),
  searchParams: Promise.resolve({ days }) }).then(renderToStaticMarkup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "owner-1" } });
  mocks.site.mockResolvedValue({ domain: "example.com", bingSite: "https://example.com/" });
  mocks.key.mockResolvedValue({ id: "key-1" });
  mocks.report.mockResolvedValue({});
  mocks.allows.mockReturnValue(true); mocks.maintenance.mockReturnValue(false);
});

describe("Bing report page access and setup", () => {
  it("rejects a signed-out reader before querying any site or report", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("REDIRECT /login");
    expect(mocks.site).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled();
  });
  it("scopes the site to the account and never reads another owner's report", async () => {
    mocks.site.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("REDIRECT /sites");
    expect(mocks.site).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "site-1", userId: "owner-1" } }));
    expect(mocks.key).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled();
  });
  it("prompts for the account key without querying saved metrics", async () => {
    mocks.key.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Connect Bing Webmaster Tools");
    expect(html).toContain("/settings?connect=bing#connections");
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.key).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
  });
  it("provides the verified-site picker when no property is bound", async () => {
    mocks.site.mockResolvedValue({ domain: "example.com", bingSite: null });
    const html = await render();
    expect(html).toContain("Choose this site&#x27;s Bing property");
    expect(html).toContain('id="bing-connection"');
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("validates the date range before querying", async () => {
    await render("90"); expect(mocks.report).toHaveBeenLastCalledWith("site-1", 90);
    await render("180"); expect(mocks.report).toHaveBeenLastCalledWith("site-1", 180);
    await render("999999"); expect(mocks.report).toHaveBeenLastCalledWith("site-1", 28);
    await render(["90", "180"]); expect(mocks.report).toHaveBeenLastCalledWith("site-1", 28);
  });
  it("keeps saved reports readable while a policy pauses new syncs", async () => {
    mocks.allows.mockReturnValue(false);
    const html = await render();
    expect(html).toContain("saved-bing-report");
    expect(html).toContain('href="/sites/site-1/assistant?actionScope=bing"');
    expect(html).toContain("Saved reports remain readable");
    expect(html).toMatch(/<button disabled="">Sync Bing/);
  });
});
