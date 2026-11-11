# 测试

## 自动测试

```bash
npm ci
npx prisma generate
npx tsc --noEmit
npm test
```

- 测试使用 Vitest，测试文件与被测代码放在一起（`*.test.ts`、`*.test.tsx`、`*.test.mjs`）。
- 涉及数据库的测试大多运行在 PGlite（进程内的 PostgreSQL）上，并执行完整的迁移链，见 `lib/testing/pglite.ts`。
- 任务领取测试（`lib/jobs/claim.pg.test.ts`）需要一个支持多连接的真实 PostgreSQL，只有设置了 `TEST_DATABASE_URL` 才运行。请使用一次性的测试库，不要指向正式数据库：

  ```bash
  DATABASE_URL=postgresql://aborder:pass@localhost:5433/aborder_test npx prisma migrate deploy
  TEST_DATABASE_URL=postgresql://aborder:pass@localhost:5433/aborder_test npx vitest run lib/jobs/claim.pg.test.ts
  ```

- 反复运行或机器资源有限时，限制并发：`npx vitest run --pool=forks --maxWorkers=1 <文件>`。
- 本机 Codex worker 的纯函数测试在 `local-worker/lib.test.mjs`，同样由 `npm test` 运行。
- 浏览器端到端测试使用 Playwright：`npm run test:e2e`。

## 发布前的人工验收

### 应用

- [ ] Google 登录、退出；关闭注册后，新账号被拒绝、已有账号可以登录
- [ ] 从 Search Console 资源添加站点，同步后概览、关键词、页面有数据，日期范围正确
- [ ] 抓取一个小站：进度、完成后的健康分与“计分方式”、问题列表、noindex 筛选
- [ ] 网页性能检查（移动端、桌面端）
- [ ] AI 爬虫访问检查：robots.txt 正常、404、5xx 三种站点的结果和提示
- [ ] GEO 监测：就绪度、GA4 同步、导入一个 .gz 访问日志
- [ ] 提醒：立即评估、Webhook 发送测试（核对 `X-ABorder-Signature`）、邮件发送测试
- [ ] 设置 → MCP：开启、创建和撤销密钥；`/mcp` 用错误密钥返回 401
- [ ] 中英文切换后各页面文字完整

### Windows 套件

在一台干净的 Windows（Docker Desktop、PowerShell 7）上：

- [ ] `构建镜像.cmd` 成功，并在 `.env` 写入镜像版本
- [ ] `配置Google.cmd` 生成 `.env`（随机密码与密钥），首次启动提示新建数据库并完成迁移
- [ ] `停止服务.cmd` 后再 `启动服务.cmd`：不再提示，数据保留
- [ ] `备份.cmd` 和 `恢复演练.cmd` 通过
- [ ] `更新MCP密钥.cmd`、`检查MCP.cmd` 通过
- [ ] `登录ChatGPT.cmd`、`验收账号模式.cmd` 通过
- [ ] `设置内容Worker.cmd` 后，内容规划中的“Codex 本地执行”任务完成
- [ ] 换一个更新版本的镜像后 `启动服务.cmd` 先自动备份再升级数据库结构
- [ ] `检查本地部署.cmd` 输出中 `OriginalCodexConfigUnchanged` 为 true

### Docker 镜像

- [ ] `docker build` 成功；`migrate deploy` 后应用 `/api/health` 返回 ok
- [ ] `node worker.cjs` 在 `WorkerHeartbeat` 中登记，收到 SIGTERM 后正常退出
