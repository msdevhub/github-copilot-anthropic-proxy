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

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

// ─── User Session Auth (cookie-based, created via /user/login with API key) ──
// In-memory only — restart drops sessions, users re-login.
// Maps token → { keyHash: string }
const USER_SESSIONS = new Map();

/** Returns the key_hash bound to a valid user_session cookie, or null. */
export function checkUserSession(req) {
  const cookies = parseCookies(req);
  const tok = cookies["user_session"] || "";
  if (!tok) return null;
  const ctx = USER_SESSIONS.get(tok);
  if (!ctx) return null;
  return ctx.keyHash || null;
}

/** Returns full session context: { token, keyHash, rawKey } or null. */
export function getUserSessionContext(req) {
  const cookies = parseCookies(req);
  const tok = cookies["user_session"] || "";
  if (!tok) return null;
  const ctx = USER_SESSIONS.get(tok);
  if (!ctx) return null;
  return { token: tok, keyHash: ctx.keyHash || null, rawKey: ctx.rawKey || null };
}

/** Creates a user session bound to a key_hash. Optionally remembers the raw
 *  key (in-memory only) so the user can view/copy it from /user/me. */
export function createUserSession(keyHash, rawKey) {
  const token = randomBytes(24).toString("hex");
  USER_SESSIONS.set(token, { keyHash, rawKey: rawKey || null });
  return token;
}

/** Destroys the user session from the request cookie. */
export function destroyUserSession(req) {
  const cookies = parseCookies(req);
  const tok = cookies["user_session"] || "";
  if (tok) USER_SESSIONS.delete(tok);
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
