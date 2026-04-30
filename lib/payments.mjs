// ─── wx-gateway payment integration (personal_qr) ───────────────────────────
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db, withTransaction } from "./database.mjs";
import { addPaidQuota } from "./keys-v2.mjs";
import { cst } from "./utils.mjs";
import { computeNextWindowReset } from "./quota-gate.mjs";

// Webhook signature freshness window
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;
// Grace period for late "paid" webhooks after expiry — beyond this we refuse to grant quota.
const PAID_AFTER_EXPIRY_GRACE_MS = 5 * 60 * 1000;

// Catalog: package id → { amount_fen, tokens_to_grant?, plan_type?, subject }
export const PACKAGES = {
  "990":        { amount_fen: 990,  tokens_to_grant: 500_000,   subject: "Copilot Proxy 50万 token" },
  "2900":       { amount_fen: 2900, tokens_to_grant: 2_000_000, subject: "Copilot Proxy 200万 token" },
  "monthly_29": { amount_fen: 2900, plan_type: "monthly_29",    subject: "Copilot Proxy 包月畅用", desc: "30天 / 5h 600次" },
};

export function getPackage(id) {
  return PACKAGES[String(id)] || null;
}

// ─── Config helpers ─────────────────────────────────────────────────────────
function getConfig() {
  const base = (process.env.WX_GATEWAY_BASE || "").replace(/\/+$/, "");
  const appName = process.env.WX_GATEWAY_APP_NAME || "";
  const secret = process.env.WX_GATEWAY_SECRET || "";
  return { base, appName, secret, enabled: !!(base && appName && secret) };
}

