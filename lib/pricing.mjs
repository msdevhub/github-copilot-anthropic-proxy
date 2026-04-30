// ─── Pricing: token-based cost computation ───────────────────────────────────
// Pricing lives in the SQLite `model_pricing` table (see lib/models-registry.mjs).
// pricing.json is now only used as a one-shot seed on first startup.
// cost_tokens = ceil(input * input_multiplier + output * output_multiplier)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { __DIR } from "./utils.mjs";
import * as registry from "./models-registry.mjs";
import { MODEL_REGISTRY_FALLBACK } from "./openai-protocol.mjs";

const PRICING_PATH = join(__DIR, "pricing.json");
const DEFAULT_RATES = { input_multiplier: 1.0, output_multiplier: 5.0 };

// ─── Seed (one-shot) ────────────────────────────────────────────────────────
export function seedPricingFromConfig() {
  let legacy = null;
  if (existsSync(PRICING_PATH)) {
    try { legacy = JSON.parse(readFileSync(PRICING_PATH, "utf8")); }
    catch (e) { console.error("[pricing] failed to read pricing.json seed:", e.message); }
  }
  const result = registry.seedFromConfig({
    legacyRegistry: MODEL_REGISTRY_FALLBACK,
    legacyPricing: legacy || {},
  });
  if (result.seeded) {
    console.log(`[models] seeded DB from config — models=${result.models}, pricing=${result.pricing}`);
  }
  return result;
}

// ─── Public API (DB-backed) ─────────────────────────────────────────────────
export function reloadPricing() { return getPricing(); }

export function getPricing() {
  try {
    const all = registry.getAllPricing();
    if (!all._default) all._default = DEFAULT_RATES;
    return all;
  } catch (e) {
    console.error("[pricing] DB read failed:", e.message);
    return { _default: DEFAULT_RATES };
  }
}

export function getRatesForModel(model) {
  try { return registry.getRatesForModel(model); }
  catch { return DEFAULT_RATES; }
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
  const rates = normalizeRates(body);
  return registry.upsertPricing(model, rates.input_multiplier, rates.output_multiplier);
}

export function deleteModelPricing(model) {
  if (!model) throw new Error("model required");
  if (model === "_default") throw new Error("cannot delete _default");
  return registry.deletePricingRow(model);
}

/** Compute cost in equivalent-tokens. Always returns a non-negative integer.
 *  Uses scaled-integer arithmetic (×1000) so that fractional multipliers like
 *  0.04/0.06 don't accumulate ±1 token rounding error on large token counts. */
export function computeCost(model, inputTokens, outputTokens) {
  const r = getRatesForModel(model);
  const inT = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const outT = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const inMilli  = Math.round(inT  * (Number(r.input_multiplier)  || 0) * 1000);
  const outMilli = Math.round(outT * (Number(r.output_multiplier) || 0) * 1000);
  const totalMilli = inMilli + outMilli;
  return Math.max(0, Math.ceil(totalMilli / 1000));
}

/**
 * Pre-charge estimate of (input, output) tokens based on the request body.
 * Heuristic: input ≈ 1 token / 4 chars of prompt JSON; output ≈ max_tokens (or 1024 default).
 * Also handles Responses API shape where prompt lives under `input`.
 */
export function estimateTokens(parsedBody) {
  let inputEst = 0;
  try {
    const promptParts = [
      parsedBody?.messages,
      parsedBody?.system,
      parsedBody?.input, // Responses API
      parsedBody?.instructions, // Responses API
    ].filter(Boolean);
    const s = promptParts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join("");
    inputEst = Math.ceil(s.length / 4);
  } catch { inputEst = 0; }
  const outputEst = parsedBody?.max_tokens
    || parsedBody?.max_completion_tokens
    || parsedBody?.max_output_tokens // Responses API
    || 1024;
  return { input: inputEst, output: outputEst };
}

/**
 * Pre-charge estimate based on the request body.
 */
export function estimateCost(model, parsedBody) {
  const { input, output } = estimateTokens(parsedBody);
  return computeCost(model, input, output);
}
