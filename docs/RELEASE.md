# A-Border SEO 发行指南

稳定版同时发行连接 `aborder.tuitehao.shop` 的 Windows x64 客户端、服务器部署用的 Linux amd64 镜像归档和通用 GHCR 镜像。生产服务器的 app、worker 和管理服务使用归档内的不可变镜像。用户电脑仅运行桌面应用和本机内容 worker。

## 准备下一版

从仓库根目录运行以下命令。示例日期应替换为计划发行日。

```powershell
node scripts/version.mjs bump patch 2026-11-12
node scripts/version.mjs check
```

`source/package.json` 是版本的权威来源。脚本同步应用、桌面端、MCP 包和对应锁文件，并更新 Docker 本地镜像默认值。版本可用 `bump major`、`bump minor`、`bump patch` 递增，或用 `set 1.2.0 2026-11-12` 指定。

编辑 [CHANGELOG](../source/CHANGELOG.md) 新版本段落，列出变更、配置或重新授权要求以及数据库迁移。涉及数据结构时，提交新的 Prisma migration。发版前执行以下检查。

```powershell
Push-Location source
npm ci
npx prisma generate
npx tsc --noEmit
npm test -- --pool=forks --maxWorkers=2
Pop-Location
Push-Location desktop
npm ci
npm test
Pop-Location
```

## 在本机打包 Windows 测试版

### 官网的手动下载渠道

