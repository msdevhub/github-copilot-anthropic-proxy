#!/usr/bin/env bash
# Stage 4 test suite — admin overview, pricing CRUD, audit log.
# Spawns server with stubbed upstream + isolated DB. Cleans up on exit.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=${PORT:-15922}
LOG="$PWD/test-stage4.log"
ORIG_DB=proxy-logs.db
ORIG_PRICING=pricing.json
SAVED_DB=""
SAVED_PRICING=""

if [[ -f "$ORIG_DB" ]]; then
  SAVED_DB="$ORIG_DB.bak.$$"
  mv "$ORIG_DB" "$SAVED_DB"
  [[ -f "$ORIG_DB-wal" ]] && mv "$ORIG_DB-wal" "$SAVED_DB-wal" || true
  [[ -f "$ORIG_DB-shm" ]] && mv "$ORIG_DB-shm" "$SAVED_DB-shm" || true
fi
if [[ -f "$ORIG_PRICING" ]]; then
  SAVED_PRICING="$ORIG_PRICING.bak.$$"
  cp "$ORIG_PRICING" "$SAVED_PRICING"
fi

# Fresh tiny pricing.json for test
cat > "$ORIG_PRICING" <<'JSON'
{
  "_default": { "input_multiplier": 1.0, "output_multiplier": 5.0 },
  "claude-opus-4-7": { "input_multiplier": 2.0, "output_multiplier": 10.0 }
}
JSON

cleanup() {
  if [[ -n "${PID:-}" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -f "$ORIG_DB" "$ORIG_DB-wal" "$ORIG_DB-shm"
  if [[ -n "$SAVED_DB" ]]; then
    mv "$SAVED_DB" "$ORIG_DB"
    [[ -f "$SAVED_DB-wal" ]] && mv "$SAVED_DB-wal" "$ORIG_DB-wal" || true
    [[ -f "$SAVED_DB-shm" ]] && mv "$SAVED_DB-shm" "$ORIG_DB-shm" || true
  fi
  if [[ -n "$SAVED_PRICING" ]]; then mv "$SAVED_PRICING" "$ORIG_PRICING"; else rm -f "$ORIG_PRICING"; fi
  rm -f "$WRAPPER"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }

# Create admin + user keys
ADMIN1=$(node --no-warnings -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  console.log(createKey({ name: 'stage4-admin-a', role: 'admin', unlimited: 1, free_quota: 0 }).raw);
});" 2>/dev/null)
ADMIN2=$(node --no-warnings -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  console.log(createKey({ name: 'stage4-admin-b', role: 'admin', unlimited: 1, free_quota: 0 }).raw);
});" 2>/dev/null)
USER1=$(node --no-warnings -e "
import('./lib/keys-v2.mjs').then(({createKey}) => {
  console.log(createKey({ name: 'stage4-user', role: 'user', unlimited: 0, free_quota: 500, balance_tokens: 1000 }).raw);
});" 2>/dev/null)

U_HASH=$(node --no-warnings -e "import('./lib/keys-v2.mjs').then(({hashKey})=>console.log(hashKey('$USER1')))" 2>/dev/null)
A2_HASH=$(node --no-warnings -e "import('./lib/keys-v2.mjs').then(({hashKey})=>console.log(hashKey('$ADMIN2')))" 2>/dev/null)

# Seed some ledger rows
node --no-warnings -e "
import('./lib/database.mjs').then(({db, addLog}) => {
  const h = '$U_HASH';
  for (let i=0;i<4;i++) {
    const id = addLog({ status:200, model:'claude-opus-4-7', stream:false, usage:{input:10,output:20}, preview:'x', requestSummary:'r', durationMs:120, apiKeyName:'stage4-user', keyHash:h });
    db.prepare('INSERT INTO usage_ledger(ts,key_hash,model,input_tokens,output_tokens,cost_tokens,source,log_id) VALUES (?,?,?,?,?,?,?,?)').run(new Date().toISOString().replace('T',' ').slice(0,23), h, 'claude-opus-4-7', 10, 20, 220, 'balance', id);
  }
  for (let i=0;i<2;i++) {
    const id = addLog({ status:200, model:'gpt-4o-mini', stream:false, usage:{input:5,output:5}, preview:'y', requestSummary:'r', durationMs:90, apiKeyName:'stage4-user', keyHash:h });
    db.prepare('INSERT INTO usage_ledger(ts,key_hash,model,input_tokens,output_tokens,cost_tokens,source,log_id) VALUES (?,?,?,?,?,?,?,?)').run(new Date().toISOString().replace('T',' ').slice(0,23), h, 'gpt-4o-mini', 5, 5, 30, 'free', id);
  }
}).catch(e=>{console.error(e);process.exit(1);});
" >/dev/null

# Server wrapper with stubbed upstream
WRAPPER="$PWD/test-stage4-wrapper.mjs"
cat > "$WRAPPER" <<'WRAP'
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.github.com/copilot_internal/v2/token')) {
    return new Response(JSON.stringify({ token: 'stub', endpoints: { api: 'https://stub.local' }, expires_at: Date.now()/1000+3600 }), { status:200, headers:{'content-type':'application/json'} });
  }
  if (u.includes('api.github.com/user')) return new Response(JSON.stringify({login:'stub'}), {status:200,headers:{'content-type':'application/json'}});
  return realFetch(url, init);
};
process.env.COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN || 'stub';
await import('./server.mjs');
WRAP

PORT=$PORT node --no-warnings "$WRAPPER" >"$LOG" 2>&1 &
PID=$!

for i in $(seq 1 50); do
  if curl -sS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then break; fi
  sleep 0.1
done
if ! curl -sS -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "server failed to start. tail of log:"; tail -50 "$LOG"; exit 1
fi

