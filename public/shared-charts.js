// Reusable chart helpers shared between admin and user dashboards.
// Exposes window.SharedCharts.{ COLORS, MODEL_COLORS, fmt, esc, fillHourly,
// drawHourly, drawShare, attachTooltip }.
(function () {
  const COLORS = {
    green: '#3dd68c', red: '#ef5f5f',
    accent: '#7170ff',
    grid: 'rgba(255,255,255,0.04)', label: '#5a5e66',
  };
  const MODEL_COLORS = ['#7170ff', '#3dd68c', '#f0b429', '#a78bfa', '#ef5f5f', '#60a5fa', '#f472b6'];

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return n.toLocaleString();
  }

  function esc(s) {
    if (s == null || s === '') return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function fillHourly(rows) {
    if (!rows || !rows.length) return [];
    const map = new Map(rows.map(h => [h.slot, h]));
    const firstDay = rows[0].slot.slice(0, 10);
    const lastDay = rows[rows.length - 1].slot.slice(0, 10);
    const filled = [];
    const d = new Date(firstDay + 'T00:00:00');
    const end = new Date(lastDay + 'T23:00:00');
    while (d <= end) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const slot = `${yyyy}-${mm}-${dd} ${hh}`;
      filled.push(map.get(slot) || { slot, total: 0, ok: 0, err: 0, tokens: 0 });
      d.setHours(d.getHours() + 1);
    }
    return filled;
  }

  function drawHourly(canvas, scrollEl, data) {
    if (!data.length || !scrollEl.getBoundingClientRect().width) return [];
    const BAR_W = 18, GAP = 3;
    const slotW = BAR_W + GAP;
    const totalW = data.length * slotW + 40;
    const h = 110, dateH = 20;
    const pad = { t: dateH + 2, b: 16 };
    const ch = h - pad.t - pad.b;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalW * dpr;
    canvas.height = h * dpr;
    canvas.style.width = totalW + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const maxVal = Math.max(...data.map(d => d.total), 1);
    const hits = [];
    ctx.clearRect(0, 0, totalW, h);

    const daySpans = [];
    let curDay = '', spanStart = 0;
    data.forEach((d, i) => {
      const day = d.slot.slice(0, 10);
      if (day !== curDay) {
        if (curDay) daySpans.push({ day: curDay, x1: spanStart * slotW, x2: i * slotW });
        curDay = day; spanStart = i;
      }
    });
    if (curDay) daySpans.push({ day: curDay, x1: spanStart * slotW, x2: data.length * slotW });

    const dayColors = ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.04)'];
    daySpans.forEach((span, si) => {
      ctx.fillStyle = dayColors[si % 2];
      ctx.fillRect(span.x1, 0, span.x2 - span.x1, h);
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(span.day + 'T12:00:00').getDay()];
      const label = `${span.day.slice(5)}  ${weekday}`;
      const cx = (span.x1 + span.x2) / 2;
      ctx.font = '600 11px Inter, system-ui';
      ctx.fillStyle = '#7170ff';
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, 14);
      if (si > 0) {
        ctx.strokeStyle = 'rgba(113,112,255,0.2)'; ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(span.x1, 0); ctx.lineTo(span.x1, h); ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    for (let i = 0; i <= 2; i++) {
      const y = pad.t + ch * (1 - i / 2);
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke();
    }

    data.forEach((d, i) => {
      const x = i * slotW + slotW / 2;
      const okH = Math.max((d.ok / maxVal) * ch, d.ok ? 1 : 0);
      const errH = Math.max((d.err / maxVal) * ch, d.err ? 1 : 0);
      const totalH = okH + errH;
      const barY = pad.t + ch - totalH;
      ctx.fillStyle = COLORS.green;
      ctx.beginPath(); ctx.roundRect(x - BAR_W / 2, barY + errH, BAR_W, okH, [0, 0, 2, 2]); ctx.fill();
      if (errH > 0) {
        ctx.fillStyle = COLORS.red;
        ctx.beginPath(); ctx.roundRect(x - BAR_W / 2, barY, BAR_W, errH, [2, 2, 0, 0]); ctx.fill();
      }
      const hour = d.slot.slice(11, 13);
      if (parseInt(hour) % 3 === 0) {
        ctx.font = '9px Inter, system-ui'; ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.label;
        ctx.fillText(hour + ':00', x, h - 3);
      }
      hits.push({ x: i * slotW, x2: (i + 1) * slotW, d });
    });

    scrollEl.scrollLeft = totalW;
    return hits;
  }

  function drawShare(el, data, nameKey, max) {
    if (!el) return;
    if (!data.length) {
      el.textContent = '';
      const empty = document.createElement('span');
      empty.style.cssText = 'color:var(--text-4);font-size:11px';
      empty.textContent = 'No data';
      el.appendChild(empty);
      return;
    }
    const html = data.slice(0, max || 7).map((m, i) => {
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const tokens = m.tokens ? ' &middot; ' + fmt(m.tokens) + ' tok' : '';
      const name = esc(m[nameKey] || m.name || m.model || 'unknown');
      return '<div class="share-item">'
        + '<div class="share-row">'
        + '<span class="share-name">' + name + '</span>'
        + '<span class="share-pct">' + m.pct + '% (' + fmt(m.count) + tokens + ')</span>'
        + '</div>'
        + '<div class="share-track"><div class="share-fill" style="width:' + m.pct + '%;background:' + color + '"></div></div>'
        + '</div>';
    }).join('');
    el.innerHTML = html;
  }

  function attachTooltip(canvas, scrollEl, tipEl, getHits) {
    function showTip(e, html) {
      tipEl.innerHTML = html;
      tipEl.classList.add('show');
      const x = Math.min(e.clientX + 12, window.innerWidth - tipEl.offsetWidth - 8);
      const y = e.clientY - tipEl.offsetHeight - 8;
      tipEl.style.left = x + 'px';
      tipEl.style.top = (y < 4 ? e.clientY + 16 : y) + 'px';
    }
    function hideTip() { tipEl.classList.remove('show'); }
    canvas.addEventListener('mousemove', function (e) {
      const rect = this.getBoundingClientRect();
      const mx = e.clientX - rect.left + scrollEl.scrollLeft;
      const hit = getHits().find(h => mx >= h.x && mx <= h.x2);
      if (hit) {
        const day = hit.d.slot.slice(0, 10);
        const hour = hit.d.slot.slice(11, 13);
        showTip(e, '<div class="tip-label">' + day + ' ' + hour + ':00</div>'
          + '<div class="tip-row"><span class="tip-dot" style="background:' + COLORS.green + '"></span>Success <span class="tip-val">' + ((hit.d.ok || 0).toLocaleString()) + '</span></div>'
          + '<div class="tip-row"><span class="tip-dot" style="background:' + COLORS.red + '"></span>Failed <span class="tip-val">' + ((hit.d.err || 0).toLocaleString()) + '</span></div>'
          + '<div class="tip-row" style="color:var(--text-3)">Tokens <span class="tip-val">' + fmt(hit.d.tokens || 0) + '</span></div>');
      } else hideTip();
    });
    canvas.addEventListener('mouseleave', hideTip);
  }

  window.SharedCharts = { COLORS, MODEL_COLORS, fmt, esc, fillHourly, drawHourly, drawShare, attachTooltip };
})();
