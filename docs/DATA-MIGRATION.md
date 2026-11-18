# Windows 桌面版的数据接管、备份和恢复

## 数据位置

新安装默认使用 `%APPDATA%\A-Border SEO\data`。接管时使用控制台显示的原安装目录。安装器更新程序文件，卸载后可用原目录和 Docker 数据卷重新接管。

| 位置 | 内容 |
| --- | --- |
| 数据目录下的 `.env` | 当前镜像、Google OAuth、数据库连接、应用加密密钥和部署设置 |
| Docker 外部数据卷 | PostgreSQL 数据。保留原有 `ABORDER_DB_VOLUME`；默认是 `aborder-seo-local_pgdata` |
| 数据目录下的 `private\` | DPAPI 保护的本机凭据、Worker 状态、后台升级记录及内部测试镜像记录 |
| 数据目录下的 `codex\chatgpt\` | A-Border SEO 专用的本机 Codex 登录目录 |
| 数据目录下的 `backups\` | 数据库归档、校验信息和备份时的加密配置 |

保留原始 `NEXTAUTH_SECRET` 或 `AUTH_SECRET` 的实际值。如果两个变量同时设置，保留两者。数据库中的 Google 令牌、API Key 等数据依赖原应用密钥。备份和迁移时把数据库归档、同一部署的配置及私有凭据一起保存在受保护的位置。

内部测试版若使用本机镜像，恢复同一后台还需要保留 `private\desktop-local-image.json` 和对应的 Docker 镜像。控制器会核对镜像 ID 和版本。

## 接管同一台电脑上的旧安装

1. 用运行旧安装的 Windows 用户启动桌面版。在首次配置区选择 **选择已有安装**，打开含原 `.env` 和 `compose.local.yml` 的目录。
2. 核对预览的目录、Docker 上下文、Compose 项目和数据库卷。确认它们对应原部署，再点 **接管此安装**。控制台使用所选目录里的原配置和数据卷。
3. 在控制台启动服务。旧镜像仍可通过 **在浏览器中打开** 使用。要使用桌面登录，从对应发行版的控制台选择 **更新后台工作台**。
4. 更新完成后，核对站点、关键词、历史记录和原有服务授权。桌面窗口首次登录会建立单独的会话。Google Web OAuth 客户端保留 `http://localhost:3300/api/auth/callback/google`，GA4 桌面授权另需 `http://localhost:3300/desktop/oauth/ga4/callback`。

桌面模式使用 `http://localhost:3300`。端口占用时，先核对监听程序及选中的项目。发现项目或数据卷冲突时，检查原目录和 Docker 上下文。保留旧卷及其 `.env`，直到核对通过。

## 复制到新数据卷

