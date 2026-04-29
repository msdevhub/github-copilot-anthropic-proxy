# 接入 wx-gateway 支付能力（v1 personal_qr）

## 背景
wx-gateway 已 ready 个人收款码 + 人工审核支付。本项目复用已有 finalize HMAC secret 和 app name `copilot-proxy`。完整 spec 见 `~/.hermes/skills/devops/wx-gateway-integrate/references/payment.md`。

## 网关地址
- Base: `https://wx.mvp.restry.cn`
- App name: `copilot-proxy`
- Secret: 复用 `WX_GATEWAY_SECRET`（finalize 那个，不要新建）

## 套餐
- ¥9.9 (990 fen) → +500000 token
- ¥29 (2900 fen) → +2000000 token
- 落到 `api_keys_v2.paid_quota`（新加字段，与 free_quota 分开记账）

## 1. DB schema

### 新增表 `payments`
```sql
CREATE TABLE payments (
  payOrderId TEXT PRIMARY KEY,         -- 网关返回的主键
  orderId TEXT NOT NULL UNIQUE,        -- 我们自家订单号
  key_id INTEGER NOT NULL,             -- 关联 api_keys_v2
  openid TEXT,
  amount_fen INTEGER NOT NULL,
  package TEXT NOT NULL,               -- "990" or "2900"
  tokens_to_grant INTEGER NOT NULL,    -- 500000 / 2000000
  status TEXT NOT NULL,                -- pending|submitted|paid|disputed|expired
  remark TEXT,                         -- 6位备注码
  qrcodeUrl TEXT,
  external_ref TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  paid_at INTEGER,
  expires_at INTEGER NOT NULL,
  webhook_processed_at INTEGER         -- 幂等用
);
CREATE INDEX idx_payments_key ON payments(key_id);
CREATE INDEX idx_payments_status ON payments(status);
```

### 新增字段
- `api_keys_v2.paid_quota` INTEGER DEFAULT 0

## 2. 后端接口

### `POST /api/pay/create`（用户登录态调用）
- 入参：`{ package: "990" | "2900" }`
- 鉴权：复用现有 user session（dashboard 已登录）
- 流程：
  1. 生成自家 orderId（如 `cp_<keyid>_<timestamp>_<rand6>`）
  2. HMAC 签名调网关 `POST /pay/create`，带 header 三件套
  3. body: `{ orderId, amount_fen, method: "personal_qr", subject, openid, expiresIn: 1800 }`
  4. subject: `"Copilot Proxy 50万 token"` / `"Copilot Proxy 200万 token"`
  5. 网关返回后落 `payments` 表 status=pending
  6. 返回前端 `{ payOrderId, qrcodeUrl, remark, amount_fen, expiresAt }`

### `POST /api/pay/claim`
- 入参：`{ payOrderId }`
- 调网关 `POST /pay/personal/claim`（HMAC）
- 更新本地 status=submitted, submitted_at
- 返回 `{ status: "submitted" }`

### `GET /api/pay/status/:payOrderId`
- 兜底用，先查本地表，本地 status 还是 pending/submitted 时再调网关 `GET /pay/status/<id>` 同步一次
- 必须校验该订单属于当前登录 user（key_id 匹配）

### `POST /api/wx/payment-webhook` ⭐ 核心
- **验签**：
  - 校验 `X-WX-Webhook-Ts` 5 分钟内
  - 算 `hmac_sha256(secret, "${event}|${payOrderId}|${status}|${ts}")` hex
  - `timingSafeEqual` 对比 `X-WX-Webhook-Sig`
  - 失败 403
- **幂等**：
  - 查本地 payments，若 `webhook_processed_at` 已写且 status 与本次一致 → 直接回 200
- **状态变更（事务）**：
  - `payment.paid` → status=paid, paid_at, external_ref；给 key_id 加 `paid_quota += tokens_to_grant`
  - `payment.disputed` → status=disputed, reject_reason
  - `payment.expired` → status=expired
  - 写 `webhook_processed_at = now`
- 任何分支都返 200（除非验签失败）

## 3. 计费扣减顺序
- quota-gate 扣费时优先级：`free_quota` → `paid_quota` → 报错
- dashboard `/user/me` 输出 `paid_quota` 字段

## 4. Dashboard
- 替换原"即将开放"stub
- 充值 banner 两个按钮：¥9.9 / ¥29
- 点击 → 调 `/api/pay/create` → 弹窗显示二维码 + 备注码（**24px+ 红框大字**，照搬 payment.md 反模式警告）
- "我已付款" 按钮 → 调 `/api/pay/claim` → 显示"等待审核"
- 轮询 `/api/pay/status` 每 5 秒一次，paid 时刷新页面 quota
- 付款历史列表（可选，简单展示最近 10 单）

## 5. 配置
- 加 env：`WX_GATEWAY_BASE=https://wx.mvp.restry.cn`
- `WX_GATEWAY_APP_NAME=copilot-proxy`
- `WX_GATEWAY_SECRET` 复用现有

## 6. 测试 checklist（实现后必跑，但需爸爸真钱测，本次只跑单测）
单测覆盖（用 mock 网关）：
- [ ] /pay/create 成功落库 + 返回 qrcodeUrl
- [ ] webhook 验签失败 403
- [ ] webhook 时间戳超 5 分钟 403
- [ ] webhook paid 事件给 paid_quota 加 token
- [ ] webhook 重复推送幂等不重复加
- [ ] webhook disputed 改 status 不加 quota
- [ ] webhook expired 改 status 不加 quota
- [ ] /pay/status 鉴权（别人的订单查不到）

真钱联调爸爸自己跑（payment.md 第 189 行 4 项）。

## 工程要求
- 改 schema 用 migration 脚本
- HMAC 工具复用 lib/auth.mjs 现有的，不要重写
- webhook handler 必须用事务保证原子性
- 加测试脚本 `scripts/test-payment.mjs`
- 提交分逻辑单元，commit message 中文

## 不做
- jsapi/native 支付
- 自动续费
- 退款流程
