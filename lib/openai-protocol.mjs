// ─── OpenAI-compatible protocol helpers ──────────────────────────────────────
// Copilot's upstream exposes an OpenAI-shaped /chat/completions endpoint;
// we forward requests there as-is and only need light helpers around it.

// Model registry — list of models we advertise via /v1/models, with provider tag.
// `protocol` indicates which proxy entry handles the model natively:
//   - "anthropic" → POST /v1/messages
//   - "openai"    → POST /v1/chat/completions (OpenAI + Google models go here)
export const MODEL_REGISTRY = [
  // Anthropic / Claude (existing)
  { id: "claude-sonnet-4-20250514",   display_name: "Claude Sonnet 4",     created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-sonnet-4-6",          display_name: "Claude Sonnet 4.6",   created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-haiku-3-5-20241022",  display_name: "Claude 3.5 Haiku",    created_at: "2024-10-22", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-20250514",     display_name: "Claude Opus 4",       created_at: "2025-05-14", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-7-20250715",   display_name: "Claude Opus 4.7",     created_at: "2025-07-15", provider: "anthropic", protocol: "anthropic" },
  { id: "claude-opus-4-7",            display_name: "Claude Opus 4.7",     created_at: "2025-07-15", provider: "anthropic", protocol: "anthropic" },

  // OpenAI / GPT
  { id: "gpt-4o",        display_name: "GPT-4o",       created_at: "2024-05-13", provider: "openai", protocol: "openai" },
  { id: "gpt-4o-mini",   display_name: "GPT-4o mini",  created_at: "2024-07-18", provider: "openai", protocol: "openai" },
  { id: "gpt-5",         display_name: "GPT-5",        created_at: "2025-08-07", provider: "openai", protocol: "openai" },
  { id: "o1",            display_name: "o1",           created_at: "2024-12-17", provider: "openai", protocol: "openai" },
  { id: "o3-mini",       display_name: "o3-mini",      created_at: "2025-01-31", provider: "openai", protocol: "openai" },

  // Google / Gemini
  { id: "gemini-2.0-flash", display_name: "Gemini 2.0 Flash", created_at: "2025-02-05", provider: "google", protocol: "openai" },
  { id: "gemini-2.5-pro",   display_name: "Gemini 2.5 Pro",   created_at: "2025-03-25", provider: "google", protocol: "openai" },
];

const REGISTRY_BY_ID = new Map(MODEL_REGISTRY.map(m => [m.id, m]));

export function getModelInfo(id) {
  if (!id) return null;
  return REGISTRY_BY_ID.get(id) || null;
}

/** True if `id` is a Claude/Anthropic-protocol model (known or by name pattern). */
export function isClaudeModel(id) {
  if (!id) return false;
  const m = REGISTRY_BY_ID.get(id);
  if (m) return m.protocol === "anthropic";
  return /^claude-/i.test(id);
}

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

/** Extract usage from a non-streaming OpenAI response body (raw text). */
export function extractUsageNonStream(text) {
  try {
    const json = JSON.parse(text);
    const u = json.usage;
    if (!u) return null;
    return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
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
        usage = { input: evt.usage.prompt_tokens || 0, output: evt.usage.completion_tokens || 0 };
      }
    } catch {}
  }
  return usage;
}
