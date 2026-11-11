# 本地 Codex worker（跨平台）

A-Border SEO 的“Codex 本地执行”任务（内容规划、文章初稿、改写和 SEO 修复建议）由你电脑上的 worker 处理：worker 从后台领取任务，在只读、无工具的沙箱里运行 Codex，把 JSON 结果交回后台。用“ChatGPT 连接”方式执行的任务，worker 只负责转交给后台处理。

- Windows：推荐使用 `windows/` 套件里的 PowerShell worker：运行 `设置内容Worker.cmd` 一次，之后随 `启动服务.cmd` 自动启动（也可以单独用 `启动内容Worker.cmd`、`停止内容Worker.cmd`）。也可以使用本目录的 Node 版。
- macOS / Linux：使用本目录的 Node 版。

Node 版需要 Node.js 22 或更新版本，以及已安装的 Codex CLI，不需要安装任何 npm 依赖。

## 一次性设置

1. 生成令牌，并写进后台的 `.env`：

   ```bash
   node local-worker/index.mjs --generate-token
   ```

   把输出的一行写入 `.env` 的 `LOCAL_CONTENT_WORKER_TOKEN=`，然后重启后台（`docker compose up -d`）。

2. 让 worker 能读到同一个令牌。任选一种：

   ```bash
   export LOCAL_CONTENT_WORKER_TOKEN='上一步的令牌'
   # 或者保存到只有自己能读的文件里
   printf '%s' '上一步的令牌' > ~/.aborder-seo/worker-token && chmod 600 ~/.aborder-seo/worker-token
   export ABORDER_WORKER_TOKEN_FILE=~/.aborder-seo/worker-token
   ```

3. 用 ChatGPT 账号登录 worker 专用的 Codex 目录（默认 `~/.aborder-seo/codex`，与你平时使用的 Codex 配置分开）：

   ```bash
   node local-worker/index.mjs --login
   ```

4. 检查设置：

   ```bash
   node local-worker/index.mjs --check
   ```

## 运行

```bash
node local-worker/index.mjs          # 持续领取任务，Ctrl+C 停止
node local-worker/index.mjs --once   # 处理一个任务后退出
```

后台的内容工作台显示 worker 在线后，就可以提交“Codex 本地执行”的任务。

## 可调整的设置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ABORDER_URL` | 后台地址。非本机地址必须用 HTTPS，并设置 `ABORDER_WORKER_ALLOW_REMOTE=1` | `http://localhost:3300` |
| `ABORDER_CODEX_BIN` | Codex 命令或完整路径。Windows 上请指向 `codex.exe` | `codex`（Windows 会先找 Codex 桌面版自带的 CLI） |
| `ABORDER_CODEX_HOME` | worker 专用的 Codex 登录目录 | `~/.aborder-seo/codex` |
| `ABORDER_CODEX_MODEL` | 指定模型 | 跟随 Codex 默认 |
| `ABORDER_CODEX_REASONING` | 推理强度：minimal、low、medium、high、xhigh | `low` |
| `ABORDER_CODEX_TIMEOUT_SECONDS` | 单个任务时限（30–540 秒） | `540` |
| `ABORDER_CODEX_DISABLE_FEATURES` | 关闭的 Codex 功能，逗号分隔。Codex 升级后如果报“Unknown feature flag”，删掉报错的那一项 | 关闭 shell、应用、插件、浏览器、图像、多代理等全部工具类功能 |
| `ABORDER_CODEX_EXTRA_ARGS` | 追加给 `codex exec` 的参数，JSON 数组，例如 `["--profile","seo"]` | 无 |
| `ABORDER_WORKER_RUNTIME` | 锁文件、日志（`worker.log`）和临时任务目录 | `~/.aborder-seo/worker` |

## 安全边界

- Codex 以只读沙箱、`--ephemeral`、`--ignore-user-config` 运行，网页搜索、MCP、插件和 shell 等工具全部关闭；输出里一旦出现工具调用，任务按 `unexpected_tool_event` 失败。
- 传给 Codex 的环境变量是白名单，`OPENAI_API_KEY` 等密钥不会传过去；登录方式固定为 ChatGPT，不会自动改用 API 计费。
- 提示词、网页内容和模型输出不写入日志，日志只记录事件、任务编号和错误代码。
- 同一台电脑上只能运行一个 worker（`worker.lock`）。
