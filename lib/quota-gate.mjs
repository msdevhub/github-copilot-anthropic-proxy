// ─── Quota gate + post-request ledger charge ────────────────────────────────
import { canAfford, isModelAllowed, chargeUsage, maybeAlertHighBurn, touchUsed } from "./keys-v2.mjs";
import { estimateCost, estimateTokens, getRatesForModel } from "./pricing.mjs";
import { db, recordAdminAction } from "./database.mjs";
import { cst } from "./utils.mjs";

const PLANS = {
  monthly_29: { price_fen: 2900, window_quota: 600, window_seconds: 5 * 3600, duration_days: 30, name: '包月畅用' }
};
export { PLANS };

// CST = UTC+8. Align next window reset to the next CST anchor in {00,05,10,15,20}.
// After 20:00 the next anchor is the following day 00:00 (i.e. hour 24, not 25).
const CST_ANCHORS = [5, 10, 15, 20, 24];
function computeNextWindowReset(nowSec) {
  const cstMs = nowSec * 1000 + 8 * 3600 * 1000;
  const d = new Date(cstMs);
  d.setUTCMinutes(0, 0, 0);
  const cstHour = d.getUTCHours();
  const nextHour = CST_ANCHORS.find((h) => h > cstHour);
  d.setUTCHours(nextHour);
  return Math.floor((d.getTime() - 8 * 3600 * 1000) / 1000);
}
export { computeNextWindowReset };

const WINDOW_ROLLOVER_STMT = db.prepare(
  'UPDATE api_keys_v2 SET window_used=0, window_reset_at=? WHERE key_hash=?'
);
const DOWNGRADE_PLAN_STMT = db.prepare(
  "UPDATE api_keys_v2 SET plan_type='free' WHERE key_hash=?"
);
const CHARGE_WINDOW_GUARD = db.prepare(
  'UPDATE api_keys_v2 SET window_used=window_used+? WHERE key_hash=? AND window_used+?<=?'
);
const CHARGE_WINDOW_FORCE = db.prepare(
  'UPDATE api_keys_v2 SET window_used=window_used+? WHERE key_hash=?'
);
const INSERT_LEDGER = db.prepare(
  'INSERT INTO usage_ledger (ts, key_hash, model, input_tokens, output_tokens, cost_tokens, source, log_id, usage_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

export function windowRolloverIfNeeded(row) {
  const now = Math.floor(Date.now() / 1000);
  const resetAt = Number(row.window_reset_at || 0);
  if (now >= resetAt) {
    const next = computeNextWindowReset(now);
    WINDOW_ROLLOVER_STMT.run(next, row.key_hash);
    row.window_used = 0;
    row.window_reset_at = next;
  }
}

function isMonthlyActive(row) {
  const now = Math.floor(Date.now() / 1000);
  return row.plan_type === 'monthly_29' && Number(row.plan_expires_at || 0) > now;
}

/**
 * Pre-flight check. Returns { ok: true } or { ok: false, status, body }.
 */
export function quotaPreflight(keyRow, parsedBody, model) {
  if (!keyRow) return { ok: true }; // legacy json-key path: no quota
  if (!isModelAllowed(keyRow, model)) {
    return { ok: false, status: 403, body: { error: { type: "permission_error", message: `model "${model}" is not allowed for this key` } } };
  }
  if (keyRow.unlimited) return { ok: true };

  // ── Monthly plan path ─────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  if (keyRow.plan_type === 'monthly_29') {
    if (Number(keyRow.plan_expires_at || 0) <= now) {
      // Expired: auto-downgrade
      DOWNGRADE_PLAN_STMT.run(keyRow.key_hash);
      keyRow.plan_type = 'free';
    } else {
      windowRolloverIfNeeded(keyRow);
      const plan = PLANS.monthly_29;
      const weight = Math.max(1, Math.ceil(getRatesForModel(model).output_multiplier));
      const windowUsed = Number(keyRow.window_used || 0);
      if (windowUsed + weight > plan.window_quota) {
        return {
          ok: false,
          status: 429,
          body: {
            error: {
              type: 'rate_limit',
              message: '5h window quota exhausted',
              window_reset_at: keyRow.window_reset_at,
              window_used: windowUsed,
              window_quota: plan.window_quota,
            }
          }
        };
      }
      return { ok: true };
    }
  }

  // ── Free/paid token path ─────────────────────────────────────────────────
  const est = estimateCost(model, parsedBody);
  const r = canAfford(keyRow, est);
  if (r.allowed) return { ok: true };
  return {
    ok: false,
    status: 402,
    body: {
      error: {
        type: "insufficient_quota",
        message: r.reason === "key_disabled" ? "key disabled" : "insufficient quota",
        free_remaining: r.free_remaining,
        balance: r.balance,
        estimated_cost: r.estimated_cost,
      },
    },
  };
}

