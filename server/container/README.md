# CentOS 7 宿主上的隔离容器部署

此方案用于已审计的 Linux 3.10/CentOS 7 宿主。宿主 glibc 2.17 不直接运行 native Bookworm 包；Node 24、glibc 2.36、Prisma 和 PostgreSQL 客户端都在现代容器用户态内运行。**容器仍共享旧宿主内核**，必须先完成真实兼容性 smoke 和隔离业务验收。通过 smoke 不等于旧内核已成为受支持的现代生产环境，长期应迁移到受维护的宿主系统。

固定目录 `/www/aborder-hosted`、Compose 项目 `aborder-hosted`。脚本只检查和操作该项目，拒绝接管工作目录/标签不符的同名资源。不使用 prune、down -v、全局 stop/restart，不修改现有 16 个其他容器、已有宿主 5432、Redis、网站或数据库。

## 网络与资源

数据库只在独立 business bridge 网络中，使用本项目 database-data 卷，**没有任何宿主端口映射**。control 在该网内提供命名空间，app/worker 使用 `network_mode: service:control`，因此业务连接内部策略服务的 `127.0.0.1:18086` 属于同一个容器网络命名空间；18086 不映射宿主、不经过 Nginx。control 的公开监听在容器内 0.0.0.0:18085；app 在容器内 0.0.0.0:18330，二者只映射宿主 **127.0.0.1** 对应端口。网络允许 Google、Bing、受控抓取任务出站。

初始硬上限为 app 768 MiB/0.75 CPU、worker 1024 MiB/0.75 CPU、PostgreSQL 512 MiB/0.5 CPU、control 256 MiB/0.25 CPU。app 禁止 inline jobs，普通 worker 长/短并发各 1。它们是保护现有站点的初始预算，不是已验证容量。数据库使用 96 MiB shared_buffers、4 MiB work_mem、30 个连接上限。一次性备份工具额外最多 512 MiB，需观察目标机实际余量后安排备份窗口。

长驻业务和 control 无 root、无额外 capabilities、只读根文件系统；可写范围仅业务缓存、CP 数据卷或独立 tmpfs。数据库需要官方镜像初始化身份管理，不赋予 privileged 或宿主 Docker socket。仅一次性工具容器以 root 操作本项目卷和私密备份目录，也不挂 Docker socket。

## 1. 宿主兼容性 smoke

将 smoke-host.sh 与 smoke.mjs 放在同一目录。`smoke.mjs` 是不含秘密的测试程序，必须设为 root 所有、0644：最终 runtime 镜像以 UID10001 运行，需要读取绑定到容器 `/smoke.mjs` 的文件。宿主父目录仍可保持 root0700，宿主由 root 执行的 shell 脚本保持0600即可。不要为此放宽任何环境文件或签名私钥权限。使用已有 Docker：

```sh
bash smoke-host.sh --run node:24-bookworm-slim
```

临时容器无网络、只读根、私有 tmpfs、192 MiB/0.25 CPU。实际检查 Node 24/x64、随机加密、文件 IO、TLS 初始化、worker_threads、node:sqlite，并输出脱敏内核/glibc版本和 ok:true。失败时停止，不通过 privileged、关闭 seccomp 或放宽宿主权限来绕过。部署器还会对最终 app/control 镜像重复同样 smoke。

## 2. 在开发机构建完整镜像包

先完成已修复协议的最终 1.5.0 业务 tar，然后在仓库根目录执行：

```powershell
node server/container/build-images.mjs --run <最终业务tar绝对路径> <全新输出目录> desktop-linux
```

生成 `aborder-hosted-images-1.5.0.tar`、`SHA256SUMS` 和 `compose.pins.env`。包含 Linux amd64 app（Node 24、业务包、PG16 客户端）、control（Node24、完整CP迁移与原协议代码）及 PostgreSQL16 镜像。版本化的 `aborder-hosted-*` 标签避免加载时覆写其他项目常用的 PG 标签；正式部署使用三个 immutable sha256 image IDs，Compose `pull_policy: never`。

