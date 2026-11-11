# A-Border SEO Windows 本机套件

在自己的 Windows 电脑上运行 A-Border SEO：应用和数据库都在 Docker Desktop 里，网页只监听本机（`http://localhost:3300`），配置和密钥只保存在本目录。所有操作都是双击 `.cmd`，整个目录可以放在任意位置。

## 需要准备

- Docker Desktop（使用 Linux 容器）
- PowerShell 7（`winget install --id Microsoft.PowerShell`；装了 Codex 桌面版的电脑通常已自带）
- 可选：Codex 桌面版，用于账号模式和本机内容 worker
- 一个 Google OAuth 客户端（Web 应用类型），回调地址 `http://localhost:3300/api/auth/callback/google`

## 第一次安装

1. **构建镜像.cmd**：用旁边的 `source` 目录构建 `a-border-seo:<版本>` 镜像。第一次要下载基础镜像和依赖，需要几分钟。
2. **配置Google.cmd**：生成 `.env`（自动填好随机的数据库密码和应用密钥），输入 Google Client ID 和 Secret，然后自动启动。第一次启动会提示新建数据库，输入 `NEW` 确认。
3. 浏览器打开 `http://localhost:3300`，用自己的 Google 账号登录并添加站点。
4. **关闭新用户注册.cmd**：之后只有已登录过的账号能再登录。

从旧版本升级请看安装包里的升级说明，先运行 **迁移旧数据.cmd**，不要在新目录里直接新建空数据库。

## 日常使用

| 启动器 | 作用 |
|---|---|
| 启动服务.cmd | 启动数据库、应用和后台 worker；镜像有新的数据库结构时，先自动备份再升级 |
| 停止服务.cmd | 停止全部服务，数据保留 |
| 备份.cmd | 导出数据库到 `backups\<时间>\database.dump`，并用 Windows 当前用户加密保存一份 `.env` |
| 恢复演练.cmd | 把最新的备份恢复到一个隔离的临时数据库（无网络、不发布端口）并逐表核对记录数，正式数据库不受影响 |
| 检查本地部署.cmd | 检查服务状态、端口绑定、数据库计数、Codex 登录，以及你自己的 Codex 配置是否保持不变 |
| 构建镜像.cmd | 源码更新后重新构建，并把 `.env` 改为使用新镜像 |

## AI 助手

| 启动器 | 作用 |
|---|---|
| 更新MCP密钥.cmd | 在后台 **设置 → MCP** 创建访问密钥后，验证并加密保存到本机 |
| 检查MCP.cmd | 不调用模型，验证 MCP：错误密钥被拒绝、工具列表、读取站点 |
| 登录ChatGPT.cmd | 登录本套件专用的 ChatGPT 账号（保存在 `codex\chatgpt`，与平时使用的 Codex 分开） |
| 账号模式.cmd | 以 ChatGPT 账号启动 Codex，只读沙箱，可调用本应用的 MCP |
| API模式.cmd | 以 OpenAI API Key 启动 Codex，每次都要确认，费用计入 API 项目 |
| 验收账号模式.cmd | 让 Codex 用 MCP 读取一个站点的数据，保存脱敏的调用记录；可加站点域名参数，例如 `验收账号模式.cmd -Domain example.com` |
| 设置内容Worker.cmd | 生成内容 worker 令牌（写入 `.env` 并加密保存一份），之后 worker 随 启动服务.cmd 一起启动；加 `-Rotate` 更换令牌 |
| 启动内容Worker.cmd / 停止内容Worker.cmd | 单独启动或停止内容 worker |

内容 worker 负责内容规划和 Codex 工作台里“Codex 本地执行”的任务：它用专用的 ChatGPT 账号在只读、无工具的沙箱里运行 Codex，只把 JSON 结果交回后台，不会改用 API 计费。日志在 `private\content-worker\worker.log`，只记录事件和错误代码。

## 可调整的设置

`.env` 里的说明见 `.env.example`。常用的几项：

| 设置 | 说明 |
|---|---|
| `LOCAL_APP_PORT` | 本机端口，默认 3300。修改时同时改 `NEXTAUTH_URL`，并在 Google OAuth 客户端里添加新的回调地址；用过 ChatGPT 连接的，在后台断开后重新连接 |
| `ABORDER_DB_VOLUME` | 使用指定名称的数据库卷（默认 `aborder-seo-local_pgdata`） |
| `GOOGLE_HTTP_PROXY` | 访问 Google 需要代理时填写，例如 `http://host.docker.internal:7890` |
| `CRAWL_MAX_PAGES`、`CRAWL_MAX_MINUTES` | 单次抓取的页数和时间上限 |
| `SCHEDULER_ENABLED` | 设为 `true` 开启每日同步、每周抓取等定时任务 |

只对脚本生效的 Windows 环境变量（在系统环境变量中设置）：

| 变量 | 说明 |
|---|---|
| `ABORDER_CODEX_BIN` | `codex.exe` 的完整路径。默认使用 Codex 桌面版自带的最新 CLI |
| `ABORDER_DOCKER_CONTEXT` | Docker 上下文，默认 `desktop-linux` |

## 目录里的文件

| 路径 | 内容 |
|---|---|
| `.env` | 本机配置和密钥，只有当前 Windows 用户可读，不要分享 |
| `private\` | 加密保存的 MCP 密钥和内容 worker 令牌（Windows DPAPI，只有当前用户能解密），以及 worker 的运行文件 |
| `codex\chatgpt`、`codex\api` | 专用的 Codex 登录目录和配置 |
| `backups\` | 备份；`env.dpapi` 只能由当前 Windows 用户解密，换电脑前请另外保存一份可迁移的加密备份 |
| `reports\` | 检查和验收记录 |

## 数据安全

- 数据库卷不由 Docker Compose 创建，而是由启动脚本在第一次启动时确认后创建，所以项目改名或执行 `docker compose down -v` 都不会删除数据。
- 数据库端口不对外发布，应用只绑定 `127.0.0.1`。
- 升级数据库结构前总会先备份；失败时数据不会被删除。
- 迁移旧数据只读挂载旧数据卷，复制出副本后在隔离环境里导出，旧目录和旧数据卷都不会被修改。
