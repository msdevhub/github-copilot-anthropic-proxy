#!/usr/bin/env node
// Quick end-to-end HMAC test for /api/wx/finalize.
// Spawns server.mjs with WX_GATEWAY_* env, computes a valid sig, curls finalize, expects 302.
//
// Usage:
//   WX_GATEWAY_SECRET=<hex> node scripts/test-wx-finalize.mjs
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = process.env.WX_GATEWAY_SECRET;
if (!SECRET) { console.error("set WX_GATEWAY_SECRET env"); process.exit(1); }

const PORT = String(40000 + Math.floor(Math.random() * 10000));
const env = {
  ...process.env,
  PORT,
  WX_GATEWAY_BASE: "https://wx.mvp.restry.cn",
  WX_GATEWAY_APP_NAME: "copilot-proxy",
  WX_GATEWAY_SECRET: SECRET,
};

const proc = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = "";
proc.stdout.on("data", (d) => { serverOut += d.toString(); });
proc.stderr.on("data", (d) => { serverOut += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 50; i++) {
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
  check("config.gatewayBase", cfg.gatewayBase === "https://wx.mvp.restry.cn");
  check("config.appName", cfg.appName === "copilot-proxy");

  // 2) finalize with valid sig → 302 to /?wx_pending=1 (first-time user) with Set-Cookie
  const token = "tok_test_" + Math.random().toString(36).slice(2);
  const openid = "oTestOpenid" + Math.floor(Math.random() * 1e6);
  const unionid = "uTestUnionid" + Math.floor(Math.random() * 1e6);
  const ts = String(Date.now());
  const sig = sign(token, openid, unionid, ts);
  const u = `http://127.0.0.1:${PORT}/api/wx/finalize?token=${token}&openid=${openid}&unionid=${unionid}&ts=${ts}&sig=${sig}`;
  r = await fetch(u, { redirect: "manual" });
  check("finalize valid → 302", r.status === 302, `got ${r.status}`);
  const loc = r.headers.get("location");
  check("finalize redirect → /?wx_pending=1", loc === "/?wx_pending=1", `got ${loc}`);
  const setCookie = r.headers.get("set-cookie");
  check("finalize sets user_session cookie", !!setCookie && setCookie.startsWith("user_session="), setCookie);

  // 3) finalize with bad sig → 302 /?err=sig
  const badSig = "00".repeat(32);
  r = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=${token}&openid=${openid}&unionid=${unionid}&ts=${ts}&sig=${badSig}`, { redirect: "manual" });
  check("bad sig → /?err=sig", r.status === 302 && r.headers.get("location") === "/?err=sig", `got ${r.status} ${r.headers.get("location")}`);

  // 4) expired ts → /?err=expired
  const oldTs = String(Date.now() - 10 * 60 * 1000);
  const oldSig = sign(token, openid, unionid, oldTs);
  r = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?token=${token}&openid=${openid}&unionid=${unionid}&ts=${oldTs}&sig=${oldSig}`, { redirect: "manual" });
  check("expired ts → /?err=expired", r.status === 302 && r.headers.get("location") === "/?err=expired");

  // 5) missing params → /?err=missing
  r = await fetch(`http://127.0.0.1:${PORT}/api/wx/finalize?openid=${openid}`, { redirect: "manual" });
  check("missing params → /?err=missing", r.status === 302 && r.headers.get("location") === "/?err=missing");

  // 6) bind-key without session → 401
  r = await fetch(`http://127.0.0.1:${PORT}/user/bind-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-fake" }),
  });
  check("bind-key no session → 401", r.status === 401);

  // 7) /user/me with the wx_pending session cookie → returns wx_pending sentinel
  const cookie = setCookie.split(";")[0]; // user_session=<tok>
  r = await fetch(`http://127.0.0.1:${PORT}/user/me`, { headers: { cookie } });
  const me = await r.json();
  check("/user/me wx_pending=true", me.wx_pending === true, JSON.stringify(me));
  check("/user/me has wx_openid_short", typeof me.wx_openid_short === "string");

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
} finally {
  proc.kill("SIGTERM");
  await sleep(200);
  if (!proc.killed) proc.kill("SIGKILL");
}
