// User self-service dashboard. Talks to /user/* endpoints scoped by user_session.
const SC = window.SharedCharts;

let hourlyHits = [];
let pollTimer = null;

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

// ─── Bind flow (first-time WeChat user) ────────────────────────────────────
async function userBindKey() {
  const key = document.getElementById('bind-key').value.trim();
  const errEl = document.getElementById('bind-err');
  errEl.textContent = '';
  if (!key) { errEl.textContent = '请输入 API Key'; return; }
  try {
    const r = await fetch('/user/bind-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ apiKey: key }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      errEl.textContent = j.error || ('bind failed (' + r.status + ')');
      return;
    }
    // Strip wx_pending=1 from URL and reload as fully-logged-in user
    location.replace('/');
  } catch (e) {
    errEl.textContent = e.message;
  }
}

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
  document.getElementById('q-used').textContent = SC.fmt(m.free_used || 0);
  document.getElementById('q-total').textContent = m.unlimited ? '∞' : SC.fmt(m.free_quota || 0);
  document.getElementById('bal').textContent = m.unlimited ? '∞' : SC.fmt(m.balance_tokens || 0);
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
  document.getElementById('q-reset').textContent = m.free_reset_at || '—';
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
  const wxPending = url.searchParams.get('wx_pending') === '1';

  // Probe session
  const r = await fetch('/user/me', { credentials: 'same-origin' });
  if (r.status === 401) {
    document.getElementById('login-screen').style.display = '';
    document.getElementById('app').style.display = 'none';
    document.getElementById('bind-screen').style.display = 'none';
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

  const me = await r.json();
  if (me && me.wx_pending) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'none';
    const bind = document.getElementById('bind-screen');
    bind.style.display = '';
    const who = document.getElementById('bind-who');
    who.textContent = me.nickname ? `${me.nickname} (${me.wx_openid_short})` : me.wx_openid_short;
    return;
  }

  // Logged in normally
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('bind-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
  const tip = document.getElementById('chart-tip');
  const canvas = document.getElementById('chart-hourly');
  const scroll = document.getElementById('chart-scroll');
  SC.attachTooltip(canvas, scroll, tip, () => hourlyHits);
  await userRefresh();
  pollTimer = setInterval(userRefresh, 5000);

  // Strip wx_pending / err from URL after successful login
  if (wxPending || wxErr) {
    const clean = location.pathname;
    history.replaceState(null, '', clean);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement) {
    if (document.activeElement.id === 'login-key') userLogin();
    else if (document.activeElement.id === 'bind-key') userBindKey();
  }
});

init();
