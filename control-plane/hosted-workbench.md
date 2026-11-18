# 服务器工作台内部鉴权与策略合同

这些接口只供受信服务器工作台使用。它们不提供用户密码登录、不提供任意命令执行，也不代替客户端 `/v1/user/login`。旧客户端的公开注册、登录、租约与回执接口保持兼容。

## 配置与网络边界

`node control-plane/server.mjs` 同时运行原公开管理监听器和可选内部监听器。仅设置 `ABORDER_CONTROL_INTERNAL_SECRET` 后才启用内部接口；未配置时完全不监听。密钥必须为独立生成的 32 字节随机值的规范 base64url 编码（43 字符），不能复用管理员密码、签名私钥、设备凭据或业务加密密钥。工作台与管理服务各自在权限受限的服务环境文件中保存它，不能发给桌面或网页，也不能写入日志、版本库或公开清单。

| 配置 | 行为 |
| --- | --- |
| `ABORDER_CONTROL_ORIGIN` | 当前公开 HTTPS 访问源，用于管理员同源和 CSRF 检查 |
| `ABORDER_CONTROL_ISSUER` | 可选、稳定的授权发行方 HTTPS 源；默认等于 ORIGIN。用于签名租约 `iss` 和内部响应 `issuer` |
| `ABORDER_CONTROL_INTERNAL_SECRET` | 启用内部监听的专用随机服务密钥 |
| `ABORDER_CONTROL_INTERNAL_BIND` | 默认 `127.0.0.1`；只接受字面量 `127.0.0.1` 或 `::1` |
| `ABORDER_CONTROL_INTERNAL_PORT` | 默认 `18086`；必须与公开管理端口不同 |

迁移示例：公开域名改为 `https://aborder.tuitehao.shop`，同时保持 `ABORDER_CONTROL_ISSUER=https://aborder.nxitek.cn`，并原样迁移签名密钥、SQLite 账号/设备/策略数据库。不要为迁服重建账号、安装标识或签名身份。旧客户端访问地址的兼容反代属于部署配置，不由内部接口提供。

公开管理监听器不注册任何 `/internal/` 路由。Nginx 只代理公开管理端口和业务端口，绝不能代理 18086。内部监听还拒绝带 Origin、Forwarded、X-Forwarded-* 的请求，只接受来自回环地址的 TCP 连接。两个服务应同机部署；确需跨主机时只能通过受限 SSH 隧道等受信通道落到回环监听，不能改为公网或 `0.0.0.0`。应用密钥轮换会令已有 hosted sessionBinding 失效，需要重新建立工作台会话。

## 请求与响应

四个接口均为 POST，使用 `Content-Type: application/json` 与 `Authorization: Bearer <内部服务密钥>`，正文上限 20 KiB，无 CORS。服务器工作台应每次请求重新检查设备策略，后台任务在领取、执行及持续运行检查点重新检查所属账号或设备策略。可做同一请求内去重，不能把 30 秒回执票据有效期当作离线授权缓存；内部服务故障应立即拒绝新业务和任务，并按现有安全检查点收尾。

| 路径（均位于 `/internal/v1/workbench/`） | JSON 输入 |
| --- | --- |
| `authenticate` | `{productId, installationId, deviceToken, desktopVersion, backendVersion, accountId?}` |
| `device-policy` | `{productId, accountId, installationId, sessionBinding, desktopVersion, backendVersion}` |
| `account-policy` | `{productId, accountId, backendVersion}` |
| `receipt` | `{ticket, component, status, code?}` |

`authenticate` 使用设备凭据、产品和安装标识查当前绑定。省略 accountId 时由设备记录确定账号；提供时必须匹配。返回的 sessionBinding 是绑定当前设备凭据摘要和账号身份的 HMAC，不返回凭据或数据库 token_hash。工作台只在服务端会话中保存它。设备解除绑定、重新绑定、登录或激活引起的凭据轮换，都会使旧绑定下一次请求立即返回 401；另一个设备的会话不受影响。普通停用和维护返回可解释的拒绝策略，恢复后可重新通过检查。

前三个接口返回：

```text
{
  v: 1, issuer, scope: "device" | "account", productId, accountId,
  installationId: string | null, desktopVersion: string | null, backendVersion,
  username: string | null, label, checkedAt, validUntil, revision,
  policy: {原签名租约的完整策略字段},
  allowed, reason: string | null, features: {jobs, codex, manus, geo},
  maintenanceMessage, release, receiptTicket,
  sessionBinding: string // 仅 authenticate 返回
}
```

