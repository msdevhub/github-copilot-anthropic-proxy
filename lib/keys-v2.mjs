// ─── api_keys_v2 access + quota/charge logic ────────────────────────────────
import { createHash, randomBytes } from "node:crypto";
import { db } from "./database.mjs";
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
const INSERT_LEDGER = db.prepare(`INSERT INTO usage_ledger (ts, key_hash, model, input_tokens, output_tokens, cost_tokens, source, log_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const INSERT_KEY = db.prepare(`INSERT INTO api_keys_v2 (key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, note, source, invite_code, wx_openid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const LIST_STMT = db.prepare(`SELECT key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, last_used_at, note, source, invite_code, wx_openid FROM api_keys_v2 ORDER BY created_at DESC`);
const SELECT_BY_OPENID = db.prepare(`SELECT * FROM api_keys_v2 WHERE wx_openid = ? LIMIT 1`);
const SELECT_BY_INVITE = db.prepare(`SELECT * FROM api_keys_v2 WHERE invite_code = ? LIMIT 1`);
const ADD_FREE_QUOTA_STMT = db.prepare(`UPDATE api_keys_v2 SET free_quota = free_quota + ? WHERE key_hash = ?`);

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

/** Create a fresh wx-signup key. Returns the row + raw key. */
export function createWxSignupKey({ openid, freeQuota = 300_000, name = null, note = null }) {
  const raw = "sk-proxy-wx-" + randomBytes(20).toString("hex");
  // Avoid invite_code collisions (UNIQUE index would throw); retry up to 5 times.
  let inviteCode = null;
  for (let i = 0; i < 5; i++) {
    const c = newInviteCode();
    if (!SELECT_BY_INVITE.get(c)) { inviteCode = c; break; }
  }
  if (!inviteCode) inviteCode = newInviteCode() + Date.now().toString(36).slice(-2);
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
  if (freeRemain >= estimatedCost) return { allowed: true, source: "free" };
  if (row.balance_tokens >= estimatedCost) return { allowed: true, source: "balance" };
  // Even if estimate exceeds either bucket alone, we conservatively deny —
  // partial-bucket spillover can be added later if needed.
  return {
    allowed: false,
    reason: "insufficient_quota",
    free_remaining: freeRemain,
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
 * Charge actual usage after the upstream call. Writes a ledger row, decrements
 * the right bucket. Source is decided again based on current state at charge time.
 */
export function chargeUsage({ row, model, inputTokens, outputTokens, logId }) {
  if (!row) return null;
  const cost = computeCost(model, inputTokens, outputTokens);
  let source;
  if (row.unlimited) {
    source = "unlimited";
  } else {
    rolloverIfNeeded(row);
    const freeRemain = Math.max(0, row.free_quota - row.free_used);
    if (freeRemain >= cost) {
      CHARGE_FREE_STMT.run(cost, row.key_hash);
      source = "free";
    } else if (row.balance_tokens >= cost) {
      CHARGE_BAL_STMT.run(cost, row.key_hash);
      source = "balance";
    } else {
      // Best-effort: drain free first, then balance, allow negative balance
      // (request already served — we don't reverse responses).
      const fromFree = Math.min(freeRemain, cost);
      if (fromFree > 0) CHARGE_FREE_STMT.run(fromFree, row.key_hash);
      const remain = cost - fromFree;
      if (remain > 0) CHARGE_BAL_STMT.run(remain, row.key_hash);
      source = "overdraft";
    }
  }
  INSERT_LEDGER.run(cst(), row.key_hash, model || null, inputTokens || 0, outputTokens || 0, cost, source, logId || null);
  touchUsed(row.key_hash);
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
