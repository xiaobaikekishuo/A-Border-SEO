# A-Border SEO 管理服务

这个服务保存管理账号、设备绑定、策略、发布记录和操作回执。SEO 工作台数据、Google 授权、第三方密钥和数据库备份保存在原客户端。管理员登录与工作台 Google 登录相互独立。一次性激活码对应管理服务中的授权账号，同一受管安装中的本地 Google 用户受该安装的策略约束。

## 在服务器部署

准备一台有 Docker Compose 的 Linux 服务器，将计划使用的域名解析到服务器，并放行 TCP 80 和 443。配置使用 Caddy 申请 TLS，管理服务的 8080 端口只在容器网络中开放。

在仓库根目录使用 Node.js 24 生成签名密钥。私钥只能由服务进程及受控备份读取。输出的公开 PEM 用来制作受管客户端配置。

```sh
umask 077
mkdir -p control-plane/secrets
node control-plane/cli.mjs init-key control-plane/secrets/signing.pem
sudo chown 1000:1000 control-plane/secrets control-plane/secrets/signing.pem
sudo chmod 700 control-plane/secrets
sudo chmod 600 control-plane/secrets/signing.pem
cd control-plane
cp .env.example .env
```

在 `.env` 中填写 `ABORDER_CONTROL_HOST` 和 `ABORDER_CONTROL_SIGNING_KID`。默认租约有效期为 900 秒，`ABORDER_CONTROL_LEASE_SECONDS` 允许设为 60 到 86400 秒。租约还会在已知的授权到期、维护切换或版本截止时间截短。

```sh
docker compose build control
read -r -s -p 'Administrator password (14 or more characters): ' admin_password
printf '\n'
printf '%s' "$admin_password" | docker compose run --rm -T --no-deps control \
  node /app/control-plane/cli.mjs init-admin administrator
unset admin_password
docker compose up -d
```

打开配置的 HTTPS 域名，使用管理员账号登录。密码使用带随机盐的 scrypt 保存。修改管理员密码可重复运行 `init-admin`，该管理员的现有会话会被清除。

管理服务也可以由 Node 24 直接运行，并由现有 HTTPS 代理转发。设置 `ABORDER_CONTROL_ORIGIN` 为客户端访问的完整 HTTPS 源，设置 `ABORDER_CONTROL_SIGNING_KEY_FILE` 和 `ABORDER_CONTROL_SIGNING_KID`，然后运行 `node control-plane/server.mjs`。默认监听 `127.0.0.1:8080`，使用 `ABORDER_CONTROL_BIND`、`ABORDER_CONTROL_PORT` 和 `ABORDER_CONTROL_DB` 自定义。只有显式设置 `ABORDER_CONTROL_ALLOW_HTTP_LOOPBACK=1` 才允许用 HTTP 回环地址联调。

已有 Nginx 或宝塔网站的服务器可参考 [systemd 部署与每日备份](deploy/README.md)，使用独立服务账号和回环端口运行。

服务器工作台可通过独立回环端口调用账号/设备鉴权、最新策略和实际执行回执，见 [内部接口合同与配置](hosted-workbench.md)。管理迁服时可设置 `ABORDER_CONTROL_ISSUER` 保留原签名发行方与账号身份，同时把 `ABORDER_CONTROL_ORIGIN` 改为新的公开 HTTPS 源。

## 用户注册、审核和登录

客户端用户账号与管理员账号分开保存。用户在客户端注册登录名和密码，管理后台的「账号授权」页面会出现「待审核」记录。登录名使用 3 到 64 位英文字母、数字、下划线、点或短横线，忽略大小写；密码为 8 到 128 位，服务器仅保存独立随机盐的 scrypt 结果。

管理员点击「审核注册」，设置授权期限、设备上限和功能，勾选「批准注册并启用账号」后保存。注册本身不提供可用授权，未审核用户登录返回 `account_pending`。批准后账号停用、授权到期、设备停用及设备上限继续生效，用户登录不能恢复被管理员停用或解除绑定的设备。

已有激活安装可在注册时附带当前设备凭据，将新登录账号关联到原管理账号并保留安装标识。注册会把原账号改为待审核，后续续租也会收到限制策略；管理员再次批准后使用账号密码登录。同一管理账号只能关联一个用户登录名。缺少或错误的设备凭据不能接管已有绑定；不自动合并不同账号的数据。原有激活码协议继续兼容已发行安装。

客户端接口使用 HTTPS JSON，密码只在注册和登录请求中传输，不保存在设备身份中：

- `POST /v1/user/register`：设备 metadata 加 `username`、`password`，已有激活设备可带 Bearer 设备凭据。返回 `{registered, accountId, username, approval: "pending"}`，不签发可用租约。
- `POST /v1/user/login`：相同 metadata 加账号密码，批准后返回 `{accountId, deviceToken, lease, user: {username}}`。重复登录同一已启用安装会轮换设备凭据，原凭据失效；不同安装受设备数量限制。