所有时间为 Unix 秒。`features` 是计算拒绝后的有效权限；调用方必须同时检查 `allowed` 和具体功能开关。拒绝原因复用原协议：`product_disabled`、`account_disabled`、`device_disabled`、`entitlement_expired`、`update_required`、`maintenance`。未批准注册仍作为 account_disabled 处理，公开登录维持已有 account_pending 提示。

设备路径复用同一套产品、账号、设备、组、维护时段、授权期限及灰度发布计算。服务端必须提供自己正在运行的 backendVersion，不能从桌面接受“本机后台版本”来替代服务器版本。Hosted 客户端的后台运行在服务器，检查不要求每个客户端安装或拉取 Docker 镜像；桌面版本门槛仍单独执行。

账号路径供无设备来源的定时任务使用，只合并产品与账号策略。它没有共享的虚构设备身份，不继承任何特定设备或组的维护与停用，不检查最低桌面版本。全局后台最低版本取已验证、未暂停、无组限定且 100% 投放的有效发布；分批或组发布由有设备来源的任务走 device-policy 执行。用户发起且需受设备策略约束的任务必须保存并复查原设备身份，不能改成账号任务以绕开设备禁用。

## 真实执行回执

`receiptTicket` 最长有效 30 秒，并在更近的授权到期、维护边界、发布截止时提前失效。工作台实际应用该次策略后才能发送 receipt，不能在仅收到策略时声称生效。票据由专用密钥签名，包含原身份、版本、凭据绑定和策略摘要；服务端重新检查当前策略、修订号、绑定与期限。篡改、过期、旧策略、已轮换或撤销凭据的票据被拒绝。

receipt 请求必须显式提供 `component`：`http_session`（设备会话）、`http_api`（业务 API）、`content_worker`（本机内容 Worker）或 `ordinary_worker`（普通后台 Worker）。账号范围只接受 http_api 和 ordinary_worker；设备范围支持全部组件。每个组件只更新自己的回执，单个组件已应用策略不代表整个工作台或其他 Worker 已停止。

状态为 `effective`（策略已应用）、`blocked`（请求或任务已按策略拒绝）、`draining`（正在收尾）、`failed`（策略执行失败）；它们不是任务完成状态。blocked 仅在当前整体拒绝或至少一个功能禁用时接受。可选 code 只接受 1 到 64 位小写字母、数字、下划线或短横线，不能上传原始异常、任务正文或凭据。

迁移 `003-hosted-workbench.sql` 新增独立 `hosted_receipt` 表，`004-hosted-receipt-components.sql` 将主键扩展为产品、范围、主体和执行组件。已有无组件回执保留为 legacy 历史记录，不能作为当前执行证据。`/admin/api/state` 的 `hostedReceipts` 和管理总览的独立表显示执行组件、范围、版本、策略版本、时间和结果。原客户端 issued_lease、device.receipt_*、升级成功/失败计数均不受影响，因此服务器结果不会被冒充为旧客户端已执行或已升级。current 仅表示这份短期回执仍与当前策略和凭据匹配，缺少新回执不等于执行失败。

常见内部错误：401 `internal_authentication_failed` / `device_authentication_failed`；403 `internal_transport_rejected`；409 `hosted_policy_changed` / `hosted_receipt_expired` / `hosted_receipt_stale` / `hosted_receipt_status_mismatch`。非预期服务错误返回固定 internal_error，不返回原始异常或凭据。

升级前备份完整管理数据库、签名密钥与环境文件。003 是新增表迁移，但旧程序拒绝高于其支持版本的数据库，回滚代码时不能直接启动旧程序读取已迁移数据库；保留当前数据库及 WAL/SHM，并按验证后的管理数据库恢复方案处理。不要覆盖还可用的新授权状态。

## 隔离验证

`node --test control-plane/test/*.test.mjs` 使用独立回环端口、内存或临时数据库及随机测试密钥，覆盖公开路由隔离、内部密钥和转发头拒绝、账号/设备/产品隔离、凭据轮换/撤销、产品/账号/设备/组策略、功能限制、授权期限、最低版本、时段边界、回执真实性及签名 issuer 与公开 origin 分离。部署后的反向代理、TLS、工作台/API/worker 调用与普通用户客户端仍须另做实机隔离验收。
