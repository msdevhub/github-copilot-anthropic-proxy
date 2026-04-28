// ─── SQLite setup and logging ────────────────────────────────────────────────
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./utils.mjs";
import { cst } from "./utils.mjs";

const db = new DatabaseSync(DB_PATH);

// Performance pragmas (per-connection settings must be re-applied on every startup)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -65536;     -- 64 MB page cache
  PRAGMA mmap_size = 268435456;   -- 256 MB memory-mapped I/O
  PRAGMA temp_store = MEMORY;
  PRAGMA wal_autocheckpoint = 2000;
`);

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

// Additional indexes for common filters (must come after ALTER TABLE adds columns below)
function ensureSecondaryIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_token ON logs(token_name, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_apikey ON logs(api_key_name, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_errors ON logs(id DESC) WHERE status >= 400 OR error IS NOT NULL;
  `);
}

// Add columns for full request/response body (idempotent)
try { db.exec("ALTER TABLE logs ADD COLUMN request_body TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN response_body TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN token_name TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN api_key_name TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN key_hash TEXT"); } catch {}

ensureSecondaryIndexes();
try { db.exec("CREATE INDEX IF NOT EXISTS idx_logs_keyhash ON logs(key_hash, id DESC)"); } catch {}

try {
  db.prepare(`
    UPDATE logs
       SET key_hash = (SELECT key_hash FROM api_keys_v2 WHERE name = logs.api_key_name)
     WHERE key_hash IS NULL
       AND api_key_name IS NOT NULL
       AND (SELECT COUNT(*) FROM api_keys_v2 WHERE name = logs.api_key_name) = 1
  `).run();
} catch {}

// ─── Stage 2: api_keys_v2 + usage_ledger ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys_v2 (
    key_hash        TEXT PRIMARY KEY,
    key_prefix      TEXT,
    name            TEXT,
    role            TEXT DEFAULT 'user',
    balance_tokens  INTEGER DEFAULT 0,
    free_quota      INTEGER DEFAULT 10000,
    free_used       INTEGER DEFAULT 0,
    free_reset_at   TEXT,
    unlimited       INTEGER DEFAULT 0,
    allowed_models  TEXT,
    status          TEXT DEFAULT 'active',
    token_name      TEXT,
    created_at      TEXT,
    last_used_at    TEXT,
    note            TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT,
    key_hash        TEXT,
    model           TEXT,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_tokens     INTEGER,
    source          TEXT,
    log_id          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_key ON usage_ledger(key_hash, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_ts ON usage_ledger(ts);
  CREATE INDEX IF NOT EXISTS idx_ledger_model ON usage_ledger(model, id DESC);
  CREATE TABLE IF NOT EXISTS admin_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL,
    admin_key_hash  TEXT,
    admin_name      TEXT,
    action          TEXT NOT NULL,
    target          TEXT,
    payload         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_actions_ts ON admin_actions(id DESC);
`);
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN token_name TEXT"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN wx_openid TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_v2_wx_openid ON api_keys_v2(wx_openid)"); } catch {}

// ─── WeChat users (one row per WeChat openid; bound to api_keys_v2 via wx_openid) ─
db.exec(`
  CREATE TABLE IF NOT EXISTS wx_users (
    openid        TEXT PRIMARY KEY,
    unionid       TEXT UNIQUE,
    nickname      TEXT,
    avatar_url    TEXT,
    created_at    TEXT,
    last_login_at TEXT
  );
`);

const insertStmt = db.prepare(`INSERT INTO logs (ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, request_body, response_body, token_name, api_key_name, key_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const insertAdminActionStmt = db.prepare(`INSERT INTO admin_actions (ts, admin_key_hash, admin_name, action, target, payload) VALUES (?, ?, ?, ?, ?, ?)`);

export function recordAdminAction({ adminKeyHash = null, adminName = null, action, target = null, payload = null }) {
  try {
    insertAdminActionStmt.run(cst(), adminKeyHash, adminName, String(action), target ? String(target) : null, payload == null ? null : (typeof payload === "string" ? payload : JSON.stringify(payload)));
  } catch (e) { console.error("[audit]", e.message); }
}

export function listAdminActions({ limit = 200, offset = 0 } = {}) {
  return db.prepare(`SELECT id, ts, admin_key_hash, admin_name, action, target, payload FROM admin_actions ORDER BY id DESC LIMIT ? OFFSET ?`).all(Math.min(limit, 1000), offset);
}

export function addLog(entry) {
  const ts = cst();
  const info = insertStmt.run(ts, entry.model || null, entry.status, entry.durationMs || 0, entry.stream ? 1 : 0, entry.usage?.input || 0, entry.usage?.output || 0, entry.preview || null, entry.requestSummary || null, entry.error || null, (entry.requestBody || "").slice(0, 512000) || null, (entry.responseBody || "").slice(0, 512000) || null, entry.tokenName || null, entry.apiKeyName || null, entry.keyHash || null);
  const icon = entry.status < 400 ? "✓" : "✗";
  const dur = entry.durationMs ? ` ${entry.durationMs}ms` : "";
  const tokens = entry.usage ? ` [in:${entry.usage.input} out:${entry.usage.output}]` : "";
  console.log(`${icon} ${ts.slice(11)} ${entry.model || "-"}  ${entry.status}${dur}${tokens}  ${entry.error || ""}`);
  return Number(info?.lastInsertRowid || 0);
}

/** Export db for use in routes (queries). */
export { db };
