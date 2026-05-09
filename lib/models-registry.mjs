// ─── Models registry (DB-backed) ─────────────────────────────────────────────
// Replaces hard-coded MODEL_REGISTRY + pricing.json. Source of truth: SQLite
// `models` and `model_pricing` tables. `syncFromUpstream()` pulls Copilot
// /models and upserts; admin can override pricing/enabled flags.

import { db, withTransaction } from "./database.mjs";
import { getToken, exchangeGitHubToken, getActiveGitHubToken } from "./tokens.mjs";

const DEFAULT_RATES = { input_multiplier: 1.0, output_multiplier: 5.0 };

// ─── Provider classification (from upstream "vendor") ───────────────────────
function classifyVendor(vendor = "") {
  const v = String(vendor).toLowerCase();
  if (v.includes("anthropic")) return { provider: "anthropic", protocol: "anthropic" };
  if (v.includes("google"))    return { provider: "google",    protocol: "openai" };
  if (v.includes("openai") || v.includes("azure")) return { provider: "openai", protocol: "openai" };
  return { provider: "openai", protocol: "openai" };
}

// ─── Read APIs ───────────────────────────────────────────────────────────────
const SELECT_ALL = db.prepare(`SELECT id, display_name, vendor, provider, protocol, preview, enabled, version, synced_at FROM models ORDER BY provider, id`);
const SELECT_ENABLED = db.prepare(`SELECT id, display_name, vendor, provider, protocol, preview, enabled, version, synced_at FROM models WHERE enabled = 1 ORDER BY provider, id`);
const SELECT_BY_ID = db.prepare(`SELECT id, display_name, vendor, provider, protocol, preview, enabled, version, synced_at FROM models WHERE id = ?`);
const SELECT_PRICING = db.prepare(`SELECT model_id, input_multiplier, output_multiplier, cache_read_multiplier, cache_write_multiplier, updated_at FROM model_pricing`);
const SELECT_PRICING_ONE = db.prepare(`SELECT input_multiplier, output_multiplier, cache_read_multiplier, cache_write_multiplier FROM model_pricing WHERE model_id = ?`);
const SELECT_DEFAULT_PRICING = db.prepare(`SELECT input_multiplier, output_multiplier, cache_read_multiplier, cache_write_multiplier FROM model_pricing WHERE model_id = '_default'`);

// NULL multipliers default to: cache_read = 0.1×input, cache_write = 1.25×input
function withCacheDefaults(r) {
  if (!r) return r;
  const inMult = Number(r.input_multiplier) || 0;
  return {
    input_multiplier: r.input_multiplier,
    output_multiplier: r.output_multiplier,
    cache_read_multiplier:  r.cache_read_multiplier  == null ? inMult * 0.1  : r.cache_read_multiplier,
    cache_write_multiplier: r.cache_write_multiplier == null ? inMult * 1.25 : r.cache_write_multiplier,
  };
}

export function listModels({ enabledOnly = false } = {}) {
  const rows = (enabledOnly ? SELECT_ENABLED : SELECT_ALL).all();
  return rows.map(r => ({ ...r, preview: !!r.preview, enabled: !!r.enabled }));
}

export function getModelInfo(id) {
  if (!id) return null;
  const r = SELECT_BY_ID.get(id);
  if (!r) return null;
  return { ...r, preview: !!r.preview, enabled: !!r.enabled };
}

export function isClaudeModel(id) {
  if (!id) return false;
  const m = SELECT_BY_ID.get(id);
  if (m) return m.protocol === "anthropic";
  return /^claude-/i.test(id);
}

export function isOpenAIProtocol(id) {
  if (!id) return false;
  const m = SELECT_BY_ID.get(id);
  if (m) return m.protocol === "openai";
  return !/^claude-/i.test(id);
}

export function getDefaultRates() {
  return withCacheDefaults(SELECT_DEFAULT_PRICING.get()) || withCacheDefaults({ ...DEFAULT_RATES });
}

export function getRatesForModel(modelId) {
  if (!modelId) return getDefaultRates();
  const r = SELECT_PRICING_ONE.get(modelId);
  if (r) return withCacheDefaults(r);
  return getDefaultRates();
}

