#!/usr/bin/env node
// Migrate api-keys.json → api_keys_v2 (sha256-hashed, unlimited=1).
// Idempotent: existing key_hashes are skipped. Run any time.
import { loadApiKeys } from "../lib/api-keys.mjs";
import { hashKey, getKeyByHash, createKey } from "../lib/keys-v2.mjs";

function main() {
  const keys = loadApiKeys();
  if (!keys.length) {
    console.log("[migrate] no keys in api-keys.json — nothing to do.");
    return;
  }

  // Admin selection (per spec): set role=admin only if name contains 'admin'
  // (case-insensitive) OR there is exactly one key. Otherwise everyone is 'user'.
  const adminIdx = keys.length === 1
    ? 0
    : keys.findIndex(k => /admin/i.test(k.name || ""));

  let migrated = 0, skipped = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const h = hashKey(k.key);
    if (getKeyByHash(h)) { skipped++; continue; }
    const role = i === adminIdx ? "admin" : "user";
    createKey({
      raw: k.key,
      name: k.name,
      role,
      unlimited: 1,
      free_quota: 0,
      balance_tokens: 0,
      token_name: k.token_name || null,
      note: "migrated from api-keys.json",
    });
    migrated++;
    console.log(`  ✓ ${k.name} → ${role} (unlimited)`);
  }
  console.log(`[migrate] done. migrated=${migrated} skipped=${skipped}`);
}

main();
