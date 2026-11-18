# A-Border SEO 服务器业务包

此目录把现有 SEO 业务编译成可在 Linux 服务器直接运行的发行包：Next.js standalone、普通 worker、Prisma CLI、schema 与迁移文件。Docker 只用于开发机上的隔离构建，最终服务器运行 Node.js 进程；客户端不需要为了服务器工作台安装 Docker。管理服务和本机 Codex worker 的代码不包含在业务包内，它们各自部署或随桌面安装。

## 前置条件与目录

当前目标为 Linux x86-64、glibc **至少 2.36**、OpenSSL 3、`/usr/bin/node` 的 Node.js 24，以及已有 PostgreSQL 16 数据库和客户端工具。不是通用任意 Linux 二进制，也不支持 Alpine/musl。部署脚本需要 systemd、Python 3、runuser；不下载安装 Node.js、PostgreSQL 或修改已有数据库服务设置。

| 路径/端口 | 用途 |
| --- | --- |
| `/opt/aborder-server/releases/bundle-<SHA前缀>/` | root 所有的不可变业务程序包 |
| `/opt/aborder-server/current` | 当前程序软链接 |
| `/etc/aborder-server/server.env` | root 所有、0600 的完整业务配置；脚本不会改写 |
| `/var/lib/aborder-server/` | 无登录权限的 aborder-server 账号数据目录 |
| `/var/cache/aborder-server/next/` | 可写 Next 缓存，与程序目录分离 |
| `/var/backups/aborder-server/<时间-随机标识>/` | root 独占的数据库与配置备份 |
| `127.0.0.1:18330` | 业务 HTTP；只供同机 HTTPS 代理访问 |
| `127.0.0.1:18085` | 管理服务公开协议的本机上游端口 |
| `127.0.0.1:18086` | 管理服务内部策略端口，绝不由 Nginx 转发 |

数据库应使用独立业务库和非超级用户角色，连接限定为字面量回环地址，Prisma schema 使用 public。部署账号需要对自身业务 schema 执行迁移的权限，普通业务角色不需要 CREATEDB。恢复脚本仅在新库创建时使用本机 postgres 系统账号；不修改 PostgreSQL 的全局配置或其他网站数据库。PostgreSQL 应只监听回环地址并通过 SCRAM 密码认证，不把 5432 暴露公网。

## 构建发行包

源代码、Prisma 迁移及版本号最终确定后，在仓库根目录运行：

```powershell
node server/build.mjs --run F:/A-border-SEO/reports/hosted-server-bundle-1.5.0 desktop-linux
```

输出目录须为空或不存在；最后参数是可选 Docker context。此命令用 `node:24-bookworm-slim` 构建 linux/amd64，导出 `aborder-seo-server-1.5.0-linux-x64.tar.gz` 和 `SHA256SUMS`。不接触已安装客户端、数据库或服务器。编译阶段禁用网络；依赖安装与 Prisma 引擎获取发生在之前的构建层。构建上下文只包含 source 与部署工具，并排除环境文件、密钥、node_modules、本机构建物和数据库。

发行包包含每个程序文件的 SHA-256、依赖中的受限软链接、运行时要求及每项 SQL 迁移校验值。传输后应从可信构建结果核对 tar 的 SHA-256，不接受从不可信下载地址同时获得的未核验摘要。部署工具会拒绝归档路径穿越、绝对路径、越界软链接、向软链接目录写入、重复条目、非普通文件及文件校验不一致。

## 首次准备

先由运维准备已有 Node 24、PostgreSQL 16、TLS/Nginx 和管理服务。将此目录的受信部署工具放在服务器临时目录，然后：

```sh
sudo /usr/bin/node server/deploy/install.mjs --run
```

安装器只创建无登录权限的 aborder-server 服务账号、目录和四个 systemd 单元并 daemon-reload，不启动服务，不初始化或迁移数据库，不覆盖已有不同内容的单元，不创建配置或随机替换密钥。

参照 `deploy/server.env.example` 创建 `/etc/aborder-server/server.env`，所有者 root、权限 0600。环境文件只用 `KEY=value` 或简单 JSON 双引号值，不写 export、重复键、尾行注释或多行值。配置中的 `ABORDER_HOSTED=1`、公网 HTTPS `NEXTAUTH_URL`、回环 `DATABASE_URL`、回环内部管理 URL 和专用内部 secret 必须正确。管理与业务服务使用同一个内部随机 secret，但该 secret 与账号密码、签名密钥及数据库密码分开。

**迁移已有数据时必须原样保留 NEXTAUTH_SECRET（或原 AUTH_SECRET）**；它也是 Google/Bing/其他 provider 凭据的加密根，换掉会令已有加密数据无法读取。保留 Google OAuth、SMTP 和其他已有设置。部署和回滚脚本不会修改任何环境内容，并检查操作前后文件摘要相同。不要把原本机设备 token、共享 LOCAL_CONTENT_WORKER_TOKEN 或单一 managed-policy 身份放入多租户服务器配置。

管理服务迁服时 `ABORDER_CONTROL_ORIGIN=https://aborder.tuitehao.shop`，保留 `ABORDER_CONTROL_ISSUER=https://aborder.nxitek.cn`、原签名密钥及完整控制库。具体 CP 迁移和旧地址兼容代理另行执行，不在业务脚本内。业务包安装前内部 authenticate/account-policy/receipt 路由必须已准备好。

