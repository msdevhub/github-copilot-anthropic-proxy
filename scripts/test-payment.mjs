#!/usr/bin/env node
// End-to-end test for /api/pay/* and /api/wx/payment-webhook.
// Spawns a mock wx-gateway on localhost and points the proxy at it.
//
// Usage:  node scripts/test-payment.mjs

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const SECRET = "test-secret-" + randomBytes(8).toString("hex");
const APP_NAME = "copilot-proxy";

// ─── Mock wx-gateway ────────────────────────────────────────────────────────
const mockOrders = new Map();
const MOCK_PORT = 40000 + Math.floor(Math.random() * 5000);

function readBody(req) {
  return new Promise((resolve) => {
    const c = []; req.on("data", b => c.push(b)); req.on("end", () => resolve(Buffer.concat(c).toString()));
  });
}
function verifyAppSig(req, payload) {
  const sig = req.headers["x-wx-sig"]; const ts = req.headers["x-wx-ts"];
  if (!sig || !ts || !req.headers["x-wx-app-name"]) return false;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");
  try {
    const a = Buffer.from(expected, "hex"); const b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

const mockGw = createServer(async (req, res) => {
  const body = await readBody(req);
  const ts = req.headers["x-wx-ts"];
  const appName = req.headers["x-wx-app-name"];
  if (req.url === "/pay/create" && req.method === "POST") {
    const parsed = JSON.parse(body);
    const payload = `${appName}|${parsed.orderId}|${parsed.amount_fen}|${ts}`;
    if (!verifyAppSig(req, payload)) { res.writeHead(403); res.end(JSON.stringify({ error: "bad_sig" })); return; }
    const payOrderId = "pay_" + randomBytes(8).toString("hex");
    const remark = "K" + randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
    const expiresAt = new Date(Date.now() + (parsed.expiresIn || 1800) * 1000).toISOString();
    mockOrders.set(payOrderId, { ...parsed, payOrderId, remark, status: "pending", expiresAt });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      payOrderId, qrcodeUrl: `http://mock/qr/${payOrderId}.png`,
      remark, amount_fen: parsed.amount_fen, expiresAt, status: "pending",
    }));
    return;
  }
  if (req.url === "/pay/personal/claim" && req.method === "POST") {
    const { payOrderId } = JSON.parse(body);
    const payload = `${appName}|${payOrderId}|${ts}`;
    if (!verifyAppSig(req, payload)) { res.writeHead(403); res.end("bad_sig"); return; }
    const o = mockOrders.get(payOrderId);
    if (!o) { res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return; }
    o.status = "submitted";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payOrderId, status: "submitted" }));
    return;
  }
  if (req.url.startsWith("/pay/status/") && req.method === "GET") {
    const id = req.url.slice("/pay/status/".length);
    const o = mockOrders.get(id);
    if (!o) { res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payOrderId: id, status: o.status, amount_fen: o.amount_fen, remark: o.remark, orderId: o.orderId }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => mockGw.listen(MOCK_PORT, r));

// ─── Spawn proxy server ─────────────────────────────────────────────────────
const DB_PATH = join(tmpdir(), `proxy-test-pay-${Date.now()}.db`);
for (const s of ["", "-shm", "-wal"]) { if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s); }

const PROXY_PORT = String(40000 + 5000 + Math.floor(Math.random() * 5000));
const env = {
  ...process.env,
  PORT: PROXY_PORT,
  DB_PATH,
  WX_GATEWAY_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  WX_GATEWAY_APP_NAME: APP_NAME,
  WX_GATEWAY_SECRET: SECRET,
  WX_SIGNUP_IP_LIMIT: "20",
  TRUST_PROXY: "true",
};