export function getAllPricing() {
  const out = {};
  for (const r of SELECT_PRICING.all()) {
    const w = withCacheDefaults(r);
    out[r.model_id] = { ...w, updated_at: r.updated_at };
  }
  return out;
}

export function lastSyncedAt() {
  const r = db.prepare(`SELECT MAX(synced_at) AS ts FROM models`).get();
  return r?.ts || null;
}

// ─── Write APIs (admin) ──────────────────────────────────────────────────────
const UPSERT_PRICING = db.prepare(`
  INSERT INTO model_pricing (model_id, input_multiplier, output_multiplier, cache_read_multiplier, cache_write_multiplier, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(model_id) DO UPDATE SET
    input_multiplier       = excluded.input_multiplier,
    output_multiplier      = excluded.output_multiplier,
    cache_read_multiplier  = excluded.cache_read_multiplier,
    cache_write_multiplier = excluded.cache_write_multiplier,
    updated_at             = excluded.updated_at
`);
const UPDATE_ENABLED = db.prepare(`UPDATE models SET enabled = ? WHERE id = ?`);
const UPDATE_DISPLAY = db.prepare(`UPDATE models SET display_name = ? WHERE id = ?`);
const DELETE_MODEL = db.prepare(`DELETE FROM models WHERE id = ? AND enabled = 0`);
const DELETE_PRICING = db.prepare(`DELETE FROM model_pricing WHERE model_id = ?`);

export function upsertPricing(modelId, input_multiplier, output_multiplier, cache_read_multiplier = null, cache_write_multiplier = null) {
  if (!modelId) throw new Error("model_id required");
  const inMult = Number(input_multiplier);
  const outMult = Number(output_multiplier);
  if (!Number.isFinite(inMult) || inMult < 0) throw new Error("input_multiplier must be non-negative number");
  if (!Number.isFinite(outMult) || outMult < 0) throw new Error("output_multiplier must be non-negative number");
  const crMult = cache_read_multiplier == null ? null : Number(cache_read_multiplier);
  const cwMult = cache_write_multiplier == null ? null : Number(cache_write_multiplier);
  if (crMult != null && (!Number.isFinite(crMult) || crMult < 0)) throw new Error("cache_read_multiplier must be non-negative number");
  if (cwMult != null && (!Number.isFinite(cwMult) || cwMult < 0)) throw new Error("cache_write_multiplier must be non-negative number");
  UPSERT_PRICING.run(modelId, inMult, outMult, crMult, cwMult, Date.now());
  return withCacheDefaults({ input_multiplier: inMult, output_multiplier: outMult, cache_read_multiplier: crMult, cache_write_multiplier: cwMult });
}

export function deletePricingRow(modelId) {
  if (!modelId) throw new Error("model_id required");
  const r = DELETE_PRICING.run(modelId);
  return r.changes > 0;
}

export function setEnabled(modelId, enabled) {
  if (!modelId) throw new Error("model_id required");
  const r = UPDATE_ENABLED.run(enabled ? 1 : 0, modelId);
  return r.changes > 0;
}

export function setDisplayName(modelId, name) {
  if (!modelId || !name) throw new Error("model_id and name required");
  const r = UPDATE_DISPLAY.run(String(name), modelId);
  return r.changes > 0;
}

export function deleteModel(modelId) {
  if (!modelId) throw new Error("model_id required");
  return withTransaction(() => {
    const info = SELECT_BY_ID.get(modelId);
    if (!info) return { ok: false, reason: "not_found" };
    if (info.enabled) return { ok: false, reason: "still_enabled" };
    DELETE_PRICING.run(modelId);
    DELETE_MODEL.run(modelId);
    return { ok: true };
  });
}

// ─── Seed (one-shot, called once on startup if models table empty) ───────────
const UPSERT_MODEL = db.prepare(`
  INSERT INTO models (id, display_name, vendor, provider, protocol, preview, enabled, version, raw_json, synced_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    vendor       = excluded.vendor,
    provider     = excluded.provider,
    protocol     = excluded.protocol,
    preview      = excluded.preview,
    version      = excluded.version,
    raw_json     = excluded.raw_json,
    synced_at    = excluded.synced_at
`);

