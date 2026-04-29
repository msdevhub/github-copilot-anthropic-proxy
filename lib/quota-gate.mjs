// ─── Quota gate + post-request ledger charge ────────────────────────────────
import { canAfford, isModelAllowed, chargeUsage, maybeAlertHighBurn } from "./keys-v2.mjs";
import { estimateCost } from "./pricing.mjs";

/**
 * Pre-flight check. Returns { ok: true } or { ok: false, status, body }.
 * The caller is expected to write the response from {status, body} on rejection.
 */
export function quotaPreflight(keyRow, parsedBody, model) {
  if (!keyRow) return { ok: true }; // legacy json-key path: no quota
  if (!isModelAllowed(keyRow, model)) {
    return { ok: false, status: 403, body: { error: { type: "permission_error", message: `model "${model}" is not allowed for this key` } } };
  }
  if (keyRow.unlimited) return { ok: true };
  const est = estimateCost(model, parsedBody);
  const r = canAfford(keyRow, est);
  if (r.allowed) return { ok: true };
  return {
    ok: false,
    status: 402,
    body: {
      error: {
        type: "insufficient_quota",
        message: r.reason === "key_disabled" ? "key disabled" : "insufficient quota",
        free_remaining: r.free_remaining,
        balance: r.balance,
        estimated_cost: r.estimated_cost,
      },
    },
  };
}

/** Post-flight: write usage to ledger and charge buckets. Best-effort, never throws. */
export function chargeFromLog(keyRow, logEntry, logId) {
  if (!keyRow || !logEntry?.usage) return;
  try {
    chargeUsage({
      row: keyRow,
      model: logEntry.model,
      inputTokens: logEntry.usage.input || 0,
      outputTokens: logEntry.usage.output || 0,
      logId,
    });
    maybeAlertHighBurn(keyRow);
  } catch (e) {
    console.error("[quota] charge failed:", e.message);
  }
}
