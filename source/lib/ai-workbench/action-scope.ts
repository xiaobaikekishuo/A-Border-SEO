import type { Translator } from "@/lib/i18n/shared";

export const actionScopes = ["weekly", "bing", "audit", "performance", "geo", "alerts", "rankings"] as const;
export type ActionScope = (typeof actionScopes)[number];

export function parseActionScope(value: unknown): ActionScope | undefined {
  return actionScopes.find(scope => scope === value);
}

export type ReportEvidence = {
  scope: ActionScope;
  site: { id: string; domain: string };
  hasData: boolean;
  truncated?: boolean;
  period: { start: string; end: string; previousStart: string; previousEnd: string };
  sections: { source: string; rows: Record<string, string | number | boolean | null>[] }[];
};

export type ReportSource = { ref: string; source: string; url: string | null };

export function reportSources(report: ReportEvidence): ReportSource[] {
  return report.sections.flatMap(section => section.rows.map((row, index) => ({
    ref: `${section.source}:${index + 1}`, source: section.source, url: typeof row.url === "string" ? row.url : null,
  })));
}

export function reportTitle(scope: ActionScope, t: Translator) {
  switch (scope) {
    case "weekly": return t("Weekly action list", "本周行动清单");
    case "bing": return t("Bing performance analysis", "Bing 搜索表现分析");
    case "audit": return t("Crawl audit priorities", "抓取审计修复清单");
    case "performance": return t("Page performance priorities", "网页性能修复清单");
    case "geo": return t("GEO evidence review", "GEO 监测分析");
    case "alerts": return t("Alert follow-up", "提醒处理清单");
    case "rankings": return t("Ranking change review", "排名变化复盘");
  }
}
