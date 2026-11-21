<div align="center">

<img src="public/brand/a-border-logo.png" alt="A-Border SEO" height="56" />

### 自托管的 SEO 与 GEO 监测工作台

Search Console 数据、全站抓取审计、网页性能、AI 爬虫访问与 AI 搜索就绪度、内容规划和只读 MCP，部署在你自己的电脑或服务器上。

</div>

---

## 主要功能

| 模块 | 内容 |
|---|---|
| **Search Console 分析** | 关键词、页面、点击、曝光、平均排名和 CTR，最近 28 天与前 28 天对比；已保存关键词与备注；CSV 导出 |
| **排名追踪** | 通过你自己的 DataForSEO 账户读取目标市场的 Google 结果页，记录已追踪关键词的实测名次、排名页面、前 10 名结果和 AI 概览是否引用网站，与 Search Console 平均排名并列；可手动或定期检查，每次有预算上限；掉排名时提醒 |
| **Bing Webmaster** | 使用自己的 Bing API Key，同步流量、查询、页面与抓取统计，并在独立 Bing 报表中查看趋势和明细；通过 IndexNow 把最近一次抓取中新增或变化的页面提交给必应等搜索引擎（Google 不参与 IndexNow） |
| **抓取与审计** | 默认每次最多 2000 页（`CRAWL_MAX_PAGES`），并发抓取；17 类问题与修复建议（含 hreflang、重定向链和混合内容资源），内容评分、结构化数据检查；中日韩文字按字计数，标题和描述按显示宽度判断；健康分按受影响页面占比计分 |
| **网页性能** | 通过 PageSpeed Insights 检查，移动端与桌面端分开：核心网页指标按 Chrome 真实用户数据（CrUX，近 28 天 p75 的 LCP、INP、CLS）判定，页面数据不足时用整站数据；另有实验室性能分、LCP、CLS、TBT、TTFB |
| **AI 爬虫访问** | 按 RFC 9309 逐个判断 19 个与 AI 搜索、模型训练和用户触发访问相关的爬虫能否访问，并读取 robots.txt 中的 Content-Signal 与 Content-Usage 声明 |
| **GEO 监测** | 15 个 AI 平台（ChatGPT、Google AI 概览、AI 模式、Gemini、Perplexity、Copilot、Claude、Grok、Meta AI、DeepSeek，以及手动记录的豆包、腾讯元宝、千问、Kimi、文心一言）的六层情况：爬虫访问实测、页面指令、索引、平台官方 AI 报表、回答中的提及与引用、AI 流量；提示词跟踪（通过你自己的 DataForSEO 账户，可定期运行、设预算，每个提示词可多次提问，带区间、回答标注和引用缺口）；AI 搜索就绪度检查（12 项，另有全站实体检查）、GA4 中的 AI 来源会话、互动会话与关键事件、访问日志中的 AI 爬虫与 AI 引荐（支持 .gz） |
| **优化机会** | 临近首页的关键词、低 CTR、内容衰退、关键词互相竞争 |
| **研究** | 关键词研究、域名概览、外链（DataForSEO，使用你自己的 Key；未配置时用 Google 自动补全建议）；用你自己的 Manus 账户做关键词深度研究、拆解 GEO 引用来源和调研外链机会 |
| **提醒** | 流量下降、排名下降、追踪关键词掉排名、抓取健康度低、大部分页面 noindex、性能变差；可推送到你的 Webhook 和邮箱。开启每周 AI 行动清单后，清单也通过它们发出 |
| **内容规划与 Codex 工作台** | 内容支柱、选题和简报，文章初稿、改写和 SEO 修复建议；由本机 Codex 或 ChatGPT 连接生成，只出草稿，不发布、不改网站。草稿可引用站点“可信来源库”中的网页作出处，库外链接替换为“〔待核实〕”标记并列出供核对（代码示例里的网址保持原样，只列出）；选题简报和旧文复核里不在已核实网址中的内链建议直接删去。两者都不再让整个任务失败。旧文复核附 6 项质量检查：首段直接给答案、一手经验、结论出处、作者和日期、问题式小标题，中文稿另查广告法绝对化用语 |
| **用 ChatGPT 额度做的任务** | 由本机 Codex 用你的 ChatGPT 套餐完成，只出草稿：排名变化复盘；按实际带来流量的搜索词批量改写低点击率页面的标题和描述（新旧对照，可导出 CSV）；按目标市场本地化改写文章并列出 hreflang 对应；按页面上的真实信息生成 JSON-LD；把 Manus 找到的外链机会写成联络邮件草稿（不发送）；搜索词聚类并对应到页面，找出内容缺口和内耗，可放进内容规划；每周一的 AI 行动清单，通过邮件和 Webhook 发出。长度、格式、链接和数字由程序检查，详见[下文](#用-chatgpt-额度做的任务)。1.9.0 起有后台任务池：本机 Codex 空闲时按 5 小时和每周用量，用快过期的额度自动跑这些任务，并可按任务类型分配模型 |
| **MCP 与只读 API** | 16 个只读工具，供 Claude Code、Codex 等 AI 助手读取你的站点数据；附 6 个技能（SKILL.md），按固定流程做周报、排名复盘、技术排查、关键词机会、GEO 复盘和新手讲解 |

界面支持中文和英文。

### 抓取说明

- 抓取器的 User-Agent 默认是 `ABorderSEOBot/1.0 (self-hosted site audit)`，可用 `CRAWLER_USER_AGENT` 修改。
- 按 RFC 9309 遵守 robots.txt：每个主机（含裸域和 www）分别检查；跳转目标先检查再跟随；robots.txt 返回 429、5xx、超时或网络错误时跳过该主机；遵守 Crawl-delay。抓取页会列出被 robots.txt 挡住的内容。
- 标记为 noindex 的页面（`<meta name="robots">`、`<meta name="googlebot">` 或 `X-Robots-Tag` 中的 `noindex`、`none`）照常抓取并跟随链接，但不计入问题、健康分和内容平均分；失效页面无论是否 noindex 都会报告。
- **健康分**：每类问题按其中最严重的级别计权（严重 30、警告 12、提示 3），乘以受影响页面占比的平方根后扣分；占比按参与审计的页面计算，noindex 页面不参与审计，也不计入分母；缺少 robots.txt、站点地图这类整站问题按全站计。少数页面的问题依然可见，大站也不会因为同一类问题出现几百次就直接变成 0 分。旧版本保存的抓取保留原来的分数，并标注“旧算法”。
- 为控制数据库体积，只保留每个站点最近几次抓取（`CRAWL_DETAIL_RETENTION`，默认 3 次）的页面正文、标题结构和结构化数据明细；更早的抓取仍保留标题、状态码、问题、链接和分数。

### AI 爬虫访问与 GEO 说明

- AI 爬虫访问检查只在你点击检查时请求该站点公开的 robots.txt；页面状态和索引指令来自已保存的抓取。robots.txt 里声明的规则不代表爬虫一定遵守，也不代表已被收录或引用。
- 训练用途的通用标记 `__usage_ai-training` 单独判断：`User-agent: *` 不覆盖它，针对具体爬虫的规则优先。
- 结构化数据检查只在本地分析已保存的页面，不下载远程 JSON-LD 上下文，也不执行页面脚本；检查结果不等于 Google 已收录或一定显示富媒体结果。Google 已于 2026 年 5 月停止为所有网站显示 FAQ 富媒体结果，HowTo 结果在 2023 年停止，检查会如实提示。
- GEO 就绪度按 Search Console 曝光优先抽样，最多检查 300 页；只给适用的项目计分（例如问答项只看文章页）。

### 各 AI 平台的 GEO 情况

GEO 监测页按六层列出每个平台，某一层没有数据时显示“无数据”，平台本身没有这一层时显示“不适用”：

1. **访问**：robots.txt 对该平台各爬虫（搜索索引、用户请求、训练分开）的规则，以及“访问检查”的实测结果。访问检查从你的服务器以浏览器和 10 个 AI 爬虫的 User-Agent 各请求一次首页和一个热门页面（约 20 个请求，几个一组，90 秒内结束），识别 Cloudflare、Akamai、Vercel 等的验证页。按 IP 验证爬虫的 CDN 对真实爬虫的处理可能不同，所以这里的“拒绝”是线索，不是定论。不模拟 Googlebot 和 Bingbot：很多防火墙会拦截甚至暂时封禁冒充它们的请求，它们的真实访问情况以 Search Console 和 Bing 网站管理员工具为准。
2. **页面指令**：按平台规则判断最近一次抓取的页面：Google（AI 概览、AI 模式、Gemini）看 noindex、nosnippet、max-snippet 和 data-nosnippet；Copilot 看 noindex、noarchive、nocache 和 ai-grounding；其他平台没有公开说明，noindex 只作提示。本版本起抓取会记录 googlebot、bingbot 专用的 meta 标签和 data-nosnippet，旧抓取会标注“未完整检查”。
3. **索引**：Google 平台看近 28 天在 Search Console 有展示的页面数，Copilot 和 ChatGPT 看 Bing 索引页数。
4. **平台 AI 报表**：导入 Search Console“生成式 AI”报告（AI 概览与 AI 模式的展示，下载的 zip 可直接选）和 Bing 网站管理员工具“AI 表现”（Copilot 引用次数、被引用页面和依据查询）。文件在浏览器里读取，只保存报表数据行；这两个报告都没有 API。
5. **回答**：提示词跟踪的结果，见下文。
6. **流量**：GA4 中各平台带来的会话，访问日志中各平台爬虫的请求数。

### 提示词跟踪

- 写下客户会问的问题（每个站点最多启用 50 个），选择要查询的平台，设置品牌名、别名、域名和竞品。ChatGPT、Gemini、Google AI 概览、AI 模式、Perplexity 和 Claude 通过你自己的 DataForSEO 账户查询，按任务计费（2026 年 11 月价格：ChatGPT、Gemini、AI 概览、AI 模式约 $0.004/个，Perplexity 和 Claude 另加模型费用，界面按约 $0.01 和 $0.04 预估）；Copilot、Grok、Meta AI、DeepSeek，以及豆包、腾讯元宝、千问、Kimi 和文心一言没有可用接口，在其应用中提问后把回答和来源链接手动记下。
- 每次运行前会显示任务数和预估费用，需要确认；运行在超过“单次预算”前停止，DataForSEO 拒绝登录或余额不足时整次停止。每个回答到达即保存，重启后继续同一次运行。
- 第一次使用建议先点 **试运行**：只向每个已选平台提出第一个启用的提示词（每个平台一个付费任务），核对回答、品牌识别和实际花费后再完整运行。试运行在运行记录里单独标出，不会推迟定期运行。同一站点同时只进行一个运行或试运行。
- 可设置每 7、14 或 30 天定期运行（默认只手动运行）。定期运行需要开启定时任务（`SCHEDULER_ENABLED=true`，Windows 套件默认关闭），`SCHEDULE_GEO_TRACKING=false` 对整个服务器关闭定期运行。查询使用站点的调研市场（语言和地区）；Claude 使用能联网搜索的最新 Haiku 模型。
- 提及率、引用率和声量份额按每个提示词在每个平台最近 90 天内的最新回答（失败的查询不会盖住之前的回答），用当前的品牌设置计算；运行记录里的各平台结果按运行结束时的设置保存。
- AI 回答每次都可能不同。设置里可让每个提示词在一次运行中提问 1 至 5 次（任务数和费用按次数相乘，试运行仍只问一次），同一次运行的各个回答一起计入。比率旁显示 95% 区间，区间按提示词数计算；不到 30 个提示词时标为样本较小。两次运行之间的变化会标出是否超出随机波动。
- 每个回答可以标注准确度（准确、部分准确、不准确）和情感（正面、中性、负面）。设置里的品牌事实卡（最多 20 条，例如成立年份、总部、价格）会逐条给出初步对照：回答写出了这个值、只提到这件事，或都没有出现。是否准确由你判断。
- **引用缺口**：回答点名或引用了竞品、却没有提到你的品牌时所引用的第三方网站（评测、论坛、百科、媒体等），按这类回答的数量排列。这些通常是值得争取报道或收录的来源。

### 排名追踪

- 在左侧 **排名追踪** 页面把已保存关键词设为追踪（每个站点最多 200 个），或直接输入新词。含 `site:`、`intitle:` 等搜索指令的词只保存、不追踪：DataForSEO 对它们按五倍计费，结果也不代表排名。
- 每次检查把追踪词提交到 DataForSEO 的标准队列（Google 自然结果，使用站点的调研市场），按读取的结果页计费：每 10 个结果一页 $0.0006（2026 年 11 月价格），读取前 30 名最多三页，即每个词最多 $0.0018；勾选 AI 概览每个词另加 $0.0006。100 个词每天检查一次前 30 名，一个月约 $5.4。Google 返回的结果较少时实际费用更低，运行记录保存 DataForSEO 报告的实际花费。
- 开始前显示词数和预估费用，需要确认；单次预算不够时只检查预算内的词，其余在运行记录里注明。提交是唯一的付费步骤：一批提交前先记下状态，进程中途停止也不会重复提交；提交时连接中断的批次，之后按任务标签在 DataForSEO 的已完成列表里找回。结果通常几分钟内返回，由后台任务陆续收取（读取结果免费），24 小时仍未返回的检查记为失败。
- 表格并列显示实测名次和变化、Search Console 近 28 天平均排名、排名页面（换了页面会标出，常见于多个页面争同一个词）、AI 概览是否出现及是否引用网站。展开一行可以看名次走势和最新一次的前 10 名结果。
- 可设置每天、每 3 天、每周、每 2 周或每 30 天定期检查（默认只手动检查），需要开启定时任务；`SCHEDULE_RANK_TRACKING=false` 对整个服务器关闭定期检查。
- “追踪关键词排名下滑”提醒在每次检查结束后评估：某个词比上次检查下降 5 位以上或掉出前 10 时触发，每次检查只触发一次。

### Manus 调研模板

在设置里保存自己的 Manus API Key 后，可以把需要读很多网页的调研交给 Manus，每次都要勾选同意并使用你自己的 Manus 积分。Manus 无法事先估算积分，这类任务通常消耗几百积分；可以选 Lite（更省积分）或标准（读取更多页面）。任务均为私有，不连接你在 Manus 中的其他应用，也不会联系任何人、提交表单或发布内容。

- **关键词深度研究**（关键词研究页）：返回研究摘要和 Excel 工作簿，可把候选词保存为关键词。
- **拆解 GEO 引用来源**（GEO 监测页）：从提示词跟踪的引用缺口里选最多 10 个网站，Manus 逐个查看页面类型、维护者、品牌怎样被收录、联系或投稿入口，按难度和优先级交回一张表。
- **调研外链机会**（外链页）：给定主题和最多 5 个竞品域名，Manus 寻找资源页、榜单、行业目录和协会、接受投稿的媒体、链接了竞品的页面等，附联系途径和切入角度。

结果通过 Manus API 的结构化输出返回，以表格显示，可下载 CSV。排名追踪这类需要固定口径、反复测量的数字不交给 Manus：它的浏览器在机房网络上运行，无法指定国家、语言和设备，也无法事先报价。

## 部署方式

### Windows 本机（个人使用推荐）

仓库外层的 `windows/` 目录是一套双击即用的脚本：构建镜像、生成配置、启动停止、备份与恢复演练、MCP 密钥和本机 Codex。数据库只在本机，应用只监听 `127.0.0.1`。步骤见 `windows/README.md`。

### Docker Compose（服务器）

```bash
cp .env.example .env      # 填写 Google OAuth、NEXTAUTH_SECRET 和数据库密码
docker compose up -d --build
```

Compose 会用本目录的 `Dockerfile` 构建镜像，然后启动三个服务：`app`（网页应用）、`worker`（执行抓取、同步和定时任务）和 `db`（PostgreSQL 16）。应用启动前会先执行数据库迁移；换用新镜像前请先备份数据库。

在能从公网访问的服务器上，登录前先完成这几项：

1. **应用端口只绑定本机。** 把 `docker-compose.yml` 中应用的端口改成 `"127.0.0.1:3000:3000"`。Docker 为发布的端口写入自己的防火墙规则，会绕过 ufw 等主机防火墙。
2. **用反向代理提供 HTTPS。** 例如 Caddy：

   ```
   seo.example.com {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

3. **设置公开地址和 Google 回调。** `.env` 中设 `NEXTAUTH_URL=https://seo.example.com` 并保留 `AUTH_TRUST_HOST=true`；Google OAuth 客户端里添加 `https://seo.example.com/api/auth/callback/google`。
4. **数据库密码。** 第一次 `docker compose up` 之前设好 `POSTGRES_PASSWORD`。PostgreSQL 会一直使用创建时的密码，之后再改需要同时改数据库里的密码。
5. **关闭注册。** 用自己的 Google 账号登录一次，然后在 `.env` 中设 `DISABLE_REGISTRATION=true`，执行 `docker compose up -d --force-recreate app`（`restart` 不会重新读取 `.env`）。否则任何 Google 账号都能注册，并用你的服务器发起抓取。
6. **保持 `NEXTAUTH_SECRET` 不变。** 它同时用于签发会话和加密保存的 API Key、Google 令牌；更改后这些数据无法解密。

### 本地开发

需要 Node.js 22 或更新版本和 PostgreSQL 16，步骤见 `DEVELOPMENT.md`。

## 后台任务与定时任务

抓取、性能检查、GSC 与 Bing 同步和提醒评估都作为任务放在 PostgreSQL 的队列里。可以重试解决的失败（超时、网络错误）在 1、5、25 分钟后重试；等待也解决不了的（Google 授权过期、缺少 Key、PageSpeed 配额用完）立即失败并显示原因。

`WORKER_MODE` 决定由谁执行任务：Docker Compose 中应用为 `off`、`worker` 服务为 `worker`；单进程运行（`npm start`）时默认 `inline`，由应用自己执行。停止 worker 时，正在进行的同步会在 `WORKER_SHUTDOWN_GRACE_SECONDS`（默认 25 秒）内完成，正在进行的抓取放回队列。

**定时任务**：每个站点每天同步 Search Console（配置了 Bing 时也同步 Bing），同步后评估提醒；每周抓取一次、检查一次网页性能；设置了定期运行的站点按其间隔运行提示词跟踪和排名检查；开启了每周 AI 行动清单的站点每周生成一次清单（`SCHEDULE_WEEKLY_AI_REPORT=false` 对整个服务器关闭）。第一次的定时抓取和性能检查分散在第一周内进行。间隔由 `SCHEDULE_*` 设置（0 关闭某一项），`SCHEDULER_ENABLED=false` 关闭全部；每个用户也可以在 **设置 → 定时任务** 为自己的站点单独调整。

**Bing 报表**：进入网站后，在左侧选择 **Bing 报表**。首次使用先保存账号 API Key，再选择主机名与当前网站一致的已验证 Bing 资源，保存后点击 **同步 Bing**。报表支持最近 28、90、180 天，按 UTC 日期截至昨天；日数据缺失不填零，收录量使用区间最近快照。关键词和页面按周结束日期筛选，边界为近似范围；每个维度最多展示点击量最高的 500 条，并支持筛选、排序和分页。报表只读取已有数据，打开页面不会启动外部同步；同步失败或部分接口未返回时，会保留并标明现有数据。

## MCP

A-Border SEO 自带 MCP（Model Context Protocol）服务，供 Claude Code、Codex 等 AI 助手读取你的 SEO 数据。

**MCP 只读。** 工具只读取数据，不写入、不修改、不排队、不触发任何操作：没有“开始抓取”或“同步”工具。所有工具都通过本实例的 `/api/v1` 和访问密钥读取，不直接连接数据库；一个密钥只能看到它所属账号的站点。

1. 打开 **设置 → MCP**，选择开启。关闭期间所有密钥都会被拒绝。
2. 输入名称并创建访问密钥。密钥只显示一次，数据库里只保存哈希。
3. 列表里显示每个密钥最后一次使用的时间，**撤销** 会立即停用。

通过 HTTP 连接 Claude Code：

```bash
claude mcp add --transport http aborder-seo https://seo.example.com/mcp --header "Authorization: Bearer <密钥>"
```

也可以用 `packages/mcp` 走 stdio，见 `packages/mcp/README.md`。没有密钥、密钥错误或已撤销时 `/mcp` 返回 401，账号关闭 MCP 时返回 403；`/health` 不需要密钥。每个密钥每分钟可以向 `/mcp` 和 `/api/v1` 合计发起 `API_RATE_LIMIT_PER_MINUTE` 次请求（默认 60）。

| 工具 | 读取内容 |
|---|---|
| `list_sites` | 站点列表、站点 ID、Search Console 与 Bing 资源 |
| `get_site_overview` | 最近 28 天与前 28 天的点击、曝光、排名和 CTR，最近一次抓取和性能检查 |
| `get_keywords` | Search Console 热门查询，最近 N 天或指定日期范围 |
| `get_pages` | 热门页面，最近 N 天或指定日期范围 |
| `get_traffic` | 每日点击和曝光，最近 N 天或指定日期范围 |
| `list_crawls` | 最近的抓取：状态、页面数、问题数和健康分 |
| `get_crawl_issues` | 某次抓取（默认最近一次完成的）的问题，按严重程度 |
| `get_vitals` | 网页性能报告：性能分、实验室 LCP、CLS、TBT、TTFB，以及 Chrome 真实用户数据（p75 的 LCP、INP、CLS） |
| `get_opportunities` | 临近首页、低 CTR、内容衰退和关键词互相竞争 |
| `get_bing_traffic` | Bing 每日点击、曝光、抓取页数，以及已收录页面数和抓取错误数 |
| `get_bing_keywords` | Bing 热门查询，按截止日期落在区间内的周汇总（Bing 按周报告） |
| `get_bing_pages` | Bing 热门页面，汇总方式同上 |
| `get_saved_keywords` | 已保存关键词、备注和 Search Console 汇总，最近 N 天或指定日期范围 |
| `get_rankings` | 排名追踪：每个追踪词的实测名次、与上次检查相比的变化、排名页面、AI 概览，以及 Search Console 平均排名；只读已保存的检查结果，不发起检查 |
| `get_ai_visibility` | 各 AI 平台的 GEO 六层情况：爬虫访问、页面指令、索引、平台 AI 报表、提示词跟踪中的提及与引用、AI 流量；只读已保存的数据 |
| `get_citation_gaps` | 引用缺口：AI 回答点名竞品、没提到品牌时引用的第三方网站，附提示词和被引用页面 |

**技能包**：**AI 与 MCP** 页面可以下载 6 个技能（每周复盘、排名变化复盘、技术问题排序、关键词与内容机会、GEO 可见度与引用缺口、SEO 入门教练），它们按固定流程调用上面的只读工具。Claude Code 放到 `~/.claude/skills/`，Codex 放到 `~/.agents/skills/`，Claude 桌面版和网页版在设置的技能（Skills）里逐个上传单个技能的 zip。

## 提醒推送

提醒在每次 GSC 或 Bing 同步、每次抓取之后，以及在站点的提醒页点击“立即评估”时检查。

### Webhook

在 **设置 → 告警 Webhook** 填写你自己的地址（n8n、Zapier、Make 或一个小脚本）和至少 16 个字符的签名密钥。**发送测试** 会发出一次 `test` 事件并显示对方的响应。

每次推送是一个 JSON POST，同一站点同一次评估的提醒合并为一次推送；持续触发的提醒（例如流量连续几天下降）每天最多推送一次：

```json
{
  "event": "alert.fired",
  "id": "cmh0c9x2k0001",
  "firedAt": "2026-10-19T05:02:11.000Z",
  "site": { "id": "cmgz...", "domain": "example.com" },
  "alerts": [
    { "id": "cmgy...", "type": "TRAFFIC_DROP", "message": "Traffic drop on example.com: clicks -34.2% vs prior week", "previousFiredAt": null }
  ],
  "url": "https://seo.example.com/sites/cmgz.../alerts",
  "app": { "name": "a-border-seo", "version": "1.1.2" }
}
```

| 请求头 | 内容 |
|---|---|
| `X-ABorder-Event` | `alert.fired`、`report.weekly` 或 `test` |
| `X-ABorder-Delivery` | 推送 ID，重试时不变，可用来去重 |
| `X-ABorder-Timestamp` | 本次尝试签名时的 Unix 秒 |
| `X-ABorder-Signature` | `sha256=` 加上以密钥对 `<timestamp>.<原始请求体>` 计算的 HMAC-SHA256（十六进制） |

校验时先用原始请求体计算 HMAC，再用常量时间比较，并拒绝过旧的时间戳：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const timestamp = headers["x-aborder-timestamp"];
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = Buffer.from(headers["x-aborder-signature"] ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
}
```

每周 AI 行动清单完成后发出一次 `report.weekly` 推送，签名、请求头和重试规则相同。`url` 指向本实例的 Codex 工作台，没有配置公开地址时为 `null`：

```json
{
  "event": "report.weekly",
  "id": "cmh3f0a1b0002",
  "generatedAt": "2026-11-23T02:14:05.000Z",
  "site": { "id": "cmgz...", "domain": "example.com" },
  "report": {
    "jobId": "aw_...",
    "title": "本周行动清单（自动）",
    "language": "zh-CN",
    "period": { "start": "2026-11-09", "end": "2026-11-15" },
    "summary": "两个商品页的点击下降，原因多半是标题没有覆盖主要搜索词。",
    "actions": [
      { "title": "重写 /cases 的标题", "reason": "近 7 天点击率 0.4%，平均排名 4", "nextStep": "把主要搜索词放进标题前半段", "verify": "三周后对比该页点击率" }
    ],
    "url": "https://seo.example.com/sites/cmgz.../assistant"
  },
  "app": { "name": "a-border-seo", "version": "1.8.0" }
}
```

返回任意 2xx 即视为成功。网络错误、超时（10 秒）或 HTTP 408、425、429、5xx 会在约 1、5、25、60 分钟后重试，第 5 次仍失败则放弃；其他状态码立即失败，也不跟随跳转。Webhook 地址和抓取器使用同一套地址检查，默认只允许公网地址；接收端在自己的内网时（例如同一 Docker 网络里的 n8n），设置 `ALERT_WEBHOOK_ALLOW_PRIVATE=true`。`ALERT_WEBHOOKS_ENABLED=false` 对整个实例关闭 Webhook。

### 邮件

管理员在 `.env` 中配置自己的 SMTP 服务器（`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM`）后，用户可在 **设置 → 邮件告警** 填写最多 5 个收件地址并开启。SMTP 登录信息只保存在环境变量里，不写入数据库，也不会显示或记录到日志。邮件为纯文本加简单 HTML，没有跟踪像素，只链接到本实例。开放注册时，任何用户都能让你的 SMTP 服务器向他填写的地址发信，因此建议关闭注册。`ALERT_EMAILS_ENABLED=false` 对整个实例关闭邮件。

## 本机 AI 写作

内容规划和 Codex 工作台中的“Codex 本地执行”任务，由你电脑上的 worker 领取：worker 在只读、无工具的沙箱里用你的 ChatGPT 账号运行 Codex CLI，只把 JSON 结果交回后台，不会自动改用 API 计费。Windows 使用 `windows/` 套件里的 `设置内容Worker.cmd`；其他系统见 `local-worker/README.md`。

也可以在 Codex 工作台里连接 ChatGPT（OAuth），用授权的 ChatGPT 套餐生成草稿。令牌加密保存在本地数据库，只发送给 OpenAI。

### 用 ChatGPT 额度做的任务

下面这些任务同样由本机 Codex 用你的 ChatGPT 套餐完成。和其他 Codex 任务一样只出草稿，不改网站、不发信；同一站点同一时间只运行一个 Codex 任务。模型只负责写，长度、格式、链接和数字由程序检查后再显示。

- **排名变化复盘**（排名追踪页的“用 ChatGPT 复盘排名变化”）：把最近一次检查与上一次相比的名次变化、换了哪个页面排名、前 10 名里新升上来的竞品、AI 概览是否出现及是否引用网站交给 Codex，解释可能的原因（作为待核实的推测），给出最多 3 条处理办法和验证方法。沿用报表分析的流程。
- **批量改标题和描述**（优化机会页）：列出近 28 天曝光不少于 100、平均排名在前 20、点击率低于该名次一般水平的页面，按少得的点击排序，默认勾选前 10 个，每次最多 20 个。每个页面附上实际带来曝光的前 8 个搜索词，Codex 据此重写。程序按显示宽度检查长度（标题 20 至 60、描述 70 至 160，中日韩文字算 2），并标出与原文相同、标题重复、写了页面上没有的数字、没有用到目标搜索词等情况；新旧对照，可复制或导出 CSV。
- **本地化改写**（Codex 工作台）：选一个有正文的已抓取页面，或粘贴至少 100 个字符的原文，再选目标语言和国家/地区。Codex 按当地人的搜索用词和说法重写，不是直译，并附上当地搜索词建议（模型建议，使用前在关键词研究里核实搜索量）。选了已抓取页面时，程序按抓取到的 hreflang 列出各语言版本之间的对应标签和 x-default；还没有本地化页面网址时用 `{localized-url}` 占位。
- **结构化数据代码**（Codex 工作台）：选一个已抓取页面（下拉框标出页面是否已有结构化数据），按页面类型生成 JSON-LD：首页为 Organization 和 WebSite，商品页为 Product，文章为 Article 或 BlogPosting，其他页面为 WebPage，首页以外另加 BreadcrumbList。程序检查 JSON 格式和类型，只保留页面上找得到的信息：页面上没有的价格、评分、评论、日期、图片和站外网址一律删去，列为“需要补充”；标题和描述与页面不一致时改用页面原文。
- **外链联络邮件草稿**（外链页）：从一次已完成的 Manus“调研外链机会”结果中选最多 10 个机会，填写署名和想推荐的内容，Codex 逐个写主题、正文和跟进邮件。只出草稿，不发送。正文里只保留你的网站和该机会自己的网址，其他链接换成“〔链接待核实〕”；提到付费、正文过长和需要手动填写的 `{{...}}` 占位都会标出。这样 Manus 积分只花在找机会上。
- **搜索词聚类**（内容规划页）：把近 28 天曝光最多的 100 或 200 个搜索词按搜索需求分组，每组对应到最合适的页面。是否缺内容由程序按 Search Console 数据判断：没有页面承接、或承接页面平均排名在 20 名以后的组是内容缺口；曝光分散在两个以上页面（各占 20% 以上）的组是内耗。选中的组可以加入内容规划的某个支柱：有页面的记为已发布并带上网址，缺口记为待写选题，已有的选题不会重复添加。
- **每周 AI 行动清单**（在提醒页按站点开启，默认关闭）：每周一 00:00 UTC（北京时间 08:00）之后，本机内容 worker 下次空闲时生成一次“本周行动清单”，完成后通过你在设置里配置的邮件提醒和 Webhook 发出（`report.weekly` 事件）。用桌面客户端时，客户端在运行就会执行，关掉窗口没关系（客户端留在系统托盘）；退出应用则等下次打开再生成，错过的一周不补。周中开启时，本周这份在 worker 下次空闲时就会生成。站点正有其他 Codex 任务时等它结束；本周没有可用数据时跳过。需要开启定时任务（`SCHEDULER_ENABLED=true`）；`SCHEDULE_WEEKLY_AI_REPORT=false` 对整个服务器关闭。

### 后台任务池：把快过期的额度用起来

ChatGPT 套餐的 Codex 额度按 5 小时窗口和每周额度计算，到期没用完就作废。后台任务池（Codex 工作台页面底部，按用户开启，默认关闭）在本机 Codex 空闲时，把这部分额度用在下面这些事上，结果同样只出草稿。

- **读取用量**：1.9.0 起的本机 worker（桌面客户端或 `source/local-worker`）每 5 分钟和每完成一个任务后，用 Codex 自带的 app-server 读一次 5 小时窗口和每周额度的已用比例、重置时间和账号可用的模型。读取不发消息，不消耗额度。旧版 worker 不会上报，后台任务池不会运行，其他功能照常。
- **什么时候跑**：手动发起的任务永远优先，后台任务在 worker 空闲时才领取，每次一个。5 小时窗口用到 70% 停（默认留 30% 给你手动发起的任务）；每周额度不超过本周已过去时间的比例加 5 个百分点，离每周重置不到 24 小时时可以用到 90%（默认至少留 10%）。读数超过 15 分钟、或报“已达上限”就停，等重置以后再跑。到线就不再开始新的后台任务，正在跑的那一个会跑完，所以实际用量可能略超过这条线；因为离用满还留着你设的余量，后台任务不会跑到超出套餐、开始用 credits 的地步。
- **审稿跟得上才继续**：待审阅的结果达到上限（默认 20 份）时暂停，在任务池里标记“已看过”后继续。每类自动任务在每个站点每天各有上限（默认排名复盘 2、提醒诊断 2、标题改写 1、结构化数据 10、搜索词聚类 1、选题简报 5，可改），按 UTC 日期计；你手动排进去的任务不计入。
- **自动加任务**（按站点勾选，每一项发现新情况时才加）：
  - 排名变化复盘：排名检查后有词掉 3 名以上、掉出检查深度、换了排名页面，或前 10 名里有竞品升上来时。只看开启以后的检查；想复盘开启前最近的那一次，点“现在复盘最近一次检查”。
  - 提醒诊断：默认只在流量或排名下降的提醒（流量下降、关键词排名变化、追踪词排名下降）触发时诊断，可改为任何提醒。
  - 标题和描述：每天检查一次，低点击率页面有新出现的，或点击率比上次检查又降了两成以上时改写，每项最多 20 页；近 28 天改写过或已在等待的页面不算，新发现的页面并入还在等待的那一项。
  - 结构化数据：每次抓取后，给缺结构化数据的页面生成代码，比上次抓取新出现的页面优先，其次按曝光，每次最多 10 个；内容没变的页面不重复排。
  - 搜索词聚类：每月一次，近 28 天有曝光的搜索词不少于 10 个时才做。
  - 选题简报：内容规划里还没有简报的待写选题，保持 5 个在等待；写好的简报直接写进选题（选题已有简报时不覆盖）。

  每一项下面显示“现在”能找到多少（展开时统计）、上次检查的时间和结果、上次加任务的时间，以及今天已自动开始几项；“现在检查一次”马上按保存的勾选检查一遍。某一项检查出错只影响它自己，下次再试。较新的复盘、诊断或聚类会替换还在等待的旧一项，等待超过两周的自动丢弃。
- **批量任务**（手动排进去，不计入每日上限）：最近一次抓取里缺结构化数据的页面，每页一项，新页面优先，最多 50 个；近 28 天没改写过的低点击率页面的标题和描述，每 20 页一项；所有还没有简报的待写选题，每个选题一项，一次最多 30 个；选最多 20 个有正文的页面按目标市场批量本地化；外链页的联络邮件面板里可以把一个 Manus 外链调研任务的全部机会排进来，每 10 个一项，署名、推荐内容和邮件语言填一次。已在任务池里或已完成的不会重复排；之前被跳过、取消或没完成的会重新排队。
- **结果直达**：任务池里每一项、每周 AI 行动清单的“上一份”和清单邮件里的链接，都直接打开那个任务的结果（优化机会、内容规划、外链页的对应面板，或 Codex 工作台），即使它已经不在最近 20 条里。
- **让位**：后台任务正在运行时你在同一站点发起任务，后台任务会停下让位（已用的额度不退回），之后重新排队。
- **按任务分配模型**：任务池设置里可以为“格式固定的任务”（标题、邮件、聚类、结构化数据、简报、关键词）和“写作和分析”（文章、本地化、修复方案、报表）分别选模型和推理强度，选项来自你的 Codex 账号；默认前者推理强度为低、后者为中，模型跟随 Codex 默认。轻量模型能用同样的额度跑多得多的格式固定任务。需要 1.9.0 起的 worker，对你手动发起的任务同样生效。
- `AI_POOL_ENABLED=false` 对整个服务器关闭后台任务池。它不依赖 `SCHEDULER_ENABLED`。

## 数据与外部连接

托管桌面版工作台连接 `aborder.tuitehao.shop`：使用设备凭据建立会话、访问本人业务数据，并协调本机内容 Worker。设备凭据只用于身份校验，不进入网页渲染进程。本地部署模式保留原有连接方式。

所有站点、关键词、抓取结果和 Google 令牌都保存在你自己的 PostgreSQL 里，应用不发送使用统计。只有下列情况会访问外部服务：

| 去向 | 什么时候 | 发送什么 | 如何关闭 |
|---|---|---|---|
| Google 登录与 API（`accounts.google.com`、`oauth2.googleapis.com`、`www.googleapis.com`、`searchconsole.googleapis.com`） | 登录、连接 Google、添加站点或同步、性能检查和索引状态检查、断开 Google 时；以及定时的每日 GSC 同步和每周性能检查 | 针对你自己的资源和页面的请求 | 不使用这些功能，或在 **设置 → 服务连接** 断开 Google；定时任务见上文 |
| Google Analytics（`analyticsdata.googleapis.com`） | 在 GEO 监测中授权并同步 GA4 报告时 | 媒体资源 ID、日期范围、站点主机名和 AI 来源筛选条件 | 只在手动同步时请求，每次同步单独授权 |
| Google 自动补全（`suggestqueries.google.com`） | 未配置 DataForSEO 时的关键词建议 | 你输入的种子关键词 | 不使用关键词建议 |
| Manus（`api.manus.ai`） | 验证自己的 Manus API Key、确认创建调研任务（关键词研究、GEO 引用来源、外链机会）或刷新结果时 | Key 用于认证。关键词研究发送种子词、目标受众和输出语言；GEO 引用来源发送品牌名、竞品名、所选来源网站及其被引用页面和相关提示词；外链机会发送网站域名、主题、竞品域名和受众；刷新时发送任务 ID | 在设置里删除 Manus Key。仅 Manus 请求可通过 `MANUS_HTTP_PROXY` 使用本机代理 |
| Manus 文件下载（`private.manuscdn.com`、`private-us-east-1.manuscdn.com`） | 从已有 Manus 任务加载关键词工作簿或 Markdown 报告时 | 服务器通过 Manus 返回的临时签名链接读取文件，API Key 只发给 Manus API | 跳过报告加载，或上传本地工作簿 |
| OpenAI（`auth.openai.com`、`api.openai.com`） | 可选的 ChatGPT 连接：登录、续期、读取模型列表和你主动请求的草稿 | OAuth 请求；草稿任务和所选的本地 SEO 证据 | 在 Codex 工作台断开连接；任务不会改用 API Key |
| Bing Webmaster Tools（`ssl.bing.com`） | 只在添加了你自己的 Bing API Key 后；之后每天同步一次 | 针对你自己的 Bing 站点的请求 | 在 **设置 → 服务连接** 删除 Key，或 `SCHEDULE_BING_SYNC_HOURS=0` |
| DataForSEO（`api.dataforseo.com`） | 只在添加了你自己的 DataForSEO Key 后：你执行的研究查询、确认后的提示词跟踪运行和排名检查，你设置的定期运行，排名检查的结果收取（免费），以及保存调研市场时核对 DataForSEO Labs 的国家与语言目录（免费接口，每天最多一次） | 关键词和域名查询；提示词、追踪关键词和站点的调研市场 | 在 **设置 → 服务连接** 删除 Key；定期运行改为“仅手动运行”，或设置 `SCHEDULE_GEO_TRACKING=false`、`SCHEDULE_RANK_TRACKING=false` |
| IndexNow（`api.indexnow.org`） | 只在你于 Bing 报表页点击“提交到 IndexNow”时 | 本站的网址列表、主机名、IndexNow 密钥和密钥文件地址；由 IndexNow 转给必应、Yandex 等参与的搜索引擎 | 不创建密钥、不点击提交 |
| GitHub 发布接口（`api.github.com`） | 只在设置了 `UPDATE_CHECK_REPO` 时，每天一次 | 查询该仓库的最新发布版本，只带 User-Agent，不含任何你的数据 | 不设置 `UPDATE_CHECK_REPO`（默认），或 `UPDATE_CHECK=false` |
| 桌面发行与下载（`github.com`、`api.github.com`、`release-assets.githubusercontent.com`、`objects.githubusercontent.com`） | 检查桌面更新或下载所选版本 | 发布元数据、清单与安装包的读取请求 | 关闭桌面自动检查，并按需手动检查和安装 |
| GitHub 容器注册表（`ghcr.io`、`pkg-containers.githubusercontent.com`） | 首次配置或升级需要拉取后台镜像时 | 公开镜像名、摘要和镜像层请求 | 使用已有本地镜像的浏览器版 |
| 你抓取的网站 | 开始抓取、点击 AI 爬虫访问检查、GEO 访问检查或 IndexNow 密钥文件检查时，以及每周的定时抓取 | 从你的服务器发出的普通 HTTP 请求，包括跳转到的地址；GEO 访问检查会以浏览器和各 AI 爬虫的 User-Agent 各请求一次 | 不开始抓取、不运行检查；定时抓取见上文 |
| 你加入可信来源库的网页 | 只在你于 Codex 工作台的可信来源库点击“检查”时，每次一个网页 | 对该网址的一次普通 HTTP 请求（只读取状态码和页面标题），包括跳转到的地址 | 不点“检查”；来源库本身只保存在本地数据库 |
| 你的 Webhook 与 SMTP 服务器 | 只在你配置后，提醒触发或点击发送测试时 | 触发的提醒（类型、内容、站点 ID 和域名） | 在设置中删除；或 `ALERT_WEBHOOKS_ENABLED=false`、`ALERT_EMAILS_ENABLED=false` |

除此之外不会有数据离开你的服务器。测试会用 `outbound-hosts.json` 检查代码里出现的每个外部地址。你的 Google 头像由浏览器直接从 Google 加载。

## 环境变量

完整说明见 `.env.example`。必填项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（Docker Compose 会自动拼出） |
| `NEXTAUTH_SECRET` | 会话密钥，同时加密保存的 API Key 和 Google 令牌（`openssl rand -hex 32`），生成后不要更改 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Google OAuth 客户端；传统自部署 Google 登录需要配置，受管客户端注册、登录和手动添加网站不需要 |

常用的可选项：`NEXTAUTH_URL`、`DISABLE_REGISTRATION`、`CRAWL_MAX_PAGES`、`CRAWL_MAX_MINUTES`、`CRAWL_DETAIL_RETENTION`、`CRAWLER_USER_AGENT`、`GOOGLE_HTTP_PROXY`、`SCHEDULER_ENABLED`、`SCHEDULE_*`（含 `SCHEDULE_GEO_TRACKING`、`SCHEDULE_RANK_TRACKING`、`SCHEDULE_WEEKLY_AI_REPORT`）、`AI_POOL_ENABLED`、`WORKER_MODE`、`LOCAL_CONTENT_WORKER_TOKEN`、`LOCAL_APP_PORT`、`UPDATE_CHECK_REPO`。

页面打开慢时，可以设 `ABORDER_SLOW_QUERY_MS=200` 后重启：耗时 200 毫秒及以上的数据库查询会以 `[slow query]` 开头写进应用日志，只记 SQL 语句，不记参数。排查完删掉这一项。

### 受管客户端连接 Google Search Console

客户端的注册账号与 Google 数据授权独立。可以先手动添加网站，随后在添加网站、站点设置或“设置 → 服务连接”中连接 Google，再绑定自己有权限访问的 GSC 资源。授权只请求 Search Console 只读权限，在系统浏览器完成，不改变 A-Border SEO 登录账号或网站归属。

管理员后台上线不会自动配置每台客户端的 Google OAuth。要启用此连接，需要为本地工作台配置自己的 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`，并在对应 Google Web OAuth 客户端登记完整回调地址 `http://localhost:3300/api/auth/callback/google`，然后通过客户端重启服务载入配置。保留现有登录与 GA4 回调地址。部署者还需启用 Search Console API，并按照 Google 项目的测试用户或应用发布状态授予访问。不要把 Google 客户端私密配置提交到仓库。流程参考 [Google Web OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)。

缺少配置时界面显示“尚未配置”，连接按钮不可用，手动添加网站仍可继续。配置正确后，授权请求用 PKCE、一次性状态及当前本地账号绑定；系统浏览器回调只暂存加密授权码，客户端确认后才交换并加密保存访问及刷新令牌。退出登录、切换账号、停用或授权超时会使未完成关联失效。

## Vercel

Vercel 上没有常驻进程：按钮触发的任务在同一请求内执行（路由上限 300 秒，大型抓取会被截断，建议用 Docker）；`vercel.json` 每天调用一次 `/api/cron/tick` 处理每日同步和提醒评估，需要设置 `CRON_SECRET`（至少 16 个字符）。定时抓取和性能检查需要 worker，只在 Docker 部署中运行。

## 技术栈

Next.js 16（App Router）、TypeScript、PostgreSQL 16、Prisma 6、Auth.js v5、Tailwind CSS v4 与 shadcn/ui、Lucide 图标、Model Context Protocol SDK。

## 许可证

MIT，见 `LICENSE`。
