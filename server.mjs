#!/usr/bin/env node
// Copilot → Anthropic API Proxy (with SQLite logging + dashboard)

import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Module imports ──────────────────────────────────────────────────────────
import { PORT, COPILOT_TOKEN_URL, DASHBOARD_PATH, PUBLIC_DIR, API_KEYS_PATH, DB_PATH, __DIR, fullError, mask } from "./lib/utils.mjs";
import { loadApiKeys, saveApiKeys } from "./lib/api-keys.mjs";
import { checkRateLimit, recordRequest, recordTokenUsage, getKeyUsageStats, getRateLimitCounters, pruneCounters } from "./lib/rate-limit.mjs";
import { loadTokens, saveTokens, getTokenType, maskToken, clearCachedToken, getActiveGitHubToken, deriveBaseUrl, exchangeGitHubToken, getTokenByName, getToken, getCachedTokenInfo } from "./lib/tokens.mjs";
import { checkApiKey, checkAdmin, checkUserSession, createUserSession, destroyUserSession, getUserSessionContext } from "./lib/auth.mjs";
import { db, addLog, recordAdminAction, listAdminActions, recordWebhookNonce, sweepWebhookNonces } from "./lib/database.mjs";
import { MODEL_REGISTRY, isClaudeModel, summarizeChatRequest, extractUsageNonStream, extractUsageStream, extractResponsesUsageNonStream, extractResponsesUsageStream, getModelRegistry } from "./lib/openai-protocol.mjs";
import { listKeys, createKey, updateKey, disableKey, topupKey, resetFree, getKeyByHash, canAfford, isModelAllowed, chargeUsage, listLedger, countKeys, hashKey, createWxSignupKey, getKeyByOpenid, getKeyByInviteCode, addFreeQuota, checkV2RateLimit, recordV2Request, maybeSettleInvite } from "./lib/keys-v2.mjs";
import { reloadPricing, getPricing, estimateCost, setModelPricing, deleteModelPricing, seedPricingFromConfig } from "./lib/pricing.mjs";
import * as modelsReg from "./lib/models-registry.mjs";
import { quotaPreflight, chargeFromLog } from "./lib/quota-gate.mjs";
import { createPayment, claimPayment, syncPaymentStatus, getPaymentByPayOrderId, listPaymentsByKey, applyWebhookEvent, verifyWebhookSig, sweepExpiredPayments, PACKAGES } from "./lib/payments.mjs";

seedPricingFromConfig();
reloadPricing();

// ─── WeChat gateway config (env-driven; if any missing, WeChat login is disabled) ─
const WX_GATEWAY_BASE = (process.env.WX_GATEWAY_BASE || "").replace(/\/+$/, "");
const WX_GATEWAY_APP_NAME = process.env.WX_GATEWAY_APP_NAME || "";
const WX_GATEWAY_SECRET = process.env.WX_GATEWAY_SECRET || "";
const WX_LOGIN_ENABLED = !!(WX_GATEWAY_BASE && WX_GATEWAY_APP_NAME && WX_GATEWAY_SECRET);
if (WX_LOGIN_ENABLED) {
  console.log(`[wx] login enabled · gateway=${WX_GATEWAY_BASE} · app=${WX_GATEWAY_APP_NAME}`);
} else {
  console.log("[wx] login disabled — set WX_GATEWAY_BASE / WX_GATEWAY_APP_NAME / WX_GATEWAY_SECRET to enable");
}
const WX_MAX_SKEW_MS = 5 * 60 * 1000;

// Trust X-Forwarded-For only when explicitly enabled (e.g. behind nginx).
// Otherwise spoofable headers are ignored; we use the raw socket address.
const TRUST_PROXY = ["true", "1", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers["x-forwarded-for"] || "").toString();
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

// ─── CLI: --add-key <name> ───────────────────────────────────────────────────
const addKeyIdx = process.argv.indexOf("--add-key");
if (addKeyIdx !== -1) {
  const keyName = process.argv[addKeyIdx + 1];
  if (!keyName) { console.error("Usage: node server.mjs --add-key <name>"); process.exit(1); }
  const keys = loadApiKeys();
  const newKey = "sk-proxy-" + randomBytes(24).toString("hex");
  keys.push({ key: newKey, name: keyName, rate_limit: { rpm: 0, rpd: 0, tpm: 0 }, created: new Date().toISOString() });
  saveApiKeys(keys);
  console.log(`✓ API key added for "${keyName}":\n  ${newKey}`);
  process.exit(0);
}

// ─── CLI: --add-admin <name> ─────────────────────────────────────────────────
// Creates a v2 admin key (unlimited). Prints raw key once.
const addAdminIdx = process.argv.indexOf("--add-admin");
if (addAdminIdx !== -1) {
  const name = process.argv[addAdminIdx + 1];
  if (!name) { console.error("Usage: node server.mjs --add-admin <name>"); process.exit(1); }
  const { raw } = createKey({ name, role: "admin", unlimited: 1, free_quota: 0, note: "admin via --add-admin" });
  console.log(`✓ admin key created for "${name}":\n  ${raw}`);
  process.exit(0);
}

// ─── In-flight request tracking & graceful shutdown ──────────────────────────
let inFlightCount = 0;
let isShuttingDown = false;

// ── In-memory store for device login sessions ───────────────────────────────
const deviceLoginSessions = new Map();

