// ─── Pricing: token-based cost computation ───────────────────────────────────
// pricing.json maps model_id → {input_multiplier, output_multiplier}.
// cost_tokens = ceil(input * input_multiplier + output * output_multiplier)
// Loaded once at startup; reload via reloadPricing().
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { __DIR } from "./utils.mjs";

const PRICING_PATH = join(__DIR, "pricing.json");
let pricing = null;

export function reloadPricing() {
  if (!existsSync(PRICING_PATH)) {
    pricing = { _default: { input_multiplier: 1.0, output_multiplier: 5.0 } };
    return pricing;
  }
  try {
    pricing = JSON.parse(readFileSync(PRICING_PATH, "utf8"));
    if (!pricing._default) pricing._default = { input_multiplier: 1.0, output_multiplier: 5.0 };
  } catch (e) {
    console.error("[pricing] failed to load pricing.json:", e.message);
    pricing = { _default: { input_multiplier: 1.0, output_multiplier: 5.0 } };
  }
  return pricing;
}

function savePricing() {
  writeFileSync(PRICING_PATH, JSON.stringify(pricing, null, 2) + "\n", "utf8");
}

function normalizeRates(body) {
  if (!body || typeof body !== "object") throw new Error("invalid body");
  const input_multiplier = Number(body.input_multiplier);
  const output_multiplier = Number(body.output_multiplier);
  if (!Number.isFinite(input_multiplier) || input_multiplier < 0) throw new Error("input_multiplier must be non-negative number");
  if (!Number.isFinite(output_multiplier) || output_multiplier < 0) throw new Error("output_multiplier must be non-negative number");
  return { input_multiplier, output_multiplier };
}

export function setModelPricing(model, body) {
  if (!model) throw new Error("model required");
  if (!pricing) reloadPricing();
  pricing[model] = normalizeRates(body);
  savePricing();
  return pricing[model];
}

export function deleteModelPricing(model) {
  if (!model) throw new Error("model required");
  if (model === "_default") throw new Error("cannot delete _default");
  if (!pricing) reloadPricing();
  if (!(model in pricing)) return false;
  delete pricing[model];
  savePricing();
  return true;
}

export function getPricing() {
  if (!pricing) reloadPricing();
  return pricing;
}

export function getRatesForModel(model) {
  const p = getPricing();
  return p[model] || p._default;
}

/** Compute cost in equivalent-tokens. Always returns a non-negative integer. */
export function computeCost(model, inputTokens, outputTokens) {
  const r = getRatesForModel(model);
  const cost = (inputTokens || 0) * r.input_multiplier + (outputTokens || 0) * r.output_multiplier;
  return Math.max(0, Math.ceil(cost));
}

/**
 * Pre-charge estimate based on the request body.
 * Heuristic: input ≈ 1 token / 4 chars of prompt JSON; output ≈ max_tokens (or 1024 default).
 */
export function estimateCost(model, parsedBody) {
  let inputEst = 0;
  try {
    const s = JSON.stringify(parsedBody?.messages || []) + JSON.stringify(parsedBody?.system || "");
    inputEst = Math.ceil(s.length / 4);
  } catch { inputEst = 0; }
  const outputEst = parsedBody?.max_tokens || parsedBody?.max_completion_tokens || 1024;
  return computeCost(model, inputEst, outputEst);
}
