import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";

const nav = vi.hoisted(() => ({ pathname: "/sites/site-a", pendingHref: null as string | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", async () => {
  const { createContext, useContext } = await import("react");
  const Status = createContext({ pending: false });
  return {
    default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
      <Status.Provider value={{ pending: href === nav.pendingHref }}>
        <a href={href} {...props}>{children}</a>
      </Status.Provider>
    ),
    useLinkStatus: () => useContext(Status),
  };
});

import { I18nProvider } from "@/lib/i18n/client";
import { SidebarNav } from "./sidebar-nav";
import DashboardLoading from "@/app/(dashboard)/loading";
import SitePageLoading from "@/app/(dashboard)/sites/[siteId]/loading";

const sites = [{ id: "site-a", domain: "example.test" }];
function renderNav(collapsed = false) {
  return renderToStaticMarkup(<I18nProvider initialLocale="zh"><SidebarNav sites={sites} collapsed={collapsed} /></I18nProvider>);
}
function link(html: string, href: string) {
  const match = html.match(new RegExp(`<a\\b[^>]*href="${href}"[^>]*>[\\s\\S]*?<\\/a>`));
  if (!match) throw new Error("Expected navigation link missing");
  return match[0];
}

beforeEach(() => { nav.pathname = "/sites/site-a"; nav.pendingHref = null; });

describe("page navigation feedback", () => {
  it.each([false, true])("announces only the pending destination, collapsed=%s", collapsed => {
    nav.pendingHref = "/sites/site-a/keywords";
    const html = renderNav(collapsed);
    const destination = link(html, nav.pendingHref);
    expect(destination).toContain('aria-busy="true"');
    expect(destination).toContain("正在打开关键词…");
    expect(destination).not.toContain('aria-current="page"');
    expect(link(html, "/sites/site-a")).toContain('aria-current="page"');
    expect(link(html, "/sites/site-a/pages")).not.toContain('aria-busy="true"');
    expect(html.match(/正在打开/g)).toHaveLength(1);
    // Navigation remains available while another page is loading.
    expect(destination).not.toContain("disabled");
    if (collapsed) expect(destination).toContain('aria-label="关键词"');
  });

  it("clears pending feedback when a transition finishes or is interrupted", () => {
    nav.pendingHref = "/sites/site-a/keywords";
    expect(renderNav()).toContain("正在打开关键词…");
    nav.pendingHref = null;
    expect(renderNav()).not.toContain('aria-busy="true"');
    nav.pathname = "/sites/site-a/pages";
    const completed = renderNav();
    expect(link(completed, "/sites/site-a/pages")).toContain('aria-current="page"');
    expect(completed).not.toContain("正在打开");
  });

  it.each(["en", "zh"] as const)("keeps the page fallback localised and limited to content: %s", locale => {
    for (const Loading of [DashboardLoading, SitePageLoading]) {
      const html = renderToStaticMarkup(<I18nProvider initialLocale={locale}><Loading /></I18nProvider>);
      expect(html).toContain(locale === "zh" ? "正在加载页面…" : "Loading page…");
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain("<nav");
      expect(html).not.toContain("<aside");
      expect(html).not.toContain("<button");
    }
  });
});
