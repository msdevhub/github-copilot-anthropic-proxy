# 微信扫码 → 自动建 key + 30万赠送 + 营销 + 反薅

## 范围
proxy 项目内（`server.mjs`、`lib/keys-v2.mjs`、`lib/database.mjs`、`lib/auth.mjs`、`public/user-dashboard.js`、`dashboard.html`）。公众号侧（wx-gateway）不在本次范围。

## 1. 自动建 key + 绑定（替代 pending 流程）
- 扫码 finalize 接口逻辑改为：
  - 收到 openid 后查 `api_keys_v2` 是否已有 `wx_openid = openid` 的 key
  - 已有 → 直接返回原 key（重复扫码场景）
  - 没有 → 自动创建一个新 key，前缀 `sk-proxy-wx-` + 随机串，落库
- `api_keys_v2` 增加字段（如未存在）：
  - `wx_openid` TEXT，唯一索引
  - `source` TEXT（标记 `wx_signup`、`manual` 等）
  - `free_quota` INTEGER（剩余赠送 token 数）
  - `quota_used` INTEGER（已用赠送 token，便于展示）
- 移除原有 pending 流程相关代码/路由（如有）。

## 2. 30万 token 赠送（不可重置）
- 新建的 wx_signup key：`free_quota = 300000`
- **不写 reset_at / reset_period，防止每月白嫖**
- 用量计费时优先扣 `free_quota`，扣完再走付费余额（如已有付费余额逻辑）
- key 详情接口 / dashboard 展示剩余赠送额度

## 3. 营销钩子（A + B + C 全要）
**A. 用完即升 banner**
- dashboard 顶部条件渲染：当 `free_quota - quota_used` 占比 < 10% 时展示
- 文案："赠送额度即将用完，充值 ¥9.9 送 50 万 token / ¥29 送 200 万 token"
- 充值按钮先做 stub（点击弹"即将开放"或跳到联系客服页），不做支付逻辑

**B. 邀请返利**
- 每个 key 生成邀请码（可用 key id 或独立短码字段 `invite_code`）
- finalize 接口加可选参数 `?ref=<invite_code>`：
  - 新用户首次创建 key 且带 ref 时，新老 key 各 +50000 free_quota
  - 防自邀：ref 对应的 openid 与新 openid 不能相同
- dashboard 展示"我的邀请链接"（`https://api.eagle.openclaws.co.uk/wx/scan?ref=xxx` 之类）和"已邀请人数 / 累计返利"
- 数据落 `wx_invites` 表（inviter_key_id, invitee_key_id, openid, created_at, reward_tokens）

**C. 公众号引导**
- 不在本次实现，仅在 dashboard 加一句引导文案："关注公众号回复'更多额度'获取额外奖励"。具体回复逻辑后续在 wx-gateway 做。

## 4. 反薅羊毛（默认全开）
- **IP 限流注册**：同 IP 24h 内最多 3 个新 openid finalize 成功，超出返 429。落 `wx_signup_ip_log` 表（ip, openid, created_at）
- **每 key 速率限制**：60 RPM。复用现有限流中间件（如有）或新增内存 token bucket
- **异常用量监控**：单 key 1h 内消耗 free_quota 超 30% → 写日志告警（console.warn + 写 `risk_alerts` 表）。先不做外发通知

## 5. 验收 checklist
- [ ] 扫码 → 收到 sk-proxy-wx-xxx key，free_quota=300000，wx_openid 绑定
- [ ] 同一 openid 重复扫码 → 返回同一 key
- [ ] 扫码带 ref → 新老 key 各 +5万
- [ ] dashboard 在剩余 < 10% 时展示充值 banner
- [ ] dashboard 展示邀请链接和邀请数据
- [ ] 同 IP 24h 内第 4 次新 openid → 429
- [ ] 单 key 高频请求触发 60 RPM 限流
- [ ] 单 key 1h 烧完 30% → risk_alerts 表有记录

## 不做
- unionid 去重（用户明确说不要）
- 公众号侧"更多额度"回复逻辑
- 真实支付接入

## 工程要求
- 改 schema 用 migration 脚本（参考 `scripts/migrate-keys.mjs`）
- 加单测或集成测脚本（参考 `scripts/test-wx-finalize.mjs`）
- 改完跑一遍现有 test-stage2/3/4 确保没回归
- 提交时 git commit 分多个逻辑单元，commit message 中文 OK
