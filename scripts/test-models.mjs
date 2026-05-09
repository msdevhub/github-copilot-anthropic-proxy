#!/usr/bin/env node
// Models registry tests — seed / sync / upsert pricing / enable / delete guard.
// Usage: node scripts/test-models.mjs

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const TMP_DB = join(tmpdir(), `proxy-models-test-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else      { console.error(`  ✗ ${msg}`); failures++; }
}

const cleanup = () => { for (const ext of ["", "-wal", "-shm"]) try { if (existsSync(TMP_DB + ext)) rmSync(TMP_DB + ext); } catch {} };
process.on("exit", cleanup);

// Pre-stub fetch BEFORE importing models-registry (since exchangeGitHubToken uses fetch)
const upstreamPayload = {
  data: [
    { id: "claude-sonnet-9", name: "Claude Sonnet 9", vendor: "Anthropic", version: "9", preview: false },
    { id: "gpt-9",           name: "GPT 9",           vendor: "OpenAI",    version: "9", preview: false },
    { id: "preview-thing",   name: "Preview Thing",   vendor: "OpenAI",    version: "p", preview: true  },
  ],
};
let nextFetchHandler = null;
globalThis.fetch = async (url, opts) => {
  if (nextFetchHandler) return nextFetchHandler(url, opts);
  // default: token exchange + /models
  if (url.includes("/copilot_internal/v2/token")) {
    return new Response(JSON.stringify({ token: "tkn", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://api.example.test" } }), { status: 200 });
  }
  if (url.endsWith("/models")) {
    return new Response(JSON.stringify(upstreamPayload), { status: 200 });
  }
  return new Response("", { status: 404 });
};

// Override token source (avoid filesystem)
process.env.GITHUB_TOKEN = "ghu_fake";

const reg = await import("../lib/models-registry.mjs");
const { MODEL_REGISTRY_FALLBACK } = await import("../lib/openai-protocol.mjs");

console.log("\n→ Test 1: seedFromConfig populates from legacy registry");
{
  const seed = reg.seedFromConfig({
    legacyRegistry: MODEL_REGISTRY_FALLBACK,
    legacyPricing: { "claude-opus-4-7": { input_multiplier: 1, output_multiplier: 5 }, "_default": { input_multiplier: 1, output_multiplier: 5 } },
  });
  assert(seed.seeded === true, "first seed runs");
  const all = reg.listModels({ enabledOnly: false });
  assert(all.length === MODEL_REGISTRY_FALLBACK.length, `seeded ${all.length} models`);
  const claudeModel = reg.getModelInfo("claude-opus-4-7");
  assert(claudeModel?.protocol === "anthropic", "claude-opus-4-7 protocol = anthropic");
  assert(reg.isClaudeModel("claude-opus-4-7") === true, "isClaudeModel true for claude");
  assert(reg.isOpenAIProtocol("gpt-5") === true, "isOpenAIProtocol true for gpt");

  // Idempotent
  const again = reg.seedFromConfig({ legacyRegistry: MODEL_REGISTRY_FALLBACK, legacyPricing: {} });
  assert(again.seeded === false, "second seed is no-op");
}

console.log("\n→ Test 2: pricing upsert / getRatesForModel / fallback");
{
  reg.upsertPricing("claude-opus-4-7", 2.5, 10.0);
  const r = reg.getRatesForModel("claude-opus-4-7");
  assert(r.input_multiplier === 2.5 && r.output_multiplier === 10.0, "upsert + read pricing");
  // Unknown model → default
  const def = reg.getRatesForModel("never-heard-of-this-model");
  assert(def.input_multiplier === 1 && def.output_multiplier === 5, "unknown model falls back to _default");
  // Validation
  let threw = false;
  try { reg.upsertPricing("x", -1, 1); } catch { threw = true; }
  assert(threw, "rejects negative multiplier");
}

console.log("\n→ Test 3: setEnabled / listModels enabledOnly");
{
  reg.setEnabled("gpt-4o", false);
  const enabled = reg.listModels({ enabledOnly: true });
  const all = reg.listModels({ enabledOnly: false });
  assert(all.length > enabled.length, "enabledOnly filters out disabled");
  assert(enabled.find(m => m.id === "gpt-4o") === undefined, "disabled model excluded");
}

console.log("\n→ Test 4: deleteModel guards against deleting enabled");
{
  const r1 = reg.deleteModel("gpt-5");
  assert(r1.ok === false && r1.reason === "still_enabled", "refuses to delete enabled model");
  // Disable then delete
  reg.setEnabled("gpt-5", false);
  const r2 = reg.deleteModel("gpt-5");
  assert(r2.ok === true, "deletes disabled model");
  assert(reg.getModelInfo("gpt-5") === null, "model gone after delete");
}

console.log("\n→ Test 5: syncFromUpstream upserts and reports counts");
{
  // Make sure our test models aren't already there
  const beforeCount = reg.listModels({ enabledOnly: false }).length;
  const result = await reg.syncFromUpstream();
  assert(result.added >= 1, `added=${result.added} (≥1)`);
  assert(reg.getModelInfo("claude-sonnet-9") !== null, "new model from upstream now in DB");
  assert(reg.getModelInfo("preview-thing")?.preview === true, "preview flag persisted");
  assert(reg.lastSyncedAt() === result.synced_at, "lastSyncedAt matches");

  // New models should auto-get default pricing row
  const r = reg.getRatesForModel("claude-sonnet-9");
  assert(r.input_multiplier > 0, "new model has pricing row");

  // Re-sync: nothing new added
  const result2 = await reg.syncFromUpstream();
  assert(result2.added === 0, "second sync added=0");
  assert(result2.updated >= 1, "second sync reports updated");
  // Total should be at least the count we had + 3 (we previously deleted gpt-5 so total can be different)
  assert(result2.total >= beforeCount, "total reflects DB state");
}

console.log("\n→ Test 6: syncFromUpstream surfaces network/HTTP errors");
{
  nextFetchHandler = async (url) => {
    if (url.includes("/copilot_internal/v2/token")) return new Response("", { status: 401 });
    return new Response("", { status: 500 });
  };
  let caught = null;
  try { await reg.syncFromUpstream(); } catch (e) { caught = e; }
  nextFetchHandler = null;
  assert(caught !== null, "throws on auth failure");
  assert(caught?.status === 401, "status=401 surfaced");
}

console.log("\n→ Test 7: pricing.mjs integration (DB → computeCost)");
{
  const { computeCost, getRatesForModel } = await import("../lib/pricing.mjs");
  reg.upsertPricing("claude-opus-4-7", 1.0, 5.0);
  const cost = computeCost("claude-opus-4-7", 1000, 100);
  assert(cost === 1500, `computeCost = 1000*1.0 + 100*5.0 = ${cost}`);
  const r = getRatesForModel("claude-opus-4-7");
  assert(r.input_multiplier === 1.0, "pricing.mjs reads from DB");

  // Cache-hit billing: NULL multipliers default to 0.1×input / 1.25×input
  assert(r.cache_read_multiplier === 0.1, `default cache_read = input*0.1 (got ${r.cache_read_multiplier})`);
  assert(r.cache_write_multiplier === 1.25, `default cache_write = input*1.25 (got ${r.cache_write_multiplier})`);
  // sonnet-4-6 acceptance case
  reg.upsertPricing("claude-sonnet-4-6", 3, 15, 0.3, 3.75);
  const sonnetCost = computeCost("claude-sonnet-4-6", 900, 242, 128000, 0);
  assert(sonnetCost === 44730, `sonnet-4-6 cache_read cost = 44730 (got ${sonnetCost})`);
  // explicit cache_write
  reg.upsertPricing("model-cw-test", 2, 10, 0.2, 2.5);
  const cwCost = computeCost("model-cw-test", 1000, 100, 0, 800);
  assert(cwCost === 5000, `cache_write cost = 5000 (got ${cwCost})`);
}

console.log(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
