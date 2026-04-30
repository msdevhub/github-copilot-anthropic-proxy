// User self-service dashboard. Talks to /user/* endpoints scoped by user_session.
const SC = window.SharedCharts;

let hourlyHits = [];
let pollTimer = null;

// ─── Resources section ─────────────────────────────────────────────────────
const RES_BASE_ANTHROPIC = 'https://api.eagle.openclaws.co.uk';
const RES_BASE_OPENAI = 'https://api.eagle.openclaws.co.uk/v1';
let resKeyRaw = null;       // full key (when session has it)
let resKeyMasked = null;    // mask form
let resKeyShown = false;

function maskKey(raw, prefix) {
  if (raw && raw.length > 8) {
    return raw.slice(0, 12) + '****' + raw.slice(-4);
  }
  if (prefix) return prefix + '****';
  return '<请先登录>';
}

function currentKeyForCmd() {
  return resKeyRaw || resKeyMasked || '<请先登录>';
}

function resTemplates(k) {
  const eagleModels = 'gpt-5.5,gpt-5.2-codex,gpt-5-mini,claude-opus-4.7-1m-internal,claude-opus-4.7,claude-opus-4.6,claude-opus-4.5,claude-sonnet-4.6,claude-sonnet-4.5,claude-haiku-4.5,gemini-3.1-pro-preview,gemini-3-flash-preview';
  const openclawJson = `EAGLE_API_KEY='${k}' && cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.eagle.$(date +%s) && jq --arg key "$EAGLE_API_KEY" '
  ($eagle_models | split(",")) as $ids |
  .models = (.models // {}) |
  .models.providers = (.models.providers // {}) |
  .models.providers.eagle = {
    baseUrl: "${RES_BASE_OPENAI}",
    apiKey: $key,
    api: "openai-completions",
    authHeader: false,
    models: ($ids | map({id: ., name: .}))
  } |
  .agents = (.agents // {}) |
  .agents.defaults = (.agents.defaults // {}) |
  .agents.defaults.model = {
    primary: "eagle/gpt-5.5",
    fallbacks: ($ids | map(select(. != "gpt-5.5")) | map("eagle/" + .))
  } |
  .agents.defaults.models = ((.agents.defaults.models // {}) + ($ids | map({(("eagle/" + .)): {}}) | add))
' --arg eagle_models '${eagleModels}' \\
  ~/.openclaw/openclaw.json > /tmp/openclaw.eagle.json && mv /tmp/openclaw.eagle.json ~/.openclaw/openclaw.json && echo "eagle provider installed ✅"`;
  return {
    cc: `npm i -g @anthropic-ai/claude-code\nexport ANTHROPIC_BASE_URL=${RES_BASE_ANTHROPIC}\nexport ANTHROPIC_AUTH_TOKEN=${k}\nclaude`,
    oc: `npm i -g opencode-ai\nexport ANTHROPIC_BASE_URL=${RES_BASE_ANTHROPIC}\nexport ANTHROPIC_AUTH_TOKEN=${k}\nopencode`,
    cx: `npm i -g @openai/codex\nexport OPENAI_BASE_URL=${RES_BASE_OPENAI}\nexport OPENAI_API_KEY=${k}\ncodex`,
    ow: `# 一键安装 eagle provider 到 ~/.openclaw/openclaw.json (会自动备份原配置)\n${openclawJson}`,
    hm: `hermes config set provider.anthropic.base_url ${RES_BASE_ANTHROPIC}\nhermes config set provider.anthropic.api_key ${k}`,
  };
}

// Render template using a non-secret placeholder so the <pre> blocks never
// contain the raw key while it's hidden. The actual key is substituted at copy time.
const RES_KEY_PLACEHOLDER = '<YOUR_KEY>';
function templateForDisplay() { return resTemplates(resKeyShown && resKeyRaw ? resKeyRaw : RES_KEY_PLACEHOLDER); }
function templateWithRealKey() { return resTemplates(resKeyRaw || resKeyMasked || RES_KEY_PLACEHOLDER); }