/** Post-flight: write usage to ledger and charge buckets. Best-effort, never throws. */
export function chargeFromLog(keyRow, logEntry, logId) {
  if (!keyRow) return;
  try {
    const hasUpstreamUsage = !!logEntry?.usage;
    const usageSource = hasUpstreamUsage ? "upstream" : "estimated";

    // ── Monthly plan: charge window_used (weight-based, usage-independent) ──
    if (isMonthlyActive(keyRow)) {
      const model = logEntry.model;
      const weight = Math.max(1, Math.ceil(getRatesForModel(model).output_multiplier));
      const plan = PLANS.monthly_29;
      const info = CHARGE_WINDOW_GUARD.run(weight, keyRow.key_hash, weight, plan.window_quota);
      if (info.changes === 0) {
        // Preflight passed (concurrent racers all saw room) but the window is now
        // full. The request was already served — we cannot un-serve it. Force the
        // overflow charge and audit it so we can spot abusive concurrency patterns.
        CHARGE_WINDOW_FORCE.run(weight, keyRow.key_hash);
        try {
          const cur = db.prepare("SELECT window_used FROM api_keys_v2 WHERE key_hash=?").get(keyRow.key_hash);
          recordAdminAction({
            adminKeyHash: keyRow.key_hash,
            adminName: keyRow.name || null,
            action: "window_overflow",
            target: model || null,
            payload: {
              weight,
              window_used_after: cur?.window_used || null,
              window_quota: plan.window_quota,
              log_id: logId,
            },
          });
        } catch (e) { /* audit best-effort */ }
      }
      INSERT_LEDGER.run(
        cst(), keyRow.key_hash, model || null,
        logEntry.usage?.input || 0, logEntry.usage?.output || 0,
        weight, 'monthly', logId || null, usageSource
      );
      touchUsed(keyRow.key_hash);
      return;
    }

    // ── Token path: prefer real usage; fall back to preflight estimate ──────
    let inputTokens, outputTokens;
    if (hasUpstreamUsage) {
      inputTokens = logEntry.usage.input || 0;
      outputTokens = logEntry.usage.output || 0;
    } else {
      // Upstream returned no usage (parser miss, network error mid-stream, etc.).
      // Charge the preflight estimate so token users can't get free requests.
      let parsed = null;
      try { parsed = JSON.parse(logEntry.requestBody || "null"); } catch {}
      if (!parsed) {
        // No body to estimate from — skip silently rather than overcharge with zeros.
        console.warn(`[quota] no upstream usage and no requestBody for log_id=${logId} key=${keyRow.key_prefix || ""}; skipping charge`);
        return;
      }
      const est = estimateTokens(parsed);
      inputTokens = est.input;
      outputTokens = est.output;
    }

    chargeUsage({
      row: keyRow,
      model: logEntry.model,
      inputTokens,
      outputTokens,
      logId,
      usageSource,
    });
    maybeAlertHighBurn(keyRow);
  } catch (e) {
    console.error("[quota] charge failed:", e.message);
  }
}
