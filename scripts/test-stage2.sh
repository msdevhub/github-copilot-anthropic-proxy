#!/usr/bin/env bash
# Stage 2 test suite — runs against an isolated DB. Spawns server on a free port,
# exercises quota gating (free → balance → 402), admin API, and verifies that
# legacy unlimited keys still work.
#
# Exits non-zero on any failure. Cleans up the spawned server even on error.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=${PORT:-15920}
DB="$PWD/test-stage2.db"
PRICING="$PWD/pricing.json"
LOG="$PWD/test-stage2.log"

cleanup() {
  if [[ -n "${PID:-}" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -f "$DB" "$DB-wal" "$DB-shm"
}
trap cleanup EXIT

rm -f "$DB" "$DB-wal" "$DB-shm" "$LOG"

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }

# ── Stand up DB with seed data via Node ──────────────────────────────────────
echo "── seeding test DB ──────────────────────────────────────────────────────"
NODE_OPTIONS=--no-warnings node -e "
import('./lib/database.mjs').then(async () => {
  process.env.DB_PATH = '$DB';
  const { createKey } = await import('./lib/keys-v2.mjs');
  // We can't change DB_PATH retroactively (already imported), so reseed direct.
  process.exit(0);
});
" >/dev/null

# Easier: use an env var that database.mjs reads. database.mjs uses DB_PATH constant
# from utils.mjs — we override by symlinking. Instead spawn server with DB_PATH.
# Actually utils.mjs reads from disk path; simplest: spawn server with custom DB
# by setting env var and patching utils.mjs to honor it. We'll instead use the
# existing default DB_PATH (proxy-logs.db). Risky — test pollutes prod data.
# To avoid that, copy the existing DB aside.
:

# Use an actual override: utils.mjs hardcodes DB_PATH. Patch by symlink trick:
# move proxy-logs.db aside and let test create a fresh one, restore on exit.
ORIG_DB=proxy-logs.db
SAVED_DB=""
if [[ -f "$ORIG_DB" ]]; then
  SAVED_DB="$ORIG_DB.bak.$$"
  mv "$ORIG_DB" "$SAVED_DB"
  [[ -f "$ORIG_DB-wal" ]] && mv "$ORIG_DB-wal" "$SAVED_DB-wal" || true
  [[ -f "$ORIG_DB-shm" ]] && mv "$ORIG_DB-shm" "$SAVED_DB-shm" || true
fi

restore_db() {
  rm -f "$ORIG_DB" "$ORIG_DB-wal" "$ORIG_DB-shm"
  if [[ -n "$SAVED_DB" ]]; then
    mv "$SAVED_DB" "$ORIG_DB"
    [[ -f "$SAVED_DB-wal" ]] && mv "$SAVED_DB-wal" "$ORIG_DB-wal" || true
    [[ -f "$SAVED_DB-shm" ]] && mv "$SAVED_DB-shm" "$ORIG_DB-shm" || true
  fi
}
trap 'cleanup; restore_db' EXIT

# Create admin + a quota-limited key BEFORE starting the server so we know their raw keys.
ADMIN_KEY=$(node -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  const r = createKey({ name: 'test-admin', role: 'admin', unlimited: 1, free_quota: 0 });
  console.log(r.raw);
});
" 2>/dev/null)

QUOTA_KEY=$(node -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  const r = createKey({ name: 'test-quota', role: 'user', unlimited: 0, free_quota: 100, balance_tokens: 0 });
  console.log(r.raw);
});
" 2>/dev/null)

UNLIMITED_KEY=$(node -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  const r = createKey({ name: 'test-legacy', role: 'user', unlimited: 1, free_quota: 0 });
  console.log(r.raw);
});
" 2>/dev/null)

echo "  admin     = ${ADMIN_KEY:0:20}…"
echo "  quota-key = ${QUOTA_KEY:0:20}…"
echo "  unlimited = ${UNLIMITED_KEY:0:20}…"

