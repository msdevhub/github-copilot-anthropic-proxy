#!/usr/bin/env node
// End-to-end test for /api/wx/finalize (stage 5: auto-create + invite + IP throttle).
//
// Usage:
//   WX_GATEWAY_SECRET=<hex> node scripts/test-wx-finalize.mjs
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const SECRET = process.env.WX_GATEWAY_SECRET;
if (!SECRET) { console.error("set WX_GATEWAY_SECRET env"); process.exit(1); }

// Use a temp DB so this test never touches production data.
const DB_PATH = join(tmpdir(), `proxy-test-wx-${Date.now()}.db`);
for (const suffix of ["", "-shm", "-wal"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) rmSync(p);
}

const PORT = String(40000 + Math.floor(Math.random() * 10000));
const env = {
  ...process.env,
  PORT,
  DB_PATH,
  WX_GATEWAY_BASE: "https://wx.mvp.restry.cn",
  WX_GATEWAY_APP_NAME: "copilot-proxy",
  WX_GATEWAY_SECRET: SECRET,
  WX_SIGNUP_IP_LIMIT: "3",
  WX_INVITE_REWARD: "50000",
};

const proc = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = "";
proc.stdout.on("data", (d) => { serverOut += d.toString(); });
proc.stderr.on("data", (d) => { serverOut += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server didn't come up in time:\n" + serverOut);
}

function sign(token, openid, unionid, ts) {
  return createHmac("sha256", SECRET).update(`${token}|${openid}|${unionid}|${ts}`).digest("hex");
}

async function finalize({ openid, unionid = "", ref = "", forwardedFor = null }) {
  const token = "tok_" + Math.random().toString(36).slice(2);
  const ts = String(Date.now());
  const sig = sign(token, openid, unionid, ts);
  const refQ = ref ? `&ref=${encodeURIComponent(ref)}` : "";
  const headers = forwardedFor ? { "x-forwarded-for": forwardedFor } : {};
  return fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=${token}&openid=${openid}&unionid=${unionid}&ts=${ts}&sig=${sig}${refQ}`, { redirect: "manual", headers });
}

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${extra}`); failed++; }
}

try {
  await waitReady();

  // 1) /api/wx/config
  let r = await fetch(`http://127.0.0.1:${PORT}/api/wx/config`);
  let cfg = await r.json();
  check("config.enabled true", cfg.enabled === true, JSON.stringify(cfg));

  // 2) First-time scan → auto-creates wx_signup key, redirects to /?wx_new=1
  const oid1 = "oTestA" + Math.floor(Math.random() * 1e9);
  r = await finalize({ openid: oid1, forwardedFor: "1.2.3.4" });
  check("finalize valid → 302", r.status === 302, `got ${r.status}`);
  const loc = r.headers.get("location");
  check("redirect → /?wx_new=1", loc === "/?wx_new=1", `got ${loc}`);
  const setCookie = r.headers.get("set-cookie");
  check("sets user_session cookie", !!setCookie && setCookie.startsWith("user_session="), setCookie);

  // 3) /user/me reflects new wx_signup key with 30万 free quota + invite_code
  const cookie = setCookie.split(";")[0];
  r = await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie } });
  const me = await r.json();
  check("me.free_quota = 300000", me.free_quota === 300000, JSON.stringify(me));
  check("me.free_used = 0", me.free_used === 0);
  check("me.source = wx_signup", me.source === "wx_signup");
  check("me.free_reset_at = null", me.free_reset_at === null);
  check("me.invite_code present", typeof me.invite_code === "string" && me.invite_code.length === 8, me.invite_code);
  check("me.key_prefix starts with sk-proxy-wx-", typeof me.key_prefix === "string" && me.key_prefix.startsWith("sk-proxy-wx-"), me.key_prefix);
  const inviterCode = me.invite_code;

  // 4) Re-scan same openid → same key (no duplicate)
  r = await finalize({ openid: oid1, forwardedFor: "1.2.3.4" });
  check("re-scan → 302 to /", r.status === 302 && r.headers.get("location") === "/", r.headers.get("location"));
  // verify still one key for that openid
  const tdb = new DatabaseSync(DB_PATH);
  const dupCount = tdb.prepare("SELECT COUNT(*) AS c FROM api_keys_v2 WHERE wx_openid = ?").get(oid1).c;
  check("only one key per openid", dupCount === 1, `got ${dupCount}`);

  // 5) Invite flow: new openid scans with ?ref=<inviterCode>
  const oid2 = "oTestB" + Math.floor(Math.random() * 1e9);
  r = await finalize({ openid: oid2, ref: inviterCode, forwardedFor: "5.6.7.8" });
  check("invitee finalize → 302", r.status === 302);
  const cookie2 = r.headers.get("set-cookie").split(";")[0];
  r = await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie: cookie2 } });
  const me2 = await r.json();
  check("invitee free_quota = 350000 (300k + 50k reward)", me2.free_quota === 350000, `got ${me2.free_quota}`);
  // inviter should also have +50k
  r = await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie } });
  const me1again = await r.json();
  check("inviter free_quota = 350000", me1again.free_quota === 350000, `got ${me1again.free_quota}`);
  check("inviter invite_stats.count >= 1", (me1again.invite_stats?.count || 0) >= 1, JSON.stringify(me1again.invite_stats));

  // 6) Self-invite → no extra reward
  const oid3 = "oTestC" + Math.floor(Math.random() * 1e9);
  // First create the key for oid3
  r = await finalize({ openid: oid3, forwardedFor: "9.9.9.9" });
  const c3 = r.headers.get("set-cookie").split(";")[0];
  let me3 = await (await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie: c3 } })).json();
  const oid3code = me3.invite_code;
  // Re-scan with self-ref — quota should NOT increase (and the openid path returns existing key)
  await finalize({ openid: oid3, ref: oid3code, forwardedFor: "9.9.9.9" });
  me3 = await (await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie: c3 } })).json();
  check("self-ref does not increase quota", me3.free_quota === 300000, `got ${me3.free_quota}`);

  // 7) IP throttle: same IP, 4th new openid in 24h → 429
  const sharedIp = "11.22.33.44";
  for (let i = 0; i < 3; i++) {
    await finalize({ openid: "oFlood" + i + Math.floor(Math.random() * 1e6), forwardedFor: sharedIp });
  }
  r = await finalize({ openid: "oFlood4_" + Math.floor(Math.random() * 1e6), forwardedFor: sharedIp });
  check("4th new openid same IP → 429", r.status === 429, `got ${r.status}`);

  // 8) Bad sig still returns /?err=sig
  const ts = String(Date.now());
  r = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=t&openid=ox&unionid=&ts=${ts}&sig=${"00".repeat(32)}`, { redirect: "manual" });
  check("bad sig → /?err=sig", r.status === 302 && r.headers.get("location") === "/?err=sig");

  // 9) Missing → /?err=missing
  r = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?openid=x`, { redirect: "manual" });
  check("missing params → /?err=missing", r.status === 302 && r.headers.get("location") === "/?err=missing");

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
} finally {
  proc.kill("SIGTERM");
  await sleep(200);
  if (!proc.killed) proc.kill("SIGKILL");
  for (const suffix of ["", "-shm", "-wal"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) try { rmSync(p); } catch {}
  }
}
