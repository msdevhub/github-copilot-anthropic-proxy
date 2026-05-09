// ─── OpenAI-compatible protocol helpers ──────────────────────────────────────
// Copilot's upstream exposes an OpenAI-shaped /chat/completions endpoint;
// we forward requests there as-is and only need light helpers around it.

import * as registry from "./models-registry.mjs";

// Hard-coded fallback list — used only if the DB is unavailable or empty.
// Production reads from `models` table (see lib/models-registry.mjs).
// Synced from Copilot upstream /models on 2026-04-29.
export const MODEL_REGISTRY_FALLBACK = [
  // Anthropic / Claude
  { id: "claude-sonnet-4",            display_name: "Claude Sonnet 4",       created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-sonnet-4-20250514",   display_name: "Claude Sonnet 4",       created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-sonnet-4.5",          display_name: "Claude Sonnet 4.5",     created_at: "2025-09-29", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-sonnet-4-6",          display_name: "Claude Sonnet 4.6",     created_at: "2026-01-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-sonnet-4.6",          display_name: "Claude Sonnet 4.6",     created_at: "2026-01-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-haiku-4.5",           display_name: "Claude Haiku 4.5",      created_at: "2025-10-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-20250514",     display_name: "Claude Opus 4",         created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4.5",            display_name: "Claude Opus 4.5",       created_at: "2025-11-24", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4.6",            display_name: "Claude Opus 4.6",       created_at: "2026-02-10", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4.6-1m",         display_name: "Claude Opus 4.6 (1M)",  created_at: "2026-02-10", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-7",            display_name: "Claude Opus 4.7",       created_at: "2026-04-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-7-20250715",   display_name: "Claude Opus 4.7",       created_at: "2026-04-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4.7",            display_name: "Claude Opus 4.7",       created_at: "2026-04-15", provider: "anthropic", protocol: "anthropic" },

  // OpenAI / GPT
  { id: "gpt-4o",         display_name: "GPT-4o",          created_at: "2024-05-13", provider: "openai", protocol: "openai" },
  { id: "gpt-4o-mini",    display_name: "GPT-4o mini",     created_at: "2024-07-18", provider: "openai", protocol: "openai" },
  { id: "gpt-5",          display_name: "GPT-5",           created_at: "2025-08-07", provider: "openai", protocol: "openai" },
  { id: "gpt-5-mini",     display_name: "GPT-5 mini",      created_at: "2025-08-07", provider: "openai", protocol: "openai" },
  { id: "gpt-5.2",        display_name: "GPT-5.2",         created_at: "2025-11-05", provider: "openai", protocol: "openai" },
  { id: "gpt-5.2-codex",  display_name: "GPT-5.2 Codex",   created_at: "2025-11-05", provider: "openai", protocol: "openai" },
  { id: "gpt-5.3-codex",  display_name: "GPT-5.3 Codex",   created_at: "2026-01-20", provider: "openai", protocol: "openai" },
  { id: "gpt-5.4",        display_name: "GPT-5.4",         created_at: "2026-02-25", provider: "openai", protocol: "openai" },
  { id: "gpt-5.4-mini",   display_name: "GPT-5.4 mini",    created_at: "2026-02-25", provider: "openai", protocol: "openai" },
  { id: "gpt-5.5",        display_name: "GPT-5.5",         created_at: "2026-04-10", provider: "openai", protocol: "openai" },
  { id: "o1",             display_name: "o1",              created_at: "2024-12-17", provider: "openai", protocol: "openai" },
  { id: "o3-mini",        display_name: "o3-mini",         created_at: "2025-01-31", provider: "openai", protocol: "openai" },

  // Google / Gemini
  { id: "gemini-2.0-flash", display_name: "Gemini 2.0 Flash", created_at: "2025-02-05", provider: "google", protocol: "openai" },
  { id: "gemini-2.5-pro",   display_name: "Gemini 2.5 Pro",   created_at: "2025-03-25", provider: "google", protocol: "openai" },
];

/** Live model list (DB → fallback if DB empty/errors). */
export function getModelRegistry({ enabledOnly = true } = {}) {
  try {
    const rows = registry.listModels({ enabledOnly });
    if (rows.length > 0) return rows;
  } catch (e) {
    console.error("[models] DB read failed, using fallback:", e.message);
  }
  return MODEL_REGISTRY_FALLBACK;
}

export function getModelInfo(id) {
  if (!id) return null;
  try {
    const r = registry.getModelInfo(id);
    if (r) return r;
  } catch {}
  return MODEL_REGISTRY_FALLBACK.find(m => m.id === id) || null;
}

/** True if `id` is a Claude/Anthropic-protocol model (known or by name pattern). */
export function isClaudeModel(id) {
  if (!id) return false;
  try {
    const m = registry.getModelInfo(id);
    if (m) return m.protocol === "anthropic";
  } catch {}
  const f = MODEL_REGISTRY_FALLBACK.find(m => m.id === id);
  if (f) return f.protocol === "anthropic";
  return /^claude-/i.test(id);
}

export function isOpenAIProtocol(id) {
  if (!id) return false;
  try {
    const m = registry.getModelInfo(id);
    if (m) return m.protocol === "openai";
  } catch {}
  const f = MODEL_REGISTRY_FALLBACK.find(m => m.id === id);
  if (f) return f.protocol === "openai";
  return !/^claude-/i.test(id);
}

/** @deprecated kept for any external callers that imported the constant directly. */
export const MODEL_REGISTRY = MODEL_REGISTRY_FALLBACK;

/** Build a short request summary for the dashboard, mirroring /v1/messages style. */
export function summarizeChatRequest(parsed) {
  const msgCount = parsed.messages?.length || 0;
  const lastMsg = parsed.messages?.[msgCount - 1];
  let lastContent = "";
  if (typeof lastMsg?.content === "string") {
    lastContent = lastMsg.content;
  } else if (Array.isArray(lastMsg?.content)) {
    lastContent = lastMsg.content.map(p => p?.text || "").join("");
  }
  const preview = lastContent.slice(0, 80);
  const requestSummary = `model=${parsed.model} stream=${!!parsed.stream} msgs=${msgCount} max_tokens=${parsed.max_tokens || parsed.max_completion_tokens || "-"} tools=${parsed.tools?.length || 0}\n\nLast message (${lastMsg?.role}):\n${lastContent.slice(0, 500)}`;
  return { preview, requestSummary };
}

/** Extract usage from a non-streaming OpenAI response body (raw text).
 *  `input` is fresh-prompt tokens (cached tokens removed) so the cost layer can
 *  add cache_read separately. */
export function extractUsageNonStream(text) {
  try {
    const json = JSON.parse(text);
    const u = json.usage;
    if (!u) return null;
    const cached = (u.prompt_tokens_details && (u.prompt_tokens_details.cached_tokens ?? u.prompt_tokens_details.cache_read_tokens))
      ?? u.cached_tokens
      ?? u.cache_read_input_tokens
      ?? 0;
    const promptTotal = u.prompt_tokens || 0;
    return {
      input: Math.max(0, promptTotal - (cached || 0)),
      output: u.completion_tokens || 0,
      cache_read: cached || 0,
      cache_write: 0,
    };
  } catch { return null; }
}

/** Extract usage from an SSE chat.completion.chunk stream (raw text). */
export function extractUsageStream(text) {
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.usage) {
        const u = evt.usage;
        const cached = (u.prompt_tokens_details && (u.prompt_tokens_details.cached_tokens ?? u.prompt_tokens_details.cache_read_tokens))
          ?? u.cached_tokens
          ?? u.cache_read_input_tokens
          ?? 0;
        const promptTotal = u.prompt_tokens || 0;
        usage = {
          input: Math.max(0, promptTotal - (cached || 0)),
          output: u.completion_tokens || 0,
          cache_read: cached || 0,
          cache_write: 0,
        };
      }
    } catch {}
  }
  return usage;
}