function renderResources(m) {
  resKeyRaw = m.raw_key || null;
  resKeyMasked = maskKey(m.raw_key, m.key_prefix);
  const disp = document.getElementById('res-key-display');
  if (disp) disp.textContent = resKeyShown && resKeyRaw ? resKeyRaw : resKeyMasked;
  const toggleBtn = document.getElementById('res-key-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = resKeyShown ? '隐藏' : '显示完整';
    toggleBtn.disabled = !resKeyRaw;
    toggleBtn.style.opacity = resKeyRaw ? '1' : '0.5';
    toggleBtn.style.cursor = resKeyRaw ? 'pointer' : 'not-allowed';
  }
  const t = templateForDisplay();
  const setPre = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setPre('res-cc-pre', t.cc);
  setPre('res-oc-pre', t.oc);
  setPre('res-cx-pre', t.cx);
  setPre('res-ow-pre', t.ow);
  setPre('res-hm-pre', t.hm);
}

window.resToggle = function() {
  const body = document.getElementById('res-body');
  const arrow = document.getElementById('res-arrow');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▲' : '▼';
};

window.pricingToggle = function() {
  const body = document.getElementById('pricing-body');
  const arrow = document.getElementById('pricing-arrow');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▲' : '▼';
};

window.resToggleKey = function() {
  if (!resKeyRaw) return;
  resKeyShown = !resKeyShown;
  const disp = document.getElementById('res-key-display');
  if (disp) disp.textContent = resKeyShown ? resKeyRaw : resKeyMasked;
  const btn = document.getElementById('res-key-toggle');
  if (btn) btn.textContent = resKeyShown ? '隐藏' : '显示完整';
  // Re-render the <pre> blocks so the placeholder/raw key visibility tracks the toggle.
  const t = templateForDisplay();
  const setPre = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setPre('res-cc-pre', t.cc);
  setPre('res-oc-pre', t.oc);
  setPre('res-cx-pre', t.cx);
  setPre('res-ow-pre', t.ow);
  setPre('res-hm-pre', t.hm);
};

window.resCopyKey = function(btn) {
  const txt = resKeyRaw || resKeyMasked || '';
  if (!txt) return;
  if (!resKeyShown && resKeyRaw) {
    const ok = window.confirm(
      '⚠️ Key 当前已隐藏，但复制内容是完整 key。\n请确认无人看屏 / 录屏后再粘贴。是否继续？'
    );
    if (!ok) return;
  }
  navigator.clipboard.writeText(txt).then(() => {
    const o = btn.textContent; btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = o; }, 1400);
  });
};

window.resSwitch = function(k) {
  document.querySelectorAll('[data-rk]').forEach(t => t.classList.toggle('active', t.dataset.rk === k));
  ['cc','oc','cx','ow','hm'].forEach(id => {
    const p = document.getElementById('res-' + id);
    if (p) p.style.display = (id === k) ? '' : 'none';
  });
};

window.resCopyCmd = function(id, btn) {
  // The on-screen <pre> may contain the placeholder (when key is hidden); the
  // clipboard always gets the real key so the command actually works.
  const tplKey = id.replace('res-', '').replace('-pre', ''); // 'cc' | 'oc' | 'cx' | 'ow' | 'hm'
  const real = templateWithRealKey()[tplKey];
  const txt = real != null ? real : (document.getElementById(id)?.innerText || '');
  const proceed = () => {
    navigator.clipboard.writeText(txt).then(() => {
      const o = btn.textContent; btn.textContent = '已复制'; btn.classList.add('ok');
      setTimeout(() => { btn.textContent = o; btn.classList.remove('ok'); }, 1400);
    });
  };
  if (!resKeyShown && resKeyRaw) {
    // Visible UI is masked but clipboard will contain the full key — confirm
    // before pasting (typical cause of leaks: screen-share, recording, demo).
    const ok = window.confirm(
      '⚠️ Key 当前已隐藏，但复制内容包含完整 key（命令需要它才能运行）。\n' +
      '请确认无人看屏 / 录屏后再粘贴。是否继续？'
    );
    if (!ok) return;
  }
  proceed();
};

