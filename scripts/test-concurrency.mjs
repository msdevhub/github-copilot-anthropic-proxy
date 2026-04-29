#!/usr/bin/env node
// 并发安全测试：覆盖 review #1 (chargeUsage 并发刷穿) 和 #2 (webhook 重放双发)。
// Usage: node scripts/test-concurrency.mjs

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const SECRET = "concurr-secret-" + randomBytes(8).toString("hex");
const APP_NAME = "copilot-proxy";

// ─── Mock wx-gateway (only needs pay/create) ────────────────────────────────
const mockOrders = new Map();
const MOCK_PORT = 50000 + Math.floor(Math.random() * 5000);
function readBody(req) {
  return new Promise(r => { const c = []; req.on("data", b => c.push(b)); req.on("end", () => r(Buffer.concat(c).toString())); });
}
function verifyAppSig(req, payload) {
  const sig = req.headers["x-wx-sig"]; if (!sig) return false;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");
  try { const a = Buffer.from(expected, "hex"), b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
const mockGw = createServer(async (req, res) => {
  const body = await readBody(req);
  const ts = req.headers["x-wx-ts"]; const appName = req.headers["x-wx-app-name"];
  if (req.url === "/pay/create" && req.method === "POST") {
    const parsed = JSON.parse(body);
    const payload = `${appName}|${parsed.orderId}|${parsed.amount_fen}|${ts}`;
    if (!verifyAppSig(req, payload)) { res.writeHead(403); res.end(); return; }
    const payOrderId = "pay_" + randomBytes(8).toString("hex");
    const expiresAt = new Date(Date.now() + 1800_000).toISOString();
    mockOrders.set(payOrderId, { ...parsed, payOrderId, status: "pending" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payOrderId, qrcodeUrl: `http://mock/${payOrderId}.png`, remark: "K" + randomBytes(2).toString("hex"), amount_fen: parsed.amount_fen, expiresAt, status: "pending" }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => mockGw.listen(MOCK_PORT, r));

// ─── Spawn proxy ────────────────────────────────────────────────────────────
const DB_PATH = join(tmpdir(), `proxy-test-concurrency-${Date.now()}.db`);
for (const s of ["", "-shm", "-wal"]) { if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s); }
// Set BEFORE any import of lib/database.mjs so the lib opens this DB.
process.env.DB_PATH = DB_PATH;
const PORT = String(50000 + 5000 + Math.floor(Math.random() * 5000));
const env = {
  ...process.env, PORT, DB_PATH,
  WX_GATEWAY_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  WX_GATEWAY_APP_NAME: APP_NAME,
  WX_GATEWAY_SECRET: SECRET,
  WX_SIGNUP_IP_LIMIT: "999",
  TRUST_PROXY: "true",
};
const proc = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = "";
proc.stdout.on("data", d => { serverOut += d.toString(); });
proc.stderr.on("data", d => { serverOut += d.toString(); });
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("server not ready:\n" + serverOut);
}
function webhookSig(event, payOrderId, status, ts) {
  return createHmac("sha256", SECRET).update(`${event}|${payOrderId}|${status}|${ts}`).digest("hex");
}
function sigFinalize(token, openid, ts) {
  return createHmac("sha256", SECRET).update(`${token}|${openid}||${ts}`).digest("hex");
}

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${extra}`); failed++; }
}

try {
  await waitReady();

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1 — chargeUsage concurrent: feed a stale `row` snapshot into 100
  // parallel chargeUsage() calls. With WHERE-guards + txn re-fetch,
  // free_used must never exceed free_quota and overdraft falls to balance.
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[1] concurrent chargeUsage — should not breach free_quota");
  const { db } = await import(`${process.cwd()}/lib/database.mjs`);
  const { createKey, getKeyByHash, chargeUsage, hashKey } = await import(`${process.cwd()}/lib/keys-v2.mjs`);

  // Note: this test imports the lib using a SEPARATE DB connection from the
  // spawned server. To avoid two-connection lock contention we close the spawned
  // server before running the in-process portion.
  proc.kill("SIGTERM"); await sleep(300);

  // Re-open: since the spawned proc had DB locked under WAL, after kill we use
  // its DB file directly (already initialized). Lib uses DB_PATH from env.
  process.env.DB_PATH = DB_PATH;
  // Re-import to pick up env (modules cached — workaround: use direct DatabaseSync for setup)
  const sdb = new DatabaseSync(DB_PATH);
  // Insert a fresh test key
  const raw = "sk-proxy-conc-" + randomBytes(8).toString("hex");
  const h = hashKey(raw);
  sdb.prepare(`INSERT INTO api_keys_v2 (key_hash, key_prefix, name, role, balance_tokens, free_quota, free_used, free_reset_at, unlimited, allowed_models, status, token_name, created_at, note, source, invite_code, wx_openid, paid_quota) VALUES (?, ?, ?, 'user', 0, 5000, 0, NULL, 0, NULL, 'active', NULL, ?, NULL, 'test', NULL, NULL, 0)`)
    .run(h, raw.slice(0, 12), "concurrency-test", new Date().toISOString());
  sdb.close();

  // Fresh stale snapshot — every call sees free_used=0
  const stale = getKeyByHash(h);
  check("setup: stale row has free_used=0 free_quota=5000", stale && stale.free_used === 0 && stale.free_quota === 5000, JSON.stringify(stale));

  const N = 100, COST_TOKENS_EACH = 100; // total 10000, but free_quota only 5000
  const promises = [];
  for (let i = 0; i < N; i++) {
    // Pass a fresh shallow copy of stale to mimic each request capturing its own snapshot
    promises.push(Promise.resolve().then(() => chargeUsage({ row: { ...stale }, model: "test-model-cheap", inputTokens: 10, outputTokens: 10, logId: null })));
  }
  await Promise.all(promises);

  const finalRow = getKeyByHash(h);
  check("free_used <= free_quota (no breach)", finalRow.free_used <= finalRow.free_quota, `free_used=${finalRow.free_used} free_quota=${finalRow.free_quota}`);
  check("free_used == free_quota (5000) — fully drained", finalRow.free_used === 5000, `got ${finalRow.free_used}`);

  // Each charge cost ≈ 100 (depends on pricing). 100 calls × 100 = 10000 total, free=5000, balance overdrafted by remainder.
  // Ledger should have N rows.
  const dbq = new DatabaseSync(DB_PATH);
  const ledgerCount = dbq.prepare("SELECT COUNT(*) AS c FROM usage_ledger WHERE key_hash = ?").get(h).c;
  check(`ledger has all ${N} rows`, ledgerCount === N, `got ${ledgerCount}`);
  const sumCost = dbq.prepare("SELECT COALESCE(SUM(cost_tokens),0) AS s FROM usage_ledger WHERE key_hash = ?").get(h).s;
  // free + |negative balance| should equal sumCost
  const accounted = finalRow.free_used + Math.max(0, -finalRow.balance_tokens);
  check("accounting balances: free_used + |overdraft| == sum(cost_tokens)", accounted === sumCost, `free=${finalRow.free_used} bal=${finalRow.balance_tokens} sum=${sumCost}`);
  dbq.close();

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2 — webhook replay: 50 concurrent identical paid webhooks must
  // grant paid_quota only ONCE.
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[2] concurrent paid webhooks — exactly one grant");
  // Re-spawn server because the in-process import locked DB above
  const proc2 = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out2 = ""; proc2.stdout.on("data", d => { out2 += d.toString(); }); proc2.stderr.on("data", d => { out2 += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch {}
    await sleep(100);
  }

  // Create a wx_signup key + payment via finalize+pay/create
  const oid = "oConc" + Math.floor(Math.random() * 1e9);
  const tok = "tok_" + randomBytes(4).toString("hex"); const ts = String(Date.now());
  const sig = sigFinalize(tok, oid, ts);
  const fr = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=${tok}&openid=${oid}&unionid=&ts=${ts}&sig=${sig}`, { redirect: "manual", headers: { "x-forwarded-for": "9.0.0.1" } });
  const cookie = fr.headers.get("set-cookie").split(";")[0];
  const cr = await fetch(`http://127.0.0.1:${PORT}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ package: "990" }) });
  const created = await cr.json();
  check("payment created", cr.status === 200 && created.payOrderId, JSON.stringify(created));

  // Fire 50 identical paid webhooks in parallel
  const ts2 = String(Date.now());
  const wsig = webhookSig("payment.paid", created.payOrderId, "paid", ts2);
  const hooks = [];
  for (let i = 0; i < 50; i++) {
    hooks.push(fetch(`http://127.0.0.1:${PORT}/api/wx/payment-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WX-Webhook-Sig": wsig, "X-WX-Webhook-Ts": ts2 },
      body: JSON.stringify({ event: "payment.paid", payOrderId: created.payOrderId, status: "paid", externalRef: "wx-conc-1", paidAt: new Date().toISOString() }),
    }));
  }
  const results = await Promise.all(hooks);
  check("all 50 webhooks → 200", results.every(r => r.status === 200), results.map(r => r.status).join(","));

  const me = await (await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie } })).json();
  check("paid_quota granted exactly once = 500_000", me.paid_quota === 500_000, `got ${me.paid_quota}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — terminal-state protection: paid → expired/disputed must be refused
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[3] terminal-state: paid → expired/disputed refused");
  for (const flip of ["expired", "disputed"]) {
    const tsx = String(Date.now());
    const sigx = webhookSig(`payment.${flip}`, created.payOrderId, flip, tsx);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/wx/payment-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WX-Webhook-Sig": sigx, "X-WX-Webhook-Ts": tsx },
      body: JSON.stringify({ event: `payment.${flip}`, payOrderId: created.payOrderId, status: flip }),
    });
    check(`${flip} after paid → 200 (refused, no flip)`, r.status === 200);
  }
  const dbf = new DatabaseSync(DB_PATH);
  const finalPayment = dbf.prepare("SELECT status FROM payments WHERE payOrderId = ?").get(created.payOrderId);
  check("payment.status remains 'paid' after flip attempts", finalPayment.status === "paid", JSON.stringify(finalPayment));
  const alerts = dbf.prepare("SELECT COUNT(*) AS c FROM risk_alerts WHERE type = 'paid_status_flip_attempt'").get().c;
  check("risk_alerts logged the flip attempts", alerts >= 1, `count=${alerts}`);
  dbf.close();

  proc2.kill("SIGTERM"); await sleep(200);

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — paid arriving long after expiry must NOT grant
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[4] paid after expiry+grace — quota NOT granted");
  const proc3 = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc3.stdout.on("data", () => {}); proc3.stderr.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch {}
    await sleep(100);
  }
  const oid4 = "oExp" + Math.floor(Math.random() * 1e9);
  const tok4 = "tok_" + randomBytes(4).toString("hex"); const ts4 = String(Date.now());
  const sig4 = sigFinalize(tok4, oid4, ts4);
  const fr4 = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=${tok4}&openid=${oid4}&unionid=&ts=${ts4}&sig=${sig4}`, { redirect: "manual", headers: { "x-forwarded-for": "9.0.0.2" } });
  const cookie4 = fr4.headers.get("set-cookie").split(";")[0];
  const cr4 = await fetch(`http://127.0.0.1:${PORT}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json", cookie: cookie4 }, body: JSON.stringify({ package: "990" }) });
  const c4 = await cr4.json();

  // Force expires_at far in the past
  const dbe = new DatabaseSync(DB_PATH);
  dbe.prepare(`UPDATE payments SET expires_at = ? WHERE payOrderId = ?`).run(Date.now() - 10 * 60_000, c4.payOrderId);
  dbe.close();

  const tsP = String(Date.now()); const sigP = webhookSig("payment.paid", c4.payOrderId, "paid", tsP);
  const rP = await fetch(`http://127.0.0.1:${PORT}/api/wx/payment-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WX-Webhook-Sig": sigP, "X-WX-Webhook-Ts": tsP },
    body: JSON.stringify({ event: "payment.paid", payOrderId: c4.payOrderId, status: "paid" }),
  });
  check("late paid webhook → 200", rP.status === 200);
  const me4 = await (await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie: cookie4 } })).json();
  check("paid_quota NOT granted after expiry+grace", (me4.paid_quota || 0) === 0, `got ${me4.paid_quota}`);
  proc3.kill("SIGTERM"); await sleep(200);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll concurrency/replay checks passed");
} finally {
  try { proc.kill("SIGKILL"); } catch {}
  mockGw.close();
  for (const s of ["", "-shm", "-wal"]) { const p = DB_PATH + s; if (existsSync(p)) try { rmSync(p); } catch {} }
}
