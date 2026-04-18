// ─── Pricing: token-based cost computation ───────────────────────────────────
// pricing.json maps model_id → {input_multiplier, output_multiplier}.
// cost_tokens = ceil(input * input_multiplier + output * output_multiplier)
// Loaded once at startup; reload via reloadPricing().
import { readFileSync, existsSync } from "node:fs";
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
