// ─── wx-gateway payment integration (personal_qr) ───────────────────────────
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./database.mjs";
import { addPaidQuota } from "./keys-v2.mjs";

// Webhook signature freshness window
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

// Catalog: package id → { amount_fen, tokens_to_grant, subject }
export const PACKAGES = {
  "990":  { amount_fen: 990,  tokens_to_grant: 500_000,   subject: "Copilot Proxy 50万 token" },
  "2900": { amount_fen: 2900, tokens_to_grant: 2_000_000, subject: "Copilot Proxy 200万 token" },
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

function buildHeaders(secret, appName, body) {
  const ts = String(Date.now());
  const sig = hmacHex(secret, body);
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
  const headers = buildHeaders(cfg.secret, cfg.appName, body);
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
  const headers = buildHeaders(cfg.secret, cfg.appName, body);
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

const APPLY_PAID = db.prepare(`
  UPDATE payments
     SET status = 'paid', paid_at = ?, external_ref = ?, webhook_processed_at = ?
   WHERE payOrderId = ?
`);
const APPLY_DISPUTED = db.prepare(`
  UPDATE payments
     SET status = 'disputed', reject_reason = ?, webhook_processed_at = ?
   WHERE payOrderId = ?
`);
const APPLY_EXPIRED = db.prepare(`
  UPDATE payments
     SET status = 'expired', webhook_processed_at = ?
   WHERE payOrderId = ?
`);

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
  const expiresAtMs = b.expiresAt ? Date.parse(b.expiresAt) : (Date.now() + 1800 * 1000);

  try {
    INSERT_PAYMENT.run(
      b.payOrderId,
      orderId,
      keyRow.key_hash,
      keyRow.wx_openid || null,
      pkg.amount_fen,
      String(packageId),
      pkg.tokens_to_grant,
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
 * Apply a webhook event. Atomic: state change + (if paid) paid_quota top-up.
 * Idempotent: a second call with the same final status is a no-op (returns { idempotent: true }).
 *
 * Returns { ok: true, applied: bool, idempotent?: bool }.
 */
export function applyWebhookEvent({ event, payOrderId, status, externalRef = null, rejectReason = null, paidAtIso = null }) {
  const payment = getPaymentByPayOrderId(payOrderId);
  if (!payment) return { ok: false, error: "payment_not_found" };

  // Idempotency: if status already matches and webhook_processed_at is set, no-op.
  if (payment.status === status && payment.webhook_processed_at) {
    return { ok: true, applied: false, idempotent: true };
  }

  const now = Date.now();
  const BEGIN = db.prepare("BEGIN");
  const COMMIT = db.prepare("COMMIT");
  const ROLLBACK = db.prepare("ROLLBACK");
  BEGIN.run();
  try {
    if (event === "payment.paid" && status === "paid") {
      const paidAtMs = paidAtIso ? Date.parse(paidAtIso) : now;
      APPLY_PAID.run(paidAtMs, externalRef, now, payOrderId);
      addPaidQuota(payment.key_id, payment.tokens_to_grant);
    } else if (event === "payment.disputed" && status === "disputed") {
      APPLY_DISPUTED.run(rejectReason, now, payOrderId);
    } else if (event === "payment.expired" && status === "expired") {
      APPLY_EXPIRED.run(now, payOrderId);
    } else {
      UPDATE_LOCAL_STATUS.run(status, payOrderId);
      db.prepare(`UPDATE payments SET webhook_processed_at = ? WHERE payOrderId = ?`).run(now, payOrderId);
    }
    COMMIT.run();
  } catch (e) {
    try { ROLLBACK.run(); } catch {}
    throw e;
  }
  return { ok: true, applied: true };
}
