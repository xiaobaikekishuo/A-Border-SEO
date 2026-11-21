/*
 * The A-Border SEO skills package: SKILL.md workflows for AI assistants that
 * read this app through its read-only MCP server (Claude, Codex and others
 * that support agent skills). Each skill names the MCP tools it calls; a test
 * checks that every tool named exists. Served as zip files by /api/skills.
 */

export type Skill = {
  /** Folder and skill name: lowercase letters, digits and hyphens. */
  name: string;
  /** Shown in the app. */
  title: { en: string; zh: string };
  /** When an assistant should use the skill: front-loaded with the task and its trigger words. */
  description: string;
  body: string;
};

const CONNECT = `## 前提

- 已在 A-Border SEO 的 **AI 与 MCP** 页面开启 MCP，并把 A-Border SEO 的 MCP 服务器接入当前 AI 客户端。工具全部只读：只读取已有数据，不会触发抓取、同步或付费查询。
- 不知道网站 ID 时，先调用 \`list_sites\`，按用户说的域名选出对应的 \`siteId\`。有多个网站且用户没说时，先问是哪一个。`;

const RULES = `## 通用规则

- 所有数字都来自工具返回的数据，写明数据的日期范围。工具没有的数据就说没有，不要估算或编造。
- Search Console 数据通常有 2 到 3 天延迟，最近几天偏低是正常的，不要当成下滑。
- 样本小（点击少于 20、展示少于 200）的变化只作参考，说明“样本少”。
- 建议要具体到页面、关键词或问题类型，并说明依据来自哪个工具的哪项数据。
- 用用户使用的语言回答；面向不熟悉 SEO 的读者时，第一次出现的术语用一句话解释。`;