export function seedFromConfig({ legacyRegistry, legacyPricing }) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM models`).get().n;
  if (count > 0) return { seeded: false, reason: "already populated" };

  const now = Date.now();
  withTransaction(() => {
    for (const m of legacyRegistry || []) {
      const { provider, protocol } = classifyVendor(m.provider === "anthropic" ? "Anthropic" : m.provider === "google" ? "Google" : "OpenAI");
      const vendor = m.provider === "anthropic" ? "Anthropic" : m.provider === "google" ? "Google" : "OpenAI";
      UPSERT_MODEL.run(
        m.id, m.display_name || m.id, vendor,
        m.provider || provider, m.protocol || protocol,
        0, 1, m.id, JSON.stringify(m), now, now
      );
    }
    for (const [modelId, rates] of Object.entries(legacyPricing || {})) {
      if (!rates) continue;
      UPSERT_PRICING.run(
        modelId,
        Number(rates.input_multiplier) || DEFAULT_RATES.input_multiplier,
        Number(rates.output_multiplier) || DEFAULT_RATES.output_multiplier,
        rates.cache_read_multiplier == null ? null : Number(rates.cache_read_multiplier),
        rates.cache_write_multiplier == null ? null : Number(rates.cache_write_multiplier),
        now
      );
    }
    if (!SELECT_DEFAULT_PRICING.get()) {
      UPSERT_PRICING.run("_default", DEFAULT_RATES.input_multiplier, DEFAULT_RATES.output_multiplier, null, null, now);
    }
  });
  return { seeded: true, models: (legacyRegistry || []).length, pricing: Object.keys(legacyPricing || {}).length };
}

// ─── Sync from upstream Copilot /models ─────────────────────────────────────
async function fetchUpstreamModels() {
  const { token: githubToken, name: tokenName } = getActiveGitHubToken();
  if (!githubToken) {
    const err = new Error("no GitHub token configured");
    err.status = 401;
    throw err;
  }
  let copilot;
  try {
    copilot = await exchangeGitHubToken(githubToken, tokenName);
  } catch (e) {
    const wrapped = new Error(`token exchange failed: ${e.message}`);
    wrapped.status = 401;
    throw wrapped;
  }
  const url = `${copilot.baseUrl.replace(/\/+$/, "")}/models`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${copilot.token}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.95.0",
      },
    });
  } catch (e) {
    const wrapped = new Error(`network error: ${e.message}`);
    wrapped.status = 502;
    throw wrapped;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`upstream auth failed: HTTP ${res.status}`);
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`upstream HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    const err = new Error("upstream returned malformed body");
    err.status = 502;
    throw err;
  }
  return json.data;
}

export async function syncFromUpstream() {
  const items = await fetchUpstreamModels();
  const now = Date.now();
  const existing = new Map(SELECT_ALL.all().map(r => [r.id, r]));

  let added = 0, updated = 0;
  withTransaction(() => {
    const defaultRates = getDefaultRates();
    for (const m of items) {
      const id = m.id;
      if (!id) continue;
      const vendor = m.vendor || "";
      const { provider, protocol } = classifyVendor(vendor);
      const display = m.name || m.display_name || id;
      const preview = m.preview ? 1 : 0;
      const version = m.version || "";
      const raw = JSON.stringify(m);
      const prev = existing.get(id);
      const isNew = !prev;
      const enabled = isNew ? 1 : (prev.enabled ? 1 : 0);
      const created = isNew ? now : (db.prepare(`SELECT created_at FROM models WHERE id = ?`).get(id)?.created_at || now);
      UPSERT_MODEL.run(id, display, vendor, provider, protocol, preview, enabled, version, raw, now, created);
      if (isNew) {
        added++;
        if (!SELECT_PRICING_ONE.get(id)) {
          UPSERT_PRICING.run(id, defaultRates.input_multiplier, defaultRates.output_multiplier, null, null, now);
        }
      } else {
        updated++;
      }
    }
  });

  const total = SELECT_ALL.all().length;
  return { added, updated, total, synced_at: now };
}
