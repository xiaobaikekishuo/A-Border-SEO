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
| **Bing Webmaster** | 使用你自己的 Bing API Key，同步查询、页面和抓取统计 |
| **抓取与审计** | 默认每次最多 2000 页（`CRAWL_MAX_PAGES`），并发抓取；16 类问题与修复建议、内容评分、结构化数据检查；健康分按受影响页面占比计分 |
| **网页性能** | 通过 PageSpeed Insights 检查 LCP、CLS、INP、TTFB，移动端与桌面端分开 |
| **AI 爬虫访问** | 按 RFC 9309 逐个判断 19 个与 AI 搜索、模型训练和用户触发访问相关的爬虫能否访问，并读取 robots.txt 中的 Content-Signal 与 Content-Usage 声明 |
| **GEO 监测** | 10 个 AI 平台（ChatGPT、Google AI 概览、AI 模式、Gemini、Perplexity、Copilot、Claude、Grok、Meta AI、DeepSeek）的六层情况：爬虫访问实测、页面指令、索引、平台官方 AI 报表、回答中的提及与引用、AI 流量；提示词跟踪（通过你自己的 DataForSEO 账户，可定期运行、设预算）；AI 搜索就绪度检查（9 项）、GA4 中的 AI 来源会话、访问日志中的 AI 爬虫与 AI 引荐（支持 .gz） |
| **优化机会** | 临近首页的关键词、低 CTR、内容衰退、关键词互相竞争 |
| **研究** | 关键词研究、域名概览、外链（DataForSEO，使用你自己的 Key；未配置时用 Google 自动补全建议） |
| **提醒** | 流量下降、排名下降、抓取健康度低、大部分页面 noindex、性能变差；可推送到你的 Webhook 和邮箱 |
| **内容规划与 Codex 工作台** | 内容支柱、选题和简报，文章初稿、改写和 SEO 修复建议；由本机 Codex 或 ChatGPT 连接生成，只出草稿，不发布、不改网站 |
| **MCP 与只读 API** | 14 个只读工具，供 Claude Code、Codex 等 AI 助手读取你的站点数据 |

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

- 写下客户会问的问题（每个站点最多启用 50 个），选择要查询的平台，设置品牌名、别名、域名和竞品。ChatGPT、Gemini、Google AI 概览、AI 模式、Perplexity 和 Claude 通过你自己的 DataForSEO 账户查询，按任务计费（2026 年 11 月价格：ChatGPT、Gemini、AI 概览、AI 模式约 $0.004/个，Perplexity 和 Claude 另加模型费用，界面按约 $0.01 和 $0.04 预估）；Copilot、Grok、Meta AI 和 DeepSeek 没有可用接口，在其应用中提问后把回答和来源链接手动记下。
- 每次运行前会显示任务数和预估费用，需要确认；运行在超过“单次预算”前停止，DataForSEO 拒绝登录或余额不足时整次停止。每个回答到达即保存，重启后继续同一次运行。
- 第一次使用建议先点 **试运行**：只向每个已选平台提出第一个启用的提示词（每个平台一个付费任务），核对回答、品牌识别和实际花费后再完整运行。试运行在运行记录里单独标出，不会推迟定期运行。同一站点同时只进行一个运行或试运行。
- 可设置每 7、14 或 30 天定期运行（默认只手动运行）。定期运行需要开启定时任务（`SCHEDULER_ENABLED=true`，Windows 套件默认关闭），`SCHEDULE_GEO_TRACKING=false` 对整个服务器关闭定期运行。查询使用站点的调研市场（语言和地区）；Claude 使用能联网搜索的最新 Haiku 模型。
- 提及率、引用率和声量份额按每个提示词在每个平台最近 90 天内的最新回答（失败的查询不会盖住之前的回答），用当前的品牌设置计算；运行记录里的各平台结果按运行结束时的设置保存。AI 回答每次都可能不同，少量提示词的比例只能看趋势。

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