需要另一个独立部署时，在同一 Docker 上下文中使用 [Windows 套件的迁移流程](../升级说明.md#从另一个目录或另一台电脑迁移)。先保存原安装的备份，等任务完成后用原安装的停止操作关闭服务。把套件放到新目录，按套件说明准备目标镜像，在目标 `.env` 选一个**尚不存在**的 `ABORDER_DB_VOLUME`，再运行新目录的 **迁移旧数据.cmd**。

确认界面显示的是预期的原目录、原卷和新卷，再输入 `YES`。脚本只读挂载旧卷，在无网络的临时容器中从副本导出，把归档写入新卷，逐表核对行数并执行目标版本迁移。归档位于新目录的 `backups\migrate-<时间>\database.dump`。新实例启动并核对通过后，可在桌面版接管它。先保留旧目录和原卷，便于回到原部署。

如果目标卷名已存在，另选一个新卷名。如果迁移中断，保留原卷、导出归档和未完成的目标卷以便排查。再次复制时使用另一个未使用的目标卷。

## 备份和隔离恢复演练

在控制台 **数据与诊断** 中选择 **备份**。数据库须处于运行状态。一次成功备份会在 `backups\<时间>\` 生成以下文件。

- `database.dump` 是 PostgreSQL 自定义格式的 `pg_dump` 归档。
- `manifest.json` 记录 SHA-256、大小及镜像信息。脚本还检查归档目录可读。
- `env.dpapi` 是用 Windows 当前用户保护的 `.env` 快照。备份时脚本会解密回读校验。

恢复演练脚本从指定备份目录读取归档并核对 SHA-256，然后把归档恢复到独立 PostgreSQL 16 容器和临时卷。容器无网络、无映射端口。脚本在正式数据库运行时逐表核对行数，并把结果写入 `restore-test.json`。如果备份后生产数据已经变化，计数差异需要用业务空闲时的新备份复核。结束时移除演练容器，保留独立演练卷。

在 PowerShell 7.3 或更新版本中，填入控制台显示的值。安装版脚本位于实际安装目录的 `resources\windows\scripts\`，使用源码时可取仓库内的 `windows\scripts\`。

```powershell
$kit = 'C:\实际安装目录\resources\windows'
$data = Join-Path $env:APPDATA 'A-Border SEO\data'
$context = 'desktop-linux'
$project = 'aborder-seo-local'
$backup = Join-Path $data 'backups\备份目录名'
& (Join-Path $kit 'scripts\restore-test.ps1') -BackupDirectory $backup -DataRoot $data -DockerContext $context -Project $project
```

## 更换电脑或 Windows 用户

在原电脑、原 Windows 用户配置文件仍可用时，另做一份可在目标设备解密的加密备份，包含 `database.dump`、其校验清单和原 `.env`。如需从 `env.dpapi` 取回备份时的配置，用原用户运行以下命令。目标文件应在原数据目录的 `private\` 中且尚不存在。脚本会生成一份私有配置文件供核对，运行中的 `.env` 保持原位。

```powershell
$recovered = Join-Path $data 'private\env-recovered.txt'
& (Join-Path $kit 'scripts\restore-env.ps1') -DataRoot $data -BackupDirectory $backup -Destination $recovered
```

在目标设备核验归档 SHA-256，将其恢复至隔离的新卷，先使用与备份数据库和应用架构兼容的版本。迁入新环境的应用配置须带上原应用密钥；数据库地址、数据库账号、数据库卷和回调按目标部署填写。核对表、站点、关键词及历史记录后，再从桌面版接管并按发行流程升级。

`env.dpapi` 和其他 DPAPI 文件依赖原 Windows 用户和配置文件。更换设备或账号时，使用可解密的配置归档导入；为本机重新配置 MCP 与内容 Worker，重新登录专用 Codex，并对过期的 Google 或 ChatGPT 授权重新登录。若原应用加密密钥已无法恢复，需在目标部署重新授权并重新录入原先加密保存的 API Key。

## 更新中断与回退

控制台的桌面更新记录位于 `%APPDATA%\A-Border SEO\desktop-update.json`。部署的后台升级记录位于所选数据目录的 `private\desktop-upgrade.json`，其中的 `backupPath` 指向迁移前归档。发生断电、重启或升级报错时，保留两个记录、原卷和备份。

1. 重新启动 Docker Desktop，使用相同的上下文、项目和数据目录。打开对应目标版本的桌面应用，查看控制台的版本和 **查看诊断**。若镜像下载或安装器启动失败，重新检查同一版本或从该 GitHub Release 下载对应安装包覆盖安装。
2. 若后台更新未完成，等待现有任务或 Compose 一次性操作退出后，用控制台的 **更新后台工作台** 重试同一目标版本。控制器从后台记录继续，校验已生成的迁移前备份，并核对 App、Worker 的镜像和后台版本。
3. 若停在迁移或健康检查阶段，核对记录里的目标版本、阶段和归档位置。先用独立环境验证归档可读，保留当前卷以便保全迁移后写入的数据。不要通过删除升级记录或停用维护状态来强制启动旧镜像。
4. 回退程序与恢复数据库分别判断。确认数据库架构兼容时，才使用旧镜像和旧安装器。架构已经变化或兼容性待确认时，把迁移前的归档恢复到独立卷，使用备份对应的应用镜像和配置验证，再决定是否切换。切换前先备份当前卷，避免覆盖升级后新写入的数据。

获取版本、镜像与安装包的对应关系见 [发行说明](RELEASE.md)。