root 将镜像 tar 和摘要传到服务器，核对 SHA256 后 `docker load --input <镜像tar>`。这只导入镜像，不重启现有容器。把本目录 compose.yml/manage-host.sh/smoke-host.sh/smoke.mjs 复制到 `/www/aborder-hosted/`；root 所有，目录0700，脚本无需执行位（用 bash 调用）。需要 Docker Compose v2；脚本不自行安装或升级 Docker。

上传工具可能默认把所有文件设为0600；须单独将公开测试程序 `/www/aborder-hosted/smoke.mjs` 改为0644，其他私密文件继续遵循下述权限。

也可只在开发机运行 `node server/container/build-images.mjs --prepare-only <最终业务tar> <新输出目录>`，不调用 Docker。输出 build-context 含 bundle.tar.gz、Dockerfiles、完整 CP 代码/迁移和小型工具。将其中除 bundle.tar.gz 外的小文件打包上传，复用已传到服务器的最终 tar并命名为同目录 bundle.tar.gz。然后在服务器运行 `bash build-on-host.sh --run <业务tar SHA256> 1.5.0`。主机无需 Node，全部校验及工具依赖在 Docker 构建层中执行。此构建不编译 Next，只提取已完成业务包并组装镜像，不启动服务；完成后生成相同 compose.pins.env。

## 3. 私密配置和原管理身份

创建 config、import、backups 三目录，root 所有0700。按 config.examples.txt 分别创建 application.env、database.env、control.env，root所有0600；将 builder 的 compose.pins.env 原样复制为 config/compose.env，0600。原签名私钥保存到 config/signing.pem，root:10001、0440，只有该文件绑定给 UID10001 的 control。不要输出文件内容。

必须原样保留迁移数据所用 NEXTAUTH_SECRET、Google/Bing/provider 配置、原 CP 签名私钥、signing key ID、完整 CP SQLite 一致性快照以及固定 issuer `https://aborder.nxitek.cn`。公开 origin 改为 `https://aborder.tuitehao.shop`。内部 secret 是两服务共用的独立32字节随机base64url值，不能复用数据库或用户密码。业务 DB role 为 aborder、密码放在 application.env 的 URL中（URL转义）；database.env 的 postgres 管理密码是另一个独立随机值，至少16字符。

把通过旧 CP 在线备份接口生成的 `control.sqlite` 放到 import/，root0600，并从可信备份记录取其 SHA256。不能复制仍写入中的裸 SQLite 文件而遗漏 WAL。执行：

```sh
cd /www/aborder-hosted
bash manage-host.sh import-control <原CP一致性快照SHA256> --run
bash manage-host.sh prepare --run
```

import-control 仅接受完全空的 control-data 卷，不覆盖已有身份；不会初始化一个替代旧账号的新库。prepare 对原控制库先做不会执行迁移的 SQLite 在线快照，再只启动本项目数据库/control，初始化无超级用户/CREATEDB/CREATEROLE 权限的业务角色，核对内部鉴权路径。数据库不映射宿主5432。此时 app/worker 尚未启动。已有账号或应用数据的 PostgreSQL迁入需用经过验证的 dump/恢复流程，并单独验证多租户账号映射，不能用新空库冒充已迁移。

