# 容器备份运维

以下命令只适用于已核对的 `/www/aborder-hosted` / Compose项目 `aborder-hosted`。由root执行，不连接现有其他项目，不需要重建镜像。

## 排查菜单高峰时的数据库连接

在业务繁忙时段，从项目运维目录运行 `bash sample-connections.sh 120 5`，每五秒采样一次，持续约十分钟。输出包括整个 PostgreSQL 实例的客户端连接数、活跃数、事务中空闲数，以及普通连接的剩余名额。汇总行显示这段时间采到的最高连接数和最少剩余名额。采样排除了监控连接，不记录账号、SQL 或站点内容。采样间隔内可能出现更短的尖峰。若高峰切换菜单仍慢，可用 UTC 时间对照同一时段的页面请求耗时。

## 从发行包升级已有实例

核对发行包所有文件的 SHA256，安装随包提供的宿主 `manage-host.sh`（root 所有，0600），然后用 `docker load` 导入已核对的镜像。将发行包的 `compose.pins.env` 以 root0600 保存在暂存目录。从项目目录运行 `bash manage-host.sh deploy-release /绝对暂存路径/compose.pins.env --run`。脚本在运维锁内读取现用 PostgreSQL 镜像 ID，只更换应用和控制服务镜像，并在迁移前备份。全新安装使用发行包中的三个镜像。程序回滚仍使用对应备份的 `compose.env` 和 `rollback` 命令。

## 每日备份

上传 `daily-backup.sh` 与 `aborder-hosted-backup.cron` 至上述目录，文件均root0600。先确认原 `manage-host.sh` 也是root0600。已有backups/logs可能被早期Docker bind初始化为0755；父目录0700仍限制其他用户进入，但每日脚本会严格拒绝。对已有目录逐个确认没有symlink、规范路径就是预期路径且owner为root，再仅将这些目录本身收紧为0700，不递归修改目录内容：

```sh
for directory in /www/aborder-hosted /www/aborder-hosted/backups /www/aborder-hosted/logs; do
  test ! -e "$directory" && continue
  test ! -L "$directory"
  test "$(readlink -f "$directory")" = "$directory"
  test "$(stat -c %u "$directory")" = 0
  chmod 0700 "$directory"
done
```

这些检查须在 `set -e` 的shell中执行，任何失败即停止；不存在的logs由daily脚本安全创建。然后手工验收一次：

```sh
cd /www/aborder-hosted
bash daily-backup.sh --run
cat /www/aborder-hosted/logs/backup.status
```

手工成功后，将提供的cron文件安装为新文件，不覆盖未知的已有同名任务：

```sh
test ! -e /etc/cron.d/aborder-hosted-backup
install -o root -g root -m 0644 /www/aborder-hosted/aborder-hosted-backup.cron /etc/cron.d/aborder-hosted-backup
systemctl is-active crond
```

如果同名任务已存在，先比对内容再决定更新；不要替换整份root crontab。CentOS的crond会自动加载cron.d；这里只读检查服务，不重启全局crond。`CRON_TZ=UTC`、每天19:40 UTC，即北京时间次日03:40，避免依赖宿主当前时区。该任务不自动迁移、重启、清理或删除任何文件。

日志目录 `/www/aborder-hosted/logs` root0700；每次日志 `backup-<UTC时间>-<随机值>.log` root0600。`backup.status` 保留最近一次状态，包括success、success_low_space、low_space、failed及详情日志路径。系统日志tag为 `aborder-hosted-backup`，只写固定摘要和私密日志路径，不写工具输出、配置或凭据。未配置邮件或其他外部通知；管理员需监控状态和系统日志。

备份文件系统和**本项目数据库卷所在文件系统**各自检查：不足5 GiB提示；不足1 GiB提前跳过备份、返回2，不自动删旧备份或日志。真正执行PG dump前，已有工具还要求剩余空间不少于 `max(256 MiB, 1.5 × PG数据库大小)`。这些阈值是初始保护，不替代增长监控、离机加密副本和保留策略。每日脚本单独flock防重入，内部manage脚本继续使用部署/备份共用锁；部署冲突返回失败，可待发布结束手工补跑。

`Dockerfile.control` COPY 的 `control-backup.mjs` 即使上传权限为0600，专用 `control-tools` 服务明确使用 `user: 0:0`，可以读取。常驻control UID10001不加载该工具，不应为此开放私密目录或密钥权限。

## 一次性恢复演练

选择有 `COMPLETE` 的新备份ID，例如下文用 `BACKUP_ID` 表示人工核对后的ID。目标库固定为**全新** `aborder_restore_20261113_ops`，如已存在必须选另一个唯一新名字，不能清空重用。现有恢复操作不会修改应用DATABASE_URL或启动新worker：

```sh
cd /www/aborder-hosted
bash manage-host.sh restore BACKUP_ID aborder_restore_20261113_ops --run
```

现有restore会核对dump SHA256、以应用角色恢复、核对迁移ledger；失败即退出并保留隔离库。它尚不是全套业务恢复验收：应只读确认库owner和各表owner均aborder、迁移记录、用户/站点/ManagedIdentity/HostedDevice/Google/Bing数据表行数、外键/索引有效，以及设备和ManagedIdentity的账号关联。行数应与**该快照时间的基线**比较，不能与仍写入的在线库直接比较。配置和原NEXTAUTH_SECRET保留还需单独验证加密凭据可解密，报告只记通过数量，不打印明文。

可通过**本项目database容器**的本地PostgreSQL连接做只读核验（不需要将管理口令放在命令行），例如：

```sh
compose() { docker compose --project-directory /www/aborder-hosted --env-file /www/aborder-hosted/config/compose.env -p aborder-hosted -f /www/aborder-hosted/compose.yml "$@"; }
compose exec -T database psql -X -U postgres -d aborder_restore_20261113_ops -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT current_database(), pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database();
SELECT count(*) AS wrong_relation_owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND pg_get_userbyid(c.relowner)<>'aborder';
SELECT count(*) AS unvalidated_constraints FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated;
SELECT count(*) AS invalid_indexes FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 WHERE c.relnamespace='public'::regnamespace AND (NOT i.indisvalid OR NOT i.indisready);
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', tablename, schemaname, tablename)
 FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SELECT count(*) AS unmatched_hosted_devices FROM "HostedDevice" d
 LEFT JOIN "ManagedIdentity" m ON m."userId"=d."userId" AND m.issuer=d.issuer
 AND m."productId"=d."productId" AND m."accountId"=d."accountId" WHERE m."userId" IS NULL;
COMMIT;
SQL
```

SQL示例适用于已应用1.5.0迁移的备份。旧版本备份没有HostedDevice时不得对它补迁移冒充原始恢复；按该备份schema核对。以上输出只包含计数/表名，不应改为输出账号、token或密钥。

容量允许时可暂留隔离库，记录名称、对应备份ID和结果。确需清理时，只删除刚验证过的精确名称 `aborder_restore_20261113_ops`，先在postgres库核对它的owner和连接数为0，不对任何连接执行terminate，不使用FORCE，不删除Docker卷、不触碰正式库aborder。执行前再次核对目标的备份记录；`DROP DATABASE "aborder_restore_20261113_ops";` 是仅针对此隔离库的最终命令。建议先保留，待恢复验收结果复核后再清理。
