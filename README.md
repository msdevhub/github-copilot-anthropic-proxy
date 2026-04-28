# copilot-anthropic-proxy

本地 / 自托管的 **GitHub Copilot → Anthropic Messages API 网关**，自带多 Key 管理与用量看板。

把 GitHub Copilot 的额度暴露成标准 Anthropic / OpenAI 兼容接口，给 Claude Code、OpenClaw 等客户端直接用。

## 功能

**API 网关**
- `POST /v1/messages` — Anthropic Messages 协议（同步 + SSE 流式）
- `POST /v1/chat/completions` — OpenAI 兼容
- `GET  /v1/models` — 模型列表
- 自动用本地缓存或 GitHub token 换取 Copilot token，请求体最小清洗后转发上游

**多 Key 管理**
- 自签 `sk-proxy-…` API key，每个 key 可设额度 / 模型白名单 / 备注
- 支持设备登录（`/api/device-login/*`）让用户自助生成 token

**双 Dashboard**
- 用户端 `/`（API key 登录，`/user` 兼容保留）：自己的额度、用量、调用记录
- 管理端 `/_admin`（Logto 登录）：日志、Keys、Usage、Pricing、Audit、Charts

**观测与审计**
- SQLite 持久化每次请求：模型、状态、延迟、token、请求/响应体（截断）
- 每小时趋势、模型分布、按 key 聚合、价格表 + 成本估算、操作审计

## 路由速查

| 路径 | 说明 |
|---|---|
| `/v1/messages` `/v1/chat/completions` `/v1/models` | 对外 API |
| `/api/keys` `/api/tokens` `/api/logs` `/api/stats/charts` | Dashboard 数据 |
| `/api/device-login/start` `/poll` | OAuth 风格设备登录 |
| `/admin/keys` `/usage` `/overview` `/pricing` `/audit` | 管理端 API（dashboard 在 `/_admin`） |
| `/user/me` `/logs` `/usage` `/stats` | 用户端 |
| `/health` `/callback` | 健康检查 / OAuth 回调 |

## 启动

需要 Node.js 22+（用了原生 `fetch` 和 `node:sqlite`），无依赖。

```bash
node server.mjs
# 默认监听 0.0.0.0:4819
```

数据库 `proxy-logs.db` 会写在仓库目录，单条 request/response body 最多保留约 512 KB。

## Token 来源

启动时按顺序尝试拿 Copilot token：

1. 缓存：`~/.openclaw/credentials/github-copilot.token.json`
2. 失效则用 GitHub token 走 `https://api.github.com/copilot_internal/v2/token` 换新的：
   - `~/.openclaw/agents/{main,researcher}/agent/auth-profiles.json`
   - `~/.openclaw/credentials/auth-profiles.json`
   - 环境变量 `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`

## 接入示例

部署后假设外网域名 `https://api.eagle.openclaws.co.uk`，先在 dashboard 创建一个 `sk-proxy-…` key。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://api.eagle.openclaws.co.uk
export ANTHROPIC_AUTH_TOKEN=sk-proxy-你的key
claude
```

### OpenClaw

走 OpenAI 兼容协议，在 `~/.openclaw/agents/<agent>/agent/models.json` 加一个 provider：

```json
{
  "providers": {
    "copilot-proxy": {
      "baseUrl": "https://api.eagle.openclaws.co.uk/v1/",
      "apiKey": "sk-proxy-你的key",
      "api": "openai-completions",
      "models": [
        { "id": "claude-sonnet-4.6", "name": "Claude Sonnet 4.6", "api": "openai-completions" }
      ]
    }
  }
}
```

然后在 agent 配置里把 primary model 设成 `copilot-proxy/claude-sonnet-4.6` 即可。

## 常见问题

**`No GitHub token found`** — 检查 `~/.openclaw/.../auth-profiles.json` 或设 `COPILOT_GITHUB_TOKEN`。

**`Token exchange failed`** — GitHub token 过期 / 账号无 Copilot 权限。

**Dashboard 没日志** — 只有真实请求打到 `/v1/messages` 或 `/v1/chat/completions` 后才会有记录。
