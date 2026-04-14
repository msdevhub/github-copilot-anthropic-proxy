// ─── Authentication: API key + Dashboard session ─────────────────────────────
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

// ─── Dashboard Session Auth (cookie-based, created after Logto SSO) ──────────
const VALID_SESSIONS = new Set();

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

/** Returns true if the request has a valid dashboard session cookie. */
export function checkDashboardSession(req) {
  const cookies = parseCookies(req);
  return VALID_SESSIONS.has(cookies["dash_session"] || "");
}

/** Creates a new dashboard session. Returns { token }. */
export function createDashboardSession() {
  const token = randomBytes(24).toString("hex");
  VALID_SESSIONS.add(token);
  return { token };
}

/** Destroys the dashboard session from the request cookie. */
export function destroyDashboardSession(req) {
  const cookies = parseCookies(req);
  const token = cookies["dash_session"] || "";
  VALID_SESSIONS.delete(token);
}
