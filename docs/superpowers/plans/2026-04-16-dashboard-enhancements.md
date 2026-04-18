# Dashboard Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API Key and Token usage charts, infinite scroll for the logs table, and client-side column sorting to the dashboard.

**Architecture:** Four independent changes: (1) extend /api/stats/charts with two new group-by queries; (2) render two new bar charts in the Charts tab reusing the existing share-list pattern; (3) add offset support to /api/logs and attach a scroll listener on .tbl-container that appends rows; (4) add onclick handlers on each th that sort the in-memory row array with CSS arrow indicators.

**Tech Stack:** Node.js (server.mjs), vanilla JS (public/dashboard.js), HTML (dashboard.html), CSS (public/dashboard.css), better-sqlite3

---

## File Map

| File | Changes |
|------|---------|
| `server.mjs` | Extend /api/stats/charts with apiKeyShare + tokenShare queries; add offset param to /api/logs |
| `dashboard.html` | Add chart-apikeys and chart-tokens cards in Charts tab; add data-col + onclick attrs to log th elements |
| `public/dashboard.js` | Add drawApiKeyShare() + drawTokenShare(); wire into loadCharts(); infinite-scroll logic; sort state + sortTable() |
| `public/dashboard.css` | .sort-asc / .sort-desc arrow styles; th[data-col] cursor pointer |

---

### Task 1: Backend — extend /api/stats/charts with API Key and Token share data

**Files:**
- Modify: `server.mjs:144-165`

- [ ] **Step 1: Add two new SQL queries inside the charts handler**

In server.mjs, locate the charts handler (line 144). After the modelShare block and before res.end, insert:

```js
    const apiKeyRows = db.prepare(`
      SELECT COALESCE(api_key_name, '(none)') as name,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs GROUP BY name ORDER BY count DESC
    `).all();
    const apiKeyTotal = apiKeyRows.reduce((s, r) => s + r.count, 0);
    const apiKeyShare = apiKeyRows.map(r => ({
      name: r.name, count: r.count, tokens: r.tokens,
      pct: apiKeyTotal ? Math.round(r.count * 100 / apiKeyTotal) : 0
    }));

    const tokenRows = db.prepare(`
      SELECT COALESCE(token_name, '(none)') as name,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM logs GROUP BY name ORDER BY count DESC
    `).all();
    const tokenTotal = tokenRows.reduce((s, r) => s + r.count, 0);
    const tokenShare = tokenRows.map(r => ({
      name: r.name, count: r.count, tokens: r.tokens,
      pct: tokenTotal ? Math.round(r.count * 100 / tokenTotal) : 0
    }));
```

- [ ] **Step 2: Include new data in the JSON response**

Change the final res.end line in the charts handler:

OLD:
```js
    res.end(JSON.stringify({ hourly, modelShare }));
```

NEW:
```js
    res.end(JSON.stringify({ hourly, modelShare, apiKeyShare, tokenShare }));
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: add apiKeyShare and tokenShare to /api/stats/charts"
```

---

### Task 2: Backend — add offset parameter to /api/logs

**Files:**
- Modify: `server.mjs:188-211`

- [ ] **Step 1: Read the offset param**

After the line:
```js
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 1000);
```

add:
```js
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
```

- [ ] **Step 2: Append OFFSET to the main SELECT**

Change the logs SELECT (currently ending `LIMIT ?`) to end with `LIMIT ? OFFSET ?` and pass offset as the final bind param:

```js
    const logs = db.prepare(`SELECT id, ts, model, status, duration_ms, stream, input_tokens, output_tokens, preview, request_summary, error, token_name, api_key_name FROM logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: add offset param to /api/logs for infinite scroll"
```

---

### Task 3: HTML — add chart cards and sortable table headers

**Files:**
- Modify: `dashboard.html:187-203` (Charts tab)
- Modify: `dashboard.html:104-115` (log table thead)

- [ ] **Step 1: Add two new chart cards in the Charts tab**

Replace the Charts tab section with:

```html
  <!-- ==================== TAB: CHARTS ==================== -->
  <div class="tab-content" id="tab-charts">

    <div class="charts">
      <div class="chart-card">
        <div class="chart-title">Requests by Hour</div>
        <div class="chart-scroll" id="chart-scroll">
          <canvas class="chart-canvas" id="chart-hourly"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Model Share</div>
        <div class="share-list" id="chart-models"></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">API Key Usage</div>
        <div class="share-list" id="chart-apikeys"></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Token Usage</div>
        <div class="share-list" id="chart-tokens"></div>
      </div>
    </div>

  </div>
