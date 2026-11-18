"use client";

import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

export function PageLoading() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-[22px]">
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 text-primary motion-safe:animate-spin" aria-hidden />
        {t("Loading page…", "正在加载页面…")}
      </div>
      <div aria-busy="true" aria-label={t("Page content", "页面内容")}>
        <div aria-hidden="true" className="flex flex-col gap-[22px] motion-safe:animate-pulse">
          <div className="panel flex min-h-[136px] flex-col justify-center gap-3 p-6">
            <div className="h-7 w-36 rounded bg-bg-section" />
            <div className="h-4 w-60 max-w-full rounded bg-bg-section" />
          </div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="panel flex h-[116px] flex-col justify-center gap-3 px-5">
                <div className="h-3 w-20 rounded bg-bg-section" />
                <div className="h-7 w-28 rounded bg-bg-section" />
              </div>
            ))}
          </div>
          <div className="panel h-[262px]" />
        </div>
      </div>
    </div>
  );
}