window.goAdmin = function() {
  location.href = '/_a/ce233c02438f1ea04adaeb0c703468eb';
};

// ─── Login UI: tab switch + WeChat scan flow ────────────────────────────────
function loginSwitch(tab) {
  document.querySelectorAll('.login-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.login-panel').forEach(p => p.classList.toggle('active', p.id === 'login-panel-' + tab));
  if (tab === 'wx') ensureWxQr();
}

let wxCfg = null;          // { enabled, gatewayBase, appName }
let wxEs = null;           // EventSource
let wxCurrentToken = null;
let wxRefreshTimer = null;

async function loadWxConfig() {
  if (wxCfg) return wxCfg;
  try {
    const r = await fetch('/api/wx/config');
    wxCfg = await r.json();
  } catch { wxCfg = { enabled: false }; }
  return wxCfg;
}

function setQrStatus(text, cls) {
  const el = document.getElementById('qr-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'qr-status' + (cls ? ' ' + cls : '');
}

function setQrSlotImage(url) {
  const slot = document.getElementById('qr-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'qr-img';
  img.src = url;
  img.alt = '微信扫码登录';
  slot.appendChild(img);
}

function setQrSlotMessage(msg, withRetry) {
  const slot = document.getElementById('qr-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const skel = document.createElement('div');
  skel.className = 'qr-skel';
  skel.textContent = msg;
  slot.appendChild(skel);
  if (withRetry) {
    const btn = document.createElement('button');
    btn.className = 'qr-retry';
    btn.textContent = '重新加载';
    btn.onclick = ensureWxQr;
    slot.appendChild(document.createElement('br'));
    slot.appendChild(btn);
  }
}

async function ensureWxQr() {
  await loadWxConfig();
  if (!wxCfg || !wxCfg.enabled) {
    // WeChat disabled — hide tabs and show only the API key form
    const tabs = document.getElementById('login-tabs');
    if (tabs) tabs.style.display = 'none';
    document.querySelectorAll('.login-panel').forEach(p => p.classList.remove('active'));
    const kp = document.getElementById('login-panel-key');
    if (kp) kp.classList.add('active');
    return;
  }
  await refreshWxQr();
}

async function refreshWxQr() {
  if (wxEs) { try { wxEs.close(); } catch {} wxEs = null; }
  if (wxRefreshTimer) { clearTimeout(wxRefreshTimer); wxRefreshTimer = null; }
  setQrSlotMessage('加载中…');
  setQrStatus('正在生成二维码…');
  try {
    const r = await fetch(`${wxCfg.gatewayBase}/wx/qr/${encodeURIComponent(wxCfg.appName)}`, { method: 'POST' });
    const data = await r.json();
    if (!data || !data.ok || !data.qrcodeUrl || !data.token) {
      setQrSlotMessage('生成失败', true);
      setQrStatus('请稍后重试', 'expired');
      return;
    }
    wxCurrentToken = data.token;
    setQrSlotImage(data.qrcodeUrl);
    setQrStatus('扫码关注「造悟者」公众号即登录');

    const es = new EventSource(`${wxCfg.gatewayBase}/wx/poll/${encodeURIComponent(data.token)}`);
    wxEs = es;
    es.onmessage = (ev) => {
      let d = null;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (!d || !d.status) return;
      if (d.status === 'scanned') setQrStatus('已扫码，请在微信中确认', 'scanned');
      else if (d.status === 'pending') setQrStatus('等待扫码…');
      else if (d.status === 'confirmed' && d.redirect) {
        try { es.close(); } catch {}
        wxEs = null;
        setQrStatus('登录中…', 'scanned');
        window.location.href = d.redirect;
      } else if (d.status === 'expired' || d.status === 'timeout') {
        try { es.close(); } catch {}
        wxEs = null;
        setQrStatus('二维码已过期，正在刷新…', 'expired');
        const slot = document.getElementById('qr-slot');
        const img = slot && slot.querySelector('img.qr-img');
        if (img) img.classList.add('expired');
        wxRefreshTimer = setTimeout(refreshWxQr, 800);
      }
    };
    es.onerror = () => {
      try { es.close(); } catch {}
      wxEs = null;
      // Try to refresh after a brief delay
      wxRefreshTimer = setTimeout(refreshWxQr, 1500);
    };
  } catch (e) {
    setQrSlotMessage('网络错误', true);
    setQrStatus(String(e && e.message || e), 'expired');
  }
}

// ─── API key login (fallback) ──────────────────────────────────────────────
async function userLogin() {
  const key = document.getElementById('login-key').value.trim();
  const errEl = document.getElementById('login-err');
  errEl.textContent = '';
  if (!key) { errEl.textContent = 'API key required'; return; }
  try {
    const r = await fetch('/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ apiKey: key }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      errEl.textContent = j.error || ('login failed (' + r.status + ')');
      return;
    }
    location.reload();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

async function userLogout() {
  await fetch('/user/logout', { method: 'POST', credentials: 'same-origin' });
  location.replace('/');
}

// ─── Bind flow removed in stage 5 — wx scan now auto-creates the key ────────

// ─── Dashboard data loaders ────────────────────────────────────────────────
async function userRefresh() {
  await Promise.all([loadMe(), loadLogs(), loadStats(), loadUsage()]);
}

async function loadMe() {
  const r = await fetch('/user/me', { credentials: 'same-origin' });
  if (!r.ok) return;
  const m = await r.json();
  document.getElementById('user-name').textContent = m.name || '(unknown)';
  document.getElementById('acct-name').textContent = m.name || '—';
  document.getElementById('acct-role').textContent = m.role || 'user';
  document.getElementById('acct-prefix').textContent = m.key_prefix ? m.key_prefix + '…' : '—';
  document.getElementById('acct-models').textContent = (m.allowed_models && m.allowed_models.length)
    ? m.allowed_models.join(', ')
    : 'all';

  // Resources section: render mask + commands
  renderResources(m);

  // Admin button
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) adminBtn.style.display = (m.role === 'admin') ? '' : 'none';
  document.getElementById('q-used').textContent = SC.fmt(m.free_used || 0);
  document.getElementById('q-total').textContent = m.unlimited ? '∞' : SC.fmt(m.free_quota || 0);
  document.getElementById('bal').textContent = m.unlimited ? '∞' : SC.fmt(m.balance_tokens || 0);
  const paidEl = document.getElementById('paid-quota');
  if (paidEl) paidEl.textContent = m.unlimited ? '∞' : SC.fmt(m.paid_quota || 0);
  const pill = document.getElementById('status-pill');
  pill.className = 'pill';
  if (m.unlimited) { pill.textContent = 'unlimited'; pill.classList.add('unl'); }
  else if (m.status === 'disabled') { pill.textContent = 'disabled'; pill.classList.add('dis'); }
  else { pill.textContent = m.status || 'active'; }
  const fill = document.getElementById('q-fill');
  if (m.unlimited || !m.free_quota) {
    fill.style.width = '0%';
  } else {
    const pct = Math.min(100, Math.round((m.free_used / m.free_quota) * 100));
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 70 && pct < 95);
    fill.classList.toggle('full', pct >= 95);
  }
  document.getElementById('q-reset').textContent = m.free_reset_at || (m.source === 'wx_signup' ? '不重置（一次性赠送）' : '—');

  // Upgrade banner: show when remaining < 10% of free_quota
  const banner = document.getElementById('upgrade-banner');
  if (banner) {
    const remain = Math.max(0, (m.free_quota || 0) - (m.free_used || 0));
    const ratio = m.free_quota ? remain / m.free_quota : 1;
    const lowRemain = !m.unlimited && m.free_quota > 0 && ratio < 0.1;
    banner.style.display = lowRemain ? '' : 'none';
    if (lowRemain) {
      const remainEl = document.getElementById('upgrade-remain');
      if (remainEl) remainEl.textContent = SC.fmt(remain);
    }
  }

  // Invite section
  const inviteCard = document.getElementById('invite-card');
  if (inviteCard) {
    if (m.invite_code) {
      inviteCard.style.display = '';
      const cfg = await loadWxConfig();
      // Build invite URL pointing to gateway (public scan entry) with ?ref=
      const base = (cfg && cfg.gatewayBase) ? cfg.gatewayBase : location.origin;
      const inviteUrl = `${base}/wx/qr/${encodeURIComponent(cfg && cfg.appName || '')}?ref=${m.invite_code}`;
      const linkEl = document.getElementById('invite-link');
      if (linkEl) linkEl.textContent = inviteUrl;
      const codeEl = document.getElementById('invite-code');
      if (codeEl) codeEl.textContent = m.invite_code;
      const stats = m.invite_stats || { count: 0, reward_total: 0 };
      const cntEl = document.getElementById('invite-count');
      const rewEl = document.getElementById('invite-reward');
      if (cntEl) cntEl.textContent = String(stats.count);
      if (rewEl) rewEl.textContent = SC.fmt(stats.reward_total);
    } else {
      inviteCard.style.display = 'none';
    }
  }
  // Plan card
  await loadPlan(m);
}

let _planResetTimer = null;

async function loadPlan(meData) {
  const card = document.getElementById('plan-card');
  const body = document.getElementById('plan-body');
  if (!card || !body) return;
  let p;
  try {
    const r = await fetch('/user/plan', { credentials: 'same-origin' });
    if (!r.ok) { card.style.display = 'none'; return; }
    p = await r.json();
  } catch { card.style.display = 'none'; return; }

  card.style.display = '';
  const nowSec = Math.floor(Date.now() / 1000);

  if (p.plan_type === 'monthly_29' && p.plan_expires_at > nowSec) {
    const daysLeft = Math.ceil((p.plan_expires_at - nowSec) / 86400);
    const resetTs = p.window_reset_at;
    const resetStr = resetTs
      ? new Date(resetTs * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
      : '—';
    const used = p.window_used || 0;
    const quota = p.window_quota || 600;
    const pct = Math.min(100, Math.round(used / quota * 100));
    const warnCls = pct >= 95 ? 'full' : (pct >= 80 ? 'warn' : '');

    body.textContent = '';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px';
    const nameSpan = document.createElement('div');
    const labelA = document.createElement('span');
    labelA.style.cssText = 'font-size:13px;color:#3dd68c;font-weight:600';
    labelA.textContent = '包月畅用';
    const labelB = document.createElement('span');
    labelB.style.cssText = 'font-size:12px;color:var(--text-3);margin-left:8px';
    labelB.textContent = '· 剩余 ' + daysLeft + ' 天';
    nameSpan.appendChild(labelA);
    nameSpan.appendChild(labelB);
    const renewBtn = document.createElement('button');
    renewBtn.style.cssText = 'background:transparent;border:1px solid #3dd68c;color:#3dd68c;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px';
    renewBtn.textContent = '续费 ¥29/月';
    renewBtn.onclick = () => window.startPayment('monthly_29');
    topRow.appendChild(nameSpan);
    topRow.appendChild(renewBtn);
    body.appendChild(topRow);

    const windowInfo = document.createElement('div');
    windowInfo.style.cssText = 'margin-top:10px;font-size:12px;color:var(--text-3)';
    windowInfo.setAttribute('data-countdown', '1');
    windowInfo.textContent = '5h 窗口已用 ' + used + '/' + quota + ' 次，重置于 ' + resetStr + ' (CST)';
    body.appendChild(windowInfo);

    const bar = document.createElement('div');
    bar.className = 'quota-bar';
    bar.style.marginTop = '6px';
    const fill = document.createElement('div');
    fill.className = 'quota-fill' + (warnCls ? ' ' + warnCls : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    body.appendChild(bar);

    if (_planResetTimer) clearInterval(_planResetTimer);
    _planResetTimer = setInterval(() => {
      const now2 = Math.floor(Date.now() / 1000);
      const diff = (p.window_reset_at || 0) - now2;
      if (diff <= 0) { clearInterval(_planResetTimer); loadPlan(meData); return; }
      const mm = String(Math.floor(diff / 60)).padStart(2, '0');
      const ss = String(diff % 60).padStart(2, '0');
      const el = body.querySelector('[data-countdown]');
      if (el) el.textContent = '5h 窗口已用 ' + used + '/' + quota + ' 次，重置于 ' + resetStr + ' (CST，' + mm + ':' + ss + ' 后)';
    }, 1000);
  } else {
    // Free user
    body.textContent = '';
    const freeLabel = document.createElement('div');
    freeLabel.style.cssText = 'font-size:12px;color:var(--text-3);margin-bottom:10px';
    freeLabel.textContent = '当前套餐：';
    const bold = document.createElement('b');
    bold.style.color = 'var(--text-2)';
    bold.textContent = '免费版';
    freeLabel.appendChild(bold);
    const span2 = document.createTextNode('（使用赠送额度）');
    freeLabel.appendChild(span2);
    body.appendChild(freeLabel);

    const upgradeBtn = document.createElement('button');
    upgradeBtn.style.cssText = 'background:linear-gradient(90deg,#7170ff,#5a59e0);border:none;color:#fff;padding:9px 18px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;width:100%';
    upgradeBtn.textContent = '升级到包月畅用 ¥29/月 — 5h 600次，30天';
    upgradeBtn.onclick = () => window.startPayment('monthly_29');
    body.appendChild(upgradeBtn);
  }
}

function copyInviteLink(btn) {
  const txt = document.getElementById('invite-link')?.textContent || '';
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(() => {
    const o = btn.textContent; btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = o; }, 1400);
  });
}

async function loadLogs() {
  const r = await fetch('/user/logs?limit=50', { credentials: 'same-origin' });
  if (!r.ok) return;
  const { logs } = await r.json();
  document.getElementById('logs-count').textContent = logs.length + ' rows';
  const body = document.getElementById('logs-body');
  body.textContent = '';
  for (const l of logs) {
    const tr = document.createElement('tr');
    const cells = [
      (l.ts || '').slice(11, 19),
      l.model || '-',
      String(l.status || '-'),
      (l.duration_ms || 0) + 'ms',
      ((l.input_tokens || 0) + (l.output_tokens || 0)).toLocaleString(),
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 2) td.className = (l.status >= 400 || l.error) ? 'status-err' : 'status-ok';
      tr.appendChild(td);
    });
    const previewTd = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'preview';
    span.textContent = l.preview || l.error || '';
    previewTd.appendChild(span);
    tr.appendChild(previewTd);
    body.appendChild(tr);
  }
}

async function loadStats() {
  const r = await fetch('/user/stats', { credentials: 'same-origin' });
  if (!r.ok) return;
  const { hourly, modelShare } = await r.json();
  const canvas = document.getElementById('chart-hourly');
  const scroll = document.getElementById('chart-scroll');
  hourlyHits = SC.drawHourly(canvas, scroll, SC.fillHourly(hourly));
  SC.drawShare(document.getElementById('chart-models'), modelShare, 'model', 7);
}

async function loadUsage() {
  const r = await fetch('/user/usage', { credentials: 'same-origin' });
  if (!r.ok) return;
  const { byDay } = await r.json();
  const total = byDay.reduce((s, d) => s + d.cost, 0) || 1;
  const items = byDay.map(d => ({
    name: d.day,
    count: d.count,
    tokens: d.cost,
    pct: Math.round(d.cost * 100 / total),
  }));
  SC.drawShare(document.getElementById('chart-byday'), items, 'name', 14);
}

// ─── Init: pick screen based on /user/me + URL hint ────────────────────────
async function init() {
  const url = new URL(location.href);
  const wxErr = url.searchParams.get('err');
  const wxNew = url.searchParams.get('wx_new') === '1';

  // Probe session
  const r = await fetch('/user/me', { credentials: 'same-origin' });
  if (r.status === 401) {
    document.getElementById('login-screen').style.display = '';
    document.getElementById('app').style.display = 'none';
    if (wxErr) {
      const errMsg = ({
        sig: '微信登录签名校验失败，请重试',
        expired: '微信登录已过期，请重试',
        missing: '微信回调参数缺失',
        wx_disabled: '微信登录暂未启用',
        db: '数据库错误',
      })[wxErr] || ('登录失败：' + wxErr);
      setTimeout(() => setQrStatus(errMsg, 'expired'), 100);
    }
    ensureWxQr();
    return;
  }

  // Logged in normally
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
  if (wxNew) {
    const welcome = document.getElementById('welcome-banner');
    if (welcome) welcome.style.display = '';
  }
  const tip = document.getElementById('chart-tip');
  const canvas = document.getElementById('chart-hourly');
  const scroll = document.getElementById('chart-scroll');
  SC.attachTooltip(canvas, scroll, tip, () => hourlyHits);
  await userRefresh();
  pollTimer = setInterval(userRefresh, 5000);

  // Strip wx_new / err from URL after successful login
  if (wxNew || wxErr) {
    const clean = location.pathname;
    history.replaceState(null, '', clean);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement) {
    if (document.activeElement.id === 'login-key') userLogin();
  }
});

