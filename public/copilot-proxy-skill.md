---
name: copilot-proxy-onboard
description: Help a user onboard to the Copilot Proxy service (api.eagle.openclaws.co.uk) — discover available models via the public /v1/models endpoint, then generate ready-to-paste config for Claude Code, Codex CLI, OpenCode, Cursor, raw curl, or any Anthropic/OpenAI-protocol client. Trigger when the user says they have a "copilot proxy key" / "eagle key" / "sk-proxy-*" key and wants to start using it, or asks "how do I use this key" / "set up Claude Code with this proxy".
---

# Copilot Proxy — Onboarding Skill

You're helping a user start using **api.eagle.openclaws.co.uk** — a Copilot-backed proxy that exposes Anthropic-compatible (`/v1/messages`) and OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`) endpoints. The user already has an API key (format: `sk-proxy-...`).

## What you need from the user

**Just one thing**: their API key (`sk-proxy-xxxxx`). Don't ask for anything else upfront.

If they haven't given it yet, say: *"把你的 sk-proxy- 开头的 key 发我"* and stop.

## Step 1 — verify the key + discover models

Always do this first, never skip. The API is the source of truth — pricing/models change.

```bash
curl -s -H "x-api-key: $KEY" https://api.eagle.openclaws.co.uk/user/me | head -c 500
curl -s https://api.eagle.openclaws.co.uk/v1/models
```

- `/user/me` → 401 means the key is wrong; otherwise returns name, plan, free_quota, paid_quota, balance, used.
- `/v1/models` → public, no auth. Returns `{data: [{id, display_name, provider, protocol, context_window, pricing:{input,output,cache_read,cache_write}, input_modalities, output_modalities}]}`. **Pricing unit = "equivalent tokens" relative multiplier, not dollars.** 1 unit ≈ deducted 1 token from the user's quota.

Show the user a compact summary: which models are usable (filter by what they want — Claude/GPT/Gemini), context size, and rough cost ratio (e.g. "claude-opus-4.7 = 1.5x input / 7.5x output").

## Step 2 — pick the right base URL by client

Two endpoints, **same key works for both**:

| Client | Base URL | Env var |
|---|---|---|
| Claude Code, Anthropic SDK, anthropic-py | `https://api.eagle.openclaws.co.uk` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| OpenAI SDK, Codex CLI, OpenCode, LangChain | `https://api.eagle.openclaws.co.uk/v1` | `OPENAI_BASE_URL` + `OPENAI_API_KEY` |
| Cursor (custom OpenAI) | `https://api.eagle.openclaws.co.uk/v1` | (in Cursor settings) |

**Header format**:
- Anthropic protocol: `x-api-key: sk-proxy-xxx` and `anthropic-version: 2023-06-01`
- OpenAI protocol: `Authorization: Bearer sk-proxy-xxx`

## Step 3 — generate ready-to-paste config

Pick the user's stated client (Claude Code / Codex / Cursor / curl / etc) and produce one block they can paste. Use the actual model IDs you got from `/v1/models` (don't guess — the catalog rotates).

### Claude Code
```bash
export ANTHROPIC_BASE_URL=https://api.eagle.openclaws.co.uk
export ANTHROPIC_AUTH_TOKEN=sk-proxy-xxxxx
claude --model claude-opus-4.7 --dangerously-skip-permissions
# or for 1M context internal variant:
claude --model claude-opus-4.7-1m-internal
```
⚠️ Claude Code must be ≥ 2.1.123 (older versions send `thinking.type.enabled` which the proxy rejects with 400).

### Codex CLI
```toml
# ~/.codex/config.toml
[providers.eagle]
name = "Eagle Copilot Proxy"
base_url = "https://api.eagle.openclaws.co.uk/v1"
env_key = "EAGLE_API_KEY"
wire_api = "responses"

[profiles.eagle]
provider = "eagle"
model = "gpt-5.4"
```
```bash
export EAGLE_API_KEY=sk-proxy-xxxxx
codex --profile eagle
```

### OpenCode
```json
// ~/.config/opencode/config.json
{
  "providers": {
    "eagle": {
      "name": "Eagle",
      "baseURL": "https://api.eagle.openclaws.co.uk/v1",
      "models": { "claude-opus-4.7": {}, "gpt-5.4": {} }
    }
  }
}
```

### Cursor
Settings → Models → Add Custom Model → OpenAI-compatible:
- Base URL: `https://api.eagle.openclaws.co.uk/v1`
- API Key: `sk-proxy-xxxxx`
- Model name: copy from `/v1/models` (e.g. `claude-sonnet-4.6`)

