// Driver route page — runs after routes.js is loaded

(function () {
  const routeId = window.location.pathname.split('/').pop();
  const route = ROUTES.find(r => r.id === routeId);

  if (!route) {
    document.getElementById('loading').innerHTML =
      '<div class="error-state">Route not found. <br><a href="/">Back to routes</a></div>';
    throw new Error('Unknown route id: ' + routeId);
  }

  const root = document.documentElement;

  // Load and apply server-side style settings (includes per-route color)
  function applyStyles(styles) {
    for (const [key, val] of Object.entries(styles)) {
      if (key.startsWith('--')) {
        root.style.setProperty(key, (key === '--radius' || key === '--route-card-radius' || key.endsWith('-font-size') || key.endsWith('-padding')) ? val + 'px' : val);
      }
    }
    // Use stored route color if available, else fall back to routes.js value
    const routeColor = styles['route-' + route.id] || route.color;
    root.style.setProperty('--route-color', routeColor);
  }
  fetch('/api/styles').then(r => r.json()).then(applyStyles).catch(() => {
    // Fallback to hardcoded colors
    root.style.setProperty('--route-color', route.color);
    root.style.setProperty('--route-color-dark', route.colorDark);
    root.style.setProperty('--route-color-light', route.colorLight);
  });
  document.title = route.name + ' — Evergreen';
  document.getElementById('route-name').textContent = route.name;
  document.getElementById('route-day').textContent = route.day;

  let allStops = [];
  let routeDate = '';
  let ws = null;
  let wsReconnectTimer = null;

  // ── Render ──────────────────────────────────────────────────────────────

  function render() {
    const stops = allStops.filter(s => !s.isSectionHeader);
    const done = stops.filter(s => s.done);
    const total = stops.length;
    const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;

    document.getElementById('progress-bar').style.width = pct + '%';
    document.getElementById('progress-text').textContent =
      done.length + ' of ' + total + ' done';
    document.getElementById('route-date').textContent = routeDate || '';

    renderAllStops();
  }

  function renderAllStops() {
    const list = document.getElementById('stops-list');
    const html = [];

    // Pending stops in original order with section headers
    let hasPending = false;
    for (const item of allStops) {
      if (item.isSectionHeader) {
        html.push(sectionHeaderHtml(item));
        continue;
      }
      if (item.done) continue;
      hasPending = true;
      html.push(stopCardHtml(item, false));
    }

    if (!hasPending) {
      html.push('<div style="text-align:center;padding:32px 20px;color:var(--text-muted);font-size:14px;">All stops complete! 🎉</div>');
    }

    // Completed stops at the bottom
    const completed = allStops.filter(s => !s.isSectionHeader && s.done);
    if (completed.length > 0) {
      html.push('<div class="section-header completed-section-header">✓ Completed — tap Undo to reopen</div>');
      completed.forEach(s => html.push(stopCardHtml(s, true)));
    }

    list.innerHTML = html.join('');
    attachStopListeners(list);
  }

  function sectionHeaderHtml(item) {
    let style = '';
    let textColor = 'var(--route-color-dark)';
    if (item.rowColor) {
      const r = Math.round((item.rowColor.red   ?? 0) * 255);
      const g = Math.round((item.rowColor.green ?? 0) * 255);
      const b = Math.round((item.rowColor.blue  ?? 0) * 255);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      textColor = brightness > 150 ? '#1a1a1a' : '#ffffff';
      style = ` style="background:rgb(${r},${g},${b});color:${textColor};border-color:rgba(0,0,0,0.15);"`;
    }
    const extra = [item.accountName, item.directions, item.notes].filter(Boolean);
    const extraHtml = extra.length
      ? `<div style="font-size:12px;font-weight:400;margin-top:4px;opacity:0.9;">${extra.map(esc).join(' · ')}</div>`
      : '';
    return `<div class="section-header"${style}>${esc(item.sectionLabel)}${extraHtml}</div>`;
  }

  function stopCardHtml(item, isCompleted) {
    const urgency = item.noteUrgency;
    const noteClass = urgency === 'urgent' ? 'note-urgent'
                    : urgency === 'hold'   ? 'note-hold'
                    : 'note-info';

    const nameOrAddr = item.accountName || item.address;
    const addrLine = item.accountName && item.address
      ? item.address + (item.city ? ', ' + item.city : '')
      : (item.city || '');

    const noteHtml = item.notes
      ? `<div class="stop-note ${noteClass}" data-row="${item.rowNumber}">${esc(item.notes)}</div>`
      : (!isCompleted ? `<div class="stop-note-add" data-row="${item.rowNumber}">+ Add note</div>` : '');

    const actionBtn = isCompleted
      ? `<button class="undo-btn" data-row="${item.rowNumber}">Undo</button>`
      : `<button class="done-btn" data-row="${item.rowNumber}" aria-label="Mark done">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round">
             <polyline points="20 6 9 17 4 12"/>
           </svg>
         </button>`;

    // Map + Directions buttons
    const mapQuery = encodeURIComponent((item.address || '') + (item.city ? ' ' + item.city : ''));
    const mapBtn = item.address
      ? `<a class="stop-action-btn" href="https://maps.google.com/?q=${mapQuery}" target="_blank" rel="noopener">📍 Map</a>`
      : '';
    const dirBtn = item.directions
      ? `<button class="stop-action-btn" data-dir-row="${item.rowNumber}">↗ Directions</button>`
      : '';

    // Row color from sheet as card background
    let colorStyle = '';
    if (item.rowColor) {
      const r = Math.round((item.rowColor.red   ?? 0) * 255);
      const g = Math.round((item.rowColor.green ?? 0) * 255);
      const b = Math.round((item.rowColor.blue  ?? 0) * 255);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      const textColor = brightness > 150 ? '#1a1a1a' : '#ffffff';
      colorStyle = `style="background:rgb(${r},${g},${b}); border-color:rgba(0,0,0,0.12); color:${textColor};"`;
    }

    return `
      <div class="stop-card${isCompleted ? ' completed' : ''}" data-row="${item.rowNumber}" ${colorStyle}>
        <div class="stop-main">
          <div class="stop-info">
            <div class="stop-account">${esc(nameOrAddr)}</div>
            ${addrLine ? `<div class="stop-address">${esc(addrLine)}</div>` : ''}
            ${(mapBtn || dirBtn) ? `<div class="stop-action-row">${mapBtn}${dirBtn}</div>` : ''}
            ${noteHtml}
          </div>
          ${actionBtn}
        </div>
        ${item.directions ? `<div class="stop-directions" id="dir-${item.rowNumber}">${esc(item.directions)}</div>` : ''}
      </div>`;
  }

  function attachStopListeners(container) {
    container.querySelectorAll('.done-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('pressed');
        setTimeout(() => markDone(Number(btn.dataset.row)), 120);
      });
    });
    container.querySelectorAll('.undo-btn').forEach(btn => {
      btn.addEventListener('click', () => markUndone(Number(btn.dataset.row)));
    });
    container.querySelectorAll('.stop-note, .stop-note-add').forEach(el => {
      el.addEventListener('click', () => editNote(Number(el.dataset.row), el));
    });
    container.querySelectorAll('[data-dir-row]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.dataset.dirRow;
        const dirEl = document.getElementById('dir-' + row);
        if (!dirEl) return;
        const visible = dirEl.style.display !== 'none';
        dirEl.style.display = visible ? 'none' : 'block';
        btn.textContent = visible ? '↗ Directions' : '↙ Hide';
      });
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async function markDone(rowNumber) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (!stop) return;
    stop.done = true;
    render();
    try {
      const res = await fetch(
        `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: true }) }
      );
      if (!res.ok) throw new Error();
    } catch {
      stop.done = false;
      render();
      showToast('Could not save — check connection');
    }
  }

  async function markUndone(rowNumber) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (!stop) return;
    stop.done = false;
    render();
    try {
      await fetch(
        `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: false }) }
      );
    } catch {
      stop.done = true;
      render();
      showToast('Could not save — check connection');
    }
  }

  function editNote(rowNumber, el) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (!stop) return;
    const prev = stop.notes || '';

    const ta = document.createElement('textarea');
    ta.className = 'note-edit';
    ta.value = prev;
    ta.placeholder = 'Add a note…';
    el.replaceWith(ta);
    ta.focus();

    async function save() {
      const val = ta.value.trim();
      stop.notes = val;
      stop.noteUrgency = classifyNote(val);
      render();
      try {
        await fetch(
          `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}/notes`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: val }) }
        );
      } catch {
        showToast('Note not saved — check connection');
      }
    }

    ta.addEventListener('blur', save);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
      if (e.key === 'Escape') { ta.value = prev; ta.blur(); }
    });
  }

  function classifyNote(text) {
    if (!text) return null;
    const l = text.toLowerCase();
    if (['skip','hold','on hold','cancel'].some(k => l.includes(k))) return 'hold';
    if (['get ','eow','asap','today','now'].some(k => l.includes(k))) return 'urgent';
    return 'info';
  }

  // ── Load data ────────────────────────────────────────────────────────────

  async function loadRoute() {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('main-content').style.display = 'none';
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(route.tabName)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      allStops = data.items;
      window.allStops = allStops; // expose for map.js
      routeDate = data.routeDate || '';
      render();
      if (window.notifyStopsUpdated) window.notifyStopsUpdated();
      document.getElementById('loading').style.display = 'none';
      document.getElementById('main-content').style.display = 'block';
    } catch (e) {
      document.getElementById('loading').innerHTML =
        `<div class="error-state">Could not load route.<br><small>${e.message}</small>
         <button onclick="location.reload()">Retry</button></div>`;
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = () => {
      document.getElementById('ws-status').style.display = 'none';
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    };

    ws.onclose = () => {
      document.getElementById('ws-status').style.display = 'block';
      wsReconnectTimer = setTimeout(connectWS, 4000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.tabName && msg.tabName !== route.tabName) return;

      if (msg.type === 'stop-updated') {
        const s = allStops.find(s => s.rowNumber === msg.rowNumber);
        if (s) { s.done = msg.done; render(); if (window.notifyStopsUpdated) window.notifyStopsUpdated(); }
      }
      if (msg.type === 'note-updated') {
        const s = allStops.find(s => s.rowNumber === msg.rowNumber);
        if (s) { s.notes = msg.notes; s.noteUrgency = msg.noteUrgency; render(); if (window.notifyStopsUpdated) window.notifyStopsUpdated(); }
      }
      if (msg.type === 'style-updated') {
        applyStyles(msg.styles);
      }
    };
  }

  // ── Start My Day (backup — once per day) ────────────────────────────────

  const backupKey = 'backup_done_' + route.id + '_' + new Date().toISOString().slice(0, 10);
  const backupTabKey = 'backup_tab_' + route.id + '_' + new Date().toISOString().slice(0, 10);

  function initStartDayBtn() {
    const btn = document.getElementById('start-day-btn');
    if (localStorage.getItem(backupKey)) {
      btn.textContent = '✓ Backup saved';
      btn.disabled = true;
    }
  }

  document.getElementById('start-day-btn').addEventListener('click', async function () {
    const btn = this;
    if (localStorage.getItem(backupKey)) return;
    btn.disabled = true;
    btn.textContent = 'Creating backup…';
    try {
      const res = await fetch(
        `/api/routes/${encodeURIComponent(route.tabName)}/backup`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      localStorage.setItem(backupKey, '1');
      localStorage.setItem(backupTabKey, data.newTitle || '');
      btn.textContent = '✓ Backup saved';
      document.getElementById('view-original-btn').style.display = 'inline-flex';
    } catch {
      btn.textContent = 'Backup failed';
      btn.disabled = false;
      showToast('Could not create backup');
    }
  });

  // ── View Original ────────────────────────────────────────────────────────

  function initViewOriginalBtn() {
    const btn = document.getElementById('view-original-btn');
    if (localStorage.getItem(backupKey)) {
      btn.style.display = 'inline-flex';
    }
    btn.addEventListener('click', async () => {
      const tabName = localStorage.getItem(backupTabKey);
      if (!tabName) { showToast('No backup found for today'); return; }
      btn.textContent = 'Loading…';
      btn.disabled = true;
      try {
        const res = await fetch(`/api/backup/${encodeURIComponent(tabName)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        showOriginal(data.items, tabName);
      } catch {
        showToast('Could not load original');
      } finally {
        btn.textContent = '📋 View Original';
        btn.disabled = false;
      }
    });
  }

  function showOriginal(items, tabName) {
    const overlay = document.getElementById('original-overlay');
    const list = document.getElementById('original-list');
    const html = [];
    for (const item of items) {
      if (item.isSectionHeader) {
        html.push(`<div class="section-header">${esc(item.sectionLabel)}</div>`);
        continue;
      }
      const nameOrAddr = item.accountName || item.address;
      const addrLine = item.accountName && item.address
        ? item.address + (item.city ? ', ' + item.city : '') : (item.city || '');
      html.push(`
        <div class="stop-card">
          <div class="stop-main">
            <div class="stop-info">
              <div class="stop-account">${esc(nameOrAddr)}</div>
              ${addrLine ? `<div class="stop-address">${esc(addrLine)}</div>` : ''}
              ${item.notes ? `<div class="stop-note note-info">${esc(item.notes)}</div>` : ''}
            </div>
          </div>
        </div>`);
    }
    list.innerHTML = html.join('');
    overlay.style.display = 'flex';
  }

  document.getElementById('original-close').addEventListener('click', () => {
    document.getElementById('original-overlay').style.display = 'none';
  });

  // ── Utilities ────────────────────────────────────────────────────────────

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  loadRoute();
  connectWS();
  initStartDayBtn();
  initViewOriginalBtn();

})();
