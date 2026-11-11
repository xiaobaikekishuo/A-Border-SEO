# 开发指南

## 准备

- Node.js 22 或更新版本（Docker 镜像使用 Node 24）
- PostgreSQL 16（可以用 `docker compose up -d db` 启动）
- 一个 Google OAuth 客户端（Web 应用类型）

```bash
npm ci
cp .env.example .env.local        # 填写 DATABASE_URL、Google OAuth 和 NEXTAUTH_SECRET
docker compose up -d db           # 或使用已有的 PostgreSQL
npx prisma migrate deploy         # 建立数据库结构
npm run dev                       # http://localhost:3000
```

Google OAuth 客户端：在 [Google Cloud Console](https://console.cloud.google.com/) 启用 Google Search Console API（以及需要时的 PageSpeed Insights API），创建 Web 应用类型的 OAuth 客户端，添加回调地址 `http://localhost:3000/api/auth/callback/google`。需要的权限是 `openid`、`email`、`profile` 和 `https://www.googleapis.com/auth/webmasters.readonly`。

## 目录结构

```
app/                Next.js App Router：(auth) 登录、(dashboard) 后台页面、api 路由、mcp 端点
components/         界面组件（ui 为基础组件，layout 为外框与侧边栏）
lib/                业务逻辑
  crawler/          抓取引擎、robots.txt、审计规则与健康分
  seo/              结构化数据、AI 爬虫访问（robots-rules、ai-bots、ai-access）
  geo/              GEO 就绪度、GA4 报告、访问日志导入
  google/ bing/     Search Console、PageSpeed、Bing 客户端
  jobs/             任务队列、执行器、定时任务
  alerts/ webhooks/ email/   提醒评估与推送
  content-planner/ ai-workbench/ chatgpt-connection/   内容规划、Codex 工作台、ChatGPT 连接
  api-v1/           只读 API
  i18n/             中英文文案
worker/             独立 worker 进程入口
packages/mcp/       只读 MCP 服务（也供 /mcp 路由使用）
local-worker/       本机 Codex worker（Node，无依赖）
prisma/             数据库结构与迁移
extensions/         部署方挂接自定义代码的唯一入口
scripts/            构建与维护脚本
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run build` / `npm start` | 生产构建与启动 |
| `npm test` | 单元与集成测试（Vitest） |
| `npm run lint` | ESLint |
| `npm run worker` | 从源码运行 worker 进程（需要 `DATABASE_URL`） |
| `npm run build:worker` | 把 worker 打包为 `dist/worker.cjs`（镜像里是 `worker.cjs`） |
| `npm run mcp` | 从源码以 stdio 运行 MCP（需要 `ABORDER_SEO_URL`、`ABORDER_SEO_API_KEY`） |
| `npm run local-worker` | 运行本机 Codex worker，见 `local-worker/README.md` |
| `npm run seed:demo` | 写入演示数据（`seed:demo:clean` 删除） |

## 数据库与迁移

- 迁移是显式的：`prisma/migrations` 按目录名顺序执行，测试用的 PGlite 也执行同一套迁移。
- 新增结构改动用 `npx prisma migrate dev --name <说明>` 生成迁移，连同 `schema.prisma` 一起提交。
- **不要修改已发布的迁移文件**：已执行的迁移按校验和记录在 `_prisma_migrations` 中。
- 镜像启动时不改数据库。Docker Compose 在应用启动前执行 `migrate deploy`；Windows 套件先备份，再执行迁移。

## 外部连接

应用可以访问的外部主机都登记在 `outbound-hosts.json`：`requests` 是应用会请求的主机，必须出现在 README 的“数据与外部连接”一节；`notRequested` 只能作为链接或字符串出现在列出的文件里。`lib/outbound-hosts.test.ts` 会扫描 `lib/`、`app/`、`packages/`、`components/` 和根目录代码，发现未登记的主机就失败。新增外部请求时，同时更新这三处。

## 架构要点

### 登录

Auth.js v5 + Google OAuth。Google 令牌和用户保存的 API Key 用 `NEXTAUTH_SECRET` 派生的密钥加密存储（`lib/encryption.ts`）。`DISABLE_REGISTRATION=true` 时只允许已登录过的账号。

### 后台任务

- 抓取、性能检查、GSC 与 Bing 同步、提醒评估和提示词跟踪运行（`geo-visibility`，试运行 `geo-visibility-trial`）都是 PostgreSQL 队列里的任务（`lib/jobs`，`Job` 表）。
- 任务类型在 `lib/jobs/handlers.ts` 注册：分为 LONG 和 SHORT 两类，各自声明重试次数和不需重试的错误。
- `WORKER_MODE=inline`（默认）由应用进程执行队列，`npm run dev` 也是如此；`worker` 由独立进程执行，此时应用设为 `off`。
- 定时任务（`lib/jobs/scheduler.ts`）在执行队列的进程里运行，所有进程合计每 10 分钟最多一轮。

### 抓取

- `lib/crawler/engine.ts`：并发抓取、每个主机遵守 robots.txt（RFC 9309）和 Crawl-delay、DNS 重绑定防护（只连接公网地址）。
- 审计规则在 `lib/crawler/audit-policy.ts`；健康分版本记录在 `Crawl.healthScoreVersion`（`page-share-v1`；为空表示旧的 8/3/1 扣分法）。
- `lib/crawler/retention.ts` 在每次抓取完成后清理更早抓取的大字段（正文、标题结构、结构化数据报告）。

### AI 爬虫访问与 GEO

- `lib/seo/robots-rules.ts` 是纯函数实现的 RFC 9309 匹配器（分组合并、最长匹配、`*` 与 `$` 通配符）；`lib/seo/ai-bots.ts` 是爬虫清单；`lib/seo/ai-access-rules.ts` 处理状态码、内容类型和声明的偏好。
- `lib/geo/readiness-rules.ts` 是就绪度检查（纯函数），`lib/geo/readiness.ts` 负责按 GSC 曝光抽样。
- 访问日志导入在浏览器里流式解析（`lib/geo/log-stream.ts`），支持 gzip。
- 平台清单在 `lib/geo/platforms.ts`（爬虫、控制标记、页面指令规则、索引、官方报表、回答来源）；`lib/geo/platform-overview.ts` 把访问、页面指令、索引、报表、回答和流量六层合成每个平台的状态。
- 纯函数：`directives.ts`（按 Google、Bing 和通用规则判断页面指令）、`probe-rules.ts`（访问检查的验证页识别和判定）、`visibility-rules.ts`（品牌提及、引用和声量份额）、`dataforseo-parse.ts`（DataForSEO 返回的解析）、`reports.ts` 和 `zip.ts`（官方报表 CSV 与 zip，在浏览器里运行）。
- `probe.ts` 发出访问检查请求（经 `fetchPublic` 的公网地址检查），结果存为 `GeoSnapshot` 的 `PROBE`；`report-store.ts` 保存 `GSC_AI`、`BING_AI` 报表。
- 提示词跟踪：`tracking.ts`（设置、提示词、回答，读取时按当前品牌设置分析），`dataforseo-ai.ts`（每个平台一个 Live 任务），`visibility-job.ts`（`geo-visibility` 任务：每个回答到达即保存，同一任务重试时接着运行，按预算停止；`geo-visibility-trial` 是只问第一个启用提示词的同一任务，类型单独，定时任务按 `geo-visibility` 计算间隔，清理旧任务时也保留最近的完整运行）。定期运行由 `GeoTracking.scheduleDays` 决定。

### 本机内容 worker

- 后台接口：`POST /api/local-content-worker`（Bearer `LOCAL_CONTENT_WORKER_TOKEN`），动作有 `heartbeat`、`claim`、`complete`、`fail`；租约 120 秒，worker 每 30 秒续约。
- `local-worker/` 是跨平台 Node 实现；Windows 套件里的 PowerShell worker 使用同一协议。

### 扩展

自定义部署只在 `extensions/index.ts` 挂接自己的代码，不改公共文件。`registerExtensions()` 在每个执行任务的进程里运行一次（Next.js 服务器、worker、MCP），可以注册：

- `registerJobHandler`（`lib/jobs/handlers.ts`）：自定义任务类型
- `registerSchedule`、`registerScheduleFilter`、`registerSchedulerTask`（`lib/jobs/scheduler.ts`）：定时规则
- `setCrawlPolicy`（`lib/jobs/policy.ts`）：站点此刻能否开始抓取
- `setSitePolicy`（`lib/site-policy.ts`）：能否添加或修改站点，以及添加、删除站点后的处理

### Bing Webmaster Tools

在 Bing Webmaster Tools 的 **设置 → API 访问** 生成 API Key（一个 Key 对应账号下所有已验证站点），在 A-Border SEO 的 **设置 → 服务连接** 保存，再到站点设置里选择对应的 Bing 资源。Bing 的查询和页面统计按周（截止到周五）汇总，且不接受日期范围；只有抓取统计里的 `CrawledPages` 是每日数值。

## MCP 包

`packages/mcp` 包含 MCP 工具、stdio 和 HTTP 两种运行方式，以及 `/mcp` 路由使用的处理程序。它只通过 `/api/v1` 读取数据，不引用应用代码（`packages/mcp/src/tools.test.ts` 会检查）。它不是 npm workspace，使用根目录的 `node_modules`：

```bash
node packages/mcp/build.mjs        # 生成 packages/mcp/dist/cli.js
```

## Docker 镜像

```bash
docker build -t a-border-seo:1.1.2 .
```

镜像包含网页应用（默认命令 `node server.js`）、worker（`node worker.cjs`）、抓取复查脚本（`node review-crawl.cjs`）和 Prisma CLI（`node node_modules/prisma/build/index.js migrate deploy`）。构建的大部分步骤在无网络环境下执行，字体等资源都随代码提供。

## 发布

1. 更新 `package.json` 和 `packages/mcp/package.json` 的版本号（`lib/version.ts` 在构建时读取它），并写好 `CHANGELOG.md`。
2. 本地执行 `npm ci && npx prisma generate && npx tsc --noEmit && npm test`。
3. 打上 `v<版本>` 标签。`.github/workflows/docker-publish.yml` 会在 amd64 和 arm64 上构建、启动测试，然后发布到 GHCR。

## 常见问题

- **数据库连接失败**：确认 PostgreSQL 在运行（`docker compose ps`），并核对 `.env.local` 里的 `DATABASE_URL`。
- **找不到 Prisma Client**：执行 `npx prisma generate`。
- **Google 登录失败**：核对 Client ID、Secret，以及 Google 控制台里的回调地址与 `NEXTAUTH_URL` 是否一致。
