import type { Locale } from "./shared";
import { REMEDIATION } from "@/lib/crawler/remediation";

// Translate only known application messages. User content, URLs and unknown
// upstream errors are kept verbatim. Nothing here changes stored findings.
const issueLabels: Record<string, string> = {
  BROKEN_LINK: "失效链接", MANAGED_INFRA: "托管基础设施端点", REDIRECT: "重定向",
  MISSING_TITLE: "缺少标题", MISSING_DESCRIPTION: "缺少描述", DUPLICATE_TITLE: "重复标题",
  DUPLICATE_DESCRIPTION: "重复描述", MISSING_H1: "缺少 H1", MULTIPLE_H1: "多个 H1",
  MISSING_ALT: "图片缺少替代文本", MISSING_CANONICAL: "缺少规范网址", MISSING_ROBOTS: "缺少 robots.txt",
  MISSING_SITEMAP: "站点地图缺失或不完整", SITEMAP_BLOCKED: "站点地图被阻止", MISSING_SCHEMA: "缺少结构化数据",
  SLOW_PAGE: "页面响应缓慢", MIXED_CONTENT: "混合内容", LARGE_PAGE: "HTML 体积过大",
  ORPHAN_CANDIDATE: "疑似孤立页", SITEMAP_COVERAGE: "站点地图覆盖",
};
const fixes: Record<string, string> = {
  BROKEN_LINK: "更新或移除失效链接。如果目标页面已移动，请改为新的网址。为已停用页面设置 301 重定向。",
  MANAGED_INFRA: "此网址属于 CDN 或托管服务商（如 Cloudflare /cdn-cgi/），由服务商自动管理，直接访问返回非 200 状态属于预期情况，无需操作。",
  REDIRECT: "将内部链接直接指向最终目标网址。确保每次重定向一步到达，避免重定向链。",
  MISSING_TITLE: "添加独立的 <title> 标签，准确描述页面内容并包含主要目标关键词。当前提示建议长度为 15 至 65 个字符。",
  MISSING_DESCRIPTION: "添加 <meta name=\"description\"> 标签，总结页面内容并吸引搜索用户点击。当前提示建议长度为 50 至 160 个字符。",
  DUPLICATE_TITLE: "为每个页面编写独立标题。如果内容相似，可考虑通过 canonical 标签归并，或合并为一个权威页面。",
  DUPLICATE_DESCRIPTION: "为每个页面编写独立的元描述，避免模板为多个页面生成相同描述。",
  MISSING_H1: "添加一个准确描述主要主题的 H1 标题，置于主要内容前，并自然地包含相关关键词。",
  MULTIPLE_H1: "保留一个 H1，将其他 H1 改为 H2 或 H3，建立清晰的标题层级。",
  MISSING_ALT: "为所有 <img> 添加简洁、准确描述图片内容的 alt 属性。装饰性图片使用空的 alt=\"\" 属性。",
  MISSING_CANONICAL: "在 <head> 中添加 <link rel=\"canonical\" href=\"...\">，指向此页面的首选网址，减少网址变体造成的重复内容问题。",
  MISSING_ROBOTS: "在站点根目录创建 robots.txt，至少声明 User-agent 和 Sitemap。用 Disallow 限制管理后台或重复页面的抓取。",
  MISSING_SITEMAP: "创建列出可索引页面的 XML 站点地图，提交到 Google Search Console，并核查可抓取页面的覆盖。",
  SITEMAP_BLOCKED: "在 robots.txt 中允许站点地图网址，移除或缩小匹配它或重定向目标的 Disallow 规则。如果 robots.txt 本身无法读取（429、5xx 或超时），请先处理，再向 Google Search Console 提交站点地图。",
  MISSING_SCHEMA: "根据页面类型添加适用的 JSON-LD 结构化数据（如 Article、Product、FAQPage），部署前用 Google 富媒体搜索结果测试验证。",
  SLOW_PAGE: "通过缓存、数据库查询优化和 CDN 降低服务器响应时间。当前提示建议响应时间低于 200 毫秒，总加载时间低于 3 秒。",
  MIXED_CONTENT: "将图片、脚本和样式等资源网址改为 HTTPS。使用协议相对网址，或通过 Content-Security-Policy 响应头强制使用 HTTPS。",
  LARGE_PAGE: "移除内联 CSS/JS、延迟非关键资源、懒加载图片并压缩 HTML，减小页面体积。当前提示建议每页小于 3 MB。",
};

export function localizedIssueType(type: string, locale: Locale): string {
  return locale === "zh" ? (issueLabels[type] ?? type.replace(/_/g, " ")) : type.replace(/_/g, " ");
}

export function localizedRemediation(type: string, text: string, locale: Locale): string {
  if (locale !== "zh") return text;
  // A stored issue can use another remediation (e.g. sitemap blocked). Match
  // the exact original text rather than substituting by issue type alone.
  const matched = REMEDIATION[type]?.howToFix === text
    ? type
    : Object.keys(REMEDIATION).find((key) => REMEDIATION[key].howToFix === text);
  return matched ? (fixes[matched] ?? text) : text;
}