// --- Dashboard HTML ---
function dashboardHTML(adminName = "") {
  const html = readFileSync(DASHBOARD_PATH, "utf8");
  return html.replace("__PORT__", PORT).replace("__ADMIN_NAME__", String(adminName).replace(/[<>"&]/g, ""));
}

// --- Proxy ---
const REQUIRED_HEADERS = {
  "Editor-Version": "vscode/1.96.0",
  "Editor-Plugin-Version": "copilot/1.0.0",
  "Openai-Intent": "conversation-edits",
};

// ─── Retry config (non-streaming only) ───────────────────────────────────────
const RETRY_DELAYS = [1000, 3000];
const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']);

async function handleRequest(req, res) {
  // Skip WebSocket upgrade requests — handled by server.on("upgrade")
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return;

  // ── Graceful shutdown: reject new requests with 503 ───────────────────────
  if (isShuttingDown) {
    res.writeHead(503, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: "Server is shutting down" }));
    return;
  }

  // Track in-flight requests for graceful shutdown
  inFlightCount++;
  res.on('close', () => { inFlightCount--; });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Health check (no auth required) ─────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    const stats = db.prepare("SELECT COUNT(*) as total_requests, SUM(CASE WHEN status >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END) as error_count FROM logs").get();
    const lastErrorRow = db.prepare("SELECT error, ts FROM logs WHERE error IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    const tokenInfo = getCachedTokenInfo();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: tokenInfo.expiry_status === 'expired' ? 'degraded' : 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      active_token: tokenInfo.name,
      token_expiry: tokenInfo.expiry_status,
      total_requests: stats.total_requests || 0,
      error_count: stats.error_count || 0,
      last_error: lastErrorRow ? { message: lastErrorRow.error, ts: lastErrorRow.ts } : null,
    }));
    return;
  }

  // Routing:
  //   /           → user dashboard (API key login) — default landing page
  //   /user, /user/index.html → user dashboard (back-compat)
  //   ADMIN_PATH  → admin dashboard (gated by user_session + role=admin)
  const pathname = req.url.split("?")[0];
  const ADMIN_PATH = process.env.ADMIN_PATH || "/_a/ce233c02438f1ea04adaeb0c703468eb";
  if (req.method === "GET" && (pathname === ADMIN_PATH || pathname === ADMIN_PATH + "/" || pathname === ADMIN_PATH + "/index.html")) {
    const ctx = getUserSessionContext(req);
    if (!ctx) {
      res.writeHead(302, { Location: `/?next=${encodeURIComponent(ADMIN_PATH)}` });
      res.end();
      return;
    }
    const row = getKeyByHash(ctx.keyHash);
    if (!row || row.status === "disabled" || row.role !== "admin") {
      res.writeHead(302, { Location: "/?err=not_admin" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML(row.name || ""));
    return;
  }
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    try {
      const html = readFileSync(join(PUBLIC_DIR, "user-dashboard.html"), "utf8").replace("__PORT__", PORT);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  // Static assets (CSS/JS from public/)
  if (req.method === "GET" && (req.url === "/dashboard.css" || req.url === "/dashboard.js" || req.url === "/shared-charts.js" || req.url === "/user-dashboard.js")) {
    const file = req.url.slice(1);
    const contentType = req.url.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
    try {
      const content = readFileSync(join(PUBLIC_DIR, file), "utf8");
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  // ── User session (Stage 3): API-key login ────────────────────────────────
  if (req.method === "POST" && req.url === "/user/login") {
    const body = await readJsonBody(req);
    const raw = (body && body.apiKey) ? String(body.apiKey).trim() : "";
    if (!raw) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "apiKey is required" }));
      return;
    }
    const row = getKeyByHash(hashKey(raw));
    if (!row || row.status === "disabled") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or disabled key" }));
      return;
    }
    const tok = createUserSession(row.key_hash, raw);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `user_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    });
    res.end(JSON.stringify({ ok: true, name: row.name, role: row.role }));
    return;
  }
  if (req.method === "POST" && req.url === "/user/logout") {
    destroyUserSession(req);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "user_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── WeChat login config (public; safe — only exposes gateway base + app name) ─
  if (req.method === "GET" && pathname === "/api/wx/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      enabled: WX_LOGIN_ENABLED,
      gatewayBase: WX_LOGIN_ENABLED ? WX_GATEWAY_BASE : null,
      appName: WX_LOGIN_ENABLED ? WX_GATEWAY_APP_NAME : null,
    }));
    return;
  }

  // ── WeChat finalize: gateway 302's the user here after a successful scan/OAuth ─
  if (req.method === "GET" && pathname === "/api/wx/finalize") {
    if (!WX_LOGIN_ENABLED) {
      res.writeHead(302, { Location: "/?err=wx_disabled" });
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const sp = url.searchParams;
    const token = sp.get("token") || "";
    const openid = sp.get("openid") || "";
    const unionid = sp.get("unionid") || "";
    const ts = sp.get("ts") || "";
    const sig = sp.get("sig") || "";
    const nickname = (sp.get("nickname") || "").trim() || null;
    const avatarUrl = (sp.get("avatarUrl") || "").trim() || null;

    const redirect = (loc) => { res.writeHead(302, { Location: loc }); res.end(); };

    if (!token || !openid || !ts || !sig) return redirect("/?err=missing");
    if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > WX_MAX_SKEW_MS) {
      return redirect("/?err=expired");
    }
    // HMAC-SHA256(`${token}|${openid}|${unionid}|${ts}`, SECRET) — nickname/avatar NOT in payload
    let sigOk = false;
    try {
      const expected = createHmac("sha256", WX_GATEWAY_SECRET)
        .update(`${token}|${openid}|${unionid}|${ts}`)
        .digest("hex");
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(sig, "hex");
      sigOk = a.length === b.length && timingSafeEqual(a, b);
    } catch { sigOk = false; }
    if (!sigOk) {
      try {
        const expected = createHmac("sha256", WX_GATEWAY_SECRET).update(`${token}|${openid}|${unionid}|${ts}`).digest("hex");
        console.error(`[wx][sig-fail] token=${mask(token)} openid=${mask(openid)} unionid=${mask(unionid)} ts=${ts} skew=${Date.now()-Number(ts)}ms got=${sig?.slice(0,8)}.. expected=${expected.slice(0,8)}.. nickname=${nickname?'Y':'N'} avatar=${avatarUrl?'Y':'N'}`);
      } catch {}
      return redirect("/?err=sig");
    }

    // Replay protection: each finalize sig is single-use. On replay, if a key is
    // already bound to this openid we re-mint a session cookie and redirect to /,
    // otherwise just bounce to /. No side-effects (wx_users upsert / signup) re-run.
    if (!recordWebhookNonce(`wx:${sig}`, Number(ts) || Date.now())) {
      const bound = db.prepare("SELECT key_hash, status, display_raw FROM api_keys_v2 WHERE wx_openid = ? LIMIT 1").get(openid);
      if (bound && bound.status !== "disabled") {
        const tokSession = createUserSession(bound.key_hash, bound.display_raw || null);
        const isHttps = req.headers["x-forwarded-proto"] === "https" || req.connection?.encrypted;
        const cookie = `user_session=${tokSession}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${isHttps ? "; Secure" : ""}`;
        res.writeHead(302, { Location: "/", "Set-Cookie": cookie });
        res.end();
        return;
      }
      return redirect("/");
    }

    // Idempotent upsert into wx_users (only fill empty fields on existing row)
    const now = new Date().toISOString();
    try {
      const existing = db.prepare("SELECT * FROM wx_users WHERE openid = ?").get(openid);
      if (!existing) {
        db.prepare(`INSERT INTO wx_users (openid, unionid, nickname, avatar_url, created_at, last_login_at)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(openid, unionid || null, nickname, avatarUrl, now, now);
      } else {
        const updates = [], params = [];
        if (nickname && !existing.nickname) { updates.push("nickname = ?"); params.push(nickname); }
        if (avatarUrl && !existing.avatar_url) { updates.push("avatar_url = ?"); params.push(avatarUrl); }
        if (unionid && !existing.unionid) { updates.push("unionid = ?"); params.push(unionid); }
        updates.push("last_login_at = ?"); params.push(now);
        params.push(openid);
        db.prepare(`UPDATE wx_users SET ${updates.join(", ")} WHERE openid = ?`).run(...params);
      }
    } catch (e) {
      console.error("[wx] upsert wx_user failed:", e.message);
      return redirect("/?err=db");
    }

    // Look up bound API key (if any)
    const boundKey = db.prepare("SELECT key_hash, status, display_raw FROM api_keys_v2 WHERE wx_openid = ? LIMIT 1").get(openid);

    let cookieValue;
    let location;
    if (boundKey && boundKey.status !== "disabled") {
      // Already bound → mint a normal user session and go to dashboard
      const tok = createUserSession(boundKey.key_hash, boundKey.display_raw || null);
      cookieValue = `user_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
      location = "/";
    } else {
      // ── First-time signup: auto-create a wx_signup key with 30万 free quota ──
      // Anti-abuse: per-IP throttle (24h max WX_SIGNUP_IP_LIMIT new openids).
      const clientIp = getClientIp(req);
      const ipLimit = Number(process.env.WX_SIGNUP_IP_LIMIT || 3);
      const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      try {
        const cnt = db.prepare("SELECT COUNT(*) AS c FROM wx_signup_ip_log WHERE ip = ? AND created_at >= ?").get(clientIp, oneDayAgo).c;
        if (cnt >= ipLimit) {
          console.warn(`[wx][ip-throttle] ip=${clientIp} count=${cnt} >= ${ipLimit}`);
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "too many signups from this IP, try later" }));
          return;
        }
      } catch (e) { /* fall through */ }

      let newKey;
      try {
        newKey = createWxSignupKey({ openid });
      } catch (e) {
        console.error("[wx] auto-create key failed:", e.message);
        return redirect("/?err=db");
      }
      try {
        db.prepare("INSERT INTO wx_signup_ip_log (ip, openid, created_at) VALUES (?, ?, ?)").run(clientIp, openid, new Date().toISOString());
      } catch {}

      // ── Invite: ?ref=<invite_code>. Reward is DEFERRED — recorded as 'pending'
      // and settled later when the invitee's cumulative usage crosses
      // WX_INVITE_SETTLE_THRESHOLD (default 10k tokens). Defends against
      // self-invite / drive-by reward farming.
      const ref = (sp.get("ref") || "").trim();
      const REWARD = Number(process.env.WX_INVITE_REWARD || 50_000);
      const INVITE_IP_LIMIT = Number(process.env.WX_INVITE_IP_LIMIT || 5);
      if (ref && REWARD > 0) {
        try {
          const inviter = getKeyByInviteCode(ref);
          if (!inviter || inviter.status === "disabled") { /* unknown ref — ignore */ }
          else if (inviter.wx_openid === openid) { /* explicit self-invite — ignore */ }
          else {
            // 24h IP-cap: count invites whose invitee signed up from the same IP
            const recentSameIp = db.prepare(`
              SELECT COUNT(*) AS c FROM wx_invites wi
              WHERE wi.inviter_ip = ? AND wi.created_at >= ?
            `).get(clientIp, oneDayAgo).c;
            if (recentSameIp >= INVITE_IP_LIMIT) {
              console.warn(`[wx][invite-ip-cap] ip=${clientIp} recent=${recentSameIp} >= ${INVITE_IP_LIMIT} — invite recorded but no reward`);
            } else {
              db.prepare(`INSERT INTO wx_invites (inviter_key_hash, invitee_key_hash, invitee_openid, reward_tokens, created_at, reward_status, inviter_ip) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
                .run(inviter.key_hash, newKey.key_hash, openid, REWARD, new Date().toISOString(), clientIp);
              console.log(`[wx][invite] pending: ${ref} → invitee ${newKey.prefix}… (settles after ${process.env.WX_INVITE_SETTLE_THRESHOLD || 10000} tokens consumed)`);
            }
          }
        } catch (e) { console.error("[wx] invite insert failed:", e.message); }
      }

      console.log(`[wx][signup] openid=${openid.slice(0,8)}… key=${newKey.prefix}… ip=${clientIp}`);
      const tok = createUserSession(newKey.key_hash, newKey.raw);
      cookieValue = `user_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
      location = "/?wx_new=1";
    }
    res.writeHead(302, { Location: location, "Set-Cookie": cookieValue });
    res.end();
    return;
  }

  // GET /user — serve user dashboard HTML
  if (req.method === "GET" && (pathname === "/user" || pathname === "/user/" || pathname === "/user/index.html")) {
    try {
      const html = readFileSync(join(PUBLIC_DIR, "user-dashboard.html"), "utf8").replace("__PORT__", PORT);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  // ── User API (Stage 3): /user/* requires user_session OR admin session ───
  if (req.url.startsWith("/user/") && req.url !== "/user/login" && req.url !== "/user/logout") {
    await handleUserApi(req, res);
    return;
  }

  // ── GET /api/user/plan — accepts Bearer OR user_session ──────────────────
  if (req.method === "GET" && pathname === "/api/user/plan") {
    let keyRow = null;
    const apiCheck = checkApiKey(req, true);
    if (apiCheck && apiCheck.valid && apiCheck.keyRow) {
      keyRow = apiCheck.keyRow;
    } else {
      const ctx = getUserSessionContext(req);
      if (ctx) keyRow = getKeyByHash(ctx.keyHash);
    }
    if (!keyRow || keyRow.status === "disabled") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      plan_type: keyRow.plan_type || "free",
      plan_expires_at: Number(keyRow.plan_expires_at || 0),
      window_used: Number(keyRow.window_used || 0),
      window_quota: 600,
      window_reset_at: Number(keyRow.window_reset_at || 0),
      free_quota: keyRow.free_quota,
      free_used: keyRow.free_used,
      paid_quota: Number(keyRow.paid_quota || 0),
      balance_tokens: keyRow.balance_tokens,
    }));
    return;
  }

  // ── Payment routes (user_session required, except webhook which uses HMAC) ─
  if (pathname === "/api/wx/payment-webhook" && req.method === "POST") {
    await handlePaymentWebhook(req, res);
    return;
  }
  if (req.url.startsWith("/api/pay/")) {
    await handlePaymentApi(req, res);
    return;
  }

  // ── Dashboard API auth guard ──────────────────────────────────────────────
  // All /api/ routes below require an admin user_session.
  if (req.url.startsWith("/api/")) {
    const ctx = getUserSessionContext(req);
    const row = ctx ? getKeyByHash(ctx.keyHash) : null;
    if (!row || row.status === "disabled" || row.role !== "admin") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — admin sign-in required" }));
      return;
    }
  }

  // Charts API
  if (req.method === "GET" && req.url.startsWith("/api/stats/charts")) {
    const hourly = db.prepare(`
      SELECT substr(ts,1,13) as slot,
        COUNT(*) as total,
        SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as err,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs GROUP BY slot ORDER BY slot
    `).all();

    const modelRows = db.prepare(`
      SELECT model, COUNT(*) as count FROM logs GROUP BY model ORDER BY count DESC
    `).all();
    const totalCount = modelRows.reduce((s, r) => s + r.count, 0);
    const modelShare = modelRows.map(r => ({
      model: r.model, count: r.count, pct: totalCount ? Math.round(r.count * 100 / totalCount) : 0
    }));

    const apiKeyRows = db.prepare(`
      SELECT COALESCE(api_key_name, '(none)') as name,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs GROUP BY api_key_name ORDER BY count DESC
    `).all();
    const apiKeyTotal = apiKeyRows.reduce((s, r) => s + r.count, 0);
    const apiKeyShare = apiKeyRows.map(r => ({
      name: r.name, count: r.count, tokens: r.tokens,
      pct: apiKeyTotal ? Math.round(r.count * 100 / apiKeyTotal) : 0
    }));

    const tokenRows = db.prepare(`
      SELECT COALESCE(token_name, '(none)') as name,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs GROUP BY token_name ORDER BY count DESC
    `).all();
    const tokenTotal = tokenRows.reduce((s, r) => s + r.count, 0);
    const tokenShare = tokenRows.map(r => ({
      name: r.name, count: r.count, tokens: r.tokens,
      pct: tokenTotal ? Math.round(r.count * 100 / tokenTotal) : 0
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hourly, modelShare, apiKeyShare, tokenShare }));
    return;
  }

  // Logs API (from SQLite)
  if (req.url.startsWith("/api/logs")) {
    const url = new URL(req.url, "http://localhost");

    // Detail endpoint: /api/logs/123
    const detailMatch = req.url.match(/^\/api\/logs\/(\d+)/);
    if (detailMatch && req.method === "GET") {
      const row = db.prepare("SELECT * FROM logs WHERE id = ?").get(parseInt(detailMatch[1]));
      if (!row) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}'); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(row));
      return;
    }

    if (req.method === "DELETE") {
      db.exec("DELETE FROM logs");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const model = url.searchParams.get("model");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
    const sinceId = parseInt(url.searchParams.get("since_id") || "0", 10);

    let where = [], params = [];
    if (from) { where.push("ts >= ?"); params.push(from); }
    if (to) { where.push("ts <= ?"); params.push(to); }
    if (model) { where.push("model = ?"); params.push(model); }
    const tokenNameFilter = url.searchParams.get("token_name");
    if (tokenNameFilter) { where.push("token_name = ?"); params.push(tokenNameFilter); }
    if (url.searchParams.get("errors_only") === "1") { where.push("(status >= 400 OR error IS NOT NULL)"); }
    if (sinceId > 0) { where.push("id > ?"); params.push(sinceId); }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    const logs = db.prepare(`SELECT id, ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, token_name, api_key_name FROM logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, sinceId > 0 ? 0 : offset);

    // Skip expensive aggregate queries on incremental polls — stats are computed over the whole table.
    if (sinceId > 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs }));
      return;
    }

    const statsRow = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as err, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens, COALESCE(CAST(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS INTEGER), 0) as avgMs FROM logs ${whereClause}`).get(...params);

    const modelStats = db.prepare(`SELECT model, COUNT(*) as count, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens, COALESCE(CAST(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS INTEGER), 0) as avgMs FROM logs ${whereClause} GROUP BY model ORDER BY count DESC`).all(...params);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs, stats: statsRow, modelStats }));
    return;
  }

  // ── Token management API ────────────────────────────────────────────────────
  const tokenTestMatch = req.url.match(/^\/api\/tokens\/([^/]+)\/test$/);
  if (req.method === "GET" && tokenTestMatch) {
    const name = decodeURIComponent(tokenTestMatch[1]);
    const tokens = loadTokens();
    const target = tokens.find(t => t.name === name);
    if (!target) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return; }
    let success = false, username = null, endpointType = "unknown";
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `token ${target.token}`, Accept: "application/json", "User-Agent": "copilot-proxy" }
      });
      if (userRes.ok) { const d = await userRes.json(); username = d.login; }
      const tokenRes = await fetch(COPILOT_TOKEN_URL, {
        headers: { Accept: "application/json", Authorization: `Bearer ${target.token}` }
      });
      if (tokenRes.ok) {
        success = true;
        const d = await tokenRes.json();
        const baseUrl = deriveBaseUrl(d.token, d.endpoints);
        endpointType = baseUrl.includes("individual") ? "individual" : "enterprise";
      }
    } catch {}
    if (username && target.username !== username) { target.username = username; saveTokens(tokens); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success, username, endpointType, type: getTokenType(target.token) }));
    return;
  }

  const tokenActivateMatch = req.url.match(/^\/api\/tokens\/([^/]+)\/activate$/);
  if (req.method === "PUT" && tokenActivateMatch) {
    const name = decodeURIComponent(tokenActivateMatch[1]);
    const tokens = loadTokens();
    const target = tokens.find(t => t.name === name);
    if (!target) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return; }
    tokens.forEach(t => t.active = false);
    target.active = true;
    saveTokens(tokens);
    clearCachedToken();
    console.log(`🔄 Active token switched to: ${name}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
    return;
  }

  const tokenDeleteMatch = req.url.match(/^\/api\/tokens\/([^/]+)$/);
  if (req.method === "DELETE" && tokenDeleteMatch && req.url.startsWith("/api/tokens/")) {
    const name = decodeURIComponent(tokenDeleteMatch[1]);
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.name === name);
    if (idx === -1) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return; }
    const wasActive = tokens[idx].active;
    tokens.splice(idx, 1);
    if (wasActive && tokens.length > 0) tokens[0].active = true;
    saveTokens(tokens);
    if (wasActive) clearCachedToken();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/tokens") {
    const tokens = loadTokens();
    const result = tokens.map(t => ({
      name: t.name,
      type: getTokenType(t.token),
      masked: maskToken(t.token),
      active: !!t.active,
      username: t.username || null,
    }));
    if (!tokens.length) {
      const envToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (envToken) {
        let username = null;
        try {
          const userRes = await fetch("https://api.github.com/user", {
            headers: { Authorization: `token ${envToken}`, Accept: "application/json", "User-Agent": "copilot-proxy" }
          });
          if (userRes.ok) { const d = await userRes.json(); username = d.login; }
        } catch {}
        result.push({ name: "(default)", type: getTokenType(envToken), masked: maskToken(envToken), active: true, username, isEnv: true });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "POST" && req.url === "/api/tokens") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return;
    }
    const { name, token: tokenValue } = parsed;
    if (!name || !tokenValue) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"name and token are required"}'); return; }
    const tokens = loadTokens();
    if (tokens.find(t => t.name === name)) { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"token name already exists"}'); return; }
    let username = null;
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `token ${tokenValue}`, Accept: "application/json", "User-Agent": "copilot-proxy" }
      });
      if (userRes.ok) { const d = await userRes.json(); username = d.login; }
    } catch {}
    const isFirst = tokens.length === 0;
    tokens.push({ name, token: tokenValue, active: isFirst, username });
    saveTokens(tokens);
    if (isFirst) clearCachedToken();
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name, active: isFirst, username }));
    return;
  }

  // ── Device Login (GitHub OAuth Device Flow) ────────────────────────────────
  if (req.method === "POST" && req.url === "/api/device-login/start") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed = {};
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const tokenName = parsed.token_name || '';
    try {
      const ghRes = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "Iv1.b507a08c87ecfe98", scope: "read:user" }),
      });
      if (!ghRes.ok) {
        const errText = await ghRes.text();
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `GitHub API error: ${ghRes.status} ${errText}` }));
        return;
      }
      const data = await ghRes.json();
      const sessionId = randomBytes(16).toString("hex");
      deviceLoginSessions.set(sessionId, {
        device_code: data.device_code,
        interval: data.interval || 5,
        expires_at: Date.now() + (data.expires_in || 900) * 1000,
        token_name: tokenName,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        session_id: sessionId,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
      }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to start device flow: ${err.message}` }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/device-login/poll") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return;
    }
    const { session_id } = parsed;
    const session = deviceLoginSessions.get(session_id);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: "Session not found or expired" }));
      return;
    }
    if (Date.now() > session.expires_at) {
      deviceLoginSessions.delete(session_id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "expired" }));
      return;
    }
    try {
      const ghRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "Iv1.b507a08c87ecfe98",
          device_code: session.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await ghRes.json();
      if (data.error === "authorization_pending") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
        return;
      }
      if (data.error === "slow_down") {
        session.interval = (session.interval || 5) + 5;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending", interval: session.interval }));
        return;
      }
      if (data.error === "expired_token") {
        deviceLoginSessions.delete(session_id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "expired" }));
        return;
      }
      if (data.error) {
        deviceLoginSessions.delete(session_id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: data.error }));
        return;
      }
      // Success — we have an access_token
      if (data.access_token) {
        let username = null;
        try {
          const userRes = await fetch("https://api.github.com/user", {
            headers: { Authorization: `token ${data.access_token}`, Accept: "application/json", "User-Agent": "copilot-proxy" },
          });
          if (userRes.ok) { const u = await userRes.json(); username = u.login; }
        } catch {}
        const name = session.token_name || `device-${username || 'user'}`;
        const tokens = loadTokens();
        let finalName = name;
        let suffix = 1;
        while (tokens.find(t => t.name === finalName)) { finalName = `${name}-${suffix++}`; }
        const isFirst = tokens.length === 0;
        tokens.push({ name: finalName, token: data.access_token, active: isFirst, username });
        saveTokens(tokens);
        if (isFirst) clearCachedToken();
        deviceLoginSessions.delete(session_id);
        console.log(`🔑 Device login: token saved as "${finalName}" (user: ${username || 'unknown'})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "complete", token_name: finalName, username }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: "Unexpected response from GitHub" }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: `Poll failed: ${err.message}` }));
    }
    return;
  }

  // ── API Key management API ─────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/keys") {
    const keys = loadApiKeys();
    const result = keys.map(k => ({
      name: k.name,
      masked: k.key.slice(0, 12) + "...",
      created: k.created,
      token_name: k.token_name || null,
      rate_limit: k.rate_limit || { rpm: 0, rpd: 0, tpm: 0 },
      usage: getKeyUsageStats(k.name),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "POST" && req.url === "/api/keys") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return;
    }
    const { name, token_name, rate_limit } = parsed;
    if (!name) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"name is required"}'); return; }
    const keys = loadApiKeys();
    if (keys.find(k => k.name === name)) { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"key name already exists"}'); return; }
    const newKey = "sk-proxy-" + randomBytes(24).toString("hex");
    const keyObj = { key: newKey, name, rate_limit: { rpm: 0, rpd: 0, tpm: 0, ...rate_limit }, created: new Date().toISOString() };
    if (token_name) keyObj.token_name = token_name;
    keys.push(keyObj);
    saveApiKeys(keys);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name, key: newKey }));
    return;
  }

  const keyDeleteMatch = req.url.match(/^\/api\/keys\/([^/]+)$/);
  if (req.method === "DELETE" && keyDeleteMatch && req.url.startsWith("/api/keys/")) {
    const name = decodeURIComponent(keyDeleteMatch[1]);
    const keys = loadApiKeys();
    const idx = keys.findIndex(k => k.name === name);
    if (idx === -1) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"key not found"}'); return; }
    keys.splice(idx, 1);
    saveApiKeys(keys);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PUT /api/keys/:name — update key config (rate_limit, token_name)
  const keyPutMatch = req.url.match(/^\/api\/keys\/([^/]+)$/);
  if (req.method === "PUT" && keyPutMatch && req.url.startsWith("/api/keys/")) {
    const name = decodeURIComponent(keyPutMatch[1]);
    const keys = loadApiKeys();
    const keyObj = keys.find(k => k.name === name);
    if (!keyObj) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"key not found"}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return;
    }
    if (parsed.rate_limit !== undefined) {
      keyObj.rate_limit = { rpm: 0, rpd: 0, tpm: 0, ...keyObj.rate_limit, ...parsed.rate_limit };
    }
    if (parsed.token_name !== undefined) {
      if (parsed.token_name) keyObj.token_name = parsed.token_name;
      else delete keyObj.token_name;
    }
    saveApiKeys(keys);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
    return;
  }

  // Mock endpoints for Claude Chrome extension (dev mode)
  if (req.url.startsWith("/api/oauth/profile")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      account: { uuid: "dev-local-user", email: "dev@local", has_claude_pro: true, has_claude_max: true },
      organization: { uuid: "dev-org", organization_type: "claude_pro", rate_limit_tier: "pro" }
    }));
    return;
  }
  if (req.url.startsWith("/api/oauth/account/settings")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ settings: {} }));
    return;
  }
  if (req.url.startsWith("/api/oauth/organizations")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [] }));
    return;
  }
  if (req.url.startsWith("/api/bootstrap/features")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payload: { features: { chrome_ext_bridge_enabled: { on: false, value: false, off: true } } } }));
    return;
  }
  if (req.url.startsWith("/v1/oauth/token")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "dev-local-token", refresh_token: "dev-local-refresh", expires_in: 31536000 }));
    return;
  }
  // Catch-all for other /api/ requests — return empty 200 instead of 404
  if (req.url.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
    return;
  }

  // ── Admin API (Stage 2) — admin user_session OR admin v2 api key (header) ──
  if (req.url.startsWith("/admin/")) {
    const ctx = getUserSessionContext(req);
    const sessionRow = ctx ? getKeyByHash(ctx.keyHash) : null;
    const sessionAdmin = sessionRow && sessionRow.status !== "disabled" && sessionRow.role === "admin"
      ? sessionRow : null;
    const apiAdm = sessionAdmin ? null : checkAdmin(req);
    if (!sessionAdmin && !(apiAdm && apiAdm.ok)) {
      const reason = apiAdm ? apiAdm.reason : "no_session";
      res.writeHead(reason === "no_key" || reason === "not_found" || reason === "no_session" ? 401 : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "auth_error", reason } }));
      return;
    }
    const adminCtx = sessionAdmin
      ? { source: "session", adminKeyHash: sessionAdmin.key_hash, adminName: sessionAdmin.name || "admin" }
      : { source: "apikey", adminKeyHash: apiAdm.keyRow?.key_hash || null, adminName: apiAdm.keyRow?.name || null };
    await handleAdmin(req, res, adminCtx);
    return;
  }

  // GET /v1/models — return supported models list (needed by Claude Code)
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: getModelRegistry({ enabledOnly: true }) }));
    return;
  }

  // ── POST /v1/chat/completions — OpenAI-compatible entry ───────────────────
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    await handleChatCompletions(req, res);
    return;
  }

  // ── POST /v1/responses — OpenAI Responses API (gpt-5.5, o-series, etc.) ───
  if (req.method === "POST" && req.url.startsWith("/v1/responses")) {
    await handleResponses(req, res);
    return;
  }

  // Only handle POST /v1/messages
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /v1/messages" }));
    return;
  }

  // ── API key auth for /v1/messages ──────────────────────────────────────────
  const apiKeyCheck = checkApiKey(req, true);
  if (!apiKeyCheck.valid) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key. Provide a valid key via x-api-key header or Authorization: Bearer <key>" },
    }));
    return;
  }

  // ── Rate limit check ──────────────────────────────────────────────────────
  if (apiKeyCheck.name) {
    const rlError = checkRateLimit(apiKeyCheck.name);
    if (rlError) {
      const resetSec = Math.ceil(Math.max(rlError.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(rlError.limit),
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": new Date(Date.now() + rlError.resetMs).toISOString(),
      });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: rlError.message },
      }));
      return;
    }
    // Record this request for RPM/RPD counters
    recordRequest(apiKeyCheck.name);
  }
  // Per-key v2 RPM limiter (60 RPM default; covers wx_signup keys with no legacy json entry)
  if (apiKeyCheck.keyRow) {
    const v2rl = checkV2RateLimit(apiKeyCheck.keyRow);
    if (v2rl) {
      const resetSec = Math.ceil(Math.max(v2rl.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(v2rl.limit),
        "x-ratelimit-remaining-requests": "0",
      });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: v2rl.message } }));
      return;
    }
    recordV2Request(apiKeyCheck.keyRow);
  }

  const startTime = Date.now();
  const logEntry = { status: 0, model: null, stream: false, usage: null, preview: "", error: null, durationMs: 0, requestSummary: "" };
  logEntry.apiKeyName = apiKeyCheck.name;
  logEntry.keyHash = apiKeyCheck.keyRow?.key_hash || null;

  try {
    // Use token bound to the API key, or fall back to active token
    const boundTokenName = apiKeyCheck.tokenName;
    const { token, baseUrl, tokenName } = boundTokenName
      ? await getTokenByName(boundTokenName)
      : await getToken();
    logEntry.tokenName = tokenName;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = null; }

    if (parsed) {

      // Reject non-Claude models on the Anthropic-protocol entry. Cross-protocol
      // routing (e.g. GPT/Gemini via /v1/messages) is intentionally unsupported —
      // each entry only accepts its native models. Use /v1/chat/completions for
      // OpenAI/Google models instead.
      if (parsed.model && !isClaudeModel(parsed.model)) {
        const msg = `Model "${parsed.model}" is not supported on /v1/messages. Use /v1/chat/completions for OpenAI/Google models.`;
        logEntry.model = parsed.model;
        logEntry.status = 400;
        logEntry.error = msg;
        logEntry.durationMs = Date.now() - startTime;
        addLog(logEntry);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: msg } }));
        return;
      }

      // Remap claude-opus-4.6 variants to the 1M context version
      if (parsed.model && /^claude-opus-4[.\-]6/i.test(parsed.model) && parsed.model !== 'claude-opus-4.6-1m') {
        console.log(`🔄 Model remapped: ${parsed.model} → claude-opus-4.6-1m`);
        parsed.model = 'claude-opus-4.6-1m';
      }

      logEntry.model = parsed.model || null;
      logEntry.stream = !!parsed.stream;

      // ── Quota preflight (Stage 2) ─────────────────────────────────────────
      const pf = quotaPreflight(apiKeyCheck.keyRow, parsed, parsed.model);
      if (!pf.ok) {
        logEntry.status = pf.status;
        logEntry.error = pf.body?.error?.message || `quota rejected (${pf.status})`;
        logEntry.durationMs = Date.now() - startTime;
        addLog(logEntry);
        res.writeHead(pf.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", ...pf.body }));
        return;
      }

      const msgCount = parsed.messages?.length || 0;
      const sysLen = Array.isArray(parsed.system) ? parsed.system.reduce((s, b) => s + (b.text?.length || 0), 0) : (parsed.system?.length || 0);
      const lastMsg = parsed.messages?.[msgCount - 1];
      const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : lastMsg?.content?.map(b => b.text || "").join("") || "";
      logEntry.preview = lastContent.slice(0, 80);
      logEntry.requestSummary = `model=${parsed.model} stream=${!!parsed.stream} msgs=${msgCount} sys=${sysLen}chars max_tokens=${parsed.max_tokens || "-"}\n\nLast message (${lastMsg?.role}):\n${lastContent.slice(0, 500)}`;

      const sanitize = (val) => {
        if (Array.isArray(val)) { val.forEach(sanitize); return; }
        if (!val || typeof val !== "object") return;
        if (val.cache_control) {
          const type = val.cache_control.type;
          if (type) val.cache_control = { type };
          else delete val.cache_control;
        }
        for (const k of Object.keys(val)) sanitize(val[k]);
      };
      sanitize(parsed.system);
      sanitize(parsed.messages);
      delete parsed.context_management;
    }

    const forwardBody = parsed ? JSON.stringify(parsed) : body;
    logEntry.requestBody = typeof forwardBody === "string" ? forwardBody : forwardBody.toString();

    const upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
        ...REQUIRED_HEADERS,
      },
      body: forwardBody,
    });

    logEntry.status = upstream.status;

    // Upstream error — capture full response body
    if (upstream.status >= 400) {
      let errBody = '';
      try {
        errBody = await upstream.text();
        const errJson = JSON.parse(errBody);
        const errMsg = errJson.error?.message || errJson.message || errBody.slice(0, 500);
        logEntry.error = `HTTP ${upstream.status}: ${errMsg}`;
      } catch {
        logEntry.error = `HTTP ${upstream.status}: ${errBody.slice(0, 500)}`;
      }
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      res.end(errBody);
      return;
    }

    const fwdHeaders = { "Content-Type": upstream.headers.get("content-type") || "application/json" };
    if (upstream.headers.get("x-request-id")) fwdHeaders["x-request-id"] = upstream.headers.get("x-request-id");
    // Add rate limit headers if applicable
    if (apiKeyCheck.name) {
      const keys = loadApiKeys();
      const keyObj = keys.find(k => k.name === apiKeyCheck.name);
      const rl = keyObj?.rate_limit;
      if (rl && rl.rpm > 0) {
        const counters = getRateLimitCounters(apiKeyCheck.name);
        pruneCounters(counters);
        fwdHeaders["x-ratelimit-limit-requests"] = String(rl.rpm);
        fwdHeaders["x-ratelimit-remaining-requests"] = String(Math.max(0, rl.rpm - counters.rpm.length));
        const oldest = counters.rpm[0];
        fwdHeaders["x-ratelimit-reset-requests"] = oldest ? new Date(oldest + 60_000).toISOString() : new Date(Date.now() + 60_000).toISOString();
      }
    }
    res.writeHead(upstream.status, fwdHeaders);

    if (!upstream.body) {
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.end();
      return;
    }

    const respChunks = [];
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        respChunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();

    logEntry.durationMs = Date.now() - startTime;
    try {
      const respText = Buffer.concat(respChunks).toString();
      logEntry.responseBody = respText;
      if (!logEntry.stream) {
        const respJson = JSON.parse(respText);
        logEntry.usage = respJson.usage ? { input: respJson.usage.input_tokens || 0, output: respJson.usage.output_tokens || 0 } : null;
      } else {
        const lines = respText.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "message_start" && evt.message?.usage) {
              logEntry.usage = logEntry.usage || { input: 0, output: 0 };
              logEntry.usage.input = evt.message.usage.input_tokens || 0;
            }
            if (evt.type === "message_delta" && evt.usage) {
              logEntry.usage = logEntry.usage || { input: 0, output: 0 };
              logEntry.usage.output = evt.usage.output_tokens || 0;
            }
          } catch {}
        }
      }
    } catch {}
    // Record token usage for TPM rate limiting
    if (apiKeyCheck.name && logEntry.usage) {
      recordTokenUsage(apiKeyCheck.name, (logEntry.usage.input || 0) + (logEntry.usage.output || 0));
    }
    const logId = addLog(logEntry);
    chargeFromLog(apiKeyCheck.keyRow, logEntry, logId);

  } catch (err) {
    logEntry.status = 502;
    logEntry.error = fullError(err);
    logEntry.durationMs = Date.now() - startTime;
    addLog(logEntry);
    console.error("[proxy error]", fullError(err));
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    } else {
      res.end();
    }
  }
}