init();

// ─── Payment flow (wx-gateway personal_qr) ─────────────────────────────────
let _payState = { payOrderId: null, pollTimer: null };

window.startPayment = async function(pkgId) {
  const r = await fetch('/api/pay/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ package: pkgId }),
  });
  const data = await r.json();
  if (!r.ok) {
    alert('创建订单失败：' + (data.error || r.status));
    return;
  }
  _payState.payOrderId = data.payOrderId;
  document.getElementById('pay-qr').src = data.qrcodeUrl;
  document.getElementById('pay-remark').textContent = data.remark;
  document.getElementById('pay-amount').textContent = (data.amount_fen / 100).toFixed(2);
  document.getElementById('pay-status').textContent = 'pending';
  document.getElementById('pay-msg').textContent = '';
  document.getElementById('pay-claim-btn').disabled = false;
  document.getElementById('pay-modal').style.display = 'flex';
  _startPaymentPoll();
};

window.claimPayment = async function() {
  if (!_payState.payOrderId) return;
  const btn = document.getElementById('pay-claim-btn');
  btn.disabled = true;
  const r = await fetch('/api/pay/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ payOrderId: _payState.payOrderId }),
  });
  const data = await r.json();
  if (!r.ok) {
    document.getElementById('pay-msg').textContent = '提交失败：' + (data.error || r.status);
    btn.disabled = false;
    return;
  }
  document.getElementById('pay-status').textContent = 'submitted';
  document.getElementById('pay-msg').textContent = '已提交，等待审核（一般 5 分钟内到账，可关闭此窗口）';
};