const observations: Record<string, string> = {
  "Missing <title> tag": "缺少 <title> 标签",
  "Missing meta description": "缺少元描述",
  "No H1 heading found": "未找到 H1 标题",
  "No canonical tag": "缺少 canonical 标签",
  "No structured data (JSON-LD / microdata)": "缺少结构化数据（JSON-LD / 微数据）",
  "Page loads insecure HTTP resources": "页面加载了不安全的 HTTP 资源",
  "Sitemap blocked by robots.txt": "站点地图被 robots.txt 阻止",
  "Sitemap not fetched, robots.txt skipped its host": "未获取站点地图，robots.txt 检查导致跳过其主机",
  "No sitemap.xml found": "未找到 sitemap.xml",
  "Fetch failed": "抓取失败",
  "Crawled page not listed in sitemap": "已抓取页面未列入站点地图",
  "Potential orphan page (no internal inlinks found)": "疑似孤立页（未发现指向它的内部链接）",
  "Potential orphan in a limited crawl; inbound links outside the sample are unverified. Not deducted from health.": "有限抓取样本中的疑似孤立页，样本之外的入链尚未核实，不扣除健康分。",
  "Identical content is already consolidated to a verified canonical page; original duplicate finding retained.": "相同内容已归并到经验证的规范页面，原始重复记录已保留。",
  "Identical canonical alias need not be listed separately in the sitemap; target coverage is evaluated separately.": "内容相同的规范网址别名无需单独列入站点地图，目标页面覆盖另行评估。",
  "A public HTML inbound link was verified during review; original sampled-crawl observation retained.": "复核时已验证公开 HTML 入链，原始样本抓取记录已保留。",
  "robots.txt redirects more than 5 times, treated as missing": "robots.txt 重定向超过 5 次，按缺失处理",
};

const patterns: [RegExp, (...values: string[]) => string][] = [
  [/^(\d+) of (\d+) pages are noindex\. If that is not intended, search engines will drop them\.$/, (noindex, total) => `${total} 个页面中有 ${noindex} 个设置了 noindex。如果并非有意设置，搜索引擎会将它们移出索引。`],
  [/^Stopped at the (\d+)-minute crawl limit$/, (minutes) => `已达到 ${minutes} 分钟抓取时限，抓取已停止`],
  [/^Crawl-delay (.*?)\: stopped early after (\d+) requests?, the rest does not fit in the (\d+)-minute crawl limit$/, (delay, requests, minutes) => `Crawl-delay ${delay}：已发送 ${requests} 个请求后提前停止，剩余请求无法在 ${minutes} 分钟抓取时限内完成`],
  [/^(\d+) H1 headings found$/, (n) => `发现 ${n} 个 H1 标题`],
  [/^(\d+)\/(\d+) images missing alt$/, (missing, total) => `${total} 张图片中有 ${missing} 张缺少 alt`],
  [/^Slow response: ([\d.]+)ms$/, (ms) => `响应缓慢：${ms} 毫秒`],
  [/^Large HTML payload: ([\d.]+)MB$/, (mb) => `HTML 体积过大：${mb} MB`],
  [/^Duplicate title shared by (\d+) pages$/, (n) => `${n} 个页面共用相同标题`],
  [/^Duplicate meta description on (\d+) pages$/, (n) => `${n} 个页面的元描述重复`],
  [/^Managed infra endpoint \((.*?)\), expected, not a broken link$/, (provider) => `托管基础设施端点（${provider}），属于预期情况，并非失效链接`],
  [/^robots\.txt not found(.*)$/, (suffix) => `未找到 robots.txt${suffix}`],
  [/^robots\.txt unreachable \((.*?)\), host skipped$/, (reason) => `无法访问 robots.txt（${reason}），已跳过主机`],
  [/^Crawl-delay (.*?) is longer than we support, host skipped$/, (delay) => `Crawl-delay ${delay} 超出支持范围，已跳过主机`],
  [/^Crawl-delay (.*?) honoured, one request at a time$/, (delay) => `遵循 Crawl-delay ${delay}，每次发送一个请求`],
  [/^(\d+) reviewed false positives excluded; (\d+) findings? unverified and not deducted from health\. Original observations are retained\.$/, (excluded, pending) => `已排除 ${excluded} 条经复核的误报；${pending} 条尚未核实，不扣除健康分。原始观察记录已保留。`],
  [/^Position ([\d.]+) · ([\d,]+) impressions · push into top 3$/, (position, impressions) => `排名 ${position} · ${impressions} 次曝光 · 可争取进入前三`],
  [/^CTR ([\d.]+)% vs ~([\d.]+)% expected at pos ([\d.]+): rewrite title\/meta$/, (ctr, expected, position) => `点击率 ${ctr}%，排名 ${position} 的预期值约为 ${expected}%；建议优化标题和元描述`],
  [/^Clicks (\d+) → (\d+) \(([-\d.]+)%\) vs prior 28 days$/, (previous, current, change) => `与前 28 天相比，点击量 ${previous} → ${current}（${change}%）`],
  [/^(\d+) landing pages competing · top: (.*)$/, (n, url) => `${n} 个落地页相互竞争 · 主要页面：${url}`],
];

export function localizedObservation(text: string, locale: Locale): string {
  if (locale !== "zh") return text;
  if (observations[text]) return observations[text];
  for (const [pattern, render] of patterns) {
    const match = text.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return text;
}