systemd 为 Web 设置 1536 MiB 内存上限与 100% CPU 配额，为 worker 设置 2048 MiB 与 150% CPU 配额；这只是初始运行约束，不是用户容量承诺。worker 固定长/短任务并发各 1，网页进程关闭 inline worker。两个进程使用 PrivateTmp、只读程序目录及专用可写数据/缓存目录。可按隔离压测结果审查调整单位限制；不要直接把用户数换算成保证容量。

## 备份、迁移与发布

以可信发行摘要执行：

```sh
sudo /usr/bin/node server/deploy/manage.mjs deploy /tmp/aborder-seo-server-1.5.0-linux-x64.tar.gz <64位SHA256> --run
```

脚本按以下顺序执行：

1. 获取互斥锁、核对环境 ACL、归档摘要与逐文件清单、Node/glibc/PG16、数据库迁移历史，验证回环内部管理 API 与密钥可用。
2. 已应用的每项数据库迁移必须仍存在且 SQL 校验值相同；未完成/失败的迁移会阻止继续。
3. 先停止 worker，再停止 Web。创建完整 PostgreSQL custom-format dump，校验 pg_restore 目录可读，备份原环境文件、当前发布路径、迁移记录与摘要；备份盘空间不足则中止。
4. 仅在备份完成后执行 Prisma `migrate deploy`，不使用 db push。配置文件不变，数据库连接不切换。
5. 原子切换 current，启动 Web，验证 `/api/health` 的数据库、实际版本和 hostedMode，再启动 worker 并检查其独立 PrivateTmp 中的数据库心跳。
6. 全部通过后启用业务服务和每日备份 timer。输出只包含版本和备份目录；失败输出只给固定说明，原始操作日志只写 root 备份目录。

若发布失败且迁移记录及环境文件摘要**完全未变**，可自动恢复原程序及先前运行状态；升级前关闭的 worker 或 Web 不会被短暂启动。若配置改变、迁移记录变化或无法确定，业务保持停止，保存新旧程序、数据库和备份现场；不会盲目恢复旧库或在不兼容 schema 上启动旧代码。首次部署失败且无旧程序时也保持停止。此行为会造成明确停机窗口，应在维护策略下安排。

只回退程序时使用：

```sh
sudo /usr/bin/node server/deploy/manage.mjs rollback /opt/aborder-server/releases/bundle-<旧摘要前缀> --run
```

回退目标必须与当前数据库的已完成迁移集合和校验值完全一致。回退前仍先做新备份；不自动降数据库。不同迁移版本必须按恢复方案处理，而不是手工改 current 软链接。

## 备份和恢复

手工备份：

```sh
sudo /usr/bin/node /opt/aborder-server/current/server/deploy/manage.mjs backup --run
```

每日 timer 约在服务器当地 03:40 执行，附加最多 15 分钟随机延迟。备份包含数据库 dump、原 server.env、程序路径、迁移 ledger 和校验值；COMPLETE 只在校验通过后创建。备份环境文件含敏感信息，目录权限为 0700、文件 0600。当前脚本不自动删除历史备份，应监测空间并制定离机加密备份与保留方案。CP 的 SQLite/签名密钥仍按 CP 独立备份方案保存。

恢复总是指向一个**不存在的新数据库**：

```sh
sudo /usr/bin/node server/deploy/manage.mjs restore /var/backups/aborder-server/<完整备份目录> aborder_restore_20261113 --run
```

恢复会检查备份摘要，用本机 postgres 创建由原业务角色拥有的新库，再以业务角色还原并核对迁移历史。不会执行 --clean，不覆盖或删除当前业务库，不修改 server.env，不启动或切换服务；失败的新库也保留供检查。核验新库的账号、站点、授权归属、凭据解密、任务和数据后，再由运维在维护窗口停止 Web/worker，保留当前库的新备份，使用与恢复库一致的程序和原加密密钥显式切换数据库配置。涉及已注册多租户身份映射的数据迁移须单独验证，不能用数据库名称变更代替账号归属迁移。

脚本使用 `/run/lock/aborder-server-operation` 排他锁；异常终止可能留下锁。只有确认记录 PID 已结束、没有迁移或备份进程仍运行后，才能人工清除该精确锁目录。脚本不自动删除无法判断的新旧锁。

## HTTPS 代理边界与验收

公开 `/admin`、`/admin/…`、`/v1/…`、`/assets/admin.js`、`/assets/admin.css` 代理到管理服务 18085；业务页面及 `/api/…` 代理到 18330。维护管理 API 和业务同域时必须保留这些精确路径。Nginx 应保留 Host/Origin，并为业务正确设置 X-Forwarded-Proto；公网只能开放 HTTPS/必要 ACME。显式拒绝 `/internal/…`，绝不能代理 18086。原管理域名兼容代理不由这里的脚本创建。

脚本验证启动健康不等于业务验收。正式开放前仍需独立测试注册审核、两个账号/设备隔离、实际业务请求、站点/GSC/Bing、普通任务及本机 Codex worker 的策略执行、维护/撤销/到期/令牌轮换、HTTPS cookie/OAuth 回调和实际备份恢复。不得把仅完成构建、未部署或未接入客户端的能力报告成已能远程控制。

开发机可执行不接触服务器的验证：

```sh
node --test server/test/*.test.mjs
python -B server/test/test_archive.py
node --check server/deploy/manage.mjs
```

这些测试覆盖配置解析、数据库范围、迁移防降级、程序完整性、归档安全、配置变化时禁止自动回退，以及仅恢复原本活动的服务；实际 Linux systemd/PG16 部署、恢复和资源限制仍需目标环境隔离联调。本目录准备阶段没有运行构建、安装 PostgreSQL或连接服务器。
