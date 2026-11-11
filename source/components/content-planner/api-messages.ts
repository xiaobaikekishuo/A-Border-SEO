import type { Translator } from "@/lib/i18n/shared";

// Translate only exact, application-owned errors. External errors and user data
// remain intact; this does not change the API response or persisted records.
const MESSAGES: Record<string, string> = {
  "Funnel counts must add up to the requested topic count": "三个读者阶段的数量之和必须等于本次建议数量。",
  "Generated topics do not match this task's funnel distribution": "生成结果未符合本任务的读者阶段分配，未自动导入。请检查数量后再手动重试。",
  "Invalid saved funnel distribution": "已保存的读者阶段分配无效，请重新设置后创建任务。",
  "Create a pillar before reviewing articles": "请先创建至少一个主题支柱，再复核旧文章。",
  "Selected articles are no longer in the latest crawl. Reload the inventory.": "所选文章已不在最近抓取中，请重新读取库存。",
  "Selected article is not an eligible site page": "所选文章不是当前站点的可用页面。",
  "Article body is missing. Paste at least 100 characters or run a new crawl.": "缺少文章正文。请粘贴至少 100 字符正文，或重新抓取。",
  "An article was edited after this review started. Generate a new review to preserve your changes.": "文章在生成后已有手动修改，本次未覆盖。请重新生成复核。",
  "This article was imported after the review started. Generate a new review.": "该文章在生成后已被导入，请重新复核。",
  "A topic with this keyword already exists in the selected pillar": "目标支柱中已有相同关键词，本次未修改。",
  "Accept an article review before recording a website update": "请先采纳一份旧文复核，再记录网站更新。",

  "Unauthorized": "登录已失效，请重新登录。",
  "Not found": "未找到当前站点。",
  "Pillar not found": "未找到总览主题，请重新读取规划。",
  "Topic not found": "未找到选题，请重新读取规划。",
  "Target pillar not found": "未找到目标主题，请重新选择。",
  "No completed crawl is available for this site": "当前站点还没有已完成的抓取，请先完成抓取。",
  "Some selected pages are no longer available in this site's latest completed crawl. Reload the page inventory.": "部分已选页面不在当前站点最新的已完成抓取中，请重新读取库存。",
  "Some selected pages are not eligible same-origin HTML pages": "部分已选页面不符合本站 HTML 页面条件，不能导入。",
  "Some selected topics were not found in this site": "当前站点中未找到部分已选选题，请重新读取规划。",
  "The target pillar already has one of these keywords. No topics were changed.": "目标主题中已有相同关键词，整批未修改。请调整主题或关键词后重试。",
  "The selected topics changed during this update. Reload and try again.": "所选选题在更新期间发生变化，请重新读取后重试。",
  "This pillar has an active generation job": "此主题还有正在处理的生成任务，请等待完成。",
  "A content plan is already queued or running for this site": "当前站点已有排队或运行中的规划任务，请等待完成。",
  "Plan not found": "未找到这份规划，请重新读取。",
  "The plan is not ready to apply": "这份规划尚未就绪，暂时不能采纳。",
  "Selected topic index is out of range": "所选选题超出方案范围，请重新读取后选择。",
  "This example is available only for ssad.shop": "此演示示例仅适用于 ssad.shop。",
  "Invalid request origin": "请求来源无效，请从本机页面重新操作。",
  "Cross-origin mutations are not allowed": "不能从其他来源修改本地规划，请从本机页面操作。",
  "Content-Type must be application/json": "请求格式不正确，请刷新后重试。",
  "Request body too large": "提交内容过大，请减少内容或分批处理。",
  "A JSON body is required": "请求缺少内容，请刷新后重试。",
  "Invalid JSON body": "请求内容格式无效，请刷新后重试。",
  "This record conflicts with an existing or changed record. Reload and try again.": "记录与已有或刚更新的记录冲突，请重新读取后重试。",
  "Content planner operation failed": "内容规划操作失败，请重试。",
  "Invalid URL": "URL 格式无效，请检查后重试。",
  "URLs must belong to this site's origin": "URL 必须属于当前站点，请检查协议和域名。",
  "The local generation job timed out. No topics were imported. Start a new plan when the worker is online.": "本机生成任务超时，未导入任何选题。请在服务在线后重新开始规划。",
  "Unable to prepare generation context": "未能准备生成所需的数据，请检查本机服务后重试。",
};

export function plannerApiError(message: string, t: Translator): string {
  return Object.hasOwn(MESSAGES, message) ? t(message, MESSAGES[message]) : message;
}
