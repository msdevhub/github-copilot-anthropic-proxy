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
import { checkApiKey, checkDashboardSession, createDashboardSession, destroyDashboardSession } from "./lib/auth.mjs";
import { db, addLog } from "./lib/database.mjs";

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
  if (req.method === "GET" && (req.url === "/dashboard.css" || req.url === "/dashboard.js")) {
    const file = req.url === "/dashboard.css" ? "dashboard.css" : "dashboard.js";
    const contentType = req.url === "/dashboard.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hourly, modelShare }));
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
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 1000);

    let where = [], params = [];
    if (from) { where.push("ts >= ?"); params.push(from); }
    if (to) { where.push("ts <= ?"); params.push(to); }
    if (model) { where.push("model = ?"); params.push(model); }
    const tokenNameFilter = url.searchParams.get("token_name");
    if (tokenNameFilter) { where.push("token_name = ?"); params.push(tokenNameFilter); }
    if (url.searchParams.get("errors_only") === "1") { where.push("(status >= 400 OR error IS NOT NULL)"); }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    const logs = db.prepare(`SELECT id, ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, token_name, api_key_name FROM logs ${whereClause} ORDER BY id DESC LIMIT ?`).all(...params, limit);

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

  // GET /v1/models — return supported models list (needed by Claude Code)
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4", created_at: "2025-05-14" },
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4", created_at: "2025-05-14" },
        { id: "claude-haiku-3-5-20241022", display_name: "Claude 3.5 Haiku", created_at: "2024-10-22" },
        { id: "claude-opus-4-20250514", display_name: "Claude Opus 4", created_at: "2025-05-14" },
      ]
    }));
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
      // Default max_tokens to 5000 if not provided
      if (!parsed.max_tokens) parsed.max_tokens = 5000;

      // Remap claude-opus-4.6 variants to the 1M context version
      if (parsed.model && /^claude-opus-4[.\-]6/i.test(parsed.model) && parsed.model !== 'claude-opus-4.6-1m') {
        console.log(`🔄 Model remapped: ${parsed.model} → claude-opus-4.6-1m`);
        parsed.model = 'claude-opus-4.6-1m';
      }

      logEntry.model = parsed.model || null;
      logEntry.stream = !!parsed.stream;

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
    addLog(logEntry);

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