BASE="http://127.0.0.1:$PORT"
H_ADMIN1=(-H "x-api-key: $ADMIN1")
H_ADMIN2=(-H "x-api-key: $ADMIN2")

echo
echo "── 1. /admin/overview returns {byKey,byModel,daily,totals} ──────────────"
out=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/overview")
for k in byKey byModel daily totals; do
  echo "$out" | grep -q "\"$k\"" && ok "has .$k" || bad "missing .$k in: $out"
done
totalReq=$(echo "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).totals.requests)})")
[[ "$totalReq" == "6" ]] && ok "totals.requests = 6" || bad "expected 6, got $totalReq"

echo
echo "── 2. /admin/pricing GET lists _default + claude-opus-4-7 ───────────────"
pr=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/pricing")
echo "$pr" | grep -q '"_default"' && ok "has _default" || bad "missing _default"
echo "$pr" | grep -q 'claude-opus-4-7' && ok "has claude-opus-4-7" || bad "missing claude-opus-4-7"

echo
echo "── 3. PATCH /admin/pricing/:model updates multiplier (takes effect) ─────"
out=$(curl -sS "${H_ADMIN1[@]}" -H 'Content-Type: application/json' -d '{"input_multiplier":3,"output_multiplier":15}' -X PATCH "$BASE/admin/pricing/claude-opus-4-7")
echo "$out" | grep -q '"ok":true' && ok "PATCH ok" || bad "patch: $out"
# Verify in memory (computeCost via /admin/pricing GET should show new rates)
pr2=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/pricing")
echo "$pr2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).pricing['claude-opus-4-7'];process.exit(p.input_multiplier===3&&p.output_multiplier===15?0:1)})" \
  && ok "new rates stored (in=3, out=15)" || bad "rates not updated: $pr2"

echo
echo "── 4. POST /admin/pricing creates new model entry ───────────────────────"
out=$(curl -sS "${H_ADMIN1[@]}" -H 'Content-Type: application/json' -d '{"model":"test-model-x","input_multiplier":0.5,"output_multiplier":2}' -X POST "$BASE/admin/pricing")
echo "$out" | grep -q '"ok":true' && ok "create ok" || bad "create: $out"
curl -sS "${H_ADMIN1[@]}" "$BASE/admin/pricing" | grep -q 'test-model-x' && ok "test-model-x in listing" || bad "new model not listed"

echo
echo "── 5. DELETE /admin/pricing/:model removes entry, not _default ──────────"
code=$(curl -sS "${H_ADMIN1[@]}" -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/pricing/test-model-x")
[[ "$code" == "200" ]] && ok "delete test-model-x → 200" || bad "expected 200 got $code"
code2=$(curl -sS "${H_ADMIN1[@]}" -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/pricing/_default")
[[ "$code2" == "400" || "$code2" == "403" ]] && ok "delete _default rejected ($code2)" || bad "expected 400/403 got $code2"

echo
echo "── 6. /admin/audit records every write; cross-admin topup visible ───────"
# admin1 tops up user key via admin2's account (different admin identity)
curl -sS "${H_ADMIN2[@]}" -H 'Content-Type: application/json' -d '{"tokens":500}' -X POST "$BASE/admin/keys/$U_HASH/topup" >/dev/null
audit=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/audit?limit=50")
echo "$audit" | grep -q '"action":"pricing.update"' && ok "audit has pricing.update" || bad "missing pricing.update: $audit"
echo "$audit" | grep -q '"action":"pricing.create"' && ok "audit has pricing.create" || bad "missing pricing.create"
echo "$audit" | grep -q '"action":"pricing.delete"' && ok "audit has pricing.delete" || bad "missing pricing.delete"
echo "$audit" | grep -q '"action":"key.topup"' && ok "audit has key.topup" || bad "missing key.topup"
echo "$audit" | grep -q '"admin_name":"stage4-admin-b"' && ok "audit records admin-b identity" || bad "missing admin-b in audit"

echo
echo "── 7. GET /admin/keys/:hash/ledger returns per-key ledger ───────────────"
led=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/keys/$U_HASH/ledger?limit=10")
n=$(echo "$led" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).ledger.length)})")
[[ "$n" -ge 6 ]] && ok "ledger has ≥6 rows (got $n)" || bad "expected ≥6 got $n"

echo
echo "── 8. non-admin key cannot access /admin/overview ───────────────────────"
code=$(curl -sS -o /dev/null -w "%{http_code}" -H "x-api-key: $USER1" "$BASE/admin/overview")
[[ "$code" == "401" || "$code" == "403" ]] && ok "user key blocked ($code)" || bad "expected 401/403 got $code"

echo
echo "── 9. invalid pricing payload rejected ──────────────────────────────────"
code=$(curl -sS "${H_ADMIN1[@]}" -o /dev/null -w "%{http_code}" -H 'Content-Type: application/json' -d '{"input_multiplier":-1,"output_multiplier":5}' -X PATCH "$BASE/admin/pricing/foo")
[[ "$code" == "400" ]] && ok "negative multiplier → 400" || bad "expected 400 got $code"

echo
echo "── 10. /admin/pricing/reload re-reads file and audits ───────────────────"
out=$(curl -sS "${H_ADMIN1[@]}" -X POST "$BASE/admin/pricing/reload")
echo "$out" | grep -q '"pricing"' && ok "reload returns pricing" || bad "reload: $out"
audit2=$(curl -sS "${H_ADMIN1[@]}" "$BASE/admin/audit?limit=10")
echo "$audit2" | grep -q '"action":"pricing.reload"' && ok "audit has pricing.reload" || bad "missing pricing.reload"

echo
echo "── results ──────────────────────────────────────────────────────────────"
echo "  passed: $pass"
echo "  failed: $fail"
[[ "$fail" == "0" ]]