**定时任务**：每个站点每天同步 Search Console（配置了 Bing 时也同步 Bing），同步后评估提醒；每周抓取一次、检查一次网页性能；设置了定期运行的站点按其间隔运行提示词跟踪。第一次的定时抓取和性能检查分散在第一周内进行。间隔由 `SCHEDULE_*` 设置（0 关闭某一项），`SCHEDULER_ENABLED=false` 关闭全部；每个用户也可以在 **设置 → 定时任务** 为自己的站点单独调整。

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
| `get_vitals` | 网页性能报告：性能分、LCP、CLS、INP、TTFB |
| `get_opportunities` | 临近首页、低 CTR、内容衰退和关键词互相竞争 |
| `get_bing_traffic` | Bing 每日点击、曝光、抓取页数，以及已收录页面数和抓取错误数 |
| `get_bing_keywords` | Bing 热门查询，按截止日期落在区间内的周汇总（Bing 按周报告） |
| `get_bing_pages` | Bing 热门页面，汇总方式同上 |
| `get_saved_keywords` | 已保存关键词、备注和 Search Console 汇总，最近 N 天或指定日期范围 |
| `get_ai_visibility` | 各 AI 平台的 GEO 六层情况：爬虫访问、页面指令、索引、平台 AI 报表、提示词跟踪中的提及与引用、AI 流量；只读已保存的数据 |

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
| `X-ABorder-Event` | `alert.fired` 或 `test` |
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

返回任意 2xx 即视为成功。网络错误、超时（10 秒）或 HTTP 408、425、429、5xx 会在约 1、5、25、60 分钟后重试，第 5 次仍失败则放弃；其他状态码立即失败，也不跟随跳转。Webhook 地址和抓取器使用同一套地址检查，默认只允许公网地址；接收端在自己的内网时（例如同一 Docker 网络里的 n8n），设置 `ALERT_WEBHOOK_ALLOW_PRIVATE=true`。`ALERT_WEBHOOKS_ENABLED=false` 对整个实例关闭 Webhook。

### 邮件

管理员在 `.env` 中配置自己的 SMTP 服务器（`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM`）后，用户可在 **设置 → 邮件告警** 填写最多 5 个收件地址并开启。SMTP 登录信息只保存在环境变量里，不写入数据库，也不会显示或记录到日志。邮件为纯文本加简单 HTML，没有跟踪像素，只链接到本实例。开放注册时，任何用户都能让你的 SMTP 服务器向他填写的地址发信，因此建议关闭注册。`ALERT_EMAILS_ENABLED=false` 对整个实例关闭邮件。

## 本机 AI 写作

内容规划和 Codex 工作台中的“Codex 本地执行”任务，由你电脑上的 worker 领取：worker 在只读、无工具的沙箱里用你的 ChatGPT 账号运行 Codex CLI，只把 JSON 结果交回后台，不会自动改用 API 计费。Windows 使用 `windows/` 套件里的 `设置内容Worker.cmd`；其他系统见 `local-worker/README.md`。

也可以在 Codex 工作台里连接 ChatGPT（OAuth），用授权的 ChatGPT 套餐生成草稿。令牌加密保存在本地数据库，只发送给 OpenAI。

## 数据与外部连接

所有站点、关键词、抓取结果和 Google 令牌都保存在你自己的 PostgreSQL 里，应用不发送使用统计。只有下列情况会访问外部服务：