官网页脚的「软件发布」打开 [软件下载目录](https://nxitek.cn/software/)。「A-Border SEO」指向[独立下载页](https://nxitek.cn/software/seo/)。桌面工作台是另一个产品，它有独立的版本和下载地址。

日常开发在本机 `F:\A-border-SEO` 进行。`desktop/` 是 Windows 客户端，`source/` 是工作台和任务代码，`control-plane/` 是账号与设备管理服务，`server/` 是服务器部署工具。`desktop/website/` 存放 SEO 下载页模板和样式，`source/CHANGELOG.md` 记录发行说明。提交并推送到经确认的 Git 远程仓库后，其他维护者才能从远端取得对应的源码。

完成本节下面的 Windows **服务器模式**打包及校验后，在仓库根目录运行以下命令。示例采用默认产物目录 `desktop/dist`，若构建到专用发行目录，将 `$dist` 指向该目录。校验工具需要本机安装 7-Zip。正式签名构建应使用该版发行流水线生成的 `desktop-release.json`。

```powershell
$version = node scripts/version.mjs check
$dist = "desktop/dist"
$site = "reports/website-release-$version/site"
if (-not (Test-Path -LiteralPath "$dist/desktop-release.json")) {
    # 仅适用于上面使用 --local --hosted 构建的未签名包
    node scripts/release-manifest.mjs --local --hosted --output "$dist/desktop-release.json"
}
pwsh -NoProfile -File scripts/verify-website-installer.ps1 -Version $version -OutputDirectory $dist -SevenZipPath "D:/7-Zip/7z.exe"
node scripts/build-software-page.mjs $dist $site
python scripts/publish-software-page.py $version --site-dir $site
```

首次在维护机发布前，创建本地文件 `scripts/private/website-publish.json`，例如 `{"host":"deploy@downloads.example.com","key":"~/.ssh/website_deploy"}`。填入该机使用的 SSH 目的地和密钥路径。`private/` 已加入 Git 忽略规则。

下载页生成器读取安装包的实际版本、签名和 SHA-256。发布命令使用上述配置（可用 `--key` 指定另一密钥路径），先传完整安装包和校验文件，再替换 SEO 产品页。旧版下载地址继续有效。同一版本号对应唯一安装包，重建出不同文件时须提升版本号。发布成功后，从官网实际下载一次并核对 SHA-256。

| 需要更新的内容 | 维护位置 |
| --- | --- |
| Windows 客户端及官网下载 | 在本机打包，再按上面的命令发布到国内官网。安装包公开路径为 `/software/releases/a-border-seo/<版本>/`。 |
| SEO 下载页文字、布局 | 修改 `desktop/website/seo.html` 或 `seo.css`，用原版本的已校验安装包重新生成并发布。 |
| 网站页脚、两款软件的目录入口 | 官网项目 `F:\nxitek.cn\maintenance\software-release\README.md` 记录路由与发布方式。共享目录页模板在 `F:\create\desktop\website\index.html`。 |
| 线上业务功能、数据库和普通 Worker | 通过服务器升级流程部署到 `aborder.tuitehao.shop`。官网上的安装包独立发布。 |
| 客户端更新策略 | 在管理后台设置发行版本和分配范围。未签名的官网安装包通过手动下载安装进行升级。 |

国内官网实际静态根目录为 `/www/wwwroot/aborder/backend/public/software/`。SEO 只发布 `seo/index.html`、带内容哈希的专属资源和分版本安装包。源码、SSH 密钥、管理配置和数据库备份留在各自的开发或运维目录。

### 构建步骤

开发者需要 Node.js 24 与 npm。在 Windows x64 上从仓库根目录运行：

```powershell
npm --prefix desktop ci
node scripts/stage-management-config.mjs <公开管理信任配置.json>
node scripts/release-manifest.mjs --local --hosted
npm --prefix desktop run package:win
$version = node scripts/version.mjs check
pwsh -NoProfile -File scripts/verify-installer.ps1 -Hosted -Version $version
```

产物位于 `desktop/dist/A-Border-SEO-Setup-<version>-x64.exe`，同目录包含 `latest.yml`、安装包的 `.blockmap` 和解包目录 `win-unpacked`。本地打包命令带 `--publish never`。`--local --hosted` 生成仅供安装验证的清单。旧 Docker 客户端的开发构建须显式设置 `ABORDER_DESKTOP_MODE=local-docker`，再准备 PowerShell 和本地镜像清单。正式 tag 工作流固定使用服务器版。

在没有现有 A-Border SEO 安装、快捷方式和数据的 Windows 测试账户上，可以给验证命令追加 `-InstallSmoke`。脚本执行静默安装与卸载，并核对临时用户数据标记仍存在。

## GitHub 与签名配置

- 在 `xiaobaikekishuo/A-Border-SEO` 启用 Actions。镜像名为 `ghcr.io/xiaobaikekishuo/a-border-seo`。首次构建后，在 GitHub Packages 给该镜像设置 **Public** 并确认仓库拥有 Actions 写权限。镜像读取检查使用全新的 Docker 配置匿名拉取指定摘要。
- 将 Windows 代码签名证书（PFX 的 base64 或 electron-builder 支持的可下载证书位置）配置为 Actions Secret `WIN_CSC_LINK`，将证书密码配置为 `WIN_CSC_KEY_PASSWORD`。将证书发布者名称配置为 Actions Variable `ABORDER_WINDOWS_PUBLISHER`，值应与 Authenticode 签名证书的 Common Name 一致。签名由 Windows runner 完成，打包前不向安装包提供凭据。
- 将管理服务 HTTPS 地址、产品标识和授权公钥放入 Actions Variable `ABORDER_MANAGEMENT_CONFIG_JSON`。签名发行包使用此配置注册和获取策略。配置与首次接入见 [受管桌面版](MANAGEMENT.md)。
- 缺少签名证书、发布者名称或管理信任配置时，tag 工作流会失败。分支 CI 的未签名 NSIS 使用一次性测试公钥。

证书参数见 [electron-builder v26 Windows 签名文档](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。镜像访问配置见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 准备发行与发布

普通分支推送和 PR 运行根目录 `.github/workflows/check.yml`。Windows 检查验证安装器和卸载时的数据目录保留。Linux 检查在独立 PostgreSQL 数据库重建 1.1.2 的表结构，验证备份恢复、目标迁移、示例记录保留、测试凭据解密、应用版本和普通 worker。准备发行时，给已审阅的提交打稳定版本 tag 并单独推送 tag。

```powershell
$version = node scripts/version.mjs check
$tag = "v$version"
node scripts/version.mjs check $tag
git tag -a $tag -m "A-Border SEO $tag"
git push origin $tag
```

`.github/workflows/release.yml` 从同一个 tag 提交执行检查并推送已完成启动测试的两种架构镜像，然后发布语义版本镜像索引。Windows runner 使用镜像索引的摘要生成清单，构建并检查安装、卸载、安装包 SHA-512 和签名。若首次匿名拉取失败，将镜像设为公开后在 Actions 中重新运行失败的作业。签名有效且匿名拉取成功后，工作流将全部文件一起上传至 GitHub Release 草稿。

草稿包含安装包、`latest.yml`、`.blockmap`、`desktop-release.json`、`RELEASE-NOTES.md`、`aborder-hosted-images-<版本>.tar.gz`、`aborder-hosted-ops-<版本>.tar.gz`、`compose.pins.env` 和 `SHA256SUMS.txt`。清单记录客户端类型、工作台域名、桌面与后台版本、提交、通用镜像 digest、适用架构和 Prisma 迁移目录。部署归档包含工作台、管理服务和 PostgreSQL 镜像，pins 文件列出各镜像的本地内容 ID。同版本运维包包含宿主升级、连接采样和核验脚本。发布前检查草稿和安装包，并在独立 Windows 环境按下节测试。

```powershell
gh release view $tag --repo xiaobaikekishuo/A-Border-SEO --json isDraft,assets,url
gh release edit $tag --repo xiaobaikekishuo/A-Border-SEO --draft=false --latest
```

公开后使用新的版本号发布任何修改。先在服务器核对 SHA256SUMS、加载托管镜像归档，按容器部署手册完成备份、迁移和版本健康检查。使用配套运维包中的 `manage-host.sh deploy-release` 升级已安装服务器，执行时继承现有 PostgreSQL pin。工作台与管理服务切换到对应版本后，管理员将已验证的版本分配给测试组。 [服务器容器部署](../server/container/README.md)

## 安装版升级验收

1. 选两台隔离 Windows x64 测试机，记录各自安装标识和原版本，保留同一用户配置。将两台设备加入试点组，发布策略的桌面和后台最低版本先留空。已签名客户端须验证与目标安装包相同的发布者。
2. 从服务器镜像归档恢复演练数据并升级共享后台。验证数据库数据、工作台健康版本和普通 worker 心跳。升级脚本的停服、备份、迁移和失败恢复都在服务器执行。
3. 一台设备从旧签名版本按分配的 tag 检查、下载和安装。旧未签名客户端需要从正式 Release 下载已签名的安装程序，核对签名并覆盖安装。在另一台设备上验证这条手动路径并打开新版客户端。
4. 管理后台应出现两个不同安装标识。桌面运行版本和后台健康版本都等于已分配版本时，设备发送 `update_verified`。关闭测试管理服务后恢复，确认成功回执可以补送。同一设备重启后，成功数保持一条。测试取消、下载失败、后台版本落后及政策暂停的情况。
5. 两台 Windows 测试机的安装、版本上报、成功回执和服务端恢复都完成后，再单独决定扩大范围或提高最低版本。自动化测试中的临时配置仅用于验证协议和重试逻辑。
