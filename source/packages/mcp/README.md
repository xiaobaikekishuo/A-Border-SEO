# A-Border SEO MCP

A-Border SEO 的只读 MCP（Model Context Protocol）服务，让 Claude Code、Codex 等 AI 助手读取你的站点数据：Search Console、抓取问题、网页性能和 SEO 优化机会。

**只读。** 每个工具都通过你自己实例的 `/api/v1` 和访问密钥读取，只发送 GET 请求，不写入、不排队、不触发任何操作；不连接数据库；一个密钥只能看到它所属账号的站点。

A-Border SEO 本身就在 `/mcp` 提供 MCP 服务，大多数情况下直接连接即可：

```bash
claude mcp add --transport http aborder-seo https://seo.example.com/mcp --header "Authorization: Bearer <密钥>"
```

本包用于 stdio 方式，或在另一台机器上转发。

## 获取密钥

在 A-Border SEO 中打开 **设置 → MCP**，开启后创建访问密钥。密钥只显示一次，请当场复制；不再需要时在同一页面撤销。

## 构建

本包不单独发布，使用仓库根目录的依赖：

```bash
npm ci                              # 仓库根目录
node packages/mcp/build.mjs         # 生成 packages/mcp/dist/cli.js
```

## stdio

```bash
claude mcp add aborder-seo -e ABORDER_SEO_URL=http://localhost:3300 -e ABORDER_SEO_API_KEY=<密钥> -- node /完整路径/packages/mcp/dist/cli.js
```

| 环境变量 | 说明 |
|---|---|
| `ABORDER_SEO_URL` | 你的 A-Border SEO 地址（默认 `http://localhost:3000`） |
| `ABORDER_SEO_API_KEY` | 在 设置 → MCP 创建的访问密钥（stdio 方式） |

## HTTP

```bash
ABORDER_SEO_URL=http://localhost:3300 node packages/mcp/dist/cli.js --http --port 3333
```

在 `http://127.0.0.1:3333/mcp` 提供 streamable HTTP，在 `/health` 提供健康检查。服务本身不保存密钥：每个客户端用 `Authorization: Bearer <密钥>` 发送自己的密钥；没有密钥或密钥被拒绝时返回 401，账号关闭 MCP 时返回 403。`--host` 修改监听地址（默认 `127.0.0.1`）。

## 工具

| 工具 | 读取内容 |
|---|---|
| `list_sites` | 站点列表、站点 ID、Search Console 与 Bing 资源 |
| `get_site_overview` | 最近 28 天与前 28 天的点击、曝光、排名和 CTR，最近一次抓取和性能检查 |
| `get_keywords` | Search Console 热门查询，最近 N 天或指定日期范围 |
| `get_pages` | 热门页面，最近 N 天或指定日期范围 |
| `get_traffic` | 每日点击和曝光，最近 N 天或指定日期范围 |
| `list_crawls` | 最近的抓取：状态、页面数、问题数和健康分 |
| `get_crawl_issues` | 某次抓取（默认最近一次完成的）的问题，按严重程度 |
| `get_vitals` | 网页性能报告：性能分、LCP、CLS、INP、TTFB |
| `get_opportunities` | 临近首页、低 CTR、内容衰退和关键词互相竞争 |
| `get_bing_traffic` | Bing 每日点击、曝光、抓取页数，以及已收录页面数和抓取错误数 |
| `get_bing_keywords` | Bing 热门查询，按截止日期落在区间内的周汇总 |
| `get_bing_pages` | Bing 热门页面，汇总方式同上 |
| `get_saved_keywords` | 已保存关键词、备注和 Search Console 汇总 |
| `get_ai_visibility` | 各 AI 平台的 GEO 六层情况（访问、页面指令、索引、平台报表、回答提及与引用、流量） |

## 许可证

MIT