| 去向 | 什么时候 | 发送什么 | 如何关闭 |
|---|---|---|---|
| Google 登录与 API（`accounts.google.com`、`oauth2.googleapis.com`、`www.googleapis.com`、`searchconsole.googleapis.com`） | 登录、连接 Google、添加站点或同步、性能检查和索引状态检查、断开 Google 时；以及定时的每日 GSC 同步和每周性能检查 | 针对你自己的资源和页面的请求 | 不使用这些功能，或在 **设置 → 服务连接** 断开 Google；定时任务见上文 |
| Google Analytics（`analyticsdata.googleapis.com`） | 在 GEO 监测中授权并同步 GA4 报告时 | 媒体资源 ID、日期范围、站点主机名和 AI 来源筛选条件 | 只在手动同步时请求，每次同步单独授权 |
| Google 自动补全（`suggestqueries.google.com`） | 未配置 DataForSEO 时的关键词建议 | 你输入的种子关键词 | 不使用关键词建议 |
| Manus（`api.manus.ai`） | 验证自己的 Manus API Key、确认创建关键词研究任务或刷新结果时 | Key 用于认证。创建时发送种子词、目标受众和输出语言；刷新时发送任务 ID | 在设置里删除 Manus Key。仅 Manus 请求可通过 `MANUS_HTTP_PROXY` 使用本机代理 |
| Manus 文件下载（`private.manuscdn.com`、`private-us-east-1.manuscdn.com`） | 从已有 Manus 任务加载关键词工作簿或 Markdown 报告时 | 服务器通过 Manus 返回的临时签名链接读取文件，API Key 只发给 Manus API | 跳过报告加载，或上传本地工作簿 |
| OpenAI（`auth.openai.com`、`api.openai.com`） | 可选的 ChatGPT 连接：登录、续期、读取模型列表和你主动请求的草稿 | OAuth 请求；草稿任务和所选的本地 SEO 证据 | 在 Codex 工作台断开连接；任务不会改用 API Key |
| Bing Webmaster Tools（`ssl.bing.com`） | 只在添加了你自己的 Bing API Key 后；之后每天同步一次 | 针对你自己的 Bing 站点的请求 | 在 **设置 → 服务连接** 删除 Key，或 `SCHEDULE_BING_SYNC_HOURS=0` |
| DataForSEO（`api.dataforseo.com`） | 只在添加了你自己的 DataForSEO Key 后：你执行的研究查询、确认后的提示词跟踪运行，以及你设置的定期运行 | 关键词和域名查询；提示词和站点的调研市场 | 在 **设置 → 服务连接** 删除 Key；定期运行改为“仅手动运行”或 `SCHEDULE_GEO_TRACKING=false` |
| GitHub 发布接口（`api.github.com`） | 只在设置了 `UPDATE_CHECK_REPO` 时，每天一次 | 查询该仓库的最新发布版本，只带 User-Agent，不含任何你的数据 | 不设置 `UPDATE_CHECK_REPO`（默认），或 `UPDATE_CHECK=false` |
| 你抓取的网站 | 开始抓取、点击 AI 爬虫访问检查或 GEO 访问检查时，以及每周的定时抓取 | 从你的服务器发出的普通 HTTP 请求，包括跳转到的地址；GEO 访问检查会以浏览器和各 AI 爬虫的 User-Agent 各请求一次 | 不开始抓取、不运行检查；定时抓取见上文 |
| 你的 Webhook 与 SMTP 服务器 | 只在你配置后，提醒触发或点击发送测试时 | 触发的提醒（类型、内容、站点 ID 和域名） | 在设置中删除；或 `ALERT_WEBHOOKS_ENABLED=false`、`ALERT_EMAILS_ENABLED=false` |

除此之外不会有数据离开你的服务器。测试会用 `outbound-hosts.json` 检查代码里出现的每个外部地址。你的 Google 头像由浏览器直接从 Google 加载。

## 环境变量

完整说明见 `.env.example`。必填项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（Docker Compose 会自动拼出） |
| `NEXTAUTH_SECRET` | 会话密钥，同时加密保存的 API Key 和 Google 令牌（`openssl rand -hex 32`），生成后不要更改 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Google OAuth 客户端 |

常用的可选项：`NEXTAUTH_URL`、`DISABLE_REGISTRATION`、`CRAWL_MAX_PAGES`、`CRAWL_MAX_MINUTES`、`CRAWL_DETAIL_RETENTION`、`CRAWLER_USER_AGENT`、`GOOGLE_HTTP_PROXY`、`SCHEDULER_ENABLED`、`SCHEDULE_*`（含 `SCHEDULE_GEO_TRACKING`）、`WORKER_MODE`、`LOCAL_CONTENT_WORKER_TOKEN`、`LOCAL_APP_PORT`、`UPDATE_CHECK_REPO`。

## Vercel

Vercel 上没有常驻进程：按钮触发的任务在同一请求内执行（路由上限 300 秒，大型抓取会被截断，建议用 Docker）；`vercel.json` 每天调用一次 `/api/cron/tick` 处理每日同步和提醒评估，需要设置 `CRON_SECRET`（至少 16 个字符）。定时抓取和性能检查需要 worker，只在 Docker 部署中运行。

## 技术栈

Next.js 16（App Router）、TypeScript、PostgreSQL 16、Prisma 6、Auth.js v5、Tailwind CSS v4 与 shadcn/ui、Lucide 图标、Model Context Protocol SDK。

## 许可证

MIT，见 `LICENSE`。
