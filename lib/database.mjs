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
// One-shot dedup before adding UNIQUE index (idempotent — no-op if no duplicates).
try {
  const dups = db.prepare(`
    SELECT wx_openid FROM api_keys_v2
    WHERE wx_openid IS NOT NULL AND wx_openid != ''
    GROUP BY wx_openid HAVING COUNT(*) > 1
  `).all();
  for (const d of dups) {
    const rows = db.prepare(`
      SELECT key_hash, name, created_at FROM api_keys_v2
      WHERE wx_openid = ? ORDER BY created_at ASC, key_hash ASC
    `).all(d.wx_openid);
    const keep = rows[0];
    const drop = rows.slice(1);
    for (const r of drop) {
      db.prepare("UPDATE api_keys_v2 SET wx_openid = NULL WHERE key_hash = ?").run(r.key_hash);
      try {
        db.prepare(`INSERT INTO admin_actions (ts, admin_key_hash, admin_name, action, target, payload) VALUES (?, ?, ?, ?, ?, ?)`).run(
          new Date().toISOString().replace("T", " ").slice(0, 23),
          null, "system:dedup", "wx_openid_dedup_unbind", r.key_hash,
          JSON.stringify({ openid: d.wx_openid, kept_key_hash: keep.key_hash, dropped_name: r.name })
        );
      } catch {}
    }
    console.warn(`[db][dedup] wx_openid=${String(d.wx_openid).slice(0,8)}… kept ${keep.key_hash.slice(0,8)}…, unbound ${drop.length}`);
  }
} catch (e) { console.error("[db][dedup] wx_openid dedup failed:", e.message); }
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_v2_wx_openid_unique ON api_keys_v2(wx_openid) WHERE wx_openid IS NOT NULL"); } catch (e) { console.error("[db] wx_openid UNIQUE index:", e.message); }
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN source TEXT"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN invite_code TEXT"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_v2_invite_code ON api_keys_v2(invite_code) WHERE invite_code IS NOT NULL"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN paid_quota INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN display_raw TEXT"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN plan_type TEXT DEFAULT 'free'"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN plan_expires_at INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN window_used INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys_v2 ADD COLUMN window_reset_at INTEGER DEFAULT 0"); } catch {}
// Stage-7: usage_source distinguishes 'upstream' (real usage from API) vs 'estimated' (preflight fallback)
try { db.exec("ALTER TABLE usage_ledger ADD COLUMN usage_source TEXT"); } catch {}
// P1-7: per-bucket breakdown JSON ({"free":80,"paid":20,"balance":0,"overdraft":0}).
// Old `source` column kept as a coarse summary (e.g. "mixed:free+paid") for compatibility.
try { db.exec("ALTER TABLE usage_ledger ADD COLUMN source_breakdown TEXT"); } catch {}
try { db.exec("ALTER TABLE usage_ledger ADD COLUMN cache_read_tokens INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE usage_ledger ADD COLUMN cache_write_tokens INTEGER DEFAULT 0"); } catch {}

// ─── Transaction helper (node:sqlite has no `db.transaction()`) ─────────────
const __BEGIN_IMMEDIATE = db.prepare("BEGIN IMMEDIATE");
const __COMMIT = db.prepare("COMMIT");
const __ROLLBACK = db.prepare("ROLLBACK");
let __inTxn = false;
export function withTransaction(fn) {
  if (__inTxn) return fn(); // re-entrant: caller already owns the txn
  __BEGIN_IMMEDIATE.run();
  __inTxn = true;
  try {
    const r = fn();
    __COMMIT.run();
    return r;
  } catch (e) {
    try { __ROLLBACK.run(); } catch {}
    throw e;
  } finally {
    __inTxn = false;
  }
}

// ─── Payments (wx-gateway personal_qr) ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    payOrderId            TEXT PRIMARY KEY,
    orderId               TEXT NOT NULL UNIQUE,
    key_id                TEXT NOT NULL,
    openid                TEXT,
    amount_fen            INTEGER NOT NULL,
    package               TEXT NOT NULL,
    tokens_to_grant       INTEGER NOT NULL,
    status                TEXT NOT NULL,
    remark                TEXT,
    qrcodeUrl             TEXT,
    external_ref          TEXT,
    reject_reason         TEXT,
    created_at            INTEGER NOT NULL,
    submitted_at          INTEGER,
    paid_at               INTEGER,
    expires_at            INTEGER NOT NULL,
    webhook_processed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_payments_key ON payments(key_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);