```

- [ ] **Step 2: Add data-col and onclick to each th**

Replace the thead:

```html
        <thead>
          <tr>
            <th data-col="ts" onclick="sortTable('ts')">Time</th>
            <th data-col="token_name" onclick="sortTable('token_name')">Token</th>
            <th data-col="api_key_name" onclick="sortTable('api_key_name')">API Key</th>
            <th data-col="model" onclick="sortTable('model')">Model</th>
            <th data-col="status" onclick="sortTable('status')">Status</th>
            <th data-col="duration_ms" onclick="sortTable('duration_ms')">Latency</th>
            <th data-col="tokens" onclick="sortTable('tokens')">Tokens</th>
            <th>Type</th>
            <th style="width:100%">Preview</th>
          </tr>
        </thead>
```

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat: add API key/token chart cards and sortable table headers"
```

---

### Task 4: CSS — sort arrow indicators

**Files:**
- Modify: `public/dashboard.css` (append at end)

- [ ] **Step 1: Append sort-related CSS**

At the very end of public/dashboard.css, append:

```css
/* Sortable table headers */
th[data-col] {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
th[data-col]:hover { color: var(--text-1); }
th[data-col]::after {
  content: '';
  display: inline-block;
  width: 8px;
  margin-left: 4px;
  opacity: 0.3;
}
th[data-col].sort-asc::after {
  content: '\25B2';
  opacity: 1;
  color: var(--accent-bright, #7170ff);
}
th[data-col].sort-desc::after {
  content: '\25BC';
  opacity: 1;
  color: var(--accent-bright, #7170ff);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/dashboard.css
git commit -m "style: sort arrow indicators for log table headers"
```

---

### Task 5: JS — draw API Key and Token share bar charts

**Files:**
- Modify: `public/dashboard.js` (after drawModelShare, before chartLoaded)

- [ ] **Step 1: Add drawApiKeyShare and drawTokenShare functions**

After the closing brace of drawModelShare (around line 453), insert the two functions.
Each function uses esc() for all user-controlled strings and fmt() for numbers — same pattern as drawModelShare.

```js
function drawApiKeyShare(data) {
  const el = document.getElementById('chart-apikeys');
  if (!data || !data.length) {
    el.textContent = '';
    el.insertAdjacentHTML('beforeend', '<span style="color:var(--text-4);font-size:11px">No data</span>');
    return;
  }
  const rows = data.slice(0, 7).map((m, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    const nameH = esc(m.name);
    return '<div class="share-item">' +
      '<div class="share-row">' +
        '<span class="share-name">' + nameH + '</span>' +
        '<span class="share-pct">' + m.pct + '% (' + fmt(m.count) + ' req \u00B7 ' + fmt(m.tokens) + ' tok)</span>' +
      '</div>' +
      '<div class="share-track">' +
        '<div class="share-fill" style="width:' + m.pct + '%;background:' + color + '"></div>' +
      '</div>' +
    '</div>';
  }).join('');
  el.textContent = '';
  el.insertAdjacentHTML('beforeend', rows);
}

function drawTokenShare(data) {
  const el = document.getElementById('chart-tokens');
  if (!data || !data.length) {
    el.textContent = '';
    el.insertAdjacentHTML('beforeend', '<span style="color:var(--text-4);font-size:11px">No data</span>');
    return;
  }
  const rows = data.slice(0, 7).map((m, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    const nameH = esc(m.name);
    return '<div class="share-item">' +
      '<div class="share-row">' +
        '<span class="share-name">' + nameH + '</span>' +
        '<span class="share-pct">' + m.pct + '% (' + fmt(m.count) + ' req \u00B7 ' + fmt(m.tokens) + ' tok)</span>' +
      '</div>' +
      '<div class="share-track">' +
        '<div class="share-fill" style="width:' + m.pct + '%;background:' + color + '"></div>' +
      '</div>' +
    '</div>';
  }).join('');
  el.textContent = '';
  el.insertAdjacentHTML('beforeend', rows);
}
```