window.closePayment = function() {
  document.getElementById('pay-modal').style.display = 'none';
  if (_payState.pollTimer) { clearInterval(_payState.pollTimer); _payState.pollTimer = null; }
  _payState.payOrderId = null;
};

function _setPayMsg(text, color) {
  const el = document.getElementById('pay-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '';
  el.style.fontWeight = color ? '600' : '';
}

function _startPaymentPoll() {
  if (_payState.pollTimer) clearInterval(_payState.pollTimer);
  _payState.pollTimer = setInterval(async () => {
    if (!_payState.payOrderId) return;
    try {
      const r = await fetch('/api/pay/status/' + encodeURIComponent(_payState.payOrderId), { credentials: 'same-origin' });
      if (!r.ok) return;
      const p = await r.json();
      const sEl = document.getElementById('pay-status');
      if (sEl) sEl.textContent = p.status;
      if (p.status === 'paid') {
        const successMsg = p.tokens_to_grant
          ? '付款成功！已到账 ' + SC.fmt(p.tokens_to_grant) + ' tokens'
          : '付款成功！包月套餐已开通';
        _setPayMsg(successMsg, '#3a8a3a');
        clearInterval(_payState.pollTimer); _payState.pollTimer = null;
        await loadMe();
      } else if (p.status === 'expired' || p.status === 'disputed') {
        _setPayMsg(p.status === 'expired' ? '订单已过期，请重新发起' : ('已驳回：' + (p.reject_reason || '请联系客服')), '#c0392b');
        clearInterval(_payState.pollTimer); _payState.pollTimer = null;
      }
    } catch {}
  }, 5000);
}
