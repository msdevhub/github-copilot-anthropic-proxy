#!/usr/bin/env node
// Archive old request/response bodies from proxy-logs.db.
// Keeps full body for the most recent N rows (default 1000) and for errors.
// Earlier rows keep all metadata (preview, tokens, status, etc.) but drop the bulky bodies.
//
// Usage: node scripts/archive-bodies.mjs [keep_recent=1000]
//
// Runs online (no service downtime) thanks to WAL. VACUUM is skipped by default —
// freed pages are reused for new inserts. Pass --vacuum to reclaim disk space.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__DIR, "..", "proxy-logs.db");

const keepRecent = parseInt(process.argv[2] || "1000", 10);
const doVacuum = process.argv.includes("--vacuum");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA temp_store=MEMORY");

const maxId = db.prepare("SELECT MAX(id) mx FROM logs").get().mx || 0;
const cutoff = maxId - keepRecent;

// Preserve full body for errors even if old
const res = db.prepare(`
  UPDATE logs
    SET request_body = NULL, response_body = NULL
  WHERE id <= ?
    AND (status < 400 AND error IS NULL)
    AND (request_body IS NOT NULL OR response_body IS NOT NULL)
`).run(cutoff);

console.log(`[${new Date().toISOString()}] archived ${res.changes} rows (id<=${cutoff}, keeping last ${keepRecent})`);

if (doVacuum) {
  console.log("VACUUM starting...");
  const t0 = Date.now();
  db.exec("VACUUM");
  console.log(`VACUUM done in ${Date.now() - t0}ms`);
}
