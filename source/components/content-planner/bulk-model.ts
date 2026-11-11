import { createTranslator, type Translator } from "@/lib/i18n/shared";
import type { ContentStatus, Funnel } from "./model";

export const BULK_LIMIT = 50;
export type InventoryPage = {
  id: string; url: string; title: string | null; suggestedKeyword: string;
  articleCandidate: boolean; existingClusterId?: string | null; existingPillarTitle?: string | null;
};
export type PageInventory = {
  siteId: string; crawl: { id: string; finishedAt: string | null; pagesFound: number; maxPages: number; sampleLimited: boolean } | null;
  rows: InventoryPage[]; total: number; page: number; pageSize: number;
};
export type ImportDraft = { pageId: string; url: string; title: string; keyword: string; funnel: Funnel };
export type ImportResult = {
  ok: true; imported: number; skipped: number;
  results: { pageId: string; status: "imported" | "skipped"; reason?: string; clusterId?: string }[];
};
export function addLimitedSelection(current: readonly string[], candidates: readonly string[]) {
  const ids = [...new Set(current)];
  let omitted = 0;
  for (const id of new Set(candidates)) {
    if (ids.includes(id)) continue;
    if (ids.length < BULK_LIMIT) ids.push(id); else omitted++;
  }
  return { ids, omitted };
}
export function draftFromPage(page: InventoryPage, funnel: Funnel = "TOFU"): ImportDraft {
  return { pageId: page.id, url: page.url, title: page.title?.trim() ?? "", keyword: page.suggestedKeyword.trim(), funnel };
}
export function importPayload(pillarId: string, drafts: ImportDraft[]) {
  return { action: "importPages", pillarId, items: drafts.map(({ pageId, title, keyword, funnel }) => ({ pageId, title: title.trim(), keyword: keyword.trim(), funnel })) };
}
export function bulkUpdateData(values: { pillarId: string; funnel: string; status: string }): { pillarId?: string; funnel?: Funnel; status?: ContentStatus } {
  return {
    ...(values.pillarId ? { pillarId: values.pillarId } : {}),
    ...(values.funnel ? { funnel: values.funnel as Funnel } : {}),
    ...(values.status ? { status: values.status as ContentStatus } : {}),
  };
}
export function importSkipReason(reason?: string, t: Translator = createTranslator("zh")): string {
  return ({ already_linked: t("This URL is already assigned to an existing topic", "该 URL 已归入已有选题"), keyword_conflict: t("The target pillar already contains this keyword. Edit the keyword and retry", "目标主题内已有相同关键词，请修改关键词后重试"), duplicate_in_request: t("This page was selected more than once in the batch", "本批次重复选择了同一页面") } as Record<string, string>)[reason ?? ""] ?? (reason ? t("Not imported: {v0}", "未导入：{v0}", { v0: reason }) : t("Not imported. Check the page and target pillar", "未导入，请重新检查页面与目标主题"));
}