首次业务导入使用独立宿主脚本 `import-business.sh`（root0600，无需重新构建镜像）。将可信 custom-format dump放到固定 `/www/aborder-hosted/backups/initial-import/database.dump`，目录root0700、文件root0600，再运行 `bash import-business.sh --run <源dump的64位SHA256>`。脚本获取同一部署flock，拒绝app/worker仍运行，要求database/control已健康；两侧重复核验dump摘要、确认目标aborder无用户relation并由无超级权限的aborder应用角色拥有，再以该角色执行 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`。成功后核对relation owner并调用只读 migration compatibility check，不迁移、不启动服务、不更改配置。错误详情只写initial-import目录下root0600日志；迁移兼容检查失败时保留已导入数据库供审查，业务继续停止。

## 4. 发布与失败恢复

```sh
bash manage-host.sh deploy /www/aborder-hosted/config/compose.env --run
```

之后升级可给另一个 root0600 的新 pins 文件。脚本禁止同时更换 PG 引擎 image ID，数据库大版本升级须单独审查。按顺序停止本项目 worker/app，备份 PG dump、CP 一致性快照、完整原配置/签名私钥、旧 image pins 与两套 schema 记录，再校验 migration checksum。只删除标签和路径已核对的**精确已停止 app/worker 容器**且不带 -v，保留所有数据卷，随后替换 control 网络命名空间。先检查内部策略连接，再显式执行业务 migrate deploy，最后启动 Web/worker并检查实际版本、hostedMode 和 worker 的数据库心跳。

从旧版本升级时，先将本版宿主脚本 `manage-host.sh` 安装到 `/www/aborder-hosted/`（root 所有，0600）。脚本在停止任何业务容器前记录 Web 和 Worker 的运行状态。停服务或备份过程中失败，会重新启动原先在运行的容器，逐个检查健康状态，并以原始错误码退出。日志会单列恢复失败的服务。只有完整校验过的备份才有 `COMPLETE` 标记。

进入镜像替换阶段后，脚本核对环境摘要、PG 迁移记录和控制库 schema。三者可读且一致时，恢复旧镜像并启动原先运行的服务。如果发生结构变化或检查失败，脚本保留数据库和备份、停止业务，等待选择与当前结构兼容的恢复镜像。

程序回滚也需要备份及完整兼容检查：

```sh
bash manage-host.sh rollback /www/aborder-hosted/backups/<备份ID>/compose.env --run
```

它要求目标程序的业务迁移集合与现库完全一致，control镜像也必须支持当前CP schema。所有失败日志或备份均保存在root私密目录；脚本不把密码放入命令行或公开日志。

## 5. 备份和隔离恢复

```sh
bash manage-host.sh backup --run
bash manage-host.sh restore <备份ID> aborder_restore_20261113 --run
```

备份包括 PostgreSQL custom dump、migration记录和校验、不会迁移原库的 SQLite snapshot、业务/数据库/控制环境、签名私钥与 image pins。COMPLETE只在全套备份完成后产生。没有自动删除备份，必须监控 `/www` 余量并配置独立离机加密副本和保留策略。

restore 只创建从未存在过的 aborder_restore_* 新数据库，由原业务角色拥有，核对 dump摘要和恢复后的迁移记录。没有 --clean、DROP或覆盖当前库，也不切换应用配置。目前此分支使用 --exit-on-error，未使用 --single-transaction；失败会保留可能部分恢复的新库，不能将其视为成功。迁移记录一致也不代表所有业务行数、账号归属或凭据解密均已验证。核对数据/凭据解密/租户归属后再计划维护切换。CP恢复也必须先在新的独立 volume/隔离项目中验证快照、原issuer与签名密钥，不能直接覆盖仍可用的 control-data；本脚本故意没有原地覆盖CP数据命令。PG和CP分别取得一致性快照，不是跨两库的同一个事务时间点。

每日备份使用本目录 `daily-backup.sh` 和 `aborder-hosted-backup.cron`；具体安装、状态检查和一次性隔离恢复见 [OPS.md](OPS.md)。没有自动删除备份或日志，也没有自动停止业务。脚本把详细输出写入root0600日志，只向系统日志发送固定摘要。部署flock冲突也会使该次备份失败，查看状态后人工补跑，不擅自打断发布。

旧域名兼容反代、Nginx/TLS新域名、账号迁移与公网客户接入仍由单独部署流程完成。Nginx只访问宿主loopback18085/18330，并明确拒绝/internal路径。不得把仅构建或仅启动服务报告成完成所有客户端远程控制验收。
