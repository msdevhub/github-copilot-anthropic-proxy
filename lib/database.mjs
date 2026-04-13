// ─── SQLite setup and logging ────────────────────────────────────────────────
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./utils.mjs";
import { cst } from "./utils.mjs";

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
try { db.exec("ALTER TABLE logs ADD COLUMN token_name TEXT"); } catch {}
try { db.exec("ALTER TABLE logs ADD COLUMN api_key_name TEXT"); } catch {}

const insertStmt = db.prepare(`INSERT INTO logs (ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, request_body, response_body, token_name, api_key_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function addLog(entry) {
  const ts = cst();
  insertStmt.run(ts, entry.model || null, entry.status, entry.durationMs || 0, entry.stream ? 1 : 0, entry.usage?.input || 0, entry.usage?.output || 0, entry.preview || null, entry.requestSummary || null, entry.error || null, (entry.requestBody || "").slice(0, 512000) || null, (entry.responseBody || "").slice(0, 512000) || null, entry.tokenName || null, entry.apiKeyName || null);
  const icon = entry.status < 400 ? "✓" : "✗";
  const dur = entry.durationMs ? ` ${entry.durationMs}ms` : "";
  const tokens = entry.usage ? ` [in:${entry.usage.input} out:${entry.usage.output}]` : "";
  console.log(`${icon} ${ts.slice(11)} ${entry.model || "-"}  ${entry.status}${dur}${tokens}  ${entry.error || ""}`);
}

/** Export db for use in routes (queries). */
export { db };