// ─── /admin/* (Stage 2) ──────────────────────────────────────────────────────
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
}

function publicKeyView(row) {
  if (!row) return null;
  let allowed = null;
  if (row.allowed_models) { try { allowed = JSON.parse(row.allowed_models); } catch {} }
  return {
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    name: row.name,
    role: row.role,
    balance_tokens: row.balance_tokens,
    free_quota: row.free_quota,
    free_used: row.free_used,
    free_reset_at: row.free_reset_at,
    unlimited: !!row.unlimited,
    allowed_models: allowed,
    status: row.status,
    token_name: row.token_name || null,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    note: row.note,
  };
}

async function handleAdmin(req, res, adminCtx = { source: "unknown", adminKeyHash: null, adminName: null }) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const audit = (action, target, payload) => recordAdminAction({ adminKeyHash: adminCtx.adminKeyHash, adminName: adminCtx.adminName, action, target, payload });

  // GET /admin/keys
  if (req.method === "GET" && path === "/admin/keys") {
    return send(200, { keys: listKeys().map(publicKeyView) });
  }

  // POST /admin/keys
  if (req.method === "POST" && path === "/admin/keys") {
    const body = await readJsonBody(req);
    if (!body || !body.name) return send(400, { error: "name is required" });
    const created = createKey({
      name: body.name,
      role: body.role === "admin" ? "admin" : "user",
      free_quota: Number.isFinite(body.free_quota) ? body.free_quota : 10000,
      balance_tokens: Number.isFinite(body.balance_tokens) ? body.balance_tokens : 0,
      unlimited: !!body.unlimited,
      allowed_models: Array.isArray(body.allowed_models) ? body.allowed_models : null,
      token_name: body.token_name || null,
      note: body.note || null,
    });
    audit("key.create", created.key_hash, { name: body.name, role: body.role, free_quota: body.free_quota, balance_tokens: body.balance_tokens, unlimited: !!body.unlimited });
    return send(201, { ok: true, key: created.raw, key_hash: created.key_hash, key_prefix: created.prefix });
  }

  // /admin/keys/:hash[/topup|/reset-free|/ledger]
  const m = path.match(/^\/admin\/keys\/([a-f0-9]{64})(?:\/(topup|reset-free|ledger))?$/);
  if (m) {
    const h = m[1], action = m[2];
    const row = getKeyByHash(h);
    if (!row) return send(404, { error: "key not found" });

    if (action === "topup" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !Number.isFinite(body.tokens) || body.tokens <= 0) return send(400, { error: "tokens (positive number) required" });
      const updated = topupKey(h, body.tokens);
      audit("key.topup", h, { name: row.name, tokens: body.tokens, new_balance: updated.balance_tokens });
      return send(200, { ok: true, key: publicKeyView(updated) });
    }
    if (action === "reset-free" && req.method === "POST") {
      const updated = resetFree(h);
      audit("key.reset_free", h, { name: row.name });
      return send(200, { ok: true, key: publicKeyView(updated) });
    }
    if (action === "ledger" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 20);
      return send(200, { ledger: listLedger({ keyHash: h, limit }) });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (!body) return send(400, { error: "invalid JSON" });
      const updated = updateKey(h, body);
      audit("key.update", h, { name: row.name, patch: body });
      return send(200, { ok: true, key: publicKeyView(updated) });
    }
    if (req.method === "DELETE") {
      const updated = disableKey(h);
      audit("key.disable", h, { name: row.name });
      return send(200, { ok: true, key: publicKeyView(updated) });
    }
    if (req.method === "GET") {
      return send(200, { key: publicKeyView(row) });
    }
  }

  // GET /admin/usage?key_hash=&from=&to=&limit=
  if (req.method === "GET" && path === "/admin/usage") {
    const keyHash = url.searchParams.get("key_hash") || null;
    const from = url.searchParams.get("from") || null;
    const to = url.searchParams.get("to") || null;
    const limit = Number(url.searchParams.get("limit") || 200);
    return send(200, { ledger: listLedger({ keyHash, from, to, limit }) });
  }

  // GET /admin/overview?from=&to=  → { byKey, byModel, daily, totals }
  if (req.method === "GET" && path === "/admin/overview") {
    const from = url.searchParams.get("from") || null;
    const to = url.searchParams.get("to") || null;
    const where = [];
    const params = [];
    if (from) { where.push("ts >= ?"); params.push(from); }
    if (to)   { where.push("ts <= ?"); params.push(to); }
    const wc = where.length ? "WHERE " + where.join(" AND ") : "";

    const byKeyRows = db.prepare(`
      SELECT l.key_hash AS key_hash,
             COALESCE(k.name, '(unknown)') AS name,
             COUNT(*) AS requests,
             COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
             COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(l.cost_tokens), 0) AS cost
        FROM usage_ledger l
        LEFT JOIN api_keys_v2 k ON k.key_hash = l.key_hash
      ${wc}
      GROUP BY l.key_hash
      ORDER BY cost DESC
    `).all(...params);

    const byModelRows = db.prepare(`
      SELECT model,
             COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_tokens), 0) AS cost,
             CAST(COALESCE(AVG(cost_tokens), 0) AS INTEGER) AS avg_cost
        FROM usage_ledger
      ${wc}
      GROUP BY model
      ORDER BY cost DESC
    `).all(...params);

    const dailyRows = db.prepare(`
      SELECT substr(ts, 1, 10) AS day,
             COUNT(*) AS requests,
             COALESCE(SUM(cost_tokens), 0) AS cost
        FROM usage_ledger
      ${wc}
      GROUP BY day
      ORDER BY day
    `).all(...params);

    const totals = db.prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_tokens), 0) AS cost
        FROM usage_ledger
      ${wc}
    `).get(...params);

    return send(200, { byKey: byKeyRows, byModel: byModelRows, daily: dailyRows, totals });
  }

  // GET /admin/pricing
  if (req.method === "GET" && path === "/admin/pricing") {
    return send(200, { pricing: getPricing() });
  }
  // POST /admin/pricing/reload
  if (req.method === "POST" && path === "/admin/pricing/reload") {
    audit("pricing.reload", null, null);
    return send(200, { pricing: reloadPricing() });
  }
  // POST /admin/pricing  — create a new model entry
  if (req.method === "POST" && path === "/admin/pricing") {
    const body = await readJsonBody(req);
    if (!body || !body.model) return send(400, { error: "model is required" });
    try {
      const rates = setModelPricing(body.model, body);
      audit("pricing.create", body.model, rates);
      reloadPricing();
      return send(201, { ok: true, model: body.model, rates });
    } catch (e) { return send(400, { error: e.message }); }
  }
  // PATCH /admin/pricing/:model — upsert
  // DELETE /admin/pricing/:model — remove
  const pm = path.match(/^\/admin\/pricing\/([^/]+)$/);
  if (pm) {
    const model = decodeURIComponent(pm[1]);
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      try {
        const rates = setModelPricing(model, body);
        audit("pricing.update", model, rates);
        reloadPricing();
        return send(200, { ok: true, model, rates });
      } catch (e) { return send(400, { error: e.message }); }
    }
    if (req.method === "DELETE") {
      try {
        const ok = deleteModelPricing(model);
        if (!ok) return send(404, { error: "model not found" });
        audit("pricing.delete", model, null);
        reloadPricing();
        return send(200, { ok: true, model });
      } catch (e) { return send(400, { error: e.message }); }
    }
  }

  // ── Models registry (DB-backed) ─────────────────────────────────────────
  // GET /admin/models — list everything (incl. disabled), with pricing
  if (req.method === "GET" && path === "/admin/models") {
    const all = modelsReg.listModels({ enabledOnly: false });
    const pricing = modelsReg.getAllPricing();
    const data = all.map(m => ({
      ...m,
      pricing: pricing[m.id] || null,
    }));
    return send(200, { models: data, last_synced_at: modelsReg.lastSyncedAt(), default_pricing: modelsReg.getDefaultRates() });
  }
  // POST /admin/models/sync — pull from upstream Copilot /models
  if (req.method === "POST" && path === "/admin/models/sync") {
    try {
      const result = await modelsReg.syncFromUpstream();
      audit("models.sync", null, result);
      return send(200, result);
    } catch (e) {
      const status = e.status || 500;
      return send(status, { error: e.message });
    }
  }
  // PATCH /admin/models/:id — { enabled?, input_multiplier?, output_multiplier?, display_name? }
  // DELETE /admin/models/:id — only if disabled
  const mm = path.match(/^\/admin\/models\/([^/]+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    if (req.method === "PATCH") {
      const body = await readJsonBody(req) || {};
      const changes = {};
      try {
        if (typeof body.enabled === "boolean") {
          if (!modelsReg.setEnabled(id, body.enabled)) return send(404, { error: "model not found" });
          changes.enabled = body.enabled;
        }
        if (typeof body.display_name === "string" && body.display_name.trim()) {
          if (!modelsReg.setDisplayName(id, body.display_name.trim())) return send(404, { error: "model not found" });
          changes.display_name = body.display_name.trim();
        }
        if (body.input_multiplier !== undefined || body.output_multiplier !== undefined) {
          const cur = modelsReg.getRatesForModel(id);
          const inMult = body.input_multiplier !== undefined ? Number(body.input_multiplier) : cur.input_multiplier;
          const outMult = body.output_multiplier !== undefined ? Number(body.output_multiplier) : cur.output_multiplier;
          changes.pricing = modelsReg.upsertPricing(id, inMult, outMult);
        }
        if (Object.keys(changes).length === 0) return send(400, { error: "no recognized fields" });
        audit("models.update", id, changes);
        return send(200, { ok: true, id, changes });
      } catch (e) { return send(400, { error: e.message }); }
    }
    if (req.method === "DELETE") {
      const r = modelsReg.deleteModel(id);
      if (!r.ok && r.reason === "not_found") return send(404, { error: "model not found" });
      if (!r.ok && r.reason === "still_enabled") return send(409, { error: "disable model before deleting" });
      audit("models.delete", id, null);
      return send(200, { ok: true, id });
    }
  }

  // GET /admin/audit?limit=&offset=
  if (req.method === "GET" && path === "/admin/audit") {
    const limit = Number(url.searchParams.get("limit") || 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    return send(200, { actions: listAdminActions({ limit, offset }) });
  }

  return send(404, { error: "not found" });
}

// ─── /user/* (Stage 3) — per-user self-service API ───────────────────────────
async function handleUserApi(req, res) {
  const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  // Resolve who's calling. Admin user_session sees all keys (admin view);
  // regular user_session sees only its own. Anything else is unauthorized.
  let scopeHash = null;     // null = unrestricted (admin)
  let viewerKey = null;     // key row for /user/me (when scoped)
  const ctx = getUserSessionContext(req);
  if (!ctx) return send(401, { error: "unauthorized — POST /user/login first" });
  viewerKey = getKeyByHash(ctx.keyHash);
  if (!viewerKey || viewerKey.status === "disabled") return send(401, { error: "session key disabled or missing" });
  if (viewerKey.role === "admin") {
    scopeHash = null;
  } else {
    scopeHash = ctx.keyHash;
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // GET /user/me
  if (req.method === "GET" && path === "/user/me") {
    let row = viewerKey || (scopeHash === null ? null : getKeyByHash(scopeHash));
    if (!row) {
      return send(200, {
        name: "(admin)", role: "admin", key_prefix: null,
        free_quota: 0, free_used: 0, free_reset_at: null,
        balance_tokens: 0, unlimited: true, status: "active", allowed_models: null,
        is_admin_view: true,
      });
    }
    // Lazy invite settlement: if this user is a pending invitee whose usage
    // crossed the threshold, credit both sides before reporting their quota.
    try {
      const r = maybeSettleInvite(row.key_hash);
      if (r && r.settled) row = getKeyByHash(row.key_hash) || row;
    } catch {}
    let allowed = null;
    if (row.allowed_models) { try { allowed = JSON.parse(row.allowed_models); } catch {} }
    // Invite stats (only meaningful for keys that have an invite_code)
    let inviteStats = null;
    if (row.invite_code) {
      try {
        const r = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(reward_tokens),0) AS rew FROM wx_invites WHERE inviter_key_hash = ?").get(row.key_hash);
        inviteStats = { count: r?.c || 0, reward_total: r?.rew || 0 };
      } catch { inviteStats = { count: 0, reward_total: 0 }; }
    }
    return send(200, {
      name: row.name,
      role: row.role,
      key_prefix: row.key_prefix,
      raw_key: (ctx.rawKey && ctx.keyHash === row.key_hash) ? ctx.rawKey : null,
      free_quota: row.free_quota,
      free_used: row.free_used,
      free_reset_at: row.free_reset_at,
      paid_quota: Number(row.paid_quota || 0),
      balance_tokens: row.balance_tokens,
      unlimited: !!row.unlimited,
      status: row.status,
      allowed_models: allowed,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      source: row.source || null,
      invite_code: row.invite_code || null,
      invite_stats: inviteStats,
    });
  }

  // GET /user/plan
  if (req.method === "GET" && path === "/user/plan") {
    const row = viewerKey || (scopeHash ? getKeyByHash(scopeHash) : null);
    if (!row) return send(200, { plan_type: "free", plan_expires_at: 0, window_used: 0, window_quota: 0, window_reset_at: 0, free_quota: 0, free_used: 0, paid_quota: 0, balance_tokens: 0 });
    return send(200, {
      plan_type: row.plan_type || "free",
      plan_expires_at: Number(row.plan_expires_at || 0),
      window_used: Number(row.window_used || 0),
      window_quota: 600,
      window_reset_at: Number(row.window_reset_at || 0),
      free_quota: row.free_quota,
      free_used: row.free_used,
      paid_quota: Number(row.paid_quota || 0),
      balance_tokens: row.balance_tokens,
    });
  }

  // GET /user/logs?limit=&offset=&since_id=&from=&to=&model=
  if (req.method === "GET" && path === "/user/logs") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
    const sinceId = parseInt(url.searchParams.get("since_id") || "0", 10);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const model = url.searchParams.get("model");

    const where = [], params = [];
    if (scopeHash) { where.push("key_hash = ?"); params.push(scopeHash); }
    if (from) { where.push("ts >= ?"); params.push(from); }
    if (to) { where.push("ts <= ?"); params.push(to); }
    if (model) { where.push("model = ?"); params.push(model); }
    if (sinceId > 0) { where.push("id > ?"); params.push(sinceId); }
    const wc = where.length ? "WHERE " + where.join(" AND ") : "";
    const logs = db.prepare(`SELECT id, ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error FROM logs ${wc} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, sinceId > 0 ? 0 : offset);
    return send(200, { logs });
  }

  // GET /user/usage?from=&to=  → aggregate from usage_ledger
  if (req.method === "GET" && path === "/user/usage") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const where = [], params = [];
    if (scopeHash) { where.push("key_hash = ?"); params.push(scopeHash); }
    if (from) { where.push("ts >= ?"); params.push(from); }
    if (to) { where.push("ts <= ?"); params.push(to); }
    const wc = where.length ? "WHERE " + where.join(" AND ") : "";
    const byModel = db.prepare(`SELECT model, COUNT(*) as count, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cost_tokens),0) as cost FROM usage_ledger ${wc} GROUP BY model ORDER BY cost DESC`).all(...params);
    const byDay = db.prepare(`SELECT substr(ts,1,10) as day, COUNT(*) as count, COALESCE(SUM(cost_tokens),0) as cost FROM usage_ledger ${wc} GROUP BY day ORDER BY day`).all(...params);
    const total = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(cost_tokens),0) as cost FROM usage_ledger ${wc}`).get(...params);
    return send(200, { byModel, byDay, total });
  }

  // GET /user/stats → hourly + modelShare (logs-based, scoped)
  if (req.method === "GET" && path === "/user/stats") {
    const where = scopeHash ? "WHERE key_hash = ?" : "";
    const params = scopeHash ? [scopeHash] : [];
    const hourly = db.prepare(`
      SELECT substr(ts,1,13) as slot,
        COUNT(*) as total,
        SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as err,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs ${where} GROUP BY slot ORDER BY slot
    `).all(...params);
    const modelRows = db.prepare(`SELECT model, COUNT(*) as count FROM logs ${where} GROUP BY model ORDER BY count DESC`).all(...params);
    const total = modelRows.reduce((s, r) => s + r.count, 0);
    const modelShare = modelRows.map(r => ({ model: r.model, count: r.count, pct: total ? Math.round(r.count * 100 / total) : 0 }));
    return send(200, { hourly, modelShare });
  }

  return send(404, { error: "not found" });
}

// ─── Payment API: /api/pay/* (user_session required) ────────────────────────
async function handlePaymentApi(req, res) {
  const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  const ctx = getUserSessionContext(req);
  if (!ctx) return send(401, { error: "unauthorized" });
  const keyRow = getKeyByHash(ctx.keyHash);
  if (!keyRow || keyRow.status === "disabled") return send(401, { error: "session_invalid" });

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // POST /api/pay/create  { package: "990" | "2900" }
  if (req.method === "POST" && pathname === "/api/pay/create") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return send(400, { error: "bad_json" }); }
    const pkgId = String(body.package || "");
    if (!PACKAGES[pkgId]) return send(400, { error: "invalid_package", allowed: Object.keys(PACKAGES) });
    const r = await createPayment({ keyRow, packageId: pkgId });
    if (!r.ok) return send(r.status || 500, { error: r.error, detail: r.detail });
    return send(200, r.payment);
  }

  // POST /api/pay/claim  { payOrderId }
  if (req.method === "POST" && pathname === "/api/pay/claim") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return send(400, { error: "bad_json" }); }
    const payment = getPaymentByPayOrderId(body.payOrderId);
    if (!payment) return send(404, { error: "not_found" });
    if (payment.key_id !== keyRow.key_hash) return send(403, { error: "forbidden" });
    const r = await claimPayment({ payment });
    if (!r.ok) return send(r.status || 500, { error: r.error, current: r.current, detail: r.detail });
    return send(200, { status: r.status });
  }

  // GET /api/pay/status/:payOrderId
  if (req.method === "GET" && pathname.startsWith("/api/pay/status/")) {
    const payOrderId = decodeURIComponent(pathname.slice("/api/pay/status/".length));
    const payment = getPaymentByPayOrderId(payOrderId);
    if (!payment) return send(404, { error: "not_found" });
    if (payment.key_id !== keyRow.key_hash) return send(403, { error: "forbidden" });
    const synced = await syncPaymentStatus({ payment });
    const p = synced || payment;
    return send(200, {
      payOrderId: p.payOrderId,
      orderId: p.orderId,
      status: p.status,
      amount_fen: p.amount_fen,
      package: p.package,
      tokens_to_grant: p.tokens_to_grant,
      remark: p.remark,
      qrcodeUrl: p.qrcodeUrl,
      created_at: p.created_at,
      submitted_at: p.submitted_at,
      paid_at: p.paid_at,
      expires_at: p.expires_at,
      reject_reason: p.reject_reason,
    });
  }

  // GET /api/pay/history?limit=
  if (req.method === "GET" && pathname === "/api/pay/history") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
    const rows = listPaymentsByKey(keyRow.key_hash, limit);
    return send(200, { payments: rows });
  }

  return send(404, { error: "not found" });
}

// ─── Webhook handler (HMAC-only public; called by wx-gateway) ───────────────
async function handlePaymentWebhook(req, res) {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj || {}));
  };

  const secret = process.env.WX_GATEWAY_SECRET || "";
  if (!secret) return send(503, { error: "wx_disabled" });

  const sig = (req.headers["x-wx-webhook-sig"] || "").toString();
  const ts  = (req.headers["x-wx-webhook-ts"]  || "").toString();
  if (!sig || !ts) return send(403, { error: "missing_signature" });

  const chunks = []; for await (const c of req) chunks.push(c);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return send(400, { error: "bad_json" }); }
  const { event, payOrderId, status, externalRef, paidAt, rejectReason } = body || {};

  const sigOk = verifyWebhookSig({ secret, event, payOrderId, status, ts, sig });
  if (!sigOk) {
    console.warn(`[pay][webhook] bad signature payOrderId=${payOrderId} event=${event}`);
    return send(403, { error: "invalid_signature" });
  }

  // Replay protection: each (sig) is single-use within the 24h sweep window.
  if (!recordWebhookNonce(`pay:${sig}`, Number(ts) || Date.now())) {
    console.log(`[pay][webhook] nonce replay payOrderId=${payOrderId} sig=${sig.slice(0,8)}…`);
    return send(200, { ok: true, replay: true });
  }

  try {
    const r = applyWebhookEvent({
      event,
      payOrderId,
      status,
      externalRef: externalRef || null,
      rejectReason: rejectReason || null,
      paidAtIso: paidAt || null,
    });
    if (!r.ok) {
      console.warn(`[pay][webhook] ${r.error} payOrderId=${payOrderId}`);
      return send(200, { ok: false, error: r.error });
    }
    if (r.idempotent) {
      console.log(`[pay][webhook] idempotent payOrderId=${payOrderId} status=${status}`);
    } else {
      console.log(`[pay][webhook] applied payOrderId=${payOrderId} event=${event} status=${status}`);
    }
    return send(200, { ok: true });
  } catch (e) {
    console.error(`[pay][webhook] handler error:`, e);
    return send(500, { error: "internal" });
  }
}

// ─── /v1/chat/completions (OpenAI-compatible) ───────────────────────────────
async function handleChatCompletions(req, res) {
  const apiKeyCheck = checkApiKey(req, true);
  if (!apiKeyCheck.valid) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { type: "authentication_error", message: "Invalid API key. Provide a valid key via x-api-key header or Authorization: Bearer <key>", code: "invalid_api_key" },
    }));
    return;
  }

  if (apiKeyCheck.name) {
    const rlError = checkRateLimit(apiKeyCheck.name);
    if (rlError) {
      const resetSec = Math.ceil(Math.max(rlError.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(rlError.limit),
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": new Date(Date.now() + rlError.resetMs).toISOString(),
      });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: rlError.message } }));
      return;
    }
    recordRequest(apiKeyCheck.name);
  }
  if (apiKeyCheck.keyRow) {
    const v2rl = checkV2RateLimit(apiKeyCheck.keyRow);
    if (v2rl) {
      const resetSec = Math.ceil(Math.max(v2rl.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(v2rl.limit),
        "x-ratelimit-remaining-requests": "0",
      });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: v2rl.message } }));
      return;
    }
    recordV2Request(apiKeyCheck.keyRow);
  }

  const startTime = Date.now();
  const logEntry = { status: 0, model: null, stream: false, usage: null, preview: "", error: null, durationMs: 0, requestSummary: "" };
  logEntry.apiKeyName = apiKeyCheck.name;
  logEntry.keyHash = apiKeyCheck.keyRow?.key_hash || null;

  try {
    const boundTokenName = apiKeyCheck.tokenName;
    const { token, baseUrl, tokenName } = boundTokenName
      ? await getTokenByName(boundTokenName)
      : await getToken();
    logEntry.tokenName = tokenName;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = null; }

    if (!parsed || !parsed.model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Request body must be JSON with a `model` field." } }));
      return;
    }

    // Reject Claude models on the OpenAI entry — use /v1/messages instead.
    if (isClaudeModel(parsed.model)) {
      const msg = `Model "${parsed.model}" is a Claude model — use /v1/messages instead of /v1/chat/completions.`;
      logEntry.model = parsed.model;
      logEntry.status = 400;
      logEntry.error = msg;
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: msg } }));
      return;
    }

    logEntry.model = parsed.model;
    logEntry.stream = !!parsed.stream;
    const { preview, requestSummary } = summarizeChatRequest(parsed);
    logEntry.preview = preview;
    logEntry.requestSummary = requestSummary;

    // ── Quota preflight (Stage 2) ─────────────────────────────────────────
    {
      const pf = quotaPreflight(apiKeyCheck.keyRow, parsed, parsed.model);
      if (!pf.ok) {
        logEntry.status = pf.status;
        logEntry.error = pf.body?.error?.message || `quota rejected (${pf.status})`;
        logEntry.durationMs = Date.now() - startTime;
        addLog(logEntry);
        res.writeHead(pf.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pf.body));
        return;
      }
    }

    // Ask upstream to include usage in stream's final chunk (OpenAI-compat).
    if (parsed.stream && !parsed.stream_options) {
      parsed.stream_options = { include_usage: true };
    } else if (parsed.stream && parsed.stream_options && parsed.stream_options.include_usage === undefined) {
      parsed.stream_options.include_usage = true;
    }

    const forwardBody = JSON.stringify(parsed);
    logEntry.requestBody = forwardBody;

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...REQUIRED_HEADERS,
      },
      body: forwardBody,
    });

    logEntry.status = upstream.status;

    if (upstream.status >= 400) {
      let errBody = '';
      try {
        errBody = await upstream.text();
        const errJson = JSON.parse(errBody);
        const errMsg = errJson.error?.message || errJson.message || errBody.slice(0, 500);
        logEntry.error = `HTTP ${upstream.status}: ${errMsg}`;
      } catch {
        logEntry.error = `HTTP ${upstream.status}: ${errBody.slice(0, 500)}`;
      }
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      res.end(errBody);
      return;
    }

    const fwdHeaders = { "Content-Type": upstream.headers.get("content-type") || "application/json" };
    if (upstream.headers.get("x-request-id")) fwdHeaders["x-request-id"] = upstream.headers.get("x-request-id");
    if (apiKeyCheck.name) {
      const keys = loadApiKeys();
      const keyObj = keys.find(k => k.name === apiKeyCheck.name);
      const rl = keyObj?.rate_limit;
      if (rl && rl.rpm > 0) {
        const counters = getRateLimitCounters(apiKeyCheck.name);
        pruneCounters(counters);
        fwdHeaders["x-ratelimit-limit-requests"] = String(rl.rpm);
        fwdHeaders["x-ratelimit-remaining-requests"] = String(Math.max(0, rl.rpm - counters.rpm.length));
        const oldest = counters.rpm[0];
        fwdHeaders["x-ratelimit-reset-requests"] = oldest ? new Date(oldest + 60_000).toISOString() : new Date(Date.now() + 60_000).toISOString();
      }
    }
    res.writeHead(upstream.status, fwdHeaders);

    if (!upstream.body) {
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.end();
      return;
    }

    const respChunks = [];
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        respChunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();

    logEntry.durationMs = Date.now() - startTime;
    const respText = Buffer.concat(respChunks).toString();
    logEntry.responseBody = respText;
    logEntry.usage = logEntry.stream ? extractUsageStream(respText) : extractUsageNonStream(respText);

    if (apiKeyCheck.name && logEntry.usage) {
      recordTokenUsage(apiKeyCheck.name, (logEntry.usage.input || 0) + (logEntry.usage.output || 0));
    }
    const logId = addLog(logEntry);
    chargeFromLog(apiKeyCheck.keyRow, logEntry, logId);

  } catch (err) {
    logEntry.status = 502;
    logEntry.error = fullError(err);
    logEntry.durationMs = Date.now() - startTime;
    addLog(logEntry);
    console.error("[chat.completions error]", fullError(err));
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    } else {
      res.end();
    }
  }
}
// ─── /v1/responses (OpenAI Responses API) ───────────────────────────────────
async function handleResponses(req, res) {
  const apiKeyCheck = checkApiKey(req, true);
  if (!apiKeyCheck.valid) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { type: "authentication_error", message: "Invalid API key.", code: "invalid_api_key" },
    }));
    return;
  }

  if (apiKeyCheck.name) {
    const rlError = checkRateLimit(apiKeyCheck.name);
    if (rlError) {
      const resetSec = Math.ceil(Math.max(rlError.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(rlError.limit),
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": new Date(Date.now() + rlError.resetMs).toISOString(),
      });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: rlError.message } }));
      return;
    }
    recordRequest(apiKeyCheck.name);
  }
  if (apiKeyCheck.keyRow) {
    const v2rl = checkV2RateLimit(apiKeyCheck.keyRow);
    if (v2rl) {
      const resetSec = Math.ceil(Math.max(v2rl.resetMs, 0) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": String(resetSec),
        "x-ratelimit-limit-requests": String(v2rl.limit),
        "x-ratelimit-remaining-requests": "0",
      });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: v2rl.message } }));
      return;
    }
    recordV2Request(apiKeyCheck.keyRow);
  }

  const startTime = Date.now();
  const logEntry = { status: 0, model: null, stream: false, usage: null, preview: "", error: null, durationMs: 0, requestSummary: "" };
  logEntry.apiKeyName = apiKeyCheck.name;
  logEntry.keyHash = apiKeyCheck.keyRow?.key_hash || null;

  try {
    const boundTokenName = apiKeyCheck.tokenName;
    const { token, baseUrl, tokenName } = boundTokenName
      ? await getTokenByName(boundTokenName)
      : await getToken();
    logEntry.tokenName = tokenName;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = null; }

    if (!parsed || !parsed.model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Request body must be JSON with a `model` field." } }));
      return;
    }

    logEntry.model = parsed.model;
    logEntry.stream = !!parsed.stream;
    logEntry.requestSummary = `responses model=${parsed.model}`;

    const pf = quotaPreflight(apiKeyCheck.keyRow, parsed, parsed.model);
    if (!pf.ok) {
      logEntry.status = pf.status;
      logEntry.error = pf.body?.error?.message || `quota rejected (${pf.status})`;
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.writeHead(pf.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pf.body));
      return;
    }

    const forwardBody = JSON.stringify(parsed);
    logEntry.requestBody = forwardBody;

    const upstream = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...REQUIRED_HEADERS,
      },
      body: forwardBody,
    });

    logEntry.status = upstream.status;

    if (upstream.status >= 400) {
      let errBody = '';
      try {
        errBody = await upstream.text();
        const errJson = JSON.parse(errBody);
        const errMsg = errJson.error?.message || errJson.message || errBody.slice(0, 500);
        logEntry.error = `HTTP ${upstream.status}: ${errMsg}`;
      } catch {
        logEntry.error = `HTTP ${upstream.status}: ${errBody.slice(0, 500)}`;
      }
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      res.end(errBody);
      return;
    }

    const fwdHeaders = { "Content-Type": upstream.headers.get("content-type") || "application/json" };
    if (upstream.headers.get("x-request-id")) fwdHeaders["x-request-id"] = upstream.headers.get("x-request-id");
    res.writeHead(upstream.status, fwdHeaders);

    if (!upstream.body) {
      logEntry.durationMs = Date.now() - startTime;
      addLog(logEntry);
      res.end();
      return;
    }

    const respChunks = [];
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        respChunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();

    logEntry.durationMs = Date.now() - startTime;
    const respText = Buffer.concat(respChunks).toString();
    logEntry.responseBody = respText;

    // Responses API usage: shape differs from chat.completions (input_tokens/output_tokens
    // inside response.completed events for streaming; top-level usage for non-streaming).
    logEntry.usage = logEntry.stream
      ? extractResponsesUsageStream(respText)
      : extractResponsesUsageNonStream(respText);

    if (apiKeyCheck.name && logEntry.usage) {
      recordTokenUsage(apiKeyCheck.name, (logEntry.usage.input || 0) + (logEntry.usage.output || 0));
    }
    const logId = addLog(logEntry);
    chargeFromLog(apiKeyCheck.keyRow, logEntry, logId);

  } catch (err) {
    logEntry.status = 502;
    logEntry.error = fullError(err);
    logEntry.durationMs = Date.now() - startTime;
    addLog(logEntry);
    console.error("[responses error]", fullError(err));
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    } else {
      res.end();
    }
  }
}

// --- Start ---
const server = createServer(handleRequest);

// --- WebSocket upgrade (mock for Claude Chrome extension) ---

function wsDecodeFrame(buf) {
  const opcode = buf[0] & 0x0f;
  const fin = !!(buf[0] & 0x80);
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { offset = 10; } // skip 8 bytes
  const masked = !!(buf[1] & 0x80);
  let data = null;
  if (masked && buf.length >= offset + 4 + len) {
    const mask = buf.slice(offset, offset + 4);
    data = Buffer.from(buf.slice(offset + 4, offset + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  } else if (!masked && buf.length >= offset + len) {
    data = buf.slice(offset, offset + len);
  }
  return { opcode, fin, data };
}

function wsSendText(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC525B27")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  console.log("[ws] client connected");

  socket.on("data", (buf) => {
    const { opcode, data } = wsDecodeFrame(buf);
    if (opcode === 0x8) { socket.end(); return; } // close
    if (opcode === 0x9) { // ping → pong
      const pong = Buffer.from(buf);
      pong[0] = (pong[0] & 0xf0) | 0xa;
      socket.write(pong);
      return;
    }
    if (opcode === 0x1 && data) {
      const text = data.toString();
      console.log("[ws] ←", text.slice(0, 300));
      try {
        const msg = JSON.parse(text);
        // Handle connect message
        if (msg.type === "connect") {
          wsSendText(socket, JSON.stringify({
            type: "connect_ack",
            status: "ok",
            session_id: `dev-session-${Date.now()}`,
          }));
          return;
        }
        // Handle ping
        if (msg.type === "ping") {
          wsSendText(socket, JSON.stringify({ type: "pong" }));
          return;
        }
        // Default: echo back ack
        wsSendText(socket, JSON.stringify({ type: "ack", received: msg.type }));
      } catch {
        // Not JSON, ignore
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => console.log("[ws] client disconnected"));
});

server.listen(PORT, "127.0.0.1", () => {
  const apiKeysConfigured = loadApiKeys().length;
  console.log(`🍟 Copilot→Anthropic proxy running at http://127.0.0.1:${PORT}`);
  console.log(`   API:       POST http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`              POST http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`   Dashboard: http://127.0.0.1:${PORT}/`);
  console.log(`   DB:        ${DB_PATH}`);
  console.log(`   API keys:  ${apiKeysConfigured ? `${apiKeysConfigured} key(s) configured (${API_KEYS_PATH})` : "none — all requests allowed (add keys with --add-key)"}`);
  console.log(`   Dash auth: user_session (role=admin)`);
  console.log(`   TrustProxy: ${TRUST_PROXY ? "ON (X-Forwarded-For honored)" : "OFF (socket addr only)"}`);
  // Periodic sweep: flip pending/submitted payments past expires_at to expired.
  const sweepHandle = setInterval(() => sweepExpiredPayments(), 60_000);
  if (typeof sweepHandle.unref === "function") sweepHandle.unref();
  // Periodic sweep: prune webhook_nonces older than 24h.
  const nonceSweepHandle = setInterval(() => sweepWebhookNonces(), 3600_000);
  if (typeof nonceSweepHandle.unref === "function") nonceSweepHandle.unref();
  // Log active token info
  const { token: activeGH, name: activeTokenName } = getActiveGitHubToken();
  if (activeGH) {
    console.log(`   Token:     ${activeTokenName} (${getTokenType(activeGH)}, ${maskToken(activeGH)})`);
    (async () => {
      try {
        const testRes = await fetch(COPILOT_TOKEN_URL, {
          headers: { Accept: "application/json", Authorization: `Bearer ${activeGH}` },
        });
        if (testRes.ok) {
          const data = await testRes.json();
          const baseUrl = deriveBaseUrl(data.token, data.endpoints);
          const epType = baseUrl.includes("individual") ? "individual" : "enterprise";
          console.log(`   Endpoint:  ${epType} (${baseUrl})`);
        }
      } catch (e) {
        console.log(`   Endpoint:  (test failed: ${e.message})`);
      }
    })();
  } else {
    console.log(`   Token:     none configured`);
  }
});