metadata 为 `productId`、`installationId`、`desktopVersion`、`backendVersion`（未知时为 null）及 `platform: "win32-x64"`。新用户注册默认一个设备，必须由管理员批准。请求限流按实际连接地址和账号名执行，不信任外部提供的 `X-Forwarded-For`；反向代理部署中全体客户端共享每分钟 60 次注册/登录及 10 次注册预算，每个产品内登录名共享每分钟 12 次预算。预算独立于正常授权心跳。

注册数据由迁移 `002-user-registration.sql` 添加，保留原管理员、设备凭据和授权信息。升级前先备份管理数据库和签名密钥。当前没有自助密码找回或邮件验证流程，不把未验证邮箱当成账号归属依据。

## 激活和管理

1. 在 A-Border SEO 产品下建立授权账号，填写授权期限、功能和设备数上限。
2. 为账号生成激活码，通过受控渠道交给用户。激活码 15 分钟内有效，成功时绑定一个安装标识。网络中断时，同一安装可在到期前重试该次激活。
3. 在装有对应服务地址、产品 ID 和签名公钥的客户端输入激活码。客户端主动轮询服务，管理网页记录收到和生效回执。未接入管理协议的安装需要先换成受管版本。
4. 停用设备后可单独启用。解除绑定会释放名额，原凭据随后继续收到签名的停用状态。要重新绑定被解除的设备，向其签发指定安装标识的新激活码。对仍启用并绑定的同账号设备，重新签发激活码可轮换丢失的设备凭据。
5. 产品停用、授权账号停用、设备停用、维护、功能限制和版本门槛独立生效。可在产品、账号、设备或设备组上配置维护或功能。管理员界面上的设备版本和在线状态以最后一次客户端上报为准。

## 发行和投放

先完成桌面发布流程。控制台在上架或恢复投放前验证官方 GitHub Release 中的 Windows x64 安装器、差分文件、更新元数据、统一发行清单及 SHA-256 文件，以及清单指定的公开 GHCR Linux amd64 镜像。安装时仍由客户端验证签名安装器和镜像摘要。

先把指定设备加入测试组，再对该组发布。相同的产品、安装标识和版本始终映射到同一个投放分桶。最低桌面或后台版本不能高于投放的版本，并在截止时间到达后生效，空截止时间表示立即生效。未命中的设备不承受这条发行的最低版本限制。目标应适用于现有 Windows x64 设备，并在整个投放期间保持资源可获取。

失败的升级回执会拦住该版本继续扩大组或比例，原投放可以暂停。发出修复版本后先用测试组验证。只有客户端报告桌面和后台均已达到目标版本且确认健康时才记录升级成功，安装包下载完成不会计为成功。

## 数据库、备份与签名轮换

SQLite 的 `PRAGMA user_version` 记录迁移版本，应用会事务执行缺少的迁移。使用 SQLite 在线备份接口制作一致的快照。以下命令把备份写入数据卷，再复制到受控备份位置。

```sh
docker compose exec -T control node /app/control-plane/cli.mjs backup /app/data/control-backup.sqlite
docker compose cp control:/app/data/control-backup.sqlite ./control-backup.sqlite
```

备份应由管理员单独保管。恢复前停止管理服务并保留原有数据库、WAL 和 SHM 文件。在新数据卷恢复快照并确认权限后再启动。签名密钥作为独立机密备份，定期验证隔离恢复。回滚到较旧数据库可能造成策略版本或租约序号倒退，客户端会拒绝这类租约。恢复时应优先恢复更新的管理数据库和原签名密钥，再确认设备可续租。

轮换时先制作含新旧两把公钥的受管客户端，并确认活跃设备已更新。再切换服务端私钥文件和 `ABORDER_CONTROL_SIGNING_KID`，重启服务并验证续租。待旧签名租约过期并完成客户端过渡后可移除旧公钥。

## 隔离验证和边界

```sh
node --test control-plane/test/*.test.mjs
```

测试用独立监听端口、临时数据库、测试管理员和测试签名密钥。验证跨账号与产品隔离、设备上限、重绑、停用和维护、离线租约到期、回执、CSRF、分组更新及失败后阻止扩容。发行资产访问用测试响应替代，正式站点和正式安装包需部署后验收。

离线设备只有最后确认状态。有效租约到期前，离线设备可以按租约继续使用；服务暂时不可达时也遵循同一到期时间。受管客户端的完整约束以客户端按协议运行、签名公钥可信和本地时钟没有被特权用户篡改为前提。服务没有远程命令执行入口。
