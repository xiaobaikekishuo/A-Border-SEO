import type { Translator } from "@/lib/i18n/shared";

/*
 * The GEO routes answer in English; this shows the messages a person can act
 * on in the selected language. Anything else (an upstream message, a field
 * error) is kept as it is.
 */

const EXACT: Record<string, [string, string]> = {
  "Unauthorized": ["Sign in again.", "请重新登录。"],
  "Unknown site": ["This site was not found.", "找不到这个网站。"],
  "Unknown prompt": ["This prompt was not found. Reload the page.", "找不到这个提示词，请刷新页面。"],
  "Unknown answer": ["This answer was not found. Reload the page.", "找不到这条回答，请刷新页面。"],
  "Unknown platform": ["Unknown platform.", "未知平台。"],
  "Unknown report": ["Unknown report.", "未知报表。"],
  "Paste the answer text": ["Paste the answer text.", "请粘贴回答内容。"],
  "Each brand needs its own name": ["Give each brand its own name.", "每个品牌需要不同的名称。"],
  "Save the tracking settings first": ["Save the tracking settings first.", "请先保存跟踪设置。"],
  "Choose at least one platform to ask": ["Choose at least one platform to ask.", "请至少选择一个要查询的平台。"],
  "Add at least one active prompt": ["Add at least one active prompt.", "请至少启用一个提示词。"],
  "Add your DataForSEO login in Settings first": ["Add your DataForSEO login in Settings first.", "请先在“设置”中添加 DataForSEO 登录信息。"],
  "Paid research requires confirmation": ["The number of tasks changed. Reload and confirm again.", "任务数已变化，请刷新后重新确认。"],
  "Research market changed. Reload and confirm again.": ["The research market changed. Reload and confirm again.", "调研市场已更改，请刷新后重新确认。"],
  "An access check is already running for this site": ["An access check is already running for this site.", "这个网站的访问检查正在进行。"],
  "Too many access checks. Wait a minute and retry.": ["Too many access checks. Wait a minute and retry.", "访问检查太频繁，请一分钟后再试。"],
  "Report pages must belong to this site": ["The report lists pages of another site. Export it for this site.", "报表中有其他网站的页面，请导出本网站的报表。"],
  "Report days must be unique and in order": ["The report repeats a day.", "报表中有重复的日期。"],
  "The report has no rows": ["The report has no rows.", "报表没有数据行。"],
  "The saved report changed. Reload before saving.": ["The saved report changed. Reload before saving.", "已保存的报表有变化，请刷新后再保存。"],
  "Cross-origin mutations are not allowed": ["The request came from another site and was refused.", "请求来自其他网站，已拒绝。"],
  "This record conflicts with an existing or changed record. Reload and try again.": ["The data changed meanwhile. Reload and try again.", "数据已变化，请刷新后重试。"],
  "The GEO request failed": ["The request failed. See the server log for details.", "请求失败，详情见服务器日志。"],
};

const PREFIX: [RegExp, (rest: string, t: Translator) => string][] = [
  [/^Not a domain: (.*)$/, (rest, t) => t("Not a domain: {value}", "不是有效的域名：{value}", { value: rest })],
  [/^Not trackable through DataForSEO: (.*)$/, (rest, t) => t("These platforms cannot be asked through DataForSEO: {value}", "这些平台不能通过 DataForSEO 查询：{value}", { value: rest })],
  [/^Up to (\d+) prompts can be active$/, (n, t) => t("Up to {n} prompts can be active.", "最多可以启用 {n} 个提示词。", { n })],
  [/^A site can keep up to (\d+) prompts$/, (n, t) => t("A site can keep up to {n} prompts.", "每个网站最多保存 {n} 个提示词。", { n })],
];

export function geoErrorMessage(message: string, t: Translator): string {
  const exact = EXACT[message];
  if (exact) return t(exact[0], exact[1]);
  for (const [pattern, render] of PREFIX) {
    const match = pattern.exec(message);
    if (match) return render(match[1], t);
  }
  return message;
}
