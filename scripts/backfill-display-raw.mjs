// Report wx_signup keys missing display_raw — these were created before
// the column existed and CANNOT be recovered (only the sha256 hash is stored).
// Re-scanning the official-account QR for the same openid will return the
// already-bound key, so the raw value is not retrievable for those users.
//
// Usage: node scripts/backfill-display-raw.mjs
import { db } from "../lib/database.mjs";

const rows = db.prepare(
  `SELECT key_hash, key_prefix, name, created_at
     FROM api_keys_v2
    WHERE source = 'wx_signup' AND (display_raw IS NULL OR display_raw = '')`
).all();

if (!rows.length) {
  console.log("[backfill] all wx_signup keys have display_raw — nothing to do");
  process.exit(0);
}
console.log(`[backfill] ${rows.length} wx_signup key(s) missing display_raw (NOT recoverable):`);
for (const r of rows) {
  console.log(`  - ${r.key_prefix}…  name=${r.name || "-"}  created=${r.created_at || "-"}`);
}
console.log(
  "\nNote: raw key bytes were never persisted for these rows. Affected users will\n" +
  "continue to see a masked prefix in the dashboard. Newly created wx_signup keys\n" +
  "will record display_raw automatically going forward."
);
