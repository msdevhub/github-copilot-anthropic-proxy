#!/usr/bin/env node
// Copilot → Anthropic API Proxy (with SQLite logging + dashboard)

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Module imports ──────────────────────────────────────────────────────────
import { PORT, COPILOT_TOKEN_URL, DASHBOARD_PATH, PUBLIC_DIR, API_KEYS_PATH, DB_PATH, __DIR, fullError } from "./lib/utils.mjs";
import { loadApiKeys, saveApiKeys } from "./lib/api-keys.mjs";
import { checkRateLimit, recordRequest, recordTokenUsage, getKeyUsageStats, getRateLimitCounters, pruneCounters } from "./lib/rate-limit.mjs";
import { loadTokens, saveTokens, getTokenType, maskToken, clearCachedToken, getActiveGitHubToken, deriveBaseUrl, exchangeGitHubToken, getTokenByName, getToken, getCachedTokenInfo } from "./lib/tokens.mjs";
import { checkApiKey, checkAdmin, checkDashboardSession, createDashboardSession, destroyDashboardSession, checkUserSession, createUserSession, destroyUserSession } from "./lib/auth.mjs";
import { db, addLog } from "./lib/database.mjs";
import { MODEL_REGISTRY, isClaudeModel, summarizeChatRequest, extractUsageNonStream, extractUsageStream } from "./lib/openai-protocol.mjs";
import { listKeys, createKey, updateKey, disableKey, topupKey, resetFree, getKeyByHash, canAfford, isModelAllowed, chargeUsage, listLedger, countKeys, hashKey } from "./lib/keys-v2.mjs";
import { reloadPricing, getPricing, estimateCost } from "./lib/pricing.mjs";
import { quotaPreflight, chargeFromLog } from "./lib/quota-gate.mjs";

reloadPricing();

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
function dashboardHTML() {
  const html = readFileSync(DASHBOARD_PATH, "utf8");
  return html.replace("__PORT__", PORT);
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

  // Dashboard (serves same HTML for / and /callback — SPA auth handled client-side)
  const pathname = req.url.split("?")[0];
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/callback")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML());
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

  // ── Dashboard session management ──────────────────────────────────────────
  // POST /api/__auth/session — create a session cookie (called by client after Logto auth)
  if (req.method === "POST" && req.url === "/api/__auth/session") {
    const { token, headers } = createDashboardSession();
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `dash_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE /api/__auth/session — destroy session (logout)
  if (req.method === "DELETE" && req.url === "/api/__auth/session") {
    destroyDashboardSession(req);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "dash_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    res.end(JSON.stringify({ ok: true }));
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
    const tok = createUserSession(row.key_hash);
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

  // ── Dashboard API auth guard ──────────────────────────────────────────────
  // All /api/ routes below require a valid dashboard session (except proxy API key routes)
  if (req.url.startsWith("/api/") && !req.url.startsWith("/api/__auth/")) {
    if (!checkDashboardSession(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — please sign in" }));
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

  // ── Admin API (Stage 2) — requires admin v2 key OR a dashboard session ────
  if (req.url.startsWith("/admin/")) {
    const session = checkDashboardSession(req);
    const adm = session ? { ok: true } : checkAdmin(req);
    if (!adm.ok) {
      res.writeHead(adm.reason === "no_key" || adm.reason === "not_found" ? 401 : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "auth_error", reason: adm.reason } }));
      return;
    }
    await handleAdmin(req, res);
    return;
  }

  // GET /v1/models — return supported models list (needed by Claude Code)
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: MODEL_REGISTRY }));
    return;
  }

  // ── POST /v1/chat/completions — OpenAI-compatible entry ───────────────────
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    await handleChatCompletions(req, res);
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

async function handleAdmin(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

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
    return send(201, { ok: true, key: created.raw, key_hash: created.key_hash, key_prefix: created.prefix });
  }

  // /admin/keys/:hash[/topup|/reset-free]
  const m = path.match(/^\/admin\/keys\/([a-f0-9]{64})(?:\/(topup|reset-free))?$/);
  if (m) {
    const h = m[1], action = m[2];
    const row = getKeyByHash(h);
    if (!row) return send(404, { error: "key not found" });

    if (action === "topup" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !Number.isFinite(body.tokens) || body.tokens <= 0) return send(400, { error: "tokens (positive number) required" });
      return send(200, { ok: true, key: publicKeyView(topupKey(h, body.tokens)) });
    }
    if (action === "reset-free" && req.method === "POST") {
      return send(200, { ok: true, key: publicKeyView(resetFree(h)) });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (!body) return send(400, { error: "invalid JSON" });
      return send(200, { ok: true, key: publicKeyView(updateKey(h, body)) });
    }
    if (req.method === "DELETE") {
      return send(200, { ok: true, key: publicKeyView(disableKey(h)) });
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

  // GET /admin/pricing
  if (req.method === "GET" && path === "/admin/pricing") {
    return send(200, { pricing: getPricing() });
  }
  // POST /admin/pricing/reload
  if (req.method === "POST" && path === "/admin/pricing/reload") {
    return send(200, { pricing: reloadPricing() });
  }

  return send(404, { error: "not found" });
}

// ─── /user/* (Stage 3) — per-user self-service API ───────────────────────────
async function handleUserApi(req, res) {
  const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  // Resolve who's calling. Admin dashboard session sees all keys (admin view);
  // user_session sees only its own. Anything else is unauthorized.
  let scopeHash = null;     // null = unrestricted (admin)
  let viewerKey = null;     // key row for /user/me (when scoped)
  if (checkDashboardSession(req)) {
    scopeHash = null;
    // For /user/me with admin session, surface the dashboard session as a virtual admin row
    // (so the page renders something sensible); allow ?key_hash=... override.
  } else {
    const h = checkUserSession(req);
    if (!h) return send(401, { error: "unauthorized — POST /user/login first" });
    viewerKey = getKeyByHash(h);
    if (!viewerKey || viewerKey.status === "disabled") return send(401, { error: "session key disabled or missing" });
    scopeHash = h;
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // GET /user/me
  if (req.method === "GET" && path === "/user/me") {
    const row = viewerKey || (scopeHash === null ? null : getKeyByHash(scopeHash));
    if (!row) {
      return send(200, {
        name: "(admin)", role: "admin", key_prefix: null,
        free_quota: 0, free_used: 0, free_reset_at: null,
        balance_tokens: 0, unlimited: true, status: "active", allowed_models: null,
        is_admin_view: true,
      });
    }
    let allowed = null;
    if (row.allowed_models) { try { allowed = JSON.parse(row.allowed_models); } catch {} }
    return send(200, {
      name: row.name,
      role: row.role,
      key_prefix: row.key_prefix,
      free_quota: row.free_quota,
      free_used: row.free_used,
      free_reset_at: row.free_reset_at,
      balance_tokens: row.balance_tokens,
      unlimited: !!row.unlimited,
      status: row.status,
      allowed_models: allowed,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
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
  console.log(`   Dash auth: Logto SSO (${process.env.LOGTO_ENDPOINT || 'https://logto.dr.restry.cn'})`);
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
