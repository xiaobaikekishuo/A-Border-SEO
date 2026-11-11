"use client";

import { useI18n } from "@/lib/i18n/client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@base-ui/react/dialog";
import { AddSiteModal } from "@/components/sites/add-site-modal";
import {
  Globe,
  Link2,
  RefreshCw,
  Bug,
  Check,
  ChevronRight,
  X,
} from "lucide-react";

type Step = {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  done: boolean;
  href: string;
  actionLabel: string;
};

interface OnboardingChecklistProps {
  hasSites: boolean;
  hasGscConnected: boolean;
  hasSyncedData: boolean;
  hasCrawled: boolean;
  firstSiteId?: string;
}

export function OnboardingChecklist({
  hasSites,
  hasGscConnected,
  hasSyncedData,
  hasCrawled,
  firstSiteId,
}: OnboardingChecklistProps) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  // With no site yet, t("Add site", "添加站点") opens the add-site dialog here instead of linking away.
  const [addSite] = useState(() => Dialog.createHandle());

  const allDone = hasSites && hasGscConnected && hasSyncedData && hasCrawled;
  if (allDone || dismissed) return null;

  const steps: Step[] = [
    {
      id: "add-site",
      label: t("Add a site", "添加站点"),
      description: t("Connect a Google Search Console property to monitor", "连接需要监测的 Google Search Console 资源"),
      icon: <Globe className="size-4" />,
      done: hasSites,
      href: "/sites",
      actionLabel: t("Add site", "添加站点"),
    },
    {
      id: "connect-gsc",
      label: t("Connect GSC", "连接 GSC"),
      description: t("Link your Google Search Console for keyword and page data", "连接 Google Search Console，获取关键词和页面数据"),
      icon: <Link2 className="size-4" />,
      done: hasGscConnected,
      href: firstSiteId ? `/sites/${firstSiteId}` : "/sites",
      actionLabel: t("Connect", "连接"),
    },
    {
      id: "first-sync",
      label: t("Sync GSC data", "同步 GSC 数据"),
      description: t("Pull the last 28 days of search performance data", "获取最近 28 天的搜索表现数据"),
      icon: <RefreshCw className="size-4" />,
      done: hasSyncedData,
      href: firstSiteId ? `/sites/${firstSiteId}` : "/sites",
      actionLabel: t("Sync now", "立即同步"),
    },
    {
      id: "first-crawl",
      label: t("Run first crawl", "运行首次抓取"),
      description: t("Audit your site for technical SEO issues", "检查站点的技术 SEO 问题"),
      icon: <Bug className="size-4" />,
      done: hasCrawled,
      href: firstSiteId ? `/sites/${firstSiteId}/crawl` : "/sites",
      actionLabel: t("Start crawl", "开始抓取"),
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  return (
    <div className="panel relative mb-6 overflow-hidden">

      <div className="flex items-start justify-between px-5 pt-5">
        <div>
          <h2 className="text-[15px] leading-5 font-semibold">
            {t("Get started", "开始使用")}</h2>
          <p className="mono-label mt-1 text-[11px] text-muted-foreground">
            {t("{done}/{total} steps completed", "已完成 {done}/{total} 步", {done: completedCount, total: steps.length})}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-section hover:text-text-strong"
          aria-label={t("Dismiss", "关闭")}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mx-5 mt-3 h-0.5 overflow-hidden bg-bg-section">
        <div
          className="h-full bg-brand-500 transition-all duration-300"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      <div className="divide-y divide-border-soft px-2 pb-2 pt-4">
        {steps.map((step) => (
          <div
            key={step.id}
            className={cn(
              "flex items-center gap-4 rounded-md px-3 py-3 transition-colors",
              !step.done && "hover:bg-bg-soft"
            )}
          >
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md border",
                step.done
                  ? "border-success/30 bg-success-bg text-success"
                  : "border-border bg-bg-soft text-text-strong"
              )}
            >
              {step.done ? <Check className="size-4" /> : step.icon}
            </div>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[14px] font-medium",
                  step.done
                    ? "text-muted-foreground line-through"
                    : "text-text-strong"
                )}
              >
                {step.label}
              </p>
              <p className="text-[13px] leading-5 text-muted-foreground">{step.description}</p>
            </div>

            {!step.done && step.id === "add-site" ? (
              <button
                type="button"
                onClick={() => addSite.open(null)}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {step.actionLabel}
                <ChevronRight className="size-3" aria-hidden />
              </button>
            ) : (
              !step.done && (
                <Link
                  href={step.href}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {step.actionLabel}
                  <ChevronRight className="size-3" aria-hidden />
                </Link>
              )
            )}
          </div>
        ))}
      </div>
      {!hasSites && <AddSiteModal handle={addSite} />}
    </div>
  );
}
