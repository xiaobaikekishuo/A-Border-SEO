# A-Border SEO Windows 桌面版

## 运行要求

Windows x64 和 Docker Desktop（Linux 容器与 Compose v2）。Docker Desktop 当前列出的 x64 最低构建为 Windows 11 23H2（22631）和 Windows 10 22H2（19045），同时要求系统仍在 Microsoft 服务支持期内。WSL 2 后端要求 WSL 2.1.5 或更新版本。以 Docker 官方支持的 Windows 版本和版本类型为准。 [Docker Desktop Windows 系统要求](https://docs.docker.com/desktop/setup/install/windows-install/#system-requirements)

安装包内置 Electron 和 PowerShell 7。应用和两个 worker 的运行状态分别显示在设置页中。本机内容 worker 需要可运行的 Codex CLI 和专用 ChatGPT 账号授权。可以设置 Windows 用户环境变量 `ABORDER_CODEX_BIN` 指定 CLI 完整路径，再重启桌面程序。 [Electron 45 发行说明](https://www.electronjs.org/blog/electron-45-0)

## 安装和首次启动

1. 安装带管理服务配置的 Windows x64 安装包，启动 Docker Desktop，然后打开 A-Border SEO。客户端首页提供注册和登录，新用户注册后等待管理员批准。正式发行包从 [A-Border SEO Releases](https://github.com/xiaobaikekishuo/A-Border-SEO/releases) 获取；内部验收包以维护者提供的路径为准。
2. 已有 Windows 安装时，选择含 `.env` 和 `compose.local.yml` 的旧 `windows` 目录，核对显示的 Docker context、Compose 项目与卷，再点击接管。如果原安装使用其他本机 Docker context，或控制台发现多个 Compose 项目，先展开接管选项填写原名称。旧后台可从系统浏览器打开，应用后台更新后即可在桌面工作台登录。具体步骤见 [接管、迁移与恢复](DATA-MIGRATION.md)。
3. 管理员批准后登录，受管客户端自动配置空数据库和本地服务，并直接打开工作台。发现同名已有卷时会要求在设置中选择对应的旧安装，避免覆盖已有数据。非受管自托管模式仍需配置原有 Google OAuth 登录。

注册账号登录工作台不需要 Google OAuth。使用 Google 相关功能时仍需配置自己的网页 OAuth 客户端和对应 API；旧自托管登录和 GA4 使用以下回调地址。

- `http://localhost:3300/api/auth/callback/google`
- `http://localhost:3300/desktop/oauth/ga4/callback`

后台只监听本机 `127.0.0.1:3300`，PostgreSQL 仅供 Docker 网络内服务使用。端口或授权 URL 冲突时，控制台会提示检查原安装；首版桌面控制器使用固定端口 3300。自定义端口部署仍可使用原 Windows 命令行或服务器方式。

## 登录和日常操作

- 受管版登录后直接进入工作台。原控制台收进应用菜单和托盘的“设置”，退出登录会清除工作台会话与本地授权。已注册账号的新设备也受后台设备数量上限约束。
- Google 及其他第三方授权按对应功能单独完成。旧 Google 用户的数据保留在原数据库，不会自动合并到新注册账号。
- GA4 报表在对应站点发起授权。系统浏览器完成后回到原工作台窗口，继续请求该站点的报表。
- ChatGPT 应用连接从工作台发起，授权结束后桌面显示连接状态。控制台的 **在浏览器中登录 Codex** 是本机内容 worker 的专用登录，可在完成后单独启动 worker。
- 控制台可启动或停止后台、创建备份和查看脱敏诊断。关闭窗口会隐藏到托盘，服务继续运行。托盘菜单提供 **退出并保留后台** 和 **退出并停止服务**。
- 停止、休眠或关机期间，定时任务要等服务恢复。运行中任务会按现有队列和租约规则处理。控制台遇到尚在运行的任务会延后停止或升级。

## 更新

在控制台检查并下载更新。签名发行版会先准备新版后台镜像，再下载 Windows 安装包。保存所有窗口中的修改后选择 **重启并安装**。新版桌面程序启动后，控制台继续处理后台备份、显式迁移、启动和健康检查，并分别显示桌面和后台版本。

也可以从 Releases 下载同架构的签名安装包覆盖安装，重开后选择 **更新后台工作台**。数据、OAuth 配置和数据库卷保持原有位置。后台升级失败时保留备份和阶段记录，从控制台重试原目标版本。需要恢复时，按 [接管、迁移与恢复](DATA-MIGRATION.md) 操作。

## 开发与内部安装包

在仓库根目录安装 Node 24 和 npm 后运行：

```powershell
node scripts/version.mjs check
npm --prefix desktop ci
npm --prefix desktop test
pwsh -NoProfile -File scripts/stage-powershell.ps1
node scripts/release-manifest.mjs --local
npm --prefix desktop run start
```

使用下面的命令构建本地 Windows x64 安装包。打包命令使用 `--publish never`。`--local` 清单可用于验证安装和控制台界面。需要在同一台电脑验证首次配置时，将对应版本的 Linux amd64 后台镜像标记为 `aborder-seo-internal:<版本>`，然后运行 `node scripts/release-manifest.mjs --local-image` 生成固定镜像 ID 的本机测试清单。Docker Desktop 中须保留该镜像，PostgreSQL 使用 `postgres:16-alpine`。正式包使用官方 GHCR 镜像摘要和签名更新源。

```powershell
$env:ABORDER_DESKTOP_MODE = "local-docker"
npm --prefix desktop run package:win
Remove-Item Env:ABORDER_DESKTOP_MODE
$version = node scripts/version.mjs check
pwsh -NoProfile -File scripts/verify-installer.ps1 -Version $version
```

产物位于 `desktop/dist/`，包括 `A-Border-SEO-Setup-<版本>-x64.exe`、差分文件和 `latest.yml`。签名、发布及下一版操作见 [发行说明](RELEASE.md)。

## 真实授权验收

### 注册账号添加网站（1.4.1 起）

“添加网站”默认使用“输入域名”，无需 Google 授权即可创建站点并进入 Codex 工作台、网站抓取。此类站点不会自动排队 GSC 同步，已有数据和账号归属保持不变。

需要点击、展示和排名数据时，在“从 Google 导入”或“站点设置 → Google Search Console”关联当前账号。该操作只附加 Google 数据权限，不会把 A-Border 登录切换为另一个用户。手动创建的站点可在站点设置选择同域名的已验证资源后同步。

本地安装仍需配置 Google Web OAuth 的 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`，并在 Google Cloud 客户端登记 `http://localhost:3300/api/auth/callback/google`。中央管理服务不提供 Google OAuth 凭据。未配置时界面会说明原因，手动添加不受影响。修改本地配置后需重启后台。Google 授权和实际 GSC 数据读取需使用用户自己的 Google 账号验收。

在使用测试 OAuth 客户端与独立数据库的 Windows 环境中安装带发行清单的版本。依次完成以下步骤。

1. 从桌面工作台打开 Google 登录，在系统浏览器核对并确认测试账号。回桌面后确认正确站点可见，另开浏览器检查两边会话可独立退出。
2. 从一个有测试 GA4 资源的站点发起报表请求，核对授权后返回原站点且能读取报表。另发起一次并取消，核对工作台可继续重试。
3. 在工作台连接测试 ChatGPT 账号，完成系统浏览器授权后核对状态自动刷新。在桌面控制台单独登录 Codex 并启动本机内容 worker，确认状态和诊断中的心跳或启动事件。生成任务会使用所选账号的额度。
