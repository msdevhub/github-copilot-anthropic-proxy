#!/usr/bin/env node
// E2E: ADMIN_PATH gating by user_session + role=admin.
//
// Usage: node scripts/test-admin-gate.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

const DB_PATH = join(tmpdir(), `proxy-test-admin-${Date.now()}.db`);
for (const suffix of ["", "-shm", "-wal"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) rmSync(p);
}

const ADMIN_PATH = "/_a/test-admin-path";
const PORT = String(40000 + Math.floor(Math.random() * 10000));
const env = {
  ...process.env,
  PORT,
  DB_PATH,
  ADMIN_PATH,
  API_KEYS_PATH: join(tmpdir(), `proxy-test-keys-${Date.now()}.json`),
};

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
}

function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn("node", ["server.mjs", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", b => { out += b.toString(); });
    p.stderr.on("data", b => { out += b.toString(); });
    p.on("close", (code) => resolve({ code, out }));
  });
}

async function login(rawKey) {
  const r = await fetch(`http://127.0.0.1:${PORT}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: rawKey }),
  });
  const setCookie = r.headers.get("set-cookie") || "";
  const m = setCookie.match(/user_session=([^;]+)/);
  return m ? m[1] : null;
}

async function fetchNoFollow(url, cookie) {
  return fetch(url, {
    headers: cookie ? { Cookie: `user_session=${cookie}` } : {},
    redirect: "manual",
  });
}

(async () => {
  // 1) Pre-create admin & user keys via CLI
  const adminRun = await runCli(["--add-admin", "test-admin"]);
  const adminKeyMatch = adminRun.out.match(/sk-proxy-[a-z0-9]+/i);
  ok("CLI created admin key", !!adminKeyMatch);
  const ADMIN_KEY = adminKeyMatch[0];

  // --add-user is not a CLI flag; we'll create the non-admin key via /admin/keys after boot
  let USER_KEY = null;

  // 2) Boot server
  const srv = spawn("node", ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let booted = false;
  srv.stdout.on("data", b => { if (b.toString().includes("running at")) booted = true; });
  srv.stderr.on("data", () => {});
  for (let i = 0; i < 50 && !booted; i++) await sleep(100);
  ok("server boots", booted);

  try {
    // 3) Anonymous → 302 /?next=ADMIN_PATH
    const anon = await fetchNoFollow(`http://127.0.0.1:${PORT}${ADMIN_PATH}`);
    ok("anon → 302", anon.status === 302);
    ok("anon → /?next=...", (anon.headers.get("location") || "").startsWith(`/?next=`));

    // 4) Admin login → 200
    const adminTok = await login(ADMIN_KEY);
    ok("admin login → user_session", !!adminTok);
    const adminRes = await fetchNoFollow(`http://127.0.0.1:${PORT}${ADMIN_PATH}`, adminTok);
    ok("admin → 200", adminRes.status === 200);
    const html = await adminRes.text();
    ok("admin html shows admin name", html.includes("test-admin"));

    // 5) Non-admin: create one via /admin/keys then login
    if (!USER_KEY) {
      const r = await fetch(`http://127.0.0.1:${PORT}/admin/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": ADMIN_KEY },
        body: JSON.stringify({ name: "regular", role: "user", free_quota: 1000 }),
      });
      const j = await r.json();
      USER_KEY = j.key || j.raw || null;
    }
    ok("got non-admin key", !!USER_KEY);
    const userTok = await login(USER_KEY);
    ok("user login → user_session", !!userTok);
    const userRes = await fetchNoFollow(`http://127.0.0.1:${PORT}${ADMIN_PATH}`, userTok);
    ok("non-admin → 302", userRes.status === 302);
    ok("non-admin → /?err=not_admin", (userRes.headers.get("location") || "").includes("err=not_admin"));

    // 6) /admin/keys with non-admin user_session → 401/403
    const userAdminApi = await fetch(`http://127.0.0.1:${PORT}/admin/keys`, {
      headers: { Cookie: `user_session=${userTok}` },
    });
    ok("non-admin /admin/keys → 401/403", userAdminApi.status === 401 || userAdminApi.status === 403);

    // 7) /admin/keys with admin user_session → 200
    const adminApi = await fetch(`http://127.0.0.1:${PORT}/admin/keys`, {
      headers: { Cookie: `user_session=${adminTok}` },
    });
    ok("admin /admin/keys → 200", adminApi.status === 200);
  } finally {
    srv.kill();
    await sleep(100);
    for (const suffix of ["", "-shm", "-wal"]) {
      const p = DB_PATH + suffix;
      if (existsSync(p)) try { rmSync(p); } catch {}
    }
    if (existsSync(env.API_KEYS_PATH)) try { rmSync(env.API_KEYS_PATH); } catch {}
  }

  console.log(`\n${fail === 0 ? "All checks passed" : `${fail} failure(s)`} (${pass} ok / ${pass + fail} total)`);
  process.exit(fail === 0 ? 0 : 1);
})();
