// ─── Authentication: API key + Dashboard password ───────────────────────────
import { randomBytes } from "node:crypto";
import { loadApiKeys } from "./api-keys.mjs";

// ─── API Key Auth ────────────────────────────────────────────────────────────

/** Returns true if the request carries a valid API key, or if no keys are configured. */
export function checkApiKey(req, returnName) {
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

// ─── Dashboard Password Auth ─────────────────────────────────────────────────
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
// Simple in-memory session store  { token → true }
const VALID_SESSIONS = new Set();

function generateSessionToken() {
  return randomBytes(24).toString("hex");
}

export function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

/** Returns true if the request is authenticated for the dashboard. */
export function checkDashboardAuth(req) {
  if (!DASHBOARD_PASSWORD) return true; // no password set → open
  const cookies = parseCookies(req);
  return VALID_SESSIONS.has(cookies["dash_session"] || "");
}

/** Renders a styled login page matching the dashboard's dark theme. */
export function loginPageHTML(error = "") {
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
export async function handleLoginPost(req, res) {
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