export const SKILLS: readonly Skill[] = [
  {
    name: "aborder-weekly-review",
    title: { en: "Weekly SEO review", zh: "每周 SEO 复盘" },
    description: "Weekly SEO review of a site from A-Border SEO data: traffic and ranking changes, likely causes, and the three things to do this week. Use for 周报, 每周复盘, 这周 SEO 怎么样, weekly SEO report or what changed this week.",
    body: `# 每周 SEO 复盘

用 A-Border SEO 的数据，回答三个问题：这周表现怎样、为什么、本周做哪三件事。

${CONNECT}

## 步骤

1. \`get_site_overview(siteId)\`：近 28 天的点击、展示、平均排名及与上一周期的对比，最近一次抓取和网页性能。
2. \`get_traffic(siteId, days: 28)\`：按天的点击和展示，找出明显的拐点（连续 3 天以上的上升或下降）。
3. \`get_keywords(siteId, days: 7, limit: 50)\` 和 \`get_keywords(siteId, startDate, endDate)\`（上一个 7 天）：对比两周的关键词，列出点击变化最大的词。
4. \`get_pages(siteId, days: 7, limit: 30)\`：找出点击变化最大的页面。
5. \`get_rankings(siteId)\`：如果开启了排名追踪，读取实测排名、上升和下降的词，以及排名页面是否换了。没有追踪的词就跳过这一步。
6. \`get_opportunities(siteId)\`：内容衰减、关键词内耗和快速机会。
7. 有 Bing 数据时，\`get_bing_traffic(siteId, days: 28)\` 作补充。

## 判断

- 点击变化超过 ±20% 且样本足够，才算显著变化。
- 平均排名变好但点击下降，先看展示是否下降（需求变化）或点击率是否下降（结果页变化，例如出现 AI 概览）。
- 实测排名下降 5 位以上，或掉出前 10，单独列出，并说明排名页面是否改变。
- 抓取健康分低于 70，或有新的严重问题，放进本周任务。

## 输出

1. **一句话结论**：这周整体是涨、跌还是持平，幅度多少。
2. **关键变化**（最多 5 条）：每条写清对象（页面或关键词）、数字变化和最可能的原因。
3. **本周三件事**：按影响从大到小排序，每件写明要改的页面或关键词、具体动作、依据。
4. **需要留意**：样本少、数据延迟或数据缺失的地方。

${RULES}`,
  },
  {
    name: "aborder-rank-review",
    title: { en: "Rank change review", zh: "排名变化复盘" },
    description: "Explains measured Google ranking changes of tracked keywords from A-Border SEO rank tracking: drops, gains, ranking page switches, AI Overviews and competitors, with fixes. Use for 排名下降, 排名变化, 为什么掉排名, rank drop or rank tracking review.",
    body: `# 排名变化复盘

解释追踪关键词的实测排名为什么变化，并给出处理办法。实测排名来自 A-Border SEO 的排名追踪（通过 DataForSEO 读取目标市场的 Google 结果页）。

${CONNECT}

## 步骤

1. \`get_rankings(siteId)\`：每个追踪词的实测排名、与上次检查相比的变化、排名页面（是否变化）、AI 概览是否出现及是否引用网站，以及 Search Console 近 28 天平均排名。没有追踪词时，告诉用户先在“排名追踪”页面添加，并结束。
2. \`get_keywords(siteId, days: 28, limit: 100)\`：对照这些词在 Search Console 中的点击、展示和平均排名。
3. \`get_pages(siteId, days: 28, limit: 50)\`：查看排名页面的流量变化。
4. \`get_opportunities(siteId)\`：看是否存在关键词内耗（多个页面争同一个词）或内容衰减。
5. \`get_crawl_issues(siteId)\`：检查排名页面是否有严重的技术问题（noindex、重定向、失效链接、加载慢）。

## 判断

- **排名页面换了**：多半是站内多个页面在争同一个词。确定一个主页面，其余页面合并、改写方向或加 canonical，并用内链指向主页面。
- **掉出结果（未进前 N）**：先排除技术原因（noindex、被 robots.txt 阻止、返回错误或重定向），再看内容是否过时、竞品是否更新。
- **小幅波动（3 位以内）**：通常是正常波动，观察下一次检查再定。
- **实测排名好但 Search Console 平均排名差**：Search Console 混合了所有国家和设备，两者口径不同，不算矛盾。
- **出现 AI 概览但没有引用网站**：在排名页面补充直接回答问题的段落、数据和来源，并配合 GEO 复盘。

## 输出

1. **概况**：追踪词数，前 3、前 10 的数量，上升和下降的数量，上次检查时间。
2. **下降的词**（按降幅排序）：每个词写原排名、现排名、排名页面、最可能的原因、建议动作。
3. **上升的词**：简要说明，可以复用的做法。
4. **下一步**：最多 5 条，按优先级排序。

${RULES}`,
  },
  {
    name: "aborder-technical-audit",
    title: { en: "Technical audit priorities", zh: "技术问题排序" },
    description: "Turns A-Border SEO crawl issues and Core Web Vitals into a prioritized technical SEO fix list with the pages affected and how to fix each. Use for 技术 SEO, 抓取问题, 网站体检, 先修什么, site audit or technical fixes.",
    body: `# 技术问题排序

把抓取发现的问题和网页性能数据，整理成按影响排序的修复清单。

${CONNECT}

## 步骤

1. \`list_crawls(siteId, limit: 5)\`：最近几次抓取的时间、页面数和健康分，看趋势。
2. \`get_crawl_issues(siteId, severity: "CRITICAL")\`，再 \`get_crawl_issues(siteId, severity: "WARNING")\`：最近一次完整抓取的问题和受影响网址。
3. 需要对比时，用 \`list_crawls\` 返回的 crawlId 调用 \`get_crawl_issues(siteId, crawlId)\`，找出新出现和已解决的问题。
4. \`get_vitals(siteId, device: "MOBILE")\`：移动端的 LCP、INP、CLS 和真实用户数据。
5. \`get_pages(siteId, days: 28, limit: 50)\`：哪些有问题的页面带来流量，用来决定优先级。

## 排序原则

1. 让页面无法被收录的问题最优先：大范围 noindex、被 robots.txt 阻止、5xx 错误、站点地图失效。
2. 有流量或有排名的页面上的问题，优先于没有流量的页面。
3. 一处修改能修好很多页面的问题（模板、全站设置），优先于逐页修改。
4. 性能问题以移动端真实用户数据为准；实验室数据只用来找原因。

## 输出

一张表：问题 | 影响的页面数（举 2 至 3 个网址）| 为什么重要 | 怎么修 | 预计工作量（小、中、大）。表后写“本周先修”的 3 项，以及修完后怎样在 A-Border SEO 里验证（重新抓取、看健康分和问题数）。

${RULES}`,
  },
  {
    name: "aborder-keyword-opportunities",
    title: { en: "Keyword and content opportunities", zh: "关键词与内容机会" },
    description: "Finds quick-win keywords, pages to refresh and content gaps from A-Border SEO search data, with what to change on which page. Use for 关键词机会, 内容机会, 写什么内容, 哪些词能快速提升, keyword opportunities or content ideas.",
    body: `# 关键词与内容机会

从已有的搜索数据里找最容易带来流量的改动：排在第 4 到 20 位的词、正在衰减的页面、互相争词的页面。

${CONNECT}

## 步骤

1. \`get_opportunities(siteId)\`：快速机会、内容衰减和关键词内耗的汇总。
2. \`get_keywords(siteId, days: 28, limit: 200)\`：找出平均排名 4 到 20、展示多但点击率低的词。
3. \`get_pages(siteId, days: 28, limit: 100)\`：确认这些词对应的页面。
4. \`get_saved_keywords(siteId)\` 和 \`get_rankings(siteId)\`：用户保存或追踪的目标词，以及它们的实测排名。
5. 有 Bing 数据时，\`get_bing_keywords(siteId)\` 补充。

## 判断

- **快速机会**：排名 4 到 20 且展示多的词。优化对应页面的标题、开头段落和小标题，补上用户想要的信息，从相关页面加内链。
- **点击率低**：排名不差但点击率明显偏低，先改标题和描述，让它直接回应搜索意图。
- **内容衰减**：比上一周期点击下降明显的页面，检查内容是否过时、竞品是否更新。
- **关键词内耗**：同一个词有多个页面在拿展示，确定主页面，其余合并或改写方向。
- **新内容**：只在现有页面都无法自然覆盖某个需求时才建议写新页面。

## 输出

1. **快速机会**（最多 10 条）：关键词 | 当前排名 | 展示 | 页面 | 具体改法。
2. **需要更新的页面**（最多 5 条）：页面 | 变化 | 建议。
3. **内耗处理**：每组写主页面和其他页面的处理方式。
4. **新内容建议**（如有）：主题、目标词、理由。

${RULES}`,
  },
  {
    name: "aborder-geo-visibility",
    title: { en: "GEO visibility and citation gaps", zh: "GEO 可见度与引用缺口" },
    description: "Reviews how AI platforms (ChatGPT, Google AI Overviews, Perplexity and others) can reach, mention and cite a site from A-Border SEO GEO data, and where competitors get cited instead. Use for GEO, AI 搜索, AI 引用, 生成式引擎优化, AI visibility or citation gaps.",
    body: `# GEO 可见度与引用缺口

检查各 AI 平台能否访问网站、回答里是否提到和引用网站，以及 AI 引用了哪些只提竞品的第三方来源。

${CONNECT}

## 步骤

1. \`get_ai_visibility(siteId)\`：每个 AI 平台的六层情况：爬虫访问、页面指令、索引、平台报告、提示词跟踪中的提及和引用、AI 带来的访问。
2. \`get_citation_gaps(siteId)\`：AI 回答引用了、但只提到竞品没提到品牌的第三方网站，以及对应的提示词和被引用页面。
3. \`get_rankings(siteId)\`：开启了排名追踪并加载 AI 概览时，看哪些词出现了 AI 概览、是否引用网站。
4. 需要技术细节时，\`get_crawl_issues(siteId)\` 查看 noindex、结构化数据等问题。

## 判断

- **访问层**：robots.txt 阻止了某平台的检索爬虫，或实测访问被拒绝，最先处理，否则其他工作都无效。
- **提及和引用**：提及率低说明品牌在相关话题上的存在感弱；被提及但不被引用，说明缺少可以直接引用的页面（清晰的定义、数据、比较、常见问题）。
- **引用缺口**：被引用次数多、又只提竞品的来源最值得争取。按来源类型给办法：榜单和评测找编辑或提交产品，论坛和问答以真实身份参与并披露关系，目录认领或提交资料，媒体提供数据或观点。不要建议付费植入、虚假评价或冒充用户发帖。
- **样本**：提示词少于 10 个或回答少于 20 个时，结论只作参考。

## 输出

1. **各平台概况**：一张表，平台 | 能否访问 | 提及率 | 引用率 | 主要问题。
2. **最该先修的访问或技术问题**（如有）。
3. **引用缺口 Top 5**：来源 | 类型 | 缺口次数 | 竞品 | 争取办法。需要逐个深入调研时，提示用户可以在 GEO 监测页面用 Manus 拆解这些来源。
4. **内容建议**：为哪些提示词补充或改写哪些页面，让 AI 更容易引用。

${RULES}`,
  },
  {
    name: "aborder-seo-coach",
    title: { en: "SEO coach for beginners", zh: "SEO 入门教练" },
    description: "Explains a site's A-Border SEO data in plain words for someone new to SEO: what the numbers mean, what is good or bad, and one next step at a time. Use for 看不懂, 新手, 这些数据什么意思, 我该从哪里开始, explain my SEO data or SEO basics.",
    body: `# SEO 入门教练

用平实的话解释网站的 SEO 数据，帮新手看懂现状，并且每次只给一到三个下一步。

${CONNECT}

## 步骤

1. \`get_site_overview(siteId)\`：先看整体：点击、展示、平均排名、点击率，最近一次抓取和网页性能。
2. 根据用户的问题，再调用一到两个工具：
   - 问流量：\`get_traffic(siteId, days: 28)\`。
   - 问关键词或排名：\`get_keywords(siteId, days: 28, limit: 20)\`，开启了排名追踪时加 \`get_rankings(siteId)\`。
   - 问网站问题：\`get_crawl_issues(siteId, severity: "CRITICAL")\`。
   - 问 AI 搜索：\`get_ai_visibility(siteId)\`。

## 讲解方式

- 每个指标先说它是什么，再说这个网站的数字，最后说算好还是需要改进。例如：“展示”是网站在搜索结果中出现的次数；“平均排名”是出现时的平均位置，数字越小越靠前。
- 不一次讲完所有内容。先讲最重要的一到两点，结尾问用户想深入哪一部分。
- 给建议时说明为什么、做完怎么在 A-Border SEO 里看效果、大概多久能看到变化（排名变化通常需要几周）。
- 不确定的地方直接说不确定，并说需要什么数据才能判断。

## 输出

1. **现在的情况**：三到五句话。
2. **最该先做的一件事**：做什么、为什么、怎么检查效果。
3. **可以接着了解的问题**：给两三个用户可能想问的方向。

${RULES}`,
  },
];

/** The SKILL.md of a skill: front matter with its name and description, then its instructions. */
export function skillMarkdown(skill: Skill): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
}

export function skillByName(name: string): Skill | undefined {
  return SKILLS.find(skill => skill.name === name);
}
