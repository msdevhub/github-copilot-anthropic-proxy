#!/usr/bin/env node
// Copilot → Anthropic API Proxy (with SQLite logging + dashboard)

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const PORT = 4819;
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const STATE_DIR = join(homedir(), ".openclaw");
const TOKEN_CACHE_PATH = join(STATE_DIR, "credentials", "github-copilot.token.json");
const __DIR = dirname(new URL(import.meta.url).pathname);
const DB_PATH = join(__DIR, "proxy-logs.db");
const DASHBOARD_PATH = join(__DIR, "dashboard.html");
const PUBLIC_DIR = join(__DIR, "public");
const API_KEYS_PATH = join(__DIR, "api-keys.json");
const TOKENS_PATH = join(__DIR, "tokens.json");

// ─── API Key helpers (defined early — used by CLI block below) ────────────────
function loadApiKeys() {
  try {
    if (!existsSync(API_KEYS_PATH)) return [];
    const data = JSON.parse(readFileSync(API_KEYS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function saveApiKeys(keys) {
  writeFileSync(API_KEYS_PATH, JSON.stringify(keys, null, 2));
}

// ─── Rate Limiting (sliding window in memory) ────────────────────────────────
// Per API-key counters: { keyName → { rpm: [timestamps], rpd: [timestamps], tpm: [{ts, tokens}] } }
const rateLimitCounters = new Map();

function getRateLimitCounters(keyName) {
  if (!rateLimitCounters.has(keyName)) {
    rateLimitCounters.set(keyName, { rpm: [], rpd: [], tpm: [] });
  }
  return rateLimitCounters.get(keyName);
}

/** Prune expired entries from sliding windows. */
function pruneCounters(counters) {
  const now = Date.now();
  const oneMinAgo = now - 60_000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  counters.rpm = counters.rpm.filter(ts => ts > oneMinAgo);
  counters.rpd = counters.rpd.filter(ts => ts > todayMs);
  counters.tpm = counters.tpm.filter(e => e.ts > oneMinAgo);
}

/**
 * Check rate limits for an API key. Returns null if OK, or an error message string if exceeded.
 * Also returns which limit was hit and the reset time.
 */
function checkRateLimit(keyName) {
  const keys = loadApiKeys();
  const keyObj = keys.find(k => k.name === keyName);
  if (!keyObj || !keyObj.rate_limit) return null;

  const rl = keyObj.rate_limit;
  const counters = getRateLimitCounters(keyName);
  pruneCounters(counters);

  if (rl.rpm && rl.rpm > 0 && counters.rpm.length >= rl.rpm) {
    return { message: `Rate limit exceeded: ${rl.rpm} RPM`, limit: rl.rpm, remaining: 0, resetMs: counters.rpm[0] + 60_000 - Date.now() };
  }
  if (rl.rpd && rl.rpd > 0 && counters.rpd.length >= rl.rpd) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return { message: `Rate limit exceeded: ${rl.rpd} RPD`, limit: rl.rpd, remaining: 0, resetMs: tomorrow.getTime() - Date.now() };
  }
  if (rl.tpm && rl.tpm > 0) {
    const totalTokens = counters.tpm.reduce((s, e) => s + e.tokens, 0);
    if (totalTokens >= rl.tpm) {
      return { message: `Rate limit exceeded: ${rl.tpm} TPM`, limit: rl.tpm, remaining: 0, resetMs: counters.tpm[0].ts + 60_000 - Date.now() };
    }
  }
  return null;
}

/** Record a request for rate limiting. Call after the request is accepted. */
function recordRequest(keyName) {
  const counters = getRateLimitCounters(keyName);
  const now = Date.now();
  counters.rpm.push(now);
  counters.rpd.push(now);
}

/** Record token usage for TPM tracking. Call after response completes. */
function recordTokenUsage(keyName, tokenCount) {
  if (!keyName || !tokenCount) return;
  const counters = getRateLimitCounters(keyName);
  counters.tpm.push({ ts: Date.now(), tokens: tokenCount });
}

/** Get current usage stats for an API key. */
function getKeyUsageStats(keyName) {
  const keys = loadApiKeys();
  const keyObj = keys.find(k => k.name === keyName);
  const rl = keyObj?.rate_limit || {};
  const counters = getRateLimitCounters(keyName);
  pruneCounters(counters);

  const tpmUsed = counters.tpm.reduce((s, e) => s + e.tokens, 0);
  return {
    rpm: { used: counters.rpm.length, limit: rl.rpm || 0 },
    rpd: { used: counters.rpd.length, limit: rl.rpd || 0 },
    tpm: { used: tpmUsed, limit: rl.tpm || 0 },
  };
}

// ─── Token management (multi-token support) ─────────────────────────────────
function loadTokens() {
  try {
    if (!existsSync(TOKENS_PATH)) return [];
    const data = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function getTokenType(token) {
  if (token.startsWith("gho_")) return "gho_";
  if (token.startsWith("ghu_")) return "ghu_";
  if (token.startsWith("github_pat_")) return "github_pat_";
  return "unknown";
}

function maskToken(token) {
  if (!token || token.length <= 8) return token || "";
  return token.slice(0, 8) + "...";
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

// --- CST Time ---
function cst(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
}

// ─── API Key Auth ─────────────────────────────────────────────────────────────

/** Returns true if the request carries a valid API key, or if no keys are configured. */
function checkApiKey(req, returnName) {
  const keys = loadApiKeys();
  if (keys.length === 0) return returnName ? { valid: true, name: null } : true; // backward-compatible: no keys file → open

  // Accept via x-api-key header or Authorization: Bearer ***
  const fromHeader = req.headers["x-api-key"] || "";
  const auth = req.headers["authorization"] || "";
  const fromBearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const candidate = fromHeader || fromBearer;
  const match = keys.find(k => k.key === candidate);
  if (returnName) return { valid: !!match, name: match?.name || null, tokenName: match?.token_name || null };
  return !!match;
}

// ─── Dashboard Password Auth ──────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
// Simple in-memory session store  { token → true }
const VALID_SESSIONS = new Set();

function generateSessionToken() {
  return randomBytes(24).toString("hex");
}

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

/** Returns true if the request is authenticated for the dashboard. */
function checkDashboardAuth(req) {
  if (!DASHBOARD_PASSWORD) return true; // no password set → open
  const cookies = parseCookies(req);
  return VALID_SESSIONS.has(cookies["dash_session"] || "");
}

/** Renders a styled login page matching the dashboard's dark theme. */
function loginPageHTML(error = "") {
  const errHtml = error
    ? `<p style="color:#f87171;margin:0 0 1rem;font-size:.875rem;">${error}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy Dashboard — Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #e2e8f0;
  }
  .card {
    background: #1a1d27; border: 1px solid #2d3048; border-radius: 12px;
    padding: 2.5rem 2rem; width: 100%; max-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
  .sub { color: #64748b; font-size: .85rem; margin-bottom: 1.75rem; }
  label { display: block; font-size: .8125rem; color: #94a3b8; margin-bottom: .4rem; font-weight: 500; }
  input[type=password] {
    width: 100%; padding: .625rem .875rem; background: #0f1117; border: 1px solid #2d3048;
    border-radius: 8px; color: #e2e8f0; font-size: .9375rem; outline: none;
    transition: border-color .15s;
  }
  input[type=password]:focus { border-color: #6366f1; }
  button {
    width: 100%; margin-top: 1.25rem; padding: .7rem; background: #6366f1; color: #fff;
    border: none; border-radius: 8px; font-size: .9375rem; font-weight: 600; cursor: pointer;
    transition: background .15s;
  }
  button:hover { background: #4f46e5; }
  .emoji { font-size: 2rem; margin-bottom: 1rem; display: block; }
</style>
</head>
<body>
<div class="card">
  <span class="emoji">🍟</span>
  <h1>Proxy Dashboard</h1>
  <p class="sub">Enter the dashboard password to continue.</p>
  ${errHtml}
  <form method="POST" action="/__login">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`;
}

/** Handles POST /__login — verifies password, sets cookie, redirects. */
async function handleLoginPost(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  // Parse application/x-www-form-urlencoded
  const params = Object.fromEntries(
    body.split("&").map(p => p.split("=").map(s => decodeURIComponent(s.replace(/\+/g, " "))))
  );
  if (params.password === DASHBOARD_PASSWORD) {
    const token = generateSessionToken();
    VALID_SESSIONS.add(token);
    res.writeHead(302, {
      "Location": "/",
      "Set-Cookie": `dash_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPageHTML("Incorrect password. Please try again."));
  }
}

// --- SQLite ---
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    model TEXT,
    status INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    stream INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    preview TEXT,
    request_summary TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model, ts DESC);
`);

// Add columns for full request/response body (idempotent)
try { db.exec("ALTER TABLE logs ADD COLUMN request_body TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN response_body TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN token_name TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN api_key_name TEXT"); } catch {}

const insertStmt = db.prepare(`INSERT INTO logs (ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, request_body, response_body, token_name, api_key_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function fullError(err) {
  const parts = [];
  let e = err;
  while (e) {
    parts.push(e.stack || e.message || String(e));
    e = e.cause;
  }
  return parts.join('\n  caused by: ');
}

function addLog(entry) {
  const ts = cst();
  insertStmt.run(ts, entry.model || null, entry.status, entry.durationMs || 0, entry.stream ? 1 : 0, entry.usage?.input || 0, entry.usage?.output || 0, entry.preview || null, entry.requestSummary || null, entry.error || null, (entry.requestBody || "").slice(0, 512000) || null, (entry.responseBody || "").slice(0, 512000) || null, entry.tokenName || null, entry.apiKeyName || null);
  const icon = entry.status < 400 ? "✓" : "✗";
  const dur = entry.durationMs ? ` ${entry.durationMs}ms` : "";
  const tokens = entry.usage ? ` [in:${entry.usage.input} out:${entry.usage.output}]` : "";
  console.log(`${icon} ${ts.slice(11)} ${entry.model || "-"}  ${entry.status}${dur}${tokens}  ${entry.error || ""}`);
}

// --- Token Management ---
let cachedToken = null;
/** Per-token-name cache: { name → { token, expiresAt, baseUrl, tokenName } } */
const tokenCacheByName = new Map();

function loadGitHubTokenFromProfiles() {
  const searchPaths = [
    join(STATE_DIR, "agents", "main", "agent", "auth-profiles.json"),
    join(STATE_DIR, "agents", "researcher", "agent", "auth-profiles.json"),
    join(STATE_DIR, "credentials", "auth-profiles.json"),
  ];
  for (const storePath of searchPaths) {
    try {
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      const profile = store.profiles?.["github-copilot:github"];
      if (profile?.type === "token" && profile.token) return profile.token;
    } catch {}
  }
  return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

/** Returns { token, name } for the active GitHub token. Checks tokens.json first, then falls back. */
function getActiveGitHubToken() {
  const tokens = loadTokens();
  const active = tokens.find(t => t.active);
  if (active) return { token: active.token, name: active.name };
  const fallback = loadGitHubTokenFromProfiles();
  if (fallback) return { token: fallback, name: "(default)" };
  return { token: "", name: "" };
}

function deriveBaseUrl(token, endpoints) {
  // Prefer endpoints.api from token exchange response (supports enterprise)
  if (endpoints?.api) return endpoints.api.replace(/\/+$/, "");
  const m = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!m) return "https://api.individual.githubcopilot.com";
  const host = m[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return `https://${host}`;
}

/** Exchange a GitHub token for a Copilot API token. Raw helper (no caching). */
async function exchangeGitHubToken(githubToken, tokenName) {
  if (!githubToken) throw new Error("No GitHub token found");
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}` },
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`);
  const data = await res.json();
  const expiresAt = typeof data.expires_at === "number"
    ? (data.expires_at < 1e11 ? data.expires_at * 1000 : data.expires_at)
    : parseInt(data.expires_at, 10) * (parseInt(data.expires_at, 10) < 1e11 ? 1000 : 1);
  const result = { token: data.token, expiresAt, baseUrl: deriveBaseUrl(data.token, data.endpoints), tokenName };
  console.log(`🔗 Token exchanged — base URL: ${result.baseUrl} (token: ${tokenName})`);
  return result;
}

/** Get a Copilot API token by token name (from tokens.json). Uses per-name cache. */
async function getTokenByName(name) {
  const cached = tokenCacheByName.get(name);
  if (cached && cached.expiresAt - Date.now() > 300_000) return cached;
  const tokens = loadTokens();
  const target = tokens.find(t => t.name === name);
  if (!target) throw new Error(`Token "${name}" not found in tokens.json`);
  const result = await exchangeGitHubToken(target.token, name);
  tokenCacheByName.set(name, result);
  return result;
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 300_000) return cachedToken;
  const { token: githubToken, name: tokenName } = getActiveGitHubToken();
  // Only use file-based cache when using default token (not tokens.json)
  if (tokenName === "(default)") {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf8"));
      if (cached.token && cached.expiresAt - Date.now() > 300_000) {
        cachedToken = { token: cached.token, expiresAt: cached.expiresAt, baseUrl: deriveBaseUrl(cached.token), tokenName };
        return cachedToken;
      }
    } catch {}
  }
  cachedToken = await exchangeGitHubToken(githubToken, tokenName);
  return cachedToken;
}

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

async function handleRequest(req, res) {
  // Skip WebSocket upgrade requests — handled by server.on("upgrade")
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Login form POST ────────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/__login") {
    await handleLoginPost(req, res);
    return;
  }

  // ── Dashboard password gate (GET / and /api/*) ─────────────────────────────
  const isDashboardRoute = (req.method === "GET" && (req.url === "/" || req.url === "/index.html"))
    || req.url.startsWith("/api/");
  if (isDashboardRoute && !checkDashboardAuth(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPageHTML());
    return;
  }

  // Dashboard
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
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
    cachedToken = null;
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
    if (wasActive) cachedToken = null;
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
    if (isFirst) cachedToken = null;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name, active: isFirst, username }));
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
      error: { type: "authentication_error", message: "Invalid API key. Provide a valid key via x-api-key header or Authorization: Bearer <key>." },
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

    // 上游返回错误时，捕获完整响应体
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
  const dashPwSet = !!DASHBOARD_PASSWORD;
  console.log(`🍟 Copilot→Anthropic proxy running at http://127.0.0.1:${PORT}`);
  console.log(`   API:       POST http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`   Dashboard: http://127.0.0.1:${PORT}/`);
  console.log(`   DB:        ${DB_PATH}`);
  console.log(`   API keys:  ${apiKeysConfigured ? `${apiKeysConfigured} key(s) configured (${API_KEYS_PATH})` : "none — all requests allowed (add keys with --add-key)"}`);
  console.log(`   Dash auth: ${dashPwSet ? "password-protected (DASHBOARD_PASSWORD is set)" : "open (set DASHBOARD_PASSWORD to protect)"}`);
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