const proc = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = "";
proc.stdout.on("data", d => { serverOut += d.toString(); });
proc.stderr.on("data", d => { serverOut += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("server not ready:\n" + serverOut);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function sigFinalize(token, openid, unionid, ts) {
  return createHmac("sha256", SECRET).update(`${token}|${openid}|${unionid}|${ts}`).digest("hex");
}
async function makeUserSession(openid, ip = "1.1.1.1") {
  const token = "tok_" + randomBytes(4).toString("hex");
  const ts = String(Date.now());
  const sig = sigFinalize(token, openid, "", ts);
  const r = await fetch(
    `http://127.0.0.1:${PROXY_PORT}/api/wx/finalize?token=${token}&openid=${openid}&unionid=&ts=${ts}&sig=${sig}`,
    { redirect: "manual", headers: { "x-forwarded-for": ip } },
  );
  const setCookie = r.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : null;
}
function webhookSig(event, payOrderId, status, ts) {
  return createHmac("sha256", SECRET).update(`${event}|${payOrderId}|${status}|${ts}`).digest("hex");
}
async function postWebhook({ event, payOrderId, status, externalRef = null, rejectReason = null, paidAt = null, ts = String(Date.now()), sig = null }) {
  const finalSig = sig || webhookSig(event, payOrderId, status, ts);
  return fetch(`http://127.0.0.1:${PROXY_PORT}/api/wx/payment-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WX-Webhook-Sig": finalSig, "X-WX-Webhook-Ts": ts },
    body: JSON.stringify({ event, payOrderId, status, amount_fen: 990, externalRef, rejectReason, paidAt }),
  });
}

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${extra}`); failed++; }
}

try {
  await waitReady();

  // ─ User A: scan login + start ¥9.9 payment ─
  const oidA = "oPayA" + Math.floor(Math.random() * 1e9);
  const cookieA = await makeUserSession(oidA, "10.0.0.1");
  check("got user_session for A", !!cookieA, cookieA);

  // 1) /pay/create lands db row + returns qrcodeUrl
  let r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieA },
    body: JSON.stringify({ package: "990" }),
  });
  let create = await r.json();
  check("create 200", r.status === 200, JSON.stringify(create));
  check("create.payOrderId", typeof create.payOrderId === "string" && create.payOrderId.startsWith("pay_"), create.payOrderId);
  check("create.qrcodeUrl present", typeof create.qrcodeUrl === "string" && create.qrcodeUrl.length > 0);
  check("create.remark present", typeof create.remark === "string" && create.remark.length > 0);
  check("create.amount_fen=990", create.amount_fen === 990);
  const payIdA = create.payOrderId;

  // db check
  const tdb = new DatabaseSync(DB_PATH);
  const row = tdb.prepare("SELECT * FROM payments WHERE payOrderId = ?").get(payIdA);
  check("db row exists pending", row && row.status === "pending", JSON.stringify(row));
  check("db row tokens_to_grant=500000", row && row.tokens_to_grant === 500_000);

  // 2) bad-package rejected
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/create`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieA },
    body: JSON.stringify({ package: "1234" }),
  });
  check("invalid package → 400", r.status === 400);

  // 3) /pay/claim flips submitted
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/claim`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieA },
    body: JSON.stringify({ payOrderId: payIdA }),
  });
  let claim = await r.json();
  check("claim 200", r.status === 200, JSON.stringify(claim));
  check("claim.status=submitted", claim.status === "submitted");
  const submitted = tdb.prepare("SELECT status FROM payments WHERE payOrderId = ?").get(payIdA);
  check("db row now submitted", submitted.status === "submitted");

  // 4) Webhook: bad signature → 403
  r = await postWebhook({ event: "payment.paid", payOrderId: payIdA, status: "paid", sig: "00".repeat(32) });
  check("bad sig webhook → 403", r.status === 403);

  // 5) Webhook: stale timestamp → 403
  const staleTs = String(Date.now() - 10 * 60 * 1000);
  r = await postWebhook({ event: "payment.paid", payOrderId: payIdA, status: "paid", ts: staleTs });
  check("stale ts webhook → 403", r.status === 403);

  // 6) Webhook paid → grant paid_quota
  const meBefore = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/user/me`, { headers: { cookie: cookieA } })).json();
  check("me.paid_quota starts 0", (meBefore.paid_quota || 0) === 0);
  r = await postWebhook({ event: "payment.paid", payOrderId: payIdA, status: "paid", externalRef: "wxpay_ref_001", paidAt: new Date().toISOString() });
  check("paid webhook → 200", r.status === 200);
  const meAfter = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/user/me`, { headers: { cookie: cookieA } })).json();
  check("me.paid_quota = 500000", meAfter.paid_quota === 500_000, `got ${meAfter.paid_quota}`);
  const paidRow = tdb.prepare("SELECT * FROM payments WHERE payOrderId = ?").get(payIdA);
  check("payment.status=paid", paidRow.status === "paid");
  check("payment.external_ref recorded", paidRow.external_ref === "wxpay_ref_001");
  check("payment.webhook_processed_at set", paidRow.webhook_processed_at != null);

  // 7) Webhook idempotency: re-deliver same paid event → no double-grant
  r = await postWebhook({ event: "payment.paid", payOrderId: payIdA, status: "paid", externalRef: "wxpay_ref_001", paidAt: new Date().toISOString() });
  check("idempotent webhook → 200", r.status === 200);
  const meAgain = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/user/me`, { headers: { cookie: cookieA } })).json();
  check("paid_quota still 500000 (no double-grant)", meAgain.paid_quota === 500_000, `got ${meAgain.paid_quota}`);

  // ─ User B: ¥29 disputed flow ─
  const oidB = "oPayB" + Math.floor(Math.random() * 1e9);
  const cookieB = await makeUserSession(oidB, "10.0.0.2");
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/create`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieB },
    body: JSON.stringify({ package: "2900" }),
  });
  const createB = await r.json();
  const payIdB = createB.payOrderId;
  check("B create 200, 2900", r.status === 200 && createB.amount_fen === 2900);

  r = await postWebhook({ event: "payment.disputed", payOrderId: payIdB, status: "disputed", rejectReason: "wrong remark code" });
  check("disputed webhook → 200", r.status === 200);
  const meB = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/user/me`, { headers: { cookie: cookieB } })).json();
  check("disputed → no paid_quota change for B", (meB.paid_quota || 0) === 0, `got ${meB.paid_quota}`);
  const rowB = tdb.prepare("SELECT * FROM payments WHERE payOrderId = ?").get(payIdB);
  check("B payment.status=disputed", rowB.status === "disputed");
  check("B reject_reason recorded", rowB.reject_reason === "wrong remark code");

  // ─ User C: expired ─
  const oidC = "oPayC" + Math.floor(Math.random() * 1e9);
  const cookieC = await makeUserSession(oidC, "10.0.0.3");
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/create`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieC },
    body: JSON.stringify({ package: "990" }),
  });
  const createC = await r.json();
  const payIdC = createC.payOrderId;

  r = await postWebhook({ event: "payment.expired", payOrderId: payIdC, status: "expired" });
  check("expired webhook → 200", r.status === 200);
  const meC = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/user/me`, { headers: { cookie: cookieC } })).json();
  check("expired → no paid_quota change for C", (meC.paid_quota || 0) === 0);
  const rowC = tdb.prepare("SELECT status FROM payments WHERE payOrderId = ?").get(payIdC);
  check("C payment.status=expired", rowC.status === "expired");

  // ─ Authz: User C cannot view User A's order ─
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/status/${encodeURIComponent(payIdA)}`, {
    headers: { cookie: cookieC },
  });
  check("cross-user status query → 403", r.status === 403, `got ${r.status}`);

  // ─ Status route works for owner ─
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/status/${encodeURIComponent(payIdA)}`, {
    headers: { cookie: cookieA },
  });
  const sA = await r.json();
  check("owner status query → 200, paid", r.status === 200 && sA.status === "paid", JSON.stringify(sA));

  // ─ Anonymous → 401 ─
  r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/pay/create`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: "990" }),
  });
  check("anonymous create → 401", r.status === 401);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    console.error("\n─── server stderr/stdout ───\n" + serverOut.split("\n").slice(-40).join("\n"));
    process.exit(1);
  }
  console.log("\nAll checks passed");
} finally {
  proc.kill("SIGTERM");
  await sleep(200);
  if (!proc.killed) proc.kill("SIGKILL");
  mockGw.close();
  for (const s of ["", "-shm", "-wal"]) {
    const p = DB_PATH + s; if (existsSync(p)) try { rmSync(p); } catch {}
  }
}