- [ ] **Step 2: Wire into loadCharts**

Change:
```js
    const { hourly, modelShare } = await r.json();
```
to:
```js
    const { hourly, modelShare, apiKeyShare, tokenShare } = await r.json();
```

Add after `drawModelShare(modelShare);`:
```js
    drawApiKeyShare(apiKeyShare);
    drawTokenShare(tokenShare);
```

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.js
git commit -m "feat: API key and token usage bar charts on Charts tab"
```

---

### Task 6: JS — infinite scroll for logs table

**Files:**
- Modify: `public/dashboard.js`

- [ ] **Step 1: Add state variables at top of dashboard.js**

After line 1 (`let autoRefresh = true, timer, filters = {};`), insert:

```js
let logRows = [];       // accumulated rows for infinite scroll
let logOffset = 0;      // rows already fetched
const LOG_PAGE = 100;   // page size
let logLoading = false;
let logExhausted = false;
let sortCol = null;
let sortDir = 'desc';
```

- [ ] **Step 2: Replace refresh() with two-function version**

Delete the entire existing `async function refresh() { ... }` block (lines 53-128).
Replace with:

```js
async function refresh() {
  logOffset = 0;
  logExhausted = false;
  logRows = [];
  await fetchLogPage(true);
}

async function fetchLogPage(isFirstPage) {
  if (logLoading || logExhausted) return;
  logLoading = true;
  try {
    const params = new URLSearchParams();
    if (filters.from) params.set('from', filters.from.replace('T', ' '));
    if (filters.to) params.set('to', filters.to.replace('T', ' '));
    if (filters.model) params.set('model', filters.model);
    if (filters.token_name) params.set('token_name', filters.token_name);
    params.set('limit', String(LOG_PAGE));
    params.set('offset', String(logOffset));
    if (document.getElementById('show-errors').checked) params.set('errors_only', '1');

    const r = await fetch('/api/logs?' + params);
    const { logs: data, stats, modelStats } = await r.json();

    if (isFirstPage) {
      document.getElementById('s-total').textContent = fmt(stats.total);
      document.getElementById('s-ok').textContent = fmt(stats.ok);
      document.getElementById('s-err').textContent = fmt(stats.err);
      document.getElementById('s-tokens').textContent = fmt(stats.tokens);
      document.getElementById('s-avg').textContent = (stats.avgMs || 0) + 'ms';

      const ms = document.getElementById('model-stats');
      ms.textContent = '';
      ms.insertAdjacentHTML('beforeend', (modelStats || []).map(m =>
        '<div class="mpill">' +
          '<span class="mpill-dot"></span>' +
          '<span class="mpill-name">' + esc(m.model) + '</span>' +
          '<span class="mpill-meta">' + m.count + 'x \u00B7 ' + fmt(m.tokens) + ' tok \u00B7 ' + m.avgMs + 'ms</span>' +
        '</div>'
      ).join(''));

      const sel = document.getElementById('f-model');
      const cur = sel.value;
      if (modelStats && modelStats.length) {
        sel.textContent = '';
        sel.insertAdjacentHTML('beforeend',
          '<option value="">All models</option>' +
          modelStats.map(m => '<option value="' + esc(m.model) + '"' + (cur === m.model ? ' selected' : '') + '>' + esc(m.model) + '</option>').join(''));
      }

      logRows = [];
    }

    if (data.length < LOG_PAGE) logExhausted = true;
    logRows = logRows.concat(data);
    logOffset += data.length;
    renderLogTable(isFirstPage);
  } finally {
    logLoading = false;
  }
}
```

- [ ] **Step 3: Add renderLogTable function**

After fetchLogPage, insert:

```js
function renderLogTable(replaceAll) {
  const tbody = document.getElementById('log-body');

  if (!logRows.length) {
    tbody.textContent = '';
    tbody.insertAdjacentHTML('beforeend',
      '<tr><td colspan="9">' +
        '<div class="empty-wrap">' +
          '<div class="empty-ring"></div>' +
          '<div class="empty-text">No requests yet</div>' +
          '<div class="empty-sub">Requests to /v1/messages will appear here</div>' +
        '</div>' +
      '</td></tr>');
    return;
  }

  const rowsToRender = replaceAll ? logRows : logRows.slice(logOffset - (logRows.length - (logRows.length - LOG_PAGE < 0 ? 0 : logRows.length - LOG_PAGE)));

  const html = (replaceAll ? logRows : rowsToRender).map(l => {
    const sc = l.status < 400 ? 'ok' : 'err';
    const badge = l.stream
      ? '<span class="badge b-stream">SSE</span>'
      : '<span class="badge b-sync">Sync</span>';
    const tok = (l.input_tokens || l.output_tokens)
      ? fmt(l.input_tokens) + '<span style="color:var(--text-4);margin:0 2px">&rarr;</span>' + fmt(l.output_tokens)
      : '<span style="color:var(--text-4)">-</span>';
    const preview = l.error || l.preview || '';
    const previewClass = l.error ? 'c-error' : 'c-preview';
    return '<tr onclick="openDetail(' + l.id + ')">' +
      '<td class="c-ts">' + (l.ts || '') + '</td>' +
      '<td class="c-token">' + esc(l.token_name || '-') + '</td>' +
      '<td class="c-token">' + esc(l.api_key_name || '-') + '</td>' +
      '<td class="c-model">' + esc(l.model || '-') + '</td>' +
      '<td><span class="c-status ' + sc + '">' + l.status + '</span></td>' +
      '<td class="c-dur">' + (l.duration_ms ? l.duration_ms + 'ms' : '-') + '</td>' +
      '<td class="c-tok">' + tok + '</td>' +
      '<td>' + badge + '</td>' +
      '<td class="' + previewClass + '">' + esc(preview) + '</td>' +
    '</tr>';
  }).join('');

  if (replaceAll) {
    tbody.textContent = '';
    tbody.insertAdjacentHTML('beforeend', html);
  } else {
    tbody.insertAdjacentHTML('beforeend', html);
  }
}
```

- [ ] **Step 4: Add scroll listener (before "// ---- Init ----")**

```js
// Infinite scroll
(function() {
  const container = document.querySelector('.tbl-container');
  if (!container) return;
  container.addEventListener('scroll', () => {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 80) {
      fetchLogPage(false);
    }
  });
})();
```

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.js
git commit -m "feat: infinite scroll for logs table with offset pagination"
```

