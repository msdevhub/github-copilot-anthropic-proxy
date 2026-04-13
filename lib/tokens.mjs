// ─── Token management (multi-token support) ─────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TOKENS_PATH, STATE_DIR, COPILOT_TOKEN_URL, TOKEN_CACHE_PATH } from "./utils.mjs";

export function loadTokens() {
  try {
    if (!existsSync(TOKENS_PATH)) return [];
    const data = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

export function getTokenType(token) {
  if (token.startsWith("gho_")) return "gho_";
  if (token.startsWith("ghu_")) return "ghu_";
  if (token.startsWith("github_pat_")) return "github_pat_";
  return "unknown";
}

export function maskToken(token) {
  if (!token || token.length <= 8) return token || "";
  return token.slice(0, 8) + "...";
}

// --- Token Management ---
/** Cached default token */
let cachedToken = null;
/** Per-token-name cache: { name → { token, expiresAt, baseUrl, tokenName } } */
const tokenCacheByName = new Map();

export function clearCachedToken() {
  cachedToken = null;
}

export function loadGitHubTokenFromProfiles() {
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
export function getActiveGitHubToken() {
  const tokens = loadTokens();
  const active = tokens.find(t => t.active);
  if (active) return { token: active.token, name: active.name };
  const fallback = loadGitHubTokenFromProfiles();
  if (fallback) return { token: fallback, name: "(default)" };
  return { token: "", name: "" };
}

export function deriveBaseUrl(token, endpoints) {
  // Prefer endpoints.api from token exchange response (supports enterprise)
  if (endpoints?.api) return endpoints.api.replace(/\/+$/, "");
  const m = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!m) return "https://api.individual.githubcopilot.com";
  const host = m[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return `https://${host}`;
}

/** Exchange a GitHub token for a Copilot API token. Raw helper (no caching). */
export async function exchangeGitHubToken(githubToken, tokenName) {
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
export async function getTokenByName(name) {
  const cached = tokenCacheByName.get(name);
  if (cached && cached.expiresAt - Date.now() > 300_000) return cached;
  const tokens = loadTokens();
  const target = tokens.find(t => t.name === name);
  if (!target) throw new Error(`Token "${name}" not found in tokens.json`);
  const result = await exchangeGitHubToken(target.token, name);
  tokenCacheByName.set(name, result);
  return result;
}

export async function getToken() {
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
