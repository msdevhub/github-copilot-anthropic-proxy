#!/usr/bin/env node
// Copilot → Anthropic API Proxy (with SQLite logging + dashboard)

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const PORT = 4819;
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const STATE_DIR = join(homedir(), ".openclaw");
const TOKEN_CACHE_PATH = join(STATE_DIR, "credentials", "github-copilot.token.json");
const DB_PATH = join(dirname(new URL(import.meta.url).pathname), "proxy-logs.db");
const DASHBOARD_PATH = join(dirname(new URL(import.meta.url).pathname), "dashboard.html");

// --- CST Time ---
function cst(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
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

const insertStmt = db.prepare(`INSERT INTO logs (ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, request_body, response_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

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
  insertStmt.run(ts, entry.model || null, entry.status, entry.durationMs || 0, entry.stream ? 1 : 0, entry.usage?.input || 0, entry.usage?.output || 0, entry.preview || null, entry.requestSummary || null, entry.error || null, (entry.requestBody || "").slice(0, 512000) || null, (entry.responseBody || "").slice(0, 512000) || null);
  const icon = entry.status < 400 ? "✓" : "✗";
  const dur = entry.durationMs ? ` ${entry.durationMs}ms` : "";
  const tokens = entry.usage ? ` [in:${entry.usage.input} out:${entry.usage.output}]` : "";
  console.log(`${icon} ${ts.slice(11)} ${entry.model || "-"}  ${entry.status}${dur}${tokens}  ${entry.error || ""}`);
}

// --- Token Management ---
let cachedToken = null;

function loadGitHubToken() {
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

function deriveBaseUrl(token) {
  const m = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!m) return "https://api.individual.githubcopilot.com";
  const host = m[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return `https://${host}`;
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 300_000) return cachedToken;
  try {
    const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf8"));
    if (cached.token && cached.expiresAt - Date.now() > 300_000) {
      cachedToken = { token: cached.token, expiresAt: cached.expiresAt, baseUrl: deriveBaseUrl(cached.token) };
      return cachedToken;
    }
  } catch {}
  const githubToken = loadGitHubToken();
  if (!githubToken) throw new Error("No GitHub token found");
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}` },
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`);
  const data = await res.json();
  const expiresAt = typeof data.expires_at === "number"
    ? (data.expires_at < 1e11 ? data.expires_at * 1000 : data.expires_at)
    : parseInt(data.expires_at, 10) * (parseInt(data.expires_at, 10) < 1e11 ? 1000 : 1);
  cachedToken = { token: data.token, expiresAt, baseUrl: deriveBaseUrl(data.token) };
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Dashboard
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML());
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
    if (url.searchParams.get("errors_only") === "1") { where.push("(status >= 400 OR error IS NOT NULL)"); }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    const logs = db.prepare(`SELECT id, ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error FROM logs ${whereClause} ORDER BY id DESC LIMIT ?`).all(...params, limit);

    const statsRow = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as err, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens, COALESCE(CAST(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS INTEGER), 0) as avgMs FROM logs ${whereClause}`).get(...params);

    const modelStats = db.prepare(`SELECT model, COUNT(*) as count, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens, COALESCE(CAST(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS INTEGER), 0) as avgMs FROM logs ${whereClause} GROUP BY model ORDER BY count DESC`).all(...params);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs, stats: statsRow, modelStats }));
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

  const startTime = Date.now();
  const logEntry = { status: 0, model: null, stream: false, usage: null, preview: "", error: null, durationMs: 0, requestSummary: "" };

  try {
    const { token, baseUrl } = await getToken();

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = null; }

    if (parsed) {
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
  console.log(`🍟 Copilot→Anthropic proxy running at http://127.0.0.1:${PORT}`);
  console.log(`   API:       POST http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`   Dashboard: http://127.0.0.1:${PORT}/`);
  console.log(`   DB:        ${DB_PATH}`);
});