// ─── HMAC helpers ───────────────────────────────────────────────────────────
function hmacHex(secret, data) {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function buildHeadersWithPayload(secret, appName, ts, payload) {
  const sig = hmacHex(secret, payload);
  return {
    "X-WX-App-Name": appName,
    "X-WX-Ts": ts,
    "X-WX-Sig": sig,
    "Content-Type": "application/json",
  };
}

/** Verify a webhook signature. Returns true if ok. */
export function verifyWebhookSig({ secret, event, payOrderId, status, ts, sig }) {
  if (!secret || !event || !payOrderId || !status || !ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() - tsNum) > WEBHOOK_MAX_SKEW_MS) return false;
  let expected;
  try {
    expected = hmacHex(secret, `${event}|${payOrderId}|${status}|${ts}`);
  } catch { return false; }
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

// ─── Gateway calls ──────────────────────────────────────────────────────────
async function gatewayCreate({ orderId, amount_fen, subject, openid, expiresIn }) {
  const cfg = getConfig();
  if (!cfg.enabled) throw new Error("wx_gateway_disabled");
  const body = JSON.stringify({
    orderId,
    amount_fen,
    method: "personal_qr",
    subject,
    expiresIn: expiresIn || 1800,
    userNote: openid ? `openid:${openid}` : undefined,
    openid: openid || undefined,
  });
  const ts = String(Date.now());
  const payload = `${cfg.appName}|${orderId}|${amount_fen}|${ts}`;
  const headers = buildHeadersWithPayload(cfg.secret, cfg.appName, ts, payload);
  const r = await fetch(`${cfg.base}/pay/create`, { method: "POST", headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, raw: text };
}

async function gatewayClaim({ payOrderId }) {
  const cfg = getConfig();
  if (!cfg.enabled) throw new Error("wx_gateway_disabled");
  const body = JSON.stringify({ payOrderId });
  const ts = String(Date.now());
  const payload = `${cfg.appName}|${payOrderId}|${ts}`;
  const headers = buildHeadersWithPayload(cfg.secret, cfg.appName, ts, payload);
  const r = await fetch(`${cfg.base}/pay/personal/claim`, { method: "POST", headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, raw: text };
}

async function gatewayStatus({ payOrderId }) {
  const cfg = getConfig();
  if (!cfg.enabled) throw new Error("wx_gateway_disabled");
  const ts = String(Date.now());
  const sig = hmacHex(cfg.secret, `${payOrderId}|${ts}`);
  const headers = {
    "X-WX-App-Name": cfg.appName,
    "X-WX-Ts": ts,
    "X-WX-Sig": sig,
  };
  const r = await fetch(`${cfg.base}/pay/status/${encodeURIComponent(payOrderId)}`, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, raw: text };
}

// ─── DB ops ─────────────────────────────────────────────────────────────────
const INSERT_PAYMENT = db.prepare(`
  INSERT INTO payments (
    payOrderId, orderId, key_id, openid, amount_fen, package, tokens_to_grant,
    status, remark, qrcodeUrl, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const SELECT_BY_PAYORDER = db.prepare(`SELECT * FROM payments WHERE payOrderId = ?`);
const SELECT_BY_ORDER = db.prepare(`SELECT * FROM payments WHERE orderId = ?`);
const LIST_BY_KEY = db.prepare(`SELECT * FROM payments WHERE key_id = ? ORDER BY created_at DESC LIMIT ?`);
const UPDATE_SUBMITTED = db.prepare(`UPDATE payments SET status = 'submitted', submitted_at = ? WHERE payOrderId = ? AND status = 'pending'`);
const UPDATE_LOCAL_STATUS = db.prepare(`UPDATE payments SET status = ? WHERE payOrderId = ?`);

const APPLY_PAID_GUARDED = db.prepare(`
  UPDATE payments
     SET status = 'paid', paid_at = ?, external_ref = ?, webhook_processed_at = ?
   WHERE payOrderId = ? AND status <> 'paid'
`);
const APPLY_DISPUTED_GUARDED = db.prepare(`
  UPDATE payments
     SET status = 'disputed', reject_reason = ?, webhook_processed_at = ?
   WHERE payOrderId = ? AND status <> 'paid' AND status <> 'disputed'
`);
const APPLY_EXPIRED_GUARDED = db.prepare(`
  UPDATE payments
     SET status = 'expired', webhook_processed_at = ?
   WHERE payOrderId = ? AND status NOT IN ('paid', 'expired')
`);
const MARK_PROCESSED = db.prepare(`UPDATE payments SET webhook_processed_at = ? WHERE payOrderId = ?`);
const INSERT_RISK_ALERT = db.prepare(`INSERT INTO risk_alerts (ts, key_hash, type, detail) VALUES (?, ?, ?, ?)`);

export function getPaymentByPayOrderId(payOrderId) {
  if (!payOrderId) return null;
  return SELECT_BY_PAYORDER.get(payOrderId) || null;
}

export function getPaymentByOrderId(orderId) {
  if (!orderId) return null;
  return SELECT_BY_ORDER.get(orderId) || null;
}

export function listPaymentsByKey(keyHash, limit = 10) {
  return LIST_BY_KEY.all(keyHash, Math.min(Number(limit) || 10, 100));
}

function genOrderId(keyHash) {
  const short = (keyHash || "anon").slice(0, 8);
  const rand = randomBytes(3).toString("hex");
  return `cp_${short}_${Date.now()}_${rand}`;
}

/**
 * Create a payment: call gateway and persist. Returns { ok, payment } or { ok:false, status, error }.
 */
export async function createPayment({ keyRow, packageId }) {
  const pkg = getPackage(packageId);
  if (!pkg) return { ok: false, status: 400, error: "invalid_package" };
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, status: 503, error: "wx_gateway_disabled" };

  const orderId = genOrderId(keyRow.key_hash);
  let resp;
  try {
    resp = await gatewayCreate({
      orderId,
      amount_fen: pkg.amount_fen,
      subject: pkg.subject,
      openid: keyRow.wx_openid || null,
      expiresIn: 1800,
    });
  } catch (e) {
    return { ok: false, status: 502, error: "gateway_unreachable", detail: e.message };
  }
  if (resp.status !== 200 || !resp.body || !resp.body.payOrderId) {
    return { ok: false, status: 502, error: "gateway_error", detail: resp.body || resp.raw };
  }

  const b = resp.body;
  // 网关可能返回毫秒数字或 ISO 字符串，都要兼容
  let expiresAtMs;
  if (typeof b.expiresAt === "number") expiresAtMs = b.expiresAt;
  else if (typeof b.expiresAt === "string") expiresAtMs = Date.parse(b.expiresAt);
  if (!expiresAtMs || Number.isNaN(expiresAtMs)) expiresAtMs = Date.now() + 1800 * 1000;

  try {
    INSERT_PAYMENT.run(
      b.payOrderId,
      orderId,
      keyRow.key_hash,
      keyRow.wx_openid || null,
      pkg.amount_fen,
      String(packageId),
      pkg.tokens_to_grant || 0,
      "pending",
      b.remark || null,
      b.qrcodeUrl || null,
      Date.now(),
      expiresAtMs,
    );
  } catch (e) {
    return { ok: false, status: 500, error: "db_insert_failed", detail: e.message };
  }

  return {
    ok: true,
    payment: {
      payOrderId: b.payOrderId,
      orderId,
      qrcodeUrl: b.qrcodeUrl,
      remark: b.remark,
      amount_fen: pkg.amount_fen,
      tokens_to_grant: pkg.tokens_to_grant,
      package: String(packageId),
      status: "pending",
      expires_at: expiresAtMs,
    },
  };
}

/** Mark "user clicked 我已付款". Calls gateway claim and flips local status. */
export async function claimPayment({ payment }) {
  if (!payment) return { ok: false, status: 404, error: "not_found" };
  if (payment.status !== "pending") {
    return { ok: false, status: 409, error: "state_invalid", current: payment.status };
  }
  let resp;
  try {
    resp = await gatewayClaim({ payOrderId: payment.payOrderId });
  } catch (e) {
    return { ok: false, status: 502, error: "gateway_unreachable", detail: e.message };
  }
  if (resp.status !== 200) {
    return { ok: false, status: 502, error: "gateway_error", detail: resp.body || resp.raw };
  }
  UPDATE_SUBMITTED.run(Date.now(), payment.payOrderId);
  return { ok: true, status: "submitted" };
}

/**
 * Pull authoritative status from gateway and reconcile if local is still pending/submitted.
 * Best-effort: returns latest local row regardless.
 */
export async function syncPaymentStatus({ payment }) {
  if (!payment) return null;
  if (payment.status !== "pending" && payment.status !== "submitted") return payment;
  let resp;
  try { resp = await gatewayStatus({ payOrderId: payment.payOrderId }); }
  catch { return payment; }
  if (resp.status !== 200 || !resp.body || !resp.body.status) return payment;
  const remoteStatus = resp.body.status;
  // We don't grant quota from sync — webhook is the source of truth for that.
  // Only mirror non-paid terminal flips locally so the UI stops polling.
  if (remoteStatus !== payment.status && (remoteStatus === "submitted" || remoteStatus === "expired" || remoteStatus === "disputed")) {
    UPDATE_LOCAL_STATUS.run(remoteStatus, payment.payOrderId);
  }
  return getPaymentByPayOrderId(payment.payOrderId);
}

/**
 * Apply a webhook event. Atomic + idempotent + terminal-state-protected:
 *   - All UPDATEs use WHERE-status guards so concurrent re-deliveries cannot
 *     double-grant quota (TOCTOU-safe).
 *   - Once `paid`, the payment is terminal — any further status flip is logged
 *     to risk_alerts and refused (paid → disputed needs human review).
 *   - `paid` events arriving after `expires_at + grace` are logged and refused.
 *
 * Returns:
 *   { ok: true, applied: true }                          — first successful apply
 *   { ok: true, applied: false, idempotent: true }       — already applied
 *   { ok: true, applied: false, refused: true, reason }  — terminal/expired guard hit
 *   { ok: false, error }                                  — payment not found
 */
export function applyWebhookEvent({ event, payOrderId, status, externalRef = null, rejectReason = null, paidAtIso = null }) {
  const payment = getPaymentByPayOrderId(payOrderId);
  if (!payment) return { ok: false, error: "payment_not_found" };

  const now = Date.now();

  // ── Terminal-state protection: once paid, refuse further auto-flips ─
  if (payment.status === "paid" && status !== "paid") {
    try {
      INSERT_RISK_ALERT.run(cst(), payment.key_id, "paid_status_flip_attempt",
        JSON.stringify({ payOrderId, requested_status: status, event, externalRef, rejectReason }));
    } catch {}
    console.warn(`[pay][webhook] refused paid→${status} on ${payOrderId} (terminal)`);
    return { ok: true, applied: false, refused: true, reason: "terminal_paid" };
  }

  // ── Idempotency fast-path: already same status + already processed ─
  if (payment.status === status && payment.webhook_processed_at) {
    return { ok: true, applied: false, idempotent: true };
  }

  return withTransaction(() => {
    if (event === "payment.paid" && status === "paid") {
      // Refuse paid arriving long after expiry
      if (payment.expires_at && now > Number(payment.expires_at) + PAID_AFTER_EXPIRY_GRACE_MS) {
        try {
          INSERT_RISK_ALERT.run(cst(), payment.key_id, "paid_after_expiry_grace",
            JSON.stringify({ payOrderId, expires_at: payment.expires_at, now, externalRef }));
        } catch {}
        MARK_PROCESSED.run(now, payOrderId);
        console.warn(`[pay][webhook] paid arrived after expiry+grace for ${payOrderId} — quota NOT granted`);
        return { ok: true, applied: false, refused: true, reason: "expired_grace" };
      }
      const paidAtMs = paidAtIso ? Date.parse(paidAtIso) : now;
      const info = APPLY_PAID_GUARDED.run(paidAtMs, externalRef, now, payOrderId);
      if (info.changes === 1) {
        const pkg = getPackage(payment.package);
        if (pkg && pkg.plan_type) {
          // Monthly plan: set plan fields (stack on top of existing if not yet expired)
          const nowSec = Math.floor(now / 1000);
          const existing = db.prepare("SELECT plan_expires_at FROM api_keys_v2 WHERE key_hash=?").get(payment.key_id);
          const currentExpiry = existing ? Number(existing.plan_expires_at || 0) : 0;
          const baseExpiry = (currentExpiry > nowSec) ? currentExpiry : nowSec;
          const newExpiry = baseExpiry + 30 * 86400;
          const nextReset = computeNextWindowReset(nowSec);
          if (currentExpiry > nowSec) {
            // Stacking: only extend expiry, don't reset window
            db.prepare("UPDATE api_keys_v2 SET plan_type=?, plan_expires_at=? WHERE key_hash=?")
              .run(pkg.plan_type, newExpiry, payment.key_id);
          } else {
            db.prepare("UPDATE api_keys_v2 SET plan_type=?, plan_expires_at=?, window_used=0, window_reset_at=? WHERE key_hash=?")
              .run(pkg.plan_type, newExpiry, nextReset, payment.key_id);
          }
        } else {
          addPaidQuota(payment.key_id, payment.tokens_to_grant);
        }
        return { ok: true, applied: true };
      }
      return { ok: true, applied: false, idempotent: true };
    }

    if (event === "payment.disputed" && status === "disputed") {
      const info = APPLY_DISPUTED_GUARDED.run(rejectReason, now, payOrderId);
      if (info.changes === 1) return { ok: true, applied: true };
      return { ok: true, applied: false, idempotent: true };
    }

    if (event === "payment.expired" && status === "expired") {
      const info = APPLY_EXPIRED_GUARDED.run(now, payOrderId);
      if (info.changes === 1) return { ok: true, applied: true };
      return { ok: true, applied: false, idempotent: true };
    }

    // Generic flip — still terminal-protected (status<>'paid' guard)
    const info = db.prepare(`UPDATE payments SET status = ?, webhook_processed_at = ? WHERE payOrderId = ? AND status <> 'paid'`).run(status, now, payOrderId);
    return { ok: true, applied: info.changes === 1, idempotent: info.changes !== 1 };
  });
}

/**
 * Periodic sweep: any pending/submitted payment past expires_at gets flipped
 * to expired. Returns number of rows updated. Best-effort.
 */
export function sweepExpiredPayments() {
  const now = Date.now();
  try {
    const info = db.prepare(`
      UPDATE payments
         SET status = 'expired',
             webhook_processed_at = COALESCE(webhook_processed_at, ?)
       WHERE status IN ('pending', 'submitted')
         AND expires_at IS NOT NULL
         AND expires_at < ?
    `).run(now, now);
    if (info.changes > 0) console.log(`[pay][sweep] marked ${info.changes} payment(s) expired`);
    return info.changes;
  } catch (e) {
    console.error("[pay][sweep] error:", e.message);
    return 0;
  }
}
