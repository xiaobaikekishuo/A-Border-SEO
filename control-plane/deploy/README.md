# 在已有 Nginx 的服务器运行

此目录提供 Node.js 24 与 systemd 部署配置，避免与服务器现有网站争用 80/443 端口。也可继续使用上一级的 Docker Compose 部署。

运行目录约定：

- `/opt/aborder-control/releases/<发布编号>/` 保存程序。必须包含 `control-plane/*.mjs`、`migrations/`、`web/` 和相邻的 `source/lib/managed/protocol.mjs`。
- `/opt/aborder-control/current` 指向当前发布目录，程序文件由 root 管理。
- `/etc/aborder-control/control.env` 仅 root 可读。systemd 读取此文件并传入服务环境。
- `/etc/aborder-control/signing.pem` 为 Ed25519 私钥，建议 root 所有、组为 `aborder-control`、权限 `0640`。目录权限 `0750`。
- `/var/lib/aborder-control/` 属于无登录权限的 `aborder-control` 服务账号，权限 `0700`，保存 SQLite 数据库。

环境文件填写：

```ini
NODE_ENV=production
ABORDER_CONTROL_ORIGIN=https://你的管理域名
ABORDER_CONTROL_BIND=127.0.0.1
ABORDER_CONTROL_PORT=18085
ABORDER_CONTROL_DB=/var/lib/aborder-control/control.sqlite
ABORDER_CONTROL_SIGNING_KEY_FILE=/etc/aborder-control/signing.pem
ABORDER_CONTROL_SIGNING_KID=production-1
ABORDER_CONTROL_LEASE_SECONDS=900
```

先用上一级 README 的 CLI 初始化密钥和管理员；初始化数据库后确认服务账号拥有数据库及其 WAL/SHM 文件。安装本目录三个 systemd 单元到 `/etc/systemd/system/`，确认 `backup.sh` 可执行，再运行 `systemctl daemon-reload` 和 `systemctl enable --now aborder-control.service aborder-control-backup.timer`。

现有 Nginx 使用管理域名单独的 HTTPS server，将请求代理到 `http://127.0.0.1:18085`，保留 Host 和 Origin。使用有效证书，并将 HTTP 重定向到 HTTPS，ACME 验证目录除外。修改前备份该域名配置，`nginx -t` 通过后再 reload。不要在公网监听应用端口。访问 `/healthz` 验证服务，访问 `/admin` 登录。

每日备份包含一致的 SQLite 快照、签名密钥、环境文件及程序目录记录，写入 root 独占的 `/var/backups/aborder-control/<UTC时间>/`。初次部署应运行 `systemctl start aborder-control-backup.service` 并检查结果。当前脚本保留全部备份，应按实际容量制定保留期并另存离机副本；同机备份不能应对服务器丢失。恢复前停止服务，保留当前数据库及 WAL/SHM，在新目录检验快照完整性后再替换并恢复权限。不要用旧快照覆盖仍可用的新数据库，策略序号回退会被客户端拒绝。

程序升级时先备份，再将新程序放入新的发布目录。迁移检查和隔离验证通过后切换 `current` 并重启。启动失败时回到前一个程序目录；如已发生不兼容数据库迁移，应采用事先验证的恢复方案，不能只切换程序。

服务器工作台部署时，在仅 root 可读的服务环境中加入独立随机 `ABORDER_CONTROL_INTERNAL_SECRET`，默认内部监听 `127.0.0.1:18086`。工作台服务使用相同密钥直连该回环端口，Nginx 不代理它。不要把内部接口加入公开 `location` 或把监听改成 `0.0.0.0`。如果迁移公开域名而需保留旧账号身份及租约发行方，显式设置 `ABORDER_CONTROL_ISSUER` 为原 HTTPS 源，`ABORDER_CONTROL_ORIGIN` 仍设为当前公开源。完整字段、执行回执和迁移边界见 [服务器工作台内部接口](../hosted-workbench.md)。

公网策略验收可运行仓库根目录的 `node scripts/smoke-managed-server.mjs --run`。先阅读脚本的参数及行为；它会创建带验收标签的账号和设备，测试后停用账号、吊销设备并保留审计记录，不变更全局策略。该脚本验证实际桌面策略模块，不能代替桌面界面、本地 API 和两个 worker 的端到端验收。
