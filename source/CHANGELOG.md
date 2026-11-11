# 更新记录

## 1.1.2（2026-11-10）

没有数据库变化。

- **健康分修正**：受影响页面的占比改为按参与审计的页面计算。此前分母是抓取到的全部页面，noindex 页面不产生问题却计入分母，站点里 noindex 页面越多分数越高，与“noindex 页面不计分”的规则不符。算法版本仍是 `page-share-v1`；含 noindex 页面的站点，新抓取的分数可能比 1.0.0–1.1.1 的抓取低几分。`scripts/review-crawl.ts` 复核时使用同样的分母。
- **切换站点时保留 GEO 监测页**：在 GEO 监测页切换站点，会打开另一个站点的 GEO 监测页，不再回到概览。
- GA4 首次同步指南的外部链接改用图标，不再使用箭头字符。
- **试运行**：提示词跟踪新增“试运行”，只向每个已选平台提出第一个启用的提示词（每个平台一个付费任务），用来在完整运行前核对设置、回答和实际花费；确认框显示要问的提示词和费用，运行记录里标为“试运行”。试运行是单独的任务类型 `geo-visibility-trial`，不会推迟定期运行；同一站点同时只进行一个运行或试运行。
- **迁移旧数据.cmd** 会带入 `.env` 里的 `SCHEDULE_GEO_TRACKING`。
- 安装包附带通用的 `升级说明.md`（原目录升级、各版本的数据库变化、从另一个目录迁移）。
- 测试：本版在发布前把全部 172 个测试文件对着真实的 PostgreSQL 16 运行了一遍，162 个文件全部通过（1582 个测试）；据此修正了上面的健康分和站点切换问题，并更新了两处过期的断言（GEO 就绪度、孤立页面的健康分）。其余 10 个文件依赖当时构建环境里没有的包或 IPv6（MCP SDK、NextAuth 核心、PGlite、jose、nodemailer、undici 代理），未能运行，涉及的代码本版没有改动。新增测试：试运行（任务、接口、定时任务不受影响）、单个任务失败时整次运行为“部分完成”、删除站点时一并删除跟踪数据、noindex 页面不影响健康分。

## 1.1.1（2026-11-09）

1.1.0 的复查修正，没有数据库变化。

- **Claude 查询**：按 DataForSEO 模型列表的 `web_search_supported` 只选能联网的模型（优先最新的 Haiku），并按站点市场设置联网搜索的国家；以前可能选到不能联网的旧模型。
- **提示词跟踪任务**：一个查询线程出错时其他线程立即停止，任务重试时不会重复付费；运行中删除的提示词直接跳过（以前会使整次运行出错）；结束时按实际保存的回答重算任务数；无法续跑的运行（最后一次尝试、Serverless 主机）会被关闭，不再一直显示“进行中”；运行记录保留 400 天。
- **最新回答**：某次查询失败不会盖住之前成功的回答。
- **访问检查**：不再冒充 Googlebot、Bingbot（防火墙常会拦截甚至暂时封禁冒充者，真实情况以 Search Console 和 Bing 为准），请求从约 30 个减到约 20 个；中途取消的检查不会保存。
- DataForSEO 的错误说明（例如哪个字段无效）会记在失败的回答里。
- Search Console 报表导入改为按“排名/点击率”列识别普通效果报告，即使 AI 报告以后加入点击数也能导入；旧浏览器无法解压 zip 时给出明确提示。
- 运行中只轮询进度，不再每 5 秒重读全部回答；服务器关闭了定时任务时，设置定期运行会给出提示（Windows 套件默认 `SCHEDULER_ENABLED=false`）。
- 界面显示的服务器错误改为中文；预算输入在保存前校验；回答详情可用 Esc 关闭。
- 设置页的 DataForSEO 说明加入 AI 回答跟踪。

## 1.1.0（2026-11-09）

### 各 AI 平台的 GEO 情况

- GEO 监测页新增 10 个平台（ChatGPT、Google AI 概览、Google AI 模式、Gemini、Perplexity、Copilot、Claude、Grok、Meta AI、DeepSeek）的六层视图：访问、页面指令、索引、平台 AI 报表、回答中的提及与引用、流量。没有数据的层显示“无数据”，平台没有的层显示“不适用”，不做推测。
- **访问检查**：以浏览器和 10 个 AI 爬虫的 User-Agent 分别请求首页和一个热门页面（不模拟 Googlebot、Bingbot，以免被防火墙封禁），识别 Cloudflare、Akamai、Vercel、DataDome 等的验证页，与浏览器结果对比，区分“只拒绝爬虫”和“本服务器也被拒绝”；同时读取 robots.txt 对每个爬虫和 Google-Extended 的规则。训练用爬虫被禁止不算问题。
- **页面指令**：按平台规则判断：Google 平台看 noindex、nosnippet、max-snippet、data-nosnippet；Copilot 看 noindex、noarchive、nocache、ai-grounding。抓取从本版本起记录 googlebot、bingbot、msnbot 专用 meta 标签和 data-nosnippet。
- **平台官方 AI 报表导入**：Search Console“生成式 AI”报告（直接选择下载的 zip）和 Bing“AI 表现”（每日、网页、依据查询）；中英文表头都能识别，拒绝误选的普通效果报告。
- **提示词跟踪**：通过你自己的 DataForSEO 账户查询 ChatGPT、Gemini、AI 概览、AI 模式、Perplexity 和 Claude，计算提及率、引用率、声量份额和引用排名，列出竞品和被引用最多的域名；Copilot、Grok、Meta AI、DeepSeek 手动记录。运行前显示费用并确认，按单次预算停止，可每 7、14、30 天定期运行（`SCHEDULE_GEO_TRACKING=false` 全部关闭）。

