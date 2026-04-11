# copilot-anthropic-proxy

一个本地运行的 GitHub Copilot -> Anthropic Messages API 代理。

它会在本机启动一个兼容 Anthropic `POST /v1/messages` 的接口，把请求转发到 GitHub Copilot 实际使用的上游地址，并把请求结果、耗时、token 用量、错误信息、请求体/响应体记录到 SQLite 中，同时提供一个本地 Dashboard 用来查看日志和统计。

## 功能概览

- 将本地 `POST /v1/messages` 请求转发到 GitHub Copilot 对应的 Anthropic 上游
- 自动从本地缓存或 GitHub token 交换 Copilot token
- 支持同步响应和 SSE 流式响应
- 自动记录模型、状态码、耗时、输入/输出 token、请求摘要、错误信息
- 将完整请求体和响应体写入 SQLite，便于排查问题
- 提供本地 Dashboard 查看请求列表、明细、按小时统计和模型分布
- 内置一组给 Claude Chrome Extension 用的本地 mock 接口与 WebSocket 响应

## 仓库结构

```text
.
├── dashboard.html   # 本地日志看板
├── server.mjs       # 代理服务
└── README.md
```

## 运行要求

- Node.js 22+

原因：

- 代码使用了原生 `fetch`
- 代码使用了 `node:sqlite` 的 `DatabaseSync`
- 仓库当前没有额外依赖，也没有 `package.json`

## 启动方式

在仓库根目录执行：

```bash
node server.mjs
```

启动后会监听：

- API: `http://127.0.0.1:4819/v1/messages`
- Dashboard: `http://127.0.0.1:4819/`

服务只监听本机 `127.0.0.1`，不会对外网开放。

## Token 获取逻辑

服务会优先尝试直接复用本地 Copilot token 缓存：

- `~/.openclaw/credentials/github-copilot.token.json`

如果缓存不存在或即将过期，则会继续寻找 GitHub token。查找顺序如下：

- `~/.openclaw/agents/main/agent/auth-profiles.json`
- `~/.openclaw/agents/researcher/agent/auth-profiles.json`
- `~/.openclaw/credentials/auth-profiles.json`
- 环境变量 `COPILOT_GITHUB_TOKEN`
- 环境变量 `GH_TOKEN`
- 环境变量 `GITHUB_TOKEN`

找到 GitHub token 后，服务会请求：

- `https://api.github.com/copilot_internal/v2/token`

再用换到的 Copilot token 去请求实际的 Anthropic 上游。

## API 用法

### 发送请求

接口形态与 Anthropic Messages API 保持一致，当前代理的主入口是：

```http
POST /v1/messages
```

示例：

```bash
curl http://127.0.0.1:4819/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 256,
    "messages": [
      { "role": "user", "content": "写一个 hello world" }
    ]
  }'
```

### 代理行为

- 会补充 GitHub Copilot 需要的请求头
- 会保留请求里的 `anthropic-version`
- 会删除 `context_management`
- 会对 `system` / `messages` 里的 `cache_control` 做最小清洗，只保留 `type`
- 请求失败时会把上游错误原样返回给调用方，同时写入日志

## Dashboard

访问 `http://127.0.0.1:4819/` 可查看本地日志面板。

支持的能力包括：

- 总请求数、成功数、失败数、总 token、平均耗时
- 按模型聚合的请求量、token 和平均延迟
- 按小时请求趋势图
- 模型占比分布
- 时间范围筛选
- 模型筛选
- 仅看错误请求
- 查看完整请求体、响应体、SSE 事件流和错误详情

## 数据存储

运行后会在仓库目录生成：

- `proxy-logs.db`

其中主要保存：

- 请求时间
- 模型名
- 状态码
- 请求耗时
- 是否流式
- 输入/输出 token
- 请求预览和摘要
- 错误信息
- 截断后的请求体和响应体

当前实现会把 `request_body` 和 `response_body` 单条最多保留约 `512000` 字符。

## 其他内置接口

除了 `/v1/messages`，服务还提供了一些本地辅助接口：

- `GET /api/logs`：读取日志列表和聚合统计
- `GET /api/logs/:id`：读取单条日志详情
- `DELETE /api/logs`：清空日志
- `GET /api/stats/charts`：图表数据

另外还实现了若干给 Claude Chrome Extension 使用的 mock 接口：

- `/api/oauth/profile`
- `/api/oauth/account/settings`
- `/api/oauth/organizations`
- `/api/bootstrap/features`
- `/v1/oauth/token`
- WebSocket upgrade 响应

## 常见问题

### 1. 启动后报 `No GitHub token found`

说明本机没有可用的 GitHub token。可以先确认：

- `~/.openclaw/.../auth-profiles.json` 是否存在
- 是否设置了 `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`

### 2. 启动后报 `Token exchange failed`

通常表示 GitHub token 无效、过期，或当前账号没有可用的 Copilot 权限。

### 3. 看板能打开，但没有日志

只有请求打到：

- `http://127.0.0.1:4819/v1/messages`

之后，Dashboard 才会出现记录。

## 开发说明

- 当前项目是一个纯 Node 脚本仓库，没有构建步骤
- 端口固定为 `4819`
- 服务入口固定为 `server.mjs`
- 仪表盘页面位于 `dashboard.html`

如果后续要扩展，比较直接的方向有：

- 把端口、监听地址、数据库路径改成环境变量
- 增加日志保留策略和自动清理
- 增加认证，避免本机其他进程误调用
- 补充 `package.json`、启动脚本和 systemd / pm2 示例
