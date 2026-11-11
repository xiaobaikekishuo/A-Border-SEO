"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { formatDay } from "@/lib/format";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { Logo } from "@/components/brand/logo";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { SiteSwitcher } from "@/components/sites/site-switcher";
import { ALL_SITES_HREF } from "@/lib/site-routes";
import { UserMenu } from "@/components/layout/user-menu";
import type { AvailableUpdate } from "@/lib/update-check";
import { PanelLeftClose, PanelLeftOpen, Menu, X } from "lucide-react";

export type ShellSite = { id: string; domain: string; dataThrough: string | null };

type AppShellProps = {
  email?: string | null;
  name?: string | null;
  image?: string | null;
  /** package.json version, shown under the user button. */
  version: string;
  /** A newer GitHub release, from the daily update check. */
  update?: AvailableUpdate | null;
  children: React.ReactNode;
  sites: ShellSite[];
};

const COLLAPSED_KEY = "aborder-sidebar-collapsed";

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSED_KEY, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSED_KEY, onChange);
  };
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function AppShell({ email, name, image, version, update, children, sites }: AppShellProps) {
  const ui = useUiText();
  const pathname = usePathname();

  // The mobile drawer is open only on the path it was opened on, so a route change closes it.
  const [openOnPath, setOpenOnPath] = useState<string | null>(null);
  const mobileOpen = openOnPath === pathname;
  const setMobileOpen = (open: boolean) => setOpenOnPath(open ? pathname : null);

  // Collapsed sidebar, remembered in localStorage (expanded on the server and when storage is blocked).
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);

  function toggleCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(!collapsed));
    } catch {
      // Storage blocked: the toggle cannot be remembered.
    }
    window.dispatchEvent(new Event(COLLAPSED_KEY));
  }

  // Status block: the open site's latest GSC day, or the latest across all sites.
  const activeId = pathname.match(/\/sites\/([^/]+)/)?.[1];
  const activeSite = sites.find((s) => s.id === activeId);
  const dataThrough = activeSite
    ? activeSite.dataThrough
    : sites.reduce<string | null>(
        (max, s) => (s.dataThrough && (!max || s.dataThrough > max) ? s.dataThrough : max),
        null
      );

  const sidebarContent = (
    <div className={cn("flex min-h-full flex-col gap-6 py-6", collapsed ? "px-3" : "px-4")}>
      <div className="flex flex-col gap-5">
        <div className={cn("flex items-center", collapsed ? "flex-col gap-3" : "justify-between")}>
          <Link
            href={ALL_SITES_HREF}
            aria-label="A-Border"
            className={cn("flex h-10 items-center text-text-strong", !collapsed && "px-2")}
          >
            <Logo variant={collapsed ? "mark" : "lockup"} decorative className={collapsed ? "h-8" : "h-10"} />
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? ui("Expand sidebar") : ui("Collapse sidebar")}
            title={collapsed ? ui("Expand sidebar") : ui("Collapse sidebar")}
            className="hidden size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-bg-section hover:text-text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
          </button>
        </div>
        <LanguageSwitcher compact={collapsed} />
        <SiteSwitcher sites={sites} collapsed={collapsed} />
      </div>

      <SidebarNav sites={sites} collapsed={collapsed} />

      <div className="mt-auto flex flex-col gap-4 pt-5">
        {!collapsed && (
          <div className="flex flex-col gap-1.5 border-t border-sidebar-border px-2 pt-4 text-[10px] leading-4 text-text-soft">
            <span className="mono-label">
              {dataThrough ? ui("GSC data through {0}", { "0": formatDay(dataThrough, { locale: ui.locale }) }) : ui("No GSC data yet")}
            </span>
            <span className="mono-label">{ui("Search data lags 3 days")}</span>
          </div>
        )}

        <UserMenu name={name} email={email} image={image} version={version} update={update} collapsed={collapsed} />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 z-20 hidden h-dvh shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:block",
          collapsed ? "w-[72px]" : "w-[244px] lg:w-[252px]"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar shadow-[var(--shadow-3)] transition-transform duration-200 md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
        inert={!mobileOpen}
      >
        <div className="flex items-center justify-end px-4 pt-3">
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={ui("Close menu")}
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-bg-section hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="flex-1">{sidebarContent}</div>
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-sidebar-border bg-sidebar/95 px-4 backdrop-blur-md md:hidden">
          <Link
            href={ALL_SITES_HREF}
            aria-label="A-Border"
            className="flex h-11 items-center px-2 text-text-strong"
          >
            <Logo decorative className="h-10" />
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label={ui("Open menu")}
            className="flex size-11 items-center justify-center rounded-lg text-text-strong hover:bg-bg-section focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1760px] flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8 xl:px-10 xl:py-10">{children}</main>
      </div>
    </div>
  );
}