### MCP 与 API

- 新增只读工具 `get_ai_visibility` 和 `GET /api/v1/sites/{siteId}/ai-visibility`，共 14 个工具。

### 数据库

- 新增 `GeoTracking`、`GeoPrompt`、`GeoRun`、`GeoAnswer` 表和 `AuditPage.robotsDirectives` 列；`GeoSnapshot` 允许 `PROBE`、`GSC_AI`、`BING_AI`。Windows 套件启动时会先备份再升级数据库。

## 1.0.0（2026-11-09）

首个正式版本。

### SEO

- Search Console 关键词、页面和每日流量，28 天对比，已保存关键词与备注，CSV 导出；Bing Webmaster 同步。
- 抓取与审计：遵守 RFC 9309 的 robots.txt 与 Crawl-delay，noindex 页面不计分，16 类问题与修复建议。
- **健康分按受影响页面占比计分**（`page-share-v1`）：每类问题按最严重级别计权，乘以受影响页面占比的平方根。每次抓取记录所用算法，旧抓取保留原分数并在界面标注“旧算法”。
- **结构化数据检查 v2**：评分（ratingValue 范围、ratingCount/reviewCount）、评论作者缺失或泛称、自我评论与自评分、Offer 可用性取值、商品列表推荐字段；提示 FAQ（2026 年 5 月起）和 HowTo 富媒体结果已停止显示；输出作者、发布日期、组织、商品等实体信号。
- 网页性能（PageSpeed Insights）、优化机会、关键词研究、域名概览与外链（DataForSEO）。
- 提醒：流量、排名、抓取健康度、大范围 noindex、网页性能；Webhook（`X-ABorder-*` 签名请求头，负载中的 `app` 字段标明名称和版本）与 SMTP 邮件。

### GEO

- **AI 爬虫访问**：纯函数实现的 RFC 9309 匹配器（分组合并、最长匹配、通配符）；按状态码区分“不存在即全部允许”和“暂时不可用即全部禁止”；超过 500 KiB 的部分忽略；跨主机跳转经过同一套地址检查。覆盖 19 个与 AI 搜索、训练和用户触发访问相关的爬虫，以及训练用途通用标记 `__usage_ai-training`；读取 Cloudflare `Content-Signal` 和 IETF `Content-Usage` 声明。
- **就绪度检查 v2**：摘要、标题、正文（中文按字计）、分节、问答（仅文章页）、事实数据、结构化数据、作者信息、链接 9 项，只给适用的项目计分；按 GSC 曝光优先抽样，最多 300 页。
- GA4 中的 AI 来源会话（分页读取，最多 50000 行），访问日志导入支持 .gz 并在浏览器里流式解析（最大 512 MiB），新增 Grok、Meta AI、Mistral、Poe、You.com、Duck.ai、通义千问、文心一言、腾讯元宝、智谱清言、秘塔等来源识别。

### 内容与 AI

- 内容规划与 Codex 工作台：支柱、选题、简报、文章初稿、改写与 SEO 修复建议。
- **本机内容 worker**：跨平台 Node 版（`local-worker/`，无依赖）和 Windows PowerShell 版，只读、无工具的沙箱，只用 ChatGPT 账号，不会改用 API Key；Codex 的命令、登录目录、模型、推理强度和关闭的功能都可以用环境变量调整。
- 可选的 ChatGPT 连接；本地端口可用 `LOCAL_APP_PORT` 设置。
- 只读 MCP（13 个工具）与 `/api/v1`。

### 稳定性与运维

- Search Console 同步按天提交，失败时只影响当天的数据。
- 只保留最近几次抓取的页面正文、标题结构和结构化数据明细（`CRAWL_DETAIL_RETENTION`，默认 3）。
- 独立的 Dockerfile（Node 24），镜像启动时不修改数据库；Docker Compose 在应用启动前执行迁移。
- 新版本提示改为可选：只有设置了 `UPDATE_CHECK_REPO` 才会查询。
- Windows 套件：脚本可以放在任意目录；数据库卷由脚本创建并在首次启动时确认；启动时先备份再自动升级数据库结构；新增构建镜像、恢复演练、内容 worker 设置和从旧安装迁移数据（只读复制）的脚本。
