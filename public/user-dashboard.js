// User self-service dashboard. Talks to /user/* endpoints scoped by user_session.
const SC = window.SharedCharts;

let hourlyHits = [];
let pollTimer = null;

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
  location.reload();
}

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

async function init() {
  // probe session
  const r = await fetch('/user/me', { credentials: 'same-origin' });
  if (r.status === 401) {
    document.getElementById('login-screen').style.display = '';
    document.getElementById('app').style.display = 'none';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
  const tip = document.getElementById('chart-tip');
  const canvas = document.getElementById('chart-hourly');
  const scroll = document.getElementById('chart-scroll');
  SC.attachTooltip(canvas, scroll, tip, () => hourlyHits);
  await userRefresh();
  pollTimer = setInterval(userRefresh, 5000);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'login-key') {
    userLogin();
  }
});

init();
