"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, pending, t } = useI18n();
  return (
    <div role="group" aria-label={t("Interface language", "界面语言")}
      className={`flex ${compact ? "flex-col" : "flex-row"} items-center gap-1 rounded-xl border border-sidebar-border bg-bg-section p-1 text-xs`}>
      {!compact && <Languages aria-hidden className="mx-1 size-4 shrink-0 text-text-soft" />}
      {(["zh", "en"] as const).map((choice) => (
        <button key={choice} type="button" lang={choice === "zh" ? "zh-CN" : "en"}
          aria-pressed={locale === choice} disabled={pending}
          onClick={() => setLocale(choice)}
          className={`min-h-8 min-w-8 rounded-lg px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60 ${locale === choice ? "bg-primary text-primary-foreground" : "text-text-soft hover:bg-bg-soft hover:text-text-strong"}`}>
          {choice === "zh" ? "中文" : compact ? "EN" : "English"}
        </button>
      ))}
    </div>
  );
}
