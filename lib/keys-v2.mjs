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
const INSERT_KEY = db.prepare(`INSERT INTO api_keys_v2 (key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const LIST_STMT = db.prepare(`SELECT key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, last_used_at, note FROM api_keys_v2 ORDER BY created_at DESC`);

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
  INSERT_KEY.run(
    h,
    prefix,
    opts.name || null,
    opts.role || "user",
    Number(opts.balance_tokens || 0),
    Number(opts.free_quota ?? 10000),
    0,
    nextMonthReset(),
    opts.unlimited ? 1 : 0,
    allowed,
    opts.status || "active",
    opts.token_name || null,
    cst(),
    opts.note || null,
  );
  return { raw, key_hash: h, prefix };
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

/** If the month has rolled over, reset free_used and bump free_reset_at. Mutates DB. */
export function rolloverIfNeeded(row) {
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