// ─── Responses API (gpt-5.5, o-series) usage extractors ─────────────────────
// Responses API uses different shape: usage.input_tokens / usage.output_tokens
// (also tolerate prompt_tokens/completion_tokens for compatibility).
function readResponsesUsage(u) {
  if (!u) return null;
  const cached = (u.input_tokens_details && (u.input_tokens_details.cached_tokens ?? u.input_tokens_details.cache_read_tokens))
    ?? u.cached_tokens
    ?? u.cache_read_input_tokens
    ?? 0;
  const inputTotal = u.input_tokens ?? u.prompt_tokens ?? 0;
  return {
    input: Math.max(0, inputTotal - (cached || 0)),
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read: cached || 0,
    cache_write: 0,
  };
}

export function extractResponsesUsageNonStream(text) {
  try {
    const json = JSON.parse(text);
    return readResponsesUsage(json.usage) || (json.response && readResponsesUsage(json.response.usage)) || null;
  } catch { return null; }
}

// Responses streaming SSE emits typed events; the terminal one is
// `response.completed` whose data carries `response.usage`. Some intermediate
// events (response.in_progress/response.output_item.done) may also include
// usage — we keep the latest non-null reading.
export function extractResponsesUsageStream(text) {
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      const u = readResponsesUsage(evt.usage)
        || (evt.response && readResponsesUsage(evt.response.usage));
      if (u) usage = u;
    } catch {}
  }
  return usage;
}