# ── Spawn server. Skip outbound by mocking fetch via SERVER_TEST_MODE env. ───
# We don't want to hit GitHub Copilot upstream during tests, so we monkey-patch
# global fetch in a wrapper script that re-exports server.mjs after stubbing.
WRAPPER="$PWD/test-stage2-wrapper.mjs"
cat > "$WRAPPER" <<'EOF'
// Stub global fetch to avoid hitting Copilot upstream during tests.
// Returns canned Anthropic / OpenAI usage so the ledger can be verified.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/v1/messages')) {
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-opus-4-7',
      usage: { input_tokens: 5, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/chat/completions')) {
    return new Response(JSON.stringify({
      id: 'chat_test', object: 'chat.completion', model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.github.com/copilot_internal/v2/token')) {
    return new Response(JSON.stringify({ token: 'stub-token', endpoints: { api: 'https://stub.local' }, expires_at: Date.now() / 1000 + 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.github.com/user')) {
    return new Response(JSON.stringify({ login: 'stub' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

// Provide a stub GitHub token so the active-token resolver works.
process.env.COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN || 'stub-gh-token';

await import('./server.mjs');
EOF

PORT=$PORT node --no-warnings "$WRAPPER" >"$LOG" 2>&1 &
PID=$!

# Wait for server (max 5s)
for i in $(seq 1 50); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" | grep -q '^[23]'; then break; fi
  sleep 0.1
done

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "server failed to start. tail of log:"
  tail -50 "$LOG"
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
api() {
  local method="$1" url="$2" key="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "x-api-key: $key" -H "Content-Type: application/json" -d "$body" "http://127.0.0.1:$PORT$url"
  else
    curl -sS -X "$method" -H "x-api-key: $key" "http://127.0.0.1:$PORT$url"
  fi
}
status() {
  local method="$1" url="$2" key="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o /dev/null -w "%{http_code}" -X "$method" -H "x-api-key: $key" -H "Content-Type: application/json" -d "$body" "http://127.0.0.1:$PORT$url"
  else
    curl -sS -o /dev/null -w "%{http_code}" -X "$method" -H "x-api-key: $key" "http://127.0.0.1:$PORT$url"
  fi
}

REQ='{"model":"claude-opus-4-7","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
GPT_REQ='{"model":"gpt-4o-mini","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'

echo
echo "── 1. unauthenticated request → 401 ─────────────────────────────────────"
code=$(status POST /v1/messages "bogus-key" "$REQ")
[[ "$code" == "401" ]] && ok "rejected with 401" || bad "expected 401 got $code"

echo
echo "── 2. unlimited key works on /v1/messages ───────────────────────────────"
code=$(status POST /v1/messages "$UNLIMITED_KEY" "$REQ")
[[ "$code" == "200" ]] && ok "unlimited /v1/messages → 200" || bad "expected 200 got $code"

echo
echo "── 3. unlimited key works on /v1/chat/completions ───────────────────────"
code=$(status POST /v1/chat/completions "$UNLIMITED_KEY" "$GPT_REQ")
[[ "$code" == "200" ]] && ok "unlimited /v1/chat/completions → 200" || bad "expected 200 got $code"

echo
echo "── 4. quota key (free=100) — small request goes through ─────────────────"
# claude-opus-4-7: input_mult=1, output_mult=5. estimate ≈ ceil(<1 + 50*5) = 251.
# 251 > 100 → should be 402. To validate the "free works" path use gpt-4o-mini
# (output_mult=0.04) where estimate ≈ ceil(<1 + 50*0.04) = 2. Under 100.
code=$(status POST /v1/chat/completions "$QUOTA_KEY" "$GPT_REQ")
[[ "$code" == "200" ]] && ok "small gpt-4o-mini request under free quota → 200" || bad "expected 200 got $code"

echo
echo "── 5. quota key — over-budget claude request → 402 ──────────────────────"
code=$(status POST /v1/messages "$QUOTA_KEY" "$REQ")
[[ "$code" == "402" ]] && ok "claude-opus over free → 402" || bad "expected 402 got $code"

echo
echo "── 6. admin API: list keys ──────────────────────────────────────────────"
out=$(api GET /admin/keys "$ADMIN_KEY")
echo "$out" | grep -q "test-admin" && ok "admin can list keys" || bad "list missing admin entry: $out"

echo
echo "── 7. non-admin key cannot reach /admin ─────────────────────────────────"
code=$(status GET /admin/keys "$UNLIMITED_KEY")
[[ "$code" == "403" ]] && ok "non-admin → 403" || bad "expected 403 got $code"

echo
echo "── 8. admin topup → quota key can now make a bigger request ────────────"
QUOTA_HASH=$(node -e "import('./lib/keys-v2.mjs').then(({hashKey}) => console.log(hashKey('$QUOTA_KEY')))" 2>/dev/null)
api POST "/admin/keys/$QUOTA_HASH/topup" "$ADMIN_KEY" '{"tokens":1000}' >/dev/null
code=$(status POST /v1/messages "$QUOTA_KEY" "$REQ")
[[ "$code" == "200" ]] && ok "after topup, claude request → 200 (paid from balance)" || bad "expected 200 got $code"

echo
echo "── 9. ledger has rows for the quota key ─────────────────────────────────"
out=$(api GET "/admin/usage?key_hash=$QUOTA_HASH" "$ADMIN_KEY")
count=$(echo "$out" | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s); console.log(j.ledger.length)})")
[[ "$count" -ge 2 ]] && ok "ledger has $count entries" || bad "expected ≥2 ledger rows, got $count: $out"

echo
echo "── 10. reset-free zeroes free_used ──────────────────────────────────────"
api POST "/admin/keys/$QUOTA_HASH/reset-free" "$ADMIN_KEY" >/dev/null
out=$(api GET "/admin/keys/$QUOTA_HASH" "$ADMIN_KEY")
fu=$(echo "$out" | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s); console.log(j.key.free_used)})")
[[ "$fu" == "0" ]] && ok "free_used reset to 0" || bad "free_used=$fu after reset"

echo
echo "── 11. PATCH disable → key cannot make requests ─────────────────────────"
api PATCH "/admin/keys/$QUOTA_HASH" "$ADMIN_KEY" '{"status":"disabled"}' >/dev/null
code=$(status POST /v1/messages "$QUOTA_KEY" "$REQ")
[[ "$code" == "401" ]] && ok "disabled key → 401" || bad "expected 401 got $code"

echo
echo "── 12. pricing reload ───────────────────────────────────────────────────"
out=$(api POST /admin/pricing/reload "$ADMIN_KEY")
echo "$out" | grep -q '"_default"' && ok "pricing reloaded" || bad "reload returned: $out"

echo
echo "── 13. legacy JSON-file key still works (compat mode) ───────────────────"
LEGACY_KEY=$(node -e "
import('./lib/api-keys.mjs').then(({loadApiKeys}) => {
  const ks = loadApiKeys();
  console.log(ks[0]?.key || '');
});
" 2>/dev/null)
if [[ -n "$LEGACY_KEY" ]]; then
  code=$(status POST /v1/messages "$LEGACY_KEY" "$REQ")
  [[ "$code" == "200" ]] && ok "legacy JSON key → 200" || bad "legacy key expected 200 got $code"
else
  echo "  - no legacy keys configured, skipping"
fi

echo
echo "── results ──────────────────────────────────────────────────────────────"
echo "  passed: $pass"
echo "  failed: $fail"
rm -f "$WRAPPER"
[[ "$fail" == "0" ]]