---

### Task 7: JS — client-side column sort

**Files:**
- Modify: `public/dashboard.js` (add sortTable function)

- [ ] **Step 1: Add sortTable function after renderLogTable**

```js
function sortTable(col) {
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = 'asc';
  }

  document.querySelectorAll('th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col) th.classList.add('sort-' + sortDir);
  });

  logRows.sort((a, b) => {
    let av = a[col], bv = b[col];
    if (col === 'tokens') {
      av = (a.input_tokens || 0) + (a.output_tokens || 0);
      bv = (b.input_tokens || 0) + (b.output_tokens || 0);
    }
    if (av == null) av = '';
    if (bv == null) bv = '';
    const cmp = (typeof av === 'number' && typeof bv === 'number')
      ? av - bv
      : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  renderLogTable(true);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/dashboard.js
git commit -m "feat: client-side column sort for logs table"
```

---

## Self-Review

**Spec coverage:**
1. Charts — API Key usage: Task 1 (SQL) + Task 3 (HTML cards) + Task 5 (drawApiKeyShare)
2. Charts — Token usage: Task 1 (SQL) + Task 3 (HTML cards) + Task 5 (drawTokenShare)
3. Infinite scroll: Task 2 (offset backend) + Task 6 (scroll listener + pagination)
4. Table header sort: Task 3 (HTML data-col) + Task 4 (CSS arrows) + Task 7 (sortTable)
5. Live refresh preserved: refresh() resets to offset=0, calls fetchLogPage(true) — timer unchanged.

**insertAdjacentHTML with esc():** All user-controlled strings pass through esc() before being inserted. Static HTML structure uses string concatenation with no user data directly embedded.

**No placeholders.**
