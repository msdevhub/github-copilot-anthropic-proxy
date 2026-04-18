// ─── Shared utilities and paths ──────────────────────────────────────────────
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ─── Shared paths (computed once, imported everywhere) ───────────────────────
// __DIR points to the project root (parent of lib/)
const __filename = fileURLToPath(import.meta.url);
export const __DIR = dirname(dirname(__filename)); // lib/../ = project root

export const PORT = Number(process.env.PORT) || 5819;
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const STATE_DIR = join(homedir(), ".openclaw");
export const TOKEN_CACHE_PATH = join(STATE_DIR, "credentials", "github-copilot.token.json");
export const DB_PATH = join(__DIR, "proxy-logs.db");
export const DASHBOARD_PATH = join(__DIR, "dashboard.html");
export const PUBLIC_DIR = join(__DIR, "public");
export const API_KEYS_PATH = join(__DIR, "api-keys.json");
export const TOKENS_PATH = join(__DIR, "tokens.json");

// ─── CST Time formatter ─────────────────────────────────────────────────────
export function cst(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
}

// ─── Full error chain formatter ──────────────────────────────────────────────
export function fullError(err) {
  const parts = [];
  let e = err;
  while (e) {
    parts.push(e.stack || e.message || String(e));
    e = e.cause;
  }
  return parts.join('\n  caused by: ');
}