### curl (Anthropic)
```bash
curl https://api.eagle.openclaws.co.uk/v1/messages \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4.6","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

### curl (OpenAI Chat Completions) — gpt-5.4 / 5.4-mini / 5.3-codex / Gemini all use this
```bash
curl https://api.eagle.openclaws.co.uk/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}]}'
```

Gemini works the **same way via OpenAI protocol** (no separate Google SDK needed):
```bash
curl https://api.eagle.openclaws.co.uk/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"gemini-3.1-pro-preview","messages":[{"role":"user","content":"hi"}]}'
```

### curl (OpenAI **Responses** API) — required for **gpt-5.5** and o-series reasoning models
GPT-5.5 (and reasoning-only models) **reject `/chat/completions` with HTTP 400** ("model gpt-5.5 is not accessible via the /chat/completions endpoint"). Use `/v1/responses` instead — different endpoint, different request shape:
```bash
curl https://api.eagle.openclaws.co.uk/v1/responses \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "hi",
    "reasoning": { "effort": "medium" },
    "max_output_tokens": 1024
  }'
```
Key differences vs Chat Completions:
- Endpoint: `/v1/responses` (not `/v1/chat/completions`)
- Body uses `input` (string or content array), not `messages`
- `max_output_tokens` (not `max_tokens`)
- Optional `reasoning.effort` = `low | medium | high` for thinking budget
- Response: `output[]` array with `output_text` / reasoning items, plus `usage.input_tokens_details.cached_tokens` for cache hits

Python SDK ≥ 1.50 supports it natively:
```python
from openai import OpenAI
client = OpenAI(base_url="https://api.eagle.openclaws.co.uk/v1", api_key="sk-proxy-xxx")
r = client.responses.create(model="gpt-5.5", input="hi", reasoning={"effort":"medium"}, max_output_tokens=1024)
print(r.output_text)
```

**For CLI tools**: in Codex's `~/.codex/config.toml`, set `wire_api = "responses"` on the provider so it routes gpt-5.5 correctly. Cursor handles this automatically when you pick gpt-5.5 from the model list.

### Quick endpoint cheat-sheet (which model → which endpoint)
| Model family | Endpoint | Body shape |
|---|---|---|
| `claude-*` | `/v1/messages` | Anthropic |
| `gpt-4*`, `gpt-5`, `gpt-5.4*`, `gpt-5.3-codex`, `gemini-*`, `o3-mini` | `/v1/chat/completions` | OpenAI Chat |
| `gpt-5.5`, future reasoning models | `/v1/responses` | OpenAI Responses |

When unsure, fetch `/v1/models` and check the `protocol` field; if a `chat/completions` call returns "not accessible via the /chat/completions endpoint", retry against `/v1/responses` with the body conversion above.

### Python (OpenAI SDK)
```python
from openai import OpenAI
client = OpenAI(base_url="https://api.eagle.openclaws.co.uk/v1", api_key="sk-proxy-xxx")
r = client.chat.completions.create(model="gpt-5.4", messages=[{"role":"user","content":"hi"}])
```

### Python (Anthropic SDK)
```python
from anthropic import Anthropic
client = Anthropic(base_url="https://api.eagle.openclaws.co.uk", api_key="sk-proxy-xxx")
r = client.messages.create(model="claude-opus-4.7", max_tokens=1024, messages=[{"role":"user","content":"hi"}])
```

## Step 4 — verify with one request

After paste, run a 5-token test to confirm. Show response + remaining quota:
```bash
curl -s -H "x-api-key: $KEY" https://api.eagle.openclaws.co.uk/user/me | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"used={d.get('used')} free={d.get('free_remaining')} paid={d.get('paid_remaining')} balance={d.get('balance')}\")"
```

## Pitfalls

- **Don't hardcode model lists** — always re-fetch `/v1/models`. Sonnet 4.7 doesn't exist; Sonnet 4.6 / Opus 4.7 do. Catalog updates frequently.
- **Don't mix headers**: Anthropic path needs `x-api-key` + `anthropic-version`; OpenAI path needs `Authorization: Bearer`. Wrong header → 401.
- **CORS / 4819**: only `api.eagle.openclaws.co.uk` is the public domain. `localhost:4819` is dev-only.
- **Cache discount**: pricing now reflects cache_read (~0.1× input) and cache_write (~1.25× input). Repeated long prompts are cheap.
- **Auth model**: usage burns from `free_quota → paid_quota → balance`. If `/user/me` shows 0/0/0 → user must top up at the dashboard.
- **Rate / 502**: a 502 means upstream Copilot busy — retry once, don't loop.

## Getting more keys / topping up

Direct user to the dashboard (root `/` of the proxy) — they log in via WeChat scan, see balance, can buy ¥9.9 (50万 token) or ¥29 (200万 token) packs. Don't try to provision keys via API; there's no public key-issuing endpoint.
