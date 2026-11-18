import Link from "next/link";
import { Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { ActionScope } from "@/lib/ai-workbench/action-scope";
import type { Translator } from "@/lib/i18n/shared";

const labels: Record<ActionScope, [string, string]> = {
  weekly: ["Generate this week’s action list", "生成本周行动清单"],
  bing: ["Analyze Bing performance with ChatGPT", "用 ChatGPT 分析 Bing 表现"],
  audit: ["Review crawl issues with ChatGPT", "用 ChatGPT 分析审计问题"],
  performance: ["Analyze page performance with ChatGPT", "用 ChatGPT 分析网页性能"],
  geo: ["Analyze GEO evidence with ChatGPT", "用 ChatGPT 分析 GEO 数据"],
  alerts: ["Review alerts with ChatGPT", "用 ChatGPT 分析告警"],
};

export function ReportAnalysisLink({ siteId, scope, t }: { siteId: string; scope: ActionScope; t: Translator }) {
  return (
    <Link
      href={`/sites/${encodeURIComponent(siteId)}/assistant?actionScope=${scope}`}
      prefetch={false}
      className={buttonVariants({ variant: "outline" })}
      title={t("Preview saved data in the workbench before generating.", "先在工作台预览已保存的数据，再决定是否生成。")}
    >
      <Sparkles aria-hidden="true" />
      {t(...labels[scope])}
    </Link>
  );
}
