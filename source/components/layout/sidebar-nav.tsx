"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";
import { useI18n } from "@/lib/i18n/client";


import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Globe,
  Search,
  FileText,
  Bug,
  Gauge,
  Lightbulb,
  Bell,
  Settings,
  Bookmark,
  Bot,
  Link as LinkIcon,
  SearchCheck,
  Layers3,
  ScanSearch,
  Activity,
  type LucideIcon,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

export function SidebarNav({
  sites,
  collapsed = false,
}: {
  sites: { id: string; domain: string }[];
  collapsed?: boolean;
}) {
  const ui = useUiText();
  const { t } = useI18n();
  const pathname = usePathname();
  const match = pathname.match(/\/sites\/([^/]+)/);
  const activeSiteId =
    match?.[1] && sites.some((s) => s.id === match[1]) ? match[1] : undefined;

  const workspaceNav: NavGroup | null = activeSiteId
    ? {
        label: ui("Workspace"),
        items: [
          { href: `/sites/${activeSiteId}`, label: ui("Overview"), icon: LayoutDashboard, exact: true },
          { href: `/sites/${activeSiteId}/keywords`, label: ui("Keywords"), icon: Search },
          { href: `/sites/${activeSiteId}/saved-keywords`, label: ui("Saved keywords"), icon: Bookmark },
          { href: `/sites/${activeSiteId}/pages`, label: ui("Pages"), icon: FileText },
          { href: `/sites/${activeSiteId}/crawl`, label: ui("Crawl / Audit"), icon: Bug },
          { href: `/sites/${activeSiteId}/vitals`, label: ui("Vitals"), icon: Gauge },
          { href: `/sites/${activeSiteId}/ai-access`, label: t("AI crawler access", "AI 爬虫访问"), icon: ScanSearch },
          { href: `/sites/${activeSiteId}/geo`, label: t("GEO monitoring", "GEO 监测"), icon: Activity },
          { href: `/sites/${activeSiteId}/opportunities`, label: ui("Opportunities"), icon: Lightbulb },
          { href: `/sites/${activeSiteId}/content`, label: ui("Content planning"), icon: Layers3 },
          { href: `/sites/${activeSiteId}/assistant`, label: t("Codex workbench", "Codex 工作台"), icon: Bot },
          { href: `/sites/${activeSiteId}/alerts`, label: ui("Alerts"), icon: Bell },
        ],
      }
    : null;

  const researchNav: NavGroup | null = activeSiteId
    ? {
        label: ui("Research"),
        items: [
          { href: `/sites/${activeSiteId}/keyword-research`, label: ui("Keyword research"), icon: SearchCheck },
          { href: `/sites/${activeSiteId}/domain-overview`, label: ui("Domain overview"), icon: Globe },
          { href: `/sites/${activeSiteId}/backlinks`, label: ui("Backlinks"), icon: LinkIcon },
        ],
      }
    : null;

  const connectNav: NavGroup | null = activeSiteId
    ? {
        label: ui("Connect"),
        items: [
          { href: `/sites/${activeSiteId}/mcp`, label: ui("AI & MCP"), icon: Bot },
          { href: `/sites/${activeSiteId}/settings`, label: ui("Site settings"), icon: Settings },
        ],
      }
    : null;

  // The home (All sites, or any page outside a site) has no site groups: the
  // workspace switcher above is the way into a site.
  const groups = [workspaceNav, researchNav, connectNav].filter(
    (g): g is NavGroup => g !== null
  );

  if (groups.length === 0) return null;

  return (
    <nav aria-label={ui("Main")} className={cn("flex flex-col gap-6", collapsed && "items-center")}>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          {!collapsed && (
            <p className="px-3 pb-2 font-data text-[10px] font-medium leading-4 tracking-[0.14em] text-text-soft uppercase">
              {ui(group.label)}
            </p>
          )}
          {group.items.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              pathname={pathname}
              collapsed={collapsed}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function SidebarLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const ui = useUiText();
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const Icon = item.icon;

  // The same violet selection treatment works in the expanded and compact sidebar.
  if (collapsed) {
    return (
      <Link
        href={item.href}
        title={ui(item.label)}
        aria-label={ui(item.label)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex size-10 items-center justify-center rounded-lg border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active
            ? "border-primary/35 bg-primary/15 text-primary"
            : "text-muted-foreground hover:border-border hover:bg-bg-section hover:text-text-strong"
        )}
      >
        <Icon className="size-4" aria-hidden />
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-[38px] items-center gap-2.5 rounded-lg border border-transparent px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "border-primary/35 bg-primary/15 font-medium text-text-strong shadow-[inset_3px_0_0_var(--primary)]"
          : "text-muted-foreground hover:border-border hover:bg-bg-section hover:text-text-strong"
      )}
    >
      <Icon className={cn("size-4 shrink-0 transition-colors", active ? "text-primary" : "text-text-soft group-hover:text-text")} aria-hidden />
      <span className="truncate">{ui(item.label)}</span>
    </Link>
  );
}
