// ─── api_keys_v2 access + quota/charge logic ────────────────────────────────
import { createHash, randomBytes } from "node:crypto";
import { db, withTransaction } from "./database.mjs";
import { cst } from "./utils.mjs";
import { computeCost } from "./pricing.mjs";

export function hashKey(rawKey) {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function newRawKey() {
  return "sk-proxy-" + randomBytes(24).toString("hex");
}

/** Compute next free reset time = first day of next month, ISO CST. */
function nextMonthReset(from = new Date()) {
  // Work in CST (UTC+8) to align with the cst() string format.
  const cstNow = new Date(from.getTime() + 8 * 3600_000);
  const y = cstNow.getUTCFullYear();
  const m = cstNow.getUTCMonth();
  // first day of next month in CST → convert back to UTC for storage as cst-string-comparable ISO
  const nextCst = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
  return nextCst.toISOString().replace("T", " ").slice(0, 23);
}

const SELECT_BY_HASH = db.prepare(`SELECT * FROM api_keys_v2 WHERE key_hash = ?`);
const UPDATE_LAST_USED = db.prepare(`UPDATE api_keys_v2 SET last_used_at = ? WHERE key_hash = ?`);
const RESET_FREE_STMT = db.prepare(`UPDATE api_keys_v2 SET free_used = 0, free_reset_at = ? WHERE key_hash = ?`);
const CHARGE_FREE_STMT = db.prepare(`UPDATE api_keys_v2 SET free_used = free_used + ? WHERE key_hash = ?`);
const CHARGE_BAL_STMT  = db.prepare(`UPDATE api_keys_v2 SET balance_tokens = balance_tokens - ? WHERE key_hash = ?`);
const INSERT_LEDGER = db.prepare(`INSERT INTO usage_ledger (ts, key_hash, model, input_tokens, output_tokens, cost_tokens, source, log_id, usage_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const INSERT_KEY = db.prepare(`INSERT INTO api_keys_v2 (key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, note, source, invite_code, wx_openid, display_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const LIST_STMT = db.prepare(`SELECT key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, last_used_at, note, source, invite_code, wx_openid FROM api_keys_v2 ORDER BY created_at DESC`);
const SELECT_BY_OPENID = db.prepare(`SELECT * FROM api_keys_v2 WHERE wx_openid = ? LIMIT 1`);
const SELECT_BY_INVITE = db.prepare(`SELECT * FROM api_keys_v2 WHERE invite_code = ? LIMIT 1`);
const ADD_FREE_QUOTA_STMT = db.prepare(`UPDATE api_keys_v2 SET free_quota = free_quota + ? WHERE key_hash = ?`);
const ADD_PAID_QUOTA_STMT = db.prepare(`UPDATE api_keys_v2 SET paid_quota = COALESCE(paid_quota, 0) + ? WHERE key_hash = ?`);
const CHARGE_PAID_STMT = db.prepare(`UPDATE api_keys_v2 SET paid_quota = COALESCE(paid_quota, 0) - ? WHERE key_hash = ?`);

// Guarded charge variants — only succeed when bucket has enough remaining.
// info.changes === 1 means the bucket fully covered the requested amount.
const CHARGE_FREE_GUARD = db.prepare(`UPDATE api_keys_v2 SET free_used = free_used + ? WHERE key_hash = ? AND (free_quota - free_used) >= ?`);
const CHARGE_PAID_GUARD = db.prepare(`UPDATE api_keys_v2 SET paid_quota = COALESCE(paid_quota, 0) - ? WHERE key_hash = ? AND COALESCE(paid_quota, 0) >= ?`);
const CHARGE_BAL_GUARD  = db.prepare(`UPDATE api_keys_v2 SET balance_tokens = balance_tokens - ? WHERE key_hash = ? AND balance_tokens >= ?`);

export function getKeyByRaw(rawKey) {
  if (!rawKey) return null;
  const row = SELECT_BY_HASH.get(hashKey(rawKey));
  return row || null;
}
export function getKeyByHash(h) {
  if (!h) return null;
  return SELECT_BY_HASH.get(h) || null;
}

export function listKeys() {
  return LIST_STMT.all();
}

export function countKeys() {
  return db.prepare("SELECT COUNT(*) AS c FROM api_keys_v2").get().c;
}

export function createKey(opts) {
  const raw = opts.raw || newRawKey();
  const h = hashKey(raw);
  const prefix = raw.slice(0, 12);
  const allowed = opts.allowed_models ? JSON.stringify(opts.allowed_models) : null;
  // Wx-signup keys must NOT auto-reset monthly — store NULL reset_at and skip rollover.
  const source = opts.source || "manual";
  const skipReset = opts.no_reset === true || source === "wx_signup";
  const resetAt = skipReset ? null : nextMonthReset();
  // Persist raw for wx_signup so /user/me can show full key on later logins.
  // For other sources, raw is shown only at creation time (not stored).
  const displayRaw = source === "wx_signup" ? raw : null;
  INSERT_KEY.run(
    h,
    prefix,
    opts.name || null,
    opts.role || "user",
    Number(opts.balance_tokens || 0),
    Number(opts.free_quota ?? 10000),
    0,
    resetAt,
    opts.unlimited ? 1 : 0,
    allowed,
    opts.status || "active",
    opts.token_name || null,
    cst(),
    opts.note || null,
    source,
    opts.invite_code || null,
    opts.wx_openid || null,
    displayRaw,
  );
  return { raw, key_hash: h, prefix };
}

/** Generate a short random invite code (8 chars, base32-like). */
function newInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

/** Create a fresh wx-signup key. Returns the row + raw key.
 *  If a key already bound to this openid exists (UNIQUE wx_openid), returns that
 *  existing row instead of throwing — makes signup idempotent. */
export function createWxSignupKey({ openid, freeQuota = 300_000, name = null, note = null }) {
  const existing = openid ? SELECT_BY_OPENID.get(openid) : null;
  if (existing) {
    return {
      raw: existing.display_raw || null,
      key_hash: existing.key_hash,
      prefix: existing.key_prefix,
      invite_code: existing.invite_code,
      free_quota: existing.free_quota,
      reused: true,
    };
  }
  const raw = "sk-proxy-wx-" + randomBytes(20).toString("hex");
  let inviteCode = null;
  for (let i = 0; i < 5; i++) {
    const c = newInviteCode();
    if (!SELECT_BY_INVITE.get(c)) { inviteCode = c; break; }
  }
  if (!inviteCode) inviteCode = newInviteCode() + Date.now().toString(36).slice(-2);
  try {
    const result = createKey({
      raw,
      name: name || `wx_${openid.slice(0, 8)}`,
      role: "user",
      free_quota: freeQuota,
      unlimited: 0,
      source: "wx_signup",
      invite_code: inviteCode,
      wx_openid: openid,
      note,
    });
    return { ...result, invite_code: inviteCode, free_quota: freeQuota };
  } catch (e) {
    // UNIQUE collision (race vs concurrent finalize) — re-fetch and return existing.
    const after = openid ? SELECT_BY_OPENID.get(openid) : null;
    if (after) {
      return {
        raw: after.display_raw || null,
        key_hash: after.key_hash,
        prefix: after.key_prefix,
        invite_code: after.invite_code,
        free_quota: after.free_quota,
        reused: true,
      };
    }
    throw e;
  }
}

export function getKeyByOpenid(openid) {
  if (!openid) return null;
  return SELECT_BY_OPENID.get(openid) || null;
}

export function getKeyByInviteCode(code) {
  if (!code) return null;
  return SELECT_BY_INVITE.get(code) || null;
}

/** Add to free_quota (used for invite rewards / future top-ups). */
export function addFreeQuota(keyHash, amount) {
  const n = Math.max(0, Number(amount || 0));
  if (!n) return;
  ADD_FREE_QUOTA_STMT.run(n, keyHash);
}

// Stage-6 invite settlement threshold (cumulative cost_tokens by invitee)
const INVITE_SETTLE_THRESHOLD = Number(process.env.WX_INVITE_SETTLE_THRESHOLD || 10_000);

/**
 * Lazy invite-reward settlement. If `inviteeKeyHash` has a pending wx_invites row
 * AND the invitee's lifetime cost_tokens reached threshold, atomically credit
 * both inviter and invitee with `reward_tokens` and flip status to 'settled'.
 * Best-effort, never throws to caller.
 */
export function maybeSettleInvite(inviteeKeyHash) {
  if (!inviteeKeyHash) return null;
  const inv = db.prepare(`SELECT * FROM wx_invites WHERE invitee_key_hash = ? AND reward_status = 'pending' LIMIT 1`).get(inviteeKeyHash);
  if (!inv) return null;
  const sum = db.prepare(`SELECT COALESCE(SUM(cost_tokens),0) AS s FROM usage_ledger WHERE key_hash = ?`).get(inviteeKeyHash);
  const consumed = Number(sum?.s || 0);
  if (consumed < INVITE_SETTLE_THRESHOLD) return { settled: false, consumed, threshold: INVITE_SETTLE_THRESHOLD };
  let settled = false;
  withTransaction(() => {
    // Re-check inside txn to avoid double-settle
    const cur = db.prepare(`SELECT reward_status FROM wx_invites WHERE id = ?`).get(inv.id);
    if (!cur || cur.reward_status !== 'pending') return;
    const reward = Number(inv.reward_tokens || 0);
    if (reward > 0) {
      ADD_FREE_QUOTA_STMT.run(reward, inv.inviter_key_hash);
      ADD_FREE_QUOTA_STMT.run(reward, inv.invitee_key_hash);
    }
    db.prepare(`UPDATE wx_invites SET reward_status = 'settled', settled_at = ? WHERE id = ?`).run(cst(), inv.id);
    settled = true;
  });
  if (settled) {
    console.log(`[wx][invite] settled inv#${inv.id} inviter=${inv.inviter_key_hash.slice(0,8)}… invitee=${inv.invitee_key_hash.slice(0,8)}… +${inv.reward_tokens} each`);
  }
  return { settled, consumed, threshold: INVITE_SETTLE_THRESHOLD };
}

/** Add to paid_quota (granted when a wx-gateway payment is marked paid). */
export function addPaidQuota(keyHash, amount) {
  const n = Math.max(0, Number(amount || 0));
  if (!n) return;
  ADD_PAID_QUOTA_STMT.run(n, keyHash);
}

export function updateKey(h, patch) {
  const row = getKeyByHash(h);
  if (!row) return null;
  const allowedFields = ["name", "role", "balance_tokens", "free_quota", "unlimited", "allowed_models", "status", "token_name", "note"];
  const sets = [];
  const vals = [];
  for (const f of allowedFields) {
    if (!(f in patch)) continue;
    let v = patch[f];
    if (f === "allowed_models") v = v ? JSON.stringify(v) : null;
    if (f === "unlimited") v = v ? 1 : 0;
    sets.push(`${f} = ?`);
    vals.push(v);
  }
  if (!sets.length) return row;
  vals.push(h);
  db.prepare(`UPDATE api_keys_v2 SET ${sets.join(", ")} WHERE key_hash = ?`).run(...vals);
  return getKeyByHash(h);
}

export function disableKey(h) {
  return updateKey(h, { status: "disabled" });
}

export function topupKey(h, tokens) {
  const n = Math.max(0, Number(tokens || 0));
  db.prepare(`UPDATE api_keys_v2 SET balance_tokens = balance_tokens + ? WHERE key_hash = ?`).run(n, h);
  return getKeyByHash(h);
}

export function resetFree(h) {
  RESET_FREE_STMT.run(nextMonthReset(), h);
  return getKeyByHash(h);
}

export function touchUsed(h) {
  UPDATE_LAST_USED.run(cst(), h);
}

/** If the month has rolled over, reset free_used and bump free_reset_at. Mutates DB.
 *  wx_signup keys never roll over — their 30万 quota is one-time. */
export function rolloverIfNeeded(row) {
  if (row.source === "wx_signup") return;
  if (!row.free_reset_at) {
    RESET_FREE_STMT.run(nextMonthReset(), row.key_hash);
    row.free_used = 0;
    row.free_reset_at = nextMonthReset();
    return;
  }
  // free_reset_at is the next reset time. If now >= that time, reset.
  if (cst() >= row.free_reset_at) {
    RESET_FREE_STMT.run(nextMonthReset(), row.key_hash);
    row.free_used = 0;
    row.free_reset_at = nextMonthReset();
  }
}

/**
 * Decide whether `row` can pay `estimatedCost` tokens.
 * Returns { allowed: bool, source?: 'unlimited'|'free'|'balance', reason?, free_remaining?, balance? }
 */
export function canAfford(row, estimatedCost) {
  if (row.status === "disabled") {
    return { allowed: false, reason: "key_disabled" };
  }
  if (row.unlimited) return { allowed: true, source: "unlimited" };
  rolloverIfNeeded(row);
  const freeRemain = Math.max(0, row.free_quota - row.free_used);
  const paidRemain = Math.max(0, Number(row.paid_quota || 0));
  if (freeRemain >= estimatedCost) return { allowed: true, source: "free" };
  if (paidRemain >= estimatedCost) return { allowed: true, source: "paid" };
  if (row.balance_tokens >= estimatedCost) return { allowed: true, source: "balance" };
  return {
    allowed: false,
    reason: "insufficient_quota",
    free_remaining: freeRemain,
    paid_remaining: paidRemain,
    balance: row.balance_tokens,
    estimated_cost: estimatedCost,
  };
}

export function isModelAllowed(row, model) {
  if (!row.allowed_models) return true;
  try {
    const arr = JSON.parse(row.allowed_models);
    if (!Array.isArray(arr) || arr.length === 0) return true;
    return arr.includes(model);
  } catch { return true; }
}

/**
 * Charge actual usage after the upstream call. Atomic: re-reads fresh state
 * inside a transaction and uses guarded UPDATEs so concurrent charges cannot
 * over-drain a bucket. Falls through free → paid → balance, finally overdraft.
 */
export function chargeUsage({ row, model, inputTokens, outputTokens, logId, usageSource = "upstream" }) {
  if (!row) return null;
  const cost = computeCost(model, inputTokens, outputTokens);
  let source = "unknown";

  withTransaction(() => {
    // Re-fetch authoritative state inside the txn — the cached row may be stale
    // after concurrent charges on the same key.
    const fresh = SELECT_BY_HASH.get(row.key_hash);
    if (!fresh) { source = "missing"; return; }
    Object.assign(row, fresh); // update caller's snapshot

    if (fresh.unlimited) { source = "unlimited"; return; }
    rolloverIfNeeded(fresh); // safe inside txn (re-entrant)

    let remain = cost;
    let drewFree = 0, drewPaid = 0, drewBal = 0;

    // Try free bucket
    {
      const cur = SELECT_BY_HASH.get(row.key_hash);
      const avail = Math.max(0, cur.free_quota - cur.free_used);
      const take = Math.min(avail, remain);
      if (take > 0) {
        const info = CHARGE_FREE_GUARD.run(take, row.key_hash, take);
        if (info.changes === 1) { remain -= take; drewFree = take; }
      }
    }
    // Try paid bucket
    if (remain > 0) {
      const cur = SELECT_BY_HASH.get(row.key_hash);
      const avail = Math.max(0, Number(cur.paid_quota || 0));
      const take = Math.min(avail, remain);
      if (take > 0) {
        const info = CHARGE_PAID_GUARD.run(take, row.key_hash, take);
        if (info.changes === 1) { remain -= take; drewPaid = take; }
      }
    }
    // Try balance bucket
    if (remain > 0) {
      const cur = SELECT_BY_HASH.get(row.key_hash);
      const avail = Math.max(0, cur.balance_tokens);
      const take = Math.min(avail, remain);
      if (take > 0) {
        const info = CHARGE_BAL_GUARD.run(take, row.key_hash, take);
        if (info.changes === 1) { remain -= take; drewBal = take; }
      }
    }
    // Overdraft: request already served — drain remainder from balance unconditionally
    if (remain > 0) {
      CHARGE_BAL_STMT.run(remain, row.key_hash);
      drewBal += remain;
      source = "overdraft";
    } else if (drewFree === cost) source = "free";
    else if (drewPaid === cost && drewFree === 0) source = "paid";
    else if (drewBal === cost && drewFree === 0 && drewPaid === 0) source = "balance";
    else source = "mixed";
  });

  INSERT_LEDGER.run(cst(), row.key_hash, model || null, inputTokens || 0, outputTokens || 0, cost, source, logId || null, usageSource);
  touchUsed(row.key_hash);
  // Stage-6: lazy invite-reward settlement after consumption crosses threshold
  try { maybeSettleInvite(row.key_hash); } catch (e) { /* best-effort */ }
  return { source, cost };
}

export function listLedger({ keyHash, from, to, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (keyHash) { where.push("key_hash = ?"); params.push(keyHash); }
  if (from)    { where.push("ts >= ?");      params.push(from); }
  if (to)      { where.push("ts <= ?");      params.push(to); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  return db.prepare(`SELECT * FROM usage_ledger ${w} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(limit, 1000));
}

// ─── Per-key v2 rate limit: 60 RPM (sliding window, in-memory) ───────────────
// Applies to all non-unlimited v2 keys. Anti-abuse safety net layered on top of
// any legacy-key per-name limit.
const V2_RPM_LIMIT = Number(process.env.V2_KEY_RPM || 60);
const v2RpmCounters = new Map(); // key_hash → number[] of timestamps (ms)

export function checkV2RateLimit(row) {
  if (!row || row.unlimited) return null;
  const now = Date.now();
  const oneMinAgo = now - 60_000;
  const arr = v2RpmCounters.get(row.key_hash) || [];
  const pruned = arr.filter(ts => ts > oneMinAgo);
  if (pruned.length !== arr.length) v2RpmCounters.set(row.key_hash, pruned);
  if (pruned.length >= V2_RPM_LIMIT) {
    return {
      message: `Rate limit exceeded: ${V2_RPM_LIMIT} RPM (per key)`,
      limit: V2_RPM_LIMIT,
      remaining: 0,
      resetMs: pruned[0] + 60_000 - now,
    };
  }
  return null;
}

export function recordV2Request(row) {
  if (!row || row.unlimited) return;
  const arr = v2RpmCounters.get(row.key_hash) || [];
  arr.push(Date.now());
  v2RpmCounters.set(row.key_hash, arr);
}

// ─── Risk monitor: wx_signup key burning >30% free_quota in last hour ───────
// Fired from chargeFromLog (best-effort). Debounced: only one alert per key/hour.
const RISK_BURN_FRACTION = 0.30;
const lastAlertAt = new Map(); // key_hash → ms

export function maybeAlertHighBurn(row) {
  if (!row || row.source !== "wx_signup" || row.unlimited) return;
  if (!row.free_quota) return;
  const now = Date.now();
  const last = lastAlertAt.get(row.key_hash) || 0;
  if (now - last < 3600_000) return; // already alerted in last hour
  // 1h window: count cost_tokens charged from this key
  const oneHourAgoIso = new Date(now - 3600_000).toISOString().replace("T", " ").slice(0, 23);
  const r = db.prepare(`SELECT COALESCE(SUM(cost_tokens),0) AS spent FROM usage_ledger WHERE key_hash = ? AND ts >= ?`).get(row.key_hash, oneHourAgoIso);
  const spent = Number(r?.spent || 0);
  const threshold = row.free_quota * RISK_BURN_FRACTION;
  if (spent >= threshold) {
    lastAlertAt.set(row.key_hash, now);
    const detail = JSON.stringify({ window_h: 1, spent, free_quota: row.free_quota, threshold });
    try {
      db.prepare(`INSERT INTO risk_alerts (ts, key_hash, type, detail) VALUES (?, ?, ?, ?)`).run(cst(), row.key_hash, "high_burn_1h", detail);
    } catch (e) { /* best-effort */ }
    console.warn(`[risk] wx_signup key ${row.key_hash.slice(0,8)}… burned ${spent}/${row.free_quota} (>${Math.round(RISK_BURN_FRACTION*100)}%) in last 1h`);
  }
}
