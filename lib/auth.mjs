// ─── Authentication: API key + Dashboard session ─────────────────────────────
import { randomBytes } from "node:crypto";
import { loadApiKeys } from "./api-keys.mjs";
import { getKeyByRaw, countKeys } from "./keys-v2.mjs";

// ─── API Key Auth ────────────────────────────────────────────────────────────

function extractCandidate(req) {
  const fromHeader = req.headers["x-api-key"] || "";
  const auth = req.headers["authorization"] || "";
  const fromBearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return fromHeader || fromBearer;
}

/**
 * Returns: { valid, name, tokenName, keyRow }
 *   - keyRow: full api_keys_v2 row (when matched via v2)
 *
 * Lookup order:
 *   1. v2 table (sha256 hash). If matched → use it.
 *   2. JSON fallback (legacy, pre-migration). Behaves like before — no quota.
 *   3. If no v2 keys AND no JSON keys → open mode (backward compatible).
 */
export function checkApiKey(req, returnName) {
  const candidate = extractCandidate(req);
  if (candidate) {
    const v2 = getKeyByRaw(candidate);
    if (v2) {
      if (v2.status === "disabled") {
        return returnName ? { valid: false, reason: "disabled" } : false;
      }
      return returnName
        ? { valid: true, name: v2.name, tokenName: v2.token_name || null, keyRow: v2 }
        : true;
    }
  }

  const keys = loadApiKeys();
  if (keys.length === 0 && countKeys() === 0) {
    return returnName ? { valid: true, name: null } : true;
  }

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

/** Admin auth — must be a v2 key with role='admin'. */
export function checkAdmin(req) {
  const candidate = extractCandidate(req);
  if (!candidate) return { ok: false, reason: "no_key" };
  const v2 = getKeyByRaw(candidate);
  if (!v2) return { ok: false, reason: "not_found" };
  if (v2.status === "disabled") return { ok: false, reason: "disabled" };
  if (v2.role !== "admin") return { ok: false, reason: "not_admin" };
  return { ok: true, keyRow: v2 };
}
