// ─── Rate Limiting (sliding window in memory) ───────────────────────────────
import { loadApiKeys } from "./api-keys.mjs";

// Per API-key counters: { keyName → { rpm: [timestamps], rpd: [timestamps], tpm: [{ts, tokens}] } }
const rateLimitCounters = new Map();

export function getRateLimitCounters(keyName) {
  if (!rateLimitCounters.has(keyName)) {
    rateLimitCounters.set(keyName, { rpm: [], rpd: [], tpm: [] });
  }
  return rateLimitCounters.get(keyName);
}

/** Prune expired entries from sliding windows. */
export function pruneCounters(counters) {
  const now = Date.now();
  const oneMinAgo = now - 60_000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  counters.rpm = counters.rpm.filter(ts => ts > oneMinAgo);
  counters.rpd = counters.rpd.filter(ts => ts > todayMs);
  counters.tpm = counters.tpm.filter(e => e.ts > oneMinAgo);
}

/**
 * Check rate limits for an API key. Returns null if OK, or an error object if exceeded.
 */
export function checkRateLimit(keyName) {
  const keys = loadApiKeys();
  const keyObj = keys.find(k => k.name === keyName);
  if (!keyObj || !keyObj.rate_limit) return null;

  const rl = keyObj.rate_limit;
  const counters = getRateLimitCounters(keyName);
  pruneCounters(counters);

  if (rl.rpm && rl.rpm > 0 && counters.rpm.length >= rl.rpm) {
    return { message: `Rate limit exceeded: ${rl.rpm} RPM`, limit: rl.rpm, remaining: 0, resetMs: counters.rpm[0] + 60_000 - Date.now() };
  }
  if (rl.rpd && rl.rpd > 0 && counters.rpd.length >= rl.rpd) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return { message: `Rate limit exceeded: ${rl.rpd} RPD`, limit: rl.rpd, remaining: 0, resetMs: tomorrow.getTime() - Date.now() };
  }
  if (rl.tpm && rl.tpm > 0) {
    const totalTokens = counters.tpm.reduce((s, e) => s + e.tokens, 0);
    if (totalTokens >= rl.tpm) {
      return { message: `Rate limit exceeded: ${rl.tpm} TPM`, limit: rl.tpm, remaining: 0, resetMs: counters.tpm[0].ts + 60_000 - Date.now() };
    }
  }
  return null;
}

/** Record a request for rate limiting. Call after the request is accepted. */
export function recordRequest(keyName) {
  const counters = getRateLimitCounters(keyName);
  const now = Date.now();
  counters.rpm.push(now);
  counters.rpd.push(now);
}

/** Record token usage for TPM tracking. Call after response completes. */
export function recordTokenUsage(keyName, tokenCount) {
  if (!keyName || !tokenCount) return;
  const counters = getRateLimitCounters(keyName);
  counters.tpm.push({ ts: Date.now(), tokens: tokenCount });
}

/** Get current usage stats for an API key. */
export function getKeyUsageStats(keyName) {
  const keys = loadApiKeys();
  const keyObj = keys.find(k => k.name === keyName);
  const rl = keyObj?.rate_limit || {};
  const counters = getRateLimitCounters(keyName);
  pruneCounters(counters);

  const tpmUsed = counters.tpm.reduce((s, e) => s + e.tokens, 0);
  return {
    rpm: { used: counters.rpm.length, limit: rl.rpm || 0 },
    rpd: { used: counters.rpd.length, limit: rl.rpd || 0 },
    tpm: { used: tpmUsed, limit: rl.tpm || 0 },
  };
}
