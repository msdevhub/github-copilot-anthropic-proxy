#!/usr/bin/env node
// P0-2 test: when upstream returns no usage, token-path key must still be charged
// (using the preflight estimate) and the ledger row must record usage_source='estimated'.
//
// Uses an isolated DB via DB_PATH env so it doesn't touch the production DB.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "p0-2-"));
process.env.DB_PATH = join(tmp, "test.db");

const { db } = await import("../lib/database.mjs");
const { createKey, getKeyByHash } = await import("../lib/keys-v2.mjs");
const { chargeFromLog } = await import("../lib/quota-gate.mjs");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log("P0-2 estimate-fallback charging:");

// Verify ALTER added the column
const cols = db.prepare("PRAGMA table_info(usage_ledger)").all().map(c => c.name);
t("usage_ledger has usage_source column", () => {
  assert.ok(cols.includes("usage_source"), `cols=${cols.join(",")}`);
});

// Create a token-path key with a paid balance
const { raw } = createKey({
  name: "p0-2-test",
  balance_tokens: 100_000,
  free_quota: 0,
  source: "manual",
});
const { hashKey } = await import("../lib/keys-v2.mjs");
const keyHash = hashKey(raw);
const row = getKeyByHash(keyHash);

t("upstream usage present → ledger row marked 'upstream'", () => {
  const before = db.prepare("SELECT balance_tokens FROM api_keys_v2 WHERE key_hash=?").get(keyHash).balance_tokens;
  chargeFromLog(row, {
    model: "claude-sonnet-4-5",
    usage: { input: 100, output: 50 },
    requestBody: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  }, null);
  const after = db.prepare("SELECT balance_tokens FROM api_keys_v2 WHERE key_hash=?").get(keyHash).balance_tokens;
  assert.ok(after < before, `balance should drop: ${before} → ${after}`);
  const last = db.prepare("SELECT usage_source, cost_tokens FROM usage_ledger WHERE key_hash=? ORDER BY id DESC LIMIT 1").get(keyHash);
  assert.equal(last.usage_source, "upstream");
  assert.ok(last.cost_tokens > 0);
});

t("upstream usage NULL → estimate fallback charges + marks 'estimated'", () => {
  const fresh = getKeyByHash(keyHash);
  const before = fresh.balance_tokens;
  chargeFromLog(fresh, {
    model: "claude-sonnet-4-5",
    usage: null, // simulate parser miss
    requestBody: JSON.stringify({
      messages: [{ role: "user", content: "x".repeat(400) }], // ~100 input tokens
      max_tokens: 200,
    }),
  }, null);
  const after = db.prepare("SELECT balance_tokens FROM api_keys_v2 WHERE key_hash=?").get(keyHash).balance_tokens;
  assert.ok(after < before, `balance should drop on estimate: ${before} → ${after}`);
  const last = db.prepare("SELECT usage_source, cost_tokens FROM usage_ledger WHERE key_hash=? ORDER BY id DESC LIMIT 1").get(keyHash);
  assert.equal(last.usage_source, "estimated");
  assert.ok(last.cost_tokens > 0, "estimate should produce non-zero cost");
});

t("no usage AND no requestBody → skipped (no ledger row added)", () => {
  const fresh = getKeyByHash(keyHash);
  const before = db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE key_hash=?").get(keyHash).n;
  chargeFromLog(fresh, { model: "claude-sonnet-4-5", usage: null }, null);
  const after = db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE key_hash=?").get(keyHash).n;
  assert.equal(after, before, "no row should be inserted");
});

console.log(`\n${pass} passed, ${fail} failed`);

// cleanup
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
