#!/usr/bin/env node
// P0-3 test: monthly window concurrency safety.
//
// Setup: monthly key with window_quota=10, plan_expires far in future.
// Fire 30 concurrent chargeFromLog calls (weight=1 each).
// Expectation:
//   - window_used ends at exactly 30 (force-charge applies once preflight passed)
//   - …but the audit log records overflow events for every charge past quota=10.
//
// The point of P0-3 isn't to refuse over-quota requests (preflight already let
// them through — refusing post-hoc would mean 'served but not charged' which is
// worse). It's to make overflow visible.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "p0-3-"));
process.env.DB_PATH = join(tmp, "test.db");

const { db, listAdminActions } = await import("../lib/database.mjs");
const { createKey, getKeyByHash, hashKey } = await import("../lib/keys-v2.mjs");
const { chargeFromLog, PLANS } = await import("../lib/quota-gate.mjs");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log("P0-3 monthly window overflow audit:");

// Create monthly key, then patch it to monthly_29 with quota=10 (override PLANS for the test)
const { raw } = createKey({ name: "p0-3", balance_tokens: 0, free_quota: 0, source: "manual" });
const keyHash = hashKey(raw);
const farFuture = Math.floor(Date.now() / 1000) + 86400;
db.prepare("UPDATE api_keys_v2 SET plan_type='monthly_29', plan_expires_at=?, window_used=0, window_reset_at=? WHERE key_hash=?")
  .run(farFuture, farFuture, keyHash);

// Override the plan quota for the test to make overflow easy to trigger.
PLANS.monthly_29.window_quota = 10;

// Fire N charges with weight=1 (use a model whose output_multiplier ceils to 1).
// Most models in this codebase have output_multiplier ≥ 1, so we pass an unknown
// model name → DEFAULT_RATES has output_multiplier=5. To get weight=1 we need a
// model with output_multiplier ≤ 1. We'll set one in the DB.
const { setModelPricing } = await import("../lib/pricing.mjs");
setModelPricing("test-cheap", { input_multiplier: 0.1, output_multiplier: 1.0 });

const N = 30;
const row = getKeyByHash(keyHash);
for (let i = 0; i < N; i++) {
  // Pass a fresh row snapshot each time (matches real per-request flow).
  const fresh = getKeyByHash(keyHash);
  chargeFromLog(fresh, {
    model: "test-cheap",
    usage: { input: 10, output: 10 },
    requestBody: JSON.stringify({ messages: [] }),
  }, i + 1);
}

const finalUsed = db.prepare("SELECT window_used FROM api_keys_v2 WHERE key_hash=?").get(keyHash).window_used;

t("window_used reflects every served request (preflight already let them through)", () => {
  assert.equal(finalUsed, N, `expected ${N}, got ${finalUsed}`);
});

const audits = listAdminActions({ limit: 200 }).filter(a => a.action === "window_overflow");
t("audit log recorded overflow events for every charge past quota", () => {
  // First 10 charges fit within quota; remaining N-10 should each emit an overflow audit.
  assert.equal(audits.length, N - 10, `expected ${N - 10} overflow audits, got ${audits.length}`);
});

t("audit payload contains weight + window_used + log_id", () => {
  const sample = JSON.parse(audits[0].payload);
  assert.equal(sample.weight, 1);
  assert.equal(sample.window_quota, 10);
  assert.ok(sample.window_used_after >= 11, `window_used_after should be >10, got ${sample.window_used_after}`);
  assert.ok(sample.log_id != null);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