// ─── WeChat signup support tables (Stage 5) ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS wx_invites (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_key_hash  TEXT NOT NULL,
    invitee_key_hash  TEXT NOT NULL UNIQUE,
    invitee_openid    TEXT,
    reward_tokens     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    reward_status     TEXT DEFAULT 'pending',
    settled_at        TEXT,
    inviter_ip        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wx_invites_inviter ON wx_invites(inviter_key_hash, id DESC);
  CREATE INDEX IF NOT EXISTS idx_wx_invites_invitee ON wx_invites(invitee_key_hash);
  CREATE TABLE IF NOT EXISTS wx_signup_ip_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip          TEXT NOT NULL,
    openid      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wx_signup_ip_log_ip_ts ON wx_signup_ip_log(ip, created_at DESC);
  CREATE TABLE IF NOT EXISTS risk_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    key_hash    TEXT,
    type        TEXT NOT NULL,
    detail      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_risk_alerts_key_ts ON risk_alerts(key_hash, id DESC);
`);

// Stage-6 wx_invites column migrations (for DBs created before these columns existed)
try { db.exec("ALTER TABLE wx_invites ADD COLUMN reward_status TEXT DEFAULT 'pending'"); } catch {}
try { db.exec("ALTER TABLE wx_invites ADD COLUMN settled_at TEXT"); } catch {}
try { db.exec("ALTER TABLE wx_invites ADD COLUMN inviter_ip TEXT"); } catch {}

// ─── Models registry + pricing (sourced from upstream Copilot /models) ──────
db.exec(`
  CREATE TABLE IF NOT EXISTS models (
    id            TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    vendor        TEXT,
    provider      TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    preview       INTEGER DEFAULT 0,
    enabled       INTEGER DEFAULT 1,
    version       TEXT,
    raw_json      TEXT,
    synced_at     INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);
  CREATE TABLE IF NOT EXISTS model_pricing (
    model_id          TEXT PRIMARY KEY,
    input_multiplier  REAL NOT NULL,
    output_multiplier REAL NOT NULL,
    updated_at        INTEGER NOT NULL
  );
`);
try { db.exec("ALTER TABLE model_pricing ADD COLUMN cache_read_multiplier REAL"); } catch {}
try { db.exec("ALTER TABLE model_pricing ADD COLUMN cache_write_multiplier REAL"); } catch {}
// Backfill defaults for legacy rows: cache_read = input*0.1, cache_write = input*1.25
try { db.exec("UPDATE model_pricing SET cache_read_multiplier  = input_multiplier * 0.1  WHERE cache_read_multiplier  IS NULL"); } catch {}
try { db.exec("UPDATE model_pricing SET cache_write_multiplier = input_multiplier * 1.25 WHERE cache_write_multiplier IS NULL"); } catch {}

// ─── Webhook / signed-redirect nonce dedup (replay protection) ──────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_nonces (
    sig          TEXT PRIMARY KEY,
    ts           INTEGER,
    processed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_nonces_processed_at ON webhook_nonces(processed_at);
`);

const INSERT_NONCE_STMT = db.prepare(`INSERT OR IGNORE INTO webhook_nonces (sig, ts, processed_at) VALUES (?, ?, ?)`);
const SWEEP_NONCE_STMT  = db.prepare(`DELETE FROM webhook_nonces WHERE processed_at < ?`);

/** Try to record a nonce. Returns true if it's the first time we've seen it,
 *  false if it was already present (= replay). Best-effort; on DB error returns true. */
export function recordWebhookNonce(sig, tsMs) {
  if (!sig) return true;
  try {
    const info = INSERT_NONCE_STMT.run(String(sig), Number(tsMs || Date.now()), Date.now());
    return info.changes === 1;
  } catch { return true; }
}

/** Sweep nonces older than 24h. Call from a periodic timer. */
export function sweepWebhookNonces() {
  try { return SWEEP_NONCE_STMT.run(Date.now() - 86400_000).changes || 0; } catch { return 0; }
}

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
