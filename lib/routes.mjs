// ─── API + Dashboard route handlers ──────────────────────────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { COPILOT_TOKEN_URL, DASHBOARD_PATH, PUBLIC_DIR, PORT } from "./utils.mjs";
import { loadApiKeys, saveApiKeys } from "./api-keys.mjs";
import { getKeyUsageStats } from "./rate-limit.mjs";
import { loadTokens, saveTokens, getTokenType, maskToken, clearCachedToken, deriveBaseUrl } from "./tokens.mjs";
import { checkDashboardAuth, handleLoginPost, loginPageHTML } from "./auth.mjs";
import { db } from "./database.mjs";

// --- Dashboard HTML ---
function dashboardHTML() {
  const html = readFileSync(DASHBOARD_PATH, "utf8");
  return html.replace("__PORT__", PORT);
}

/**
 * Handle dashboard, API, and management routes.
 * Returns true if the route was handled, false if not (so proxy logic can run).
 */
export async function handleRoutes(req, res) {
  // ── Login form POST ────────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/__login") {
    await handleLoginPost(req, res);
    return true;
  }

  // ── Dashboard password gate (GET / and /api/*) ─────────────────────────────
  const isDashboardRoute = (req.method === "GET" && (req.url === "/" || req.url === "/index.html"))
    || req.url.startsWith("/api/");
  if (isDashboardRoute && !checkDashboardAuth(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPageHTML());
    return true;
  }

  // Dashboard
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML());
    return true;
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
    return true;
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
    return true;
  }

  // Logs API (from SQLite)
  if (req.url.startsWith("/api/logs")) {
    const url = new URL(req.url, "http://localhost");

    // Detail endpoint: /api/logs/123
    const detailMatch = req.url.match(/^\/api\/logs\/(\d+)/);
    if (detailMatch && req.method === "GET") {
      const row = db.prepare("SELECT * FROM logs WHERE id = ?").get(parseInt(detailMatch[1]));
      if (!row) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}'); return true; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(row));
      return true;
    }

    if (req.method === "DELETE") {
      db.exec("DELETE FROM logs");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return true;
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
    return true;
  }

  // ── Token management API ────────────────────────────────────────────────────
  const tokenTestMatch = req.url.match(/^\/api\/tokens\/([^/]+)\/test$/);
  if (req.method === "GET" && tokenTestMatch) {
    const name = decodeURIComponent(tokenTestMatch[1]);
    const tokens = loadTokens();
    const target = tokens.find(t => t.name === name);
    if (!target) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return true; }
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
    return true;
  }

  const tokenActivateMatch = req.url.match(/^\/api\/tokens\/([^/]+)\/activate$/);
  if (req.method === "PUT" && tokenActivateMatch) {
    const name = decodeURIComponent(tokenActivateMatch[1]);
    const tokens = loadTokens();
    const target = tokens.find(t => t.name === name);
    if (!target) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return true; }
    tokens.forEach(t => t.active = false);
    target.active = true;
    saveTokens(tokens);
    clearCachedToken();
    console.log(`🔄 Active token switched to: ${name}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
    return true;
  }

  const tokenDeleteMatch = req.url.match(/^\/api\/tokens\/([^/]+)$/);
  if (req.method === "DELETE" && tokenDeleteMatch && req.url.startsWith("/api/tokens/")) {
    const name = decodeURIComponent(tokenDeleteMatch[1]);
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.name === name);
    if (idx === -1) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"token not found"}'); return true; }
    const wasActive = tokens[idx].active;
    tokens.splice(idx, 1);
    if (wasActive && tokens.length > 0) tokens[0].active = true;
    saveTokens(tokens);
    if (wasActive) clearCachedToken();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
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
    return true;
  }

  if (req.method === "POST" && req.url === "/api/tokens") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return true;
    }
    const { name, token: tokenValue } = parsed;
    if (!name || !tokenValue) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"name and token are required"}'); return true; }
    const tokens = loadTokens();
    if (tokens.find(t => t.name === name)) { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"token name already exists"}'); return true; }
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
    return true;
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
    return true;
  }

  if (req.method === "POST" && req.url === "/api/keys") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return true;
    }
    const { name, token_name, rate_limit } = parsed;
    if (!name) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"name is required"}'); return true; }
    const keys = loadApiKeys();
    if (keys.find(k => k.name === name)) { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"key name already exists"}'); return true; }
    const newKey = "sk-proxy-" + randomBytes(24).toString("hex");
    const keyObj = { key: newKey, name, rate_limit: { rpm: 0, rpd: 0, tpm: 0, ...rate_limit }, created: new Date().toISOString() };
    if (token_name) keyObj.token_name = token_name;
    keys.push(keyObj);
    saveApiKeys(keys);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name, key: newKey }));
    return true;
  }

  const keyDeleteMatch = req.url.match(/^\/api\/keys\/([^/]+)$/);
  if (req.method === "DELETE" && keyDeleteMatch && req.url.startsWith("/api/keys/")) {
    const name = decodeURIComponent(keyDeleteMatch[1]);
    const keys = loadApiKeys();
    const idx = keys.findIndex(k => k.name === name);
    if (idx === -1) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"key not found"}'); return true; }
    keys.splice(idx, 1);
    saveApiKeys(keys);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // PUT /api/keys/:name — update key config (rate_limit, token_name)
  const keyPutMatch = req.url.match(/^\/api\/keys\/([^/]+)$/);
  if (req.method === "PUT" && keyPutMatch && req.url.startsWith("/api/keys/")) {
    const name = decodeURIComponent(keyPutMatch[1]);
    const keys = loadApiKeys();
    const keyObj = keys.find(k => k.name === name);
    if (!keyObj) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"key not found"}'); return true; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid JSON"}'); return true;
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
    return true;
  }

  // Mock endpoints for Claude Chrome extension (dev mode)
  if (req.url.startsWith("/api/oauth/profile")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      account: { uuid: "dev-local-user", email: "dev@local", has_claude_pro: true, has_claude_max: true },
      organization: { uuid: "dev-org", organization_type: "claude_pro", rate_limit_tier: "pro" }
    }));
    return true;
  }
  if (req.url.startsWith("/api/oauth/account/settings")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ settings: {} }));
    return true;
  }
  if (req.url.startsWith("/api/oauth/organizations")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [] }));
    return true;
  }
  if (req.url.startsWith("/api/bootstrap/features")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payload: { features: { chrome_ext_bridge_enabled: { on: false, value: false, off: true } } } }));
    return true;
  }
  if (req.url.startsWith("/v1/oauth/token")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "dev-local-token", refresh_token: "dev-local-refresh", expires_in: 31536000 }));
    return true;
  }
  // Catch-all for other /api/ requests — return empty 200 instead of 404
  if (req.url.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
    return true;
  }

  return false; // Not a route we handle — fall through to proxy
}
