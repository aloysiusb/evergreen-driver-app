// Driver route page — runs after routes.js is loaded

(function () {
  const routeId = window.location.pathname.split('/').pop();
  const route = ROUTES.find(r => r.id === routeId);

  if (!route) {
    document.getElementById('loading').innerHTML =
      '<div class="error-state">Route not found. <br><a href="/">Back to routes</a></div>';
    throw new Error('Unknown route id: ' + routeId);
  }

  // Apply color theme
  const root = document.documentElement;
  root.style.setProperty('--route-color', route.color);
  root.style.setProperty('--route-color-dark', route.colorDark);
  root.style.setProperty('--route-color-light', route.colorLight);
  document.title = route.name + ' — Evergreen';
  document.getElementById('route-name').textContent = route.name;
  document.getElementById('route-day').textContent = route.day;

  let allStops = [];
  let routeDate = '';
  let ws = null;
  let wsReconnectTimer = null;
  let completedExpanded = false;

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

    renderPendingStops();
    updateCompletedSummary(done.length);
  }

  function renderPendingStops() {
    const list = document.getElementById('stops-list');
    const html = [];

    for (const item of allStops) {
      if (item.isSectionHeader) {
        html.push('<div class="section-header">' + esc(item.sectionLabel) + '</div>');
        continue;
      }
      if (item.done) continue;
      html.push(stopCardHtml(item, false));
    }

    if (html.length === 0) {
      html.push('<div style="text-align:center;padding:48px 20px;color:var(--text-muted);font-size:14px;">All stops complete! 🎉</div>');
    }

    list.innerHTML = html.join('');
    attachStopListeners(list);
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

    return `
      <div class="stop-card${isCompleted ? ' completed' : ''}" data-row="${item.rowNumber}">
        <div class="stop-main">
          <div class="stop-info">
            <div class="stop-account">${esc(nameOrAddr)}</div>
            ${addrLine ? `<div class="stop-address">${esc(addrLine)}</div>` : ''}
            ${noteHtml}
          </div>
          ${actionBtn}
        </div>
        ${item.directions ? `<div class="stop-directions">↗ ${esc(item.directions)}</div>` : ''}
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
  }

  function updateCompletedSummary(count) {
    const summary = document.getElementById('completed-summary');
    if (count === 0) { summary.style.display = 'none'; return; }
    summary.style.display = 'block';
    document.getElementById('completed-count').textContent =
      '✓ ' + count + ' stop' + (count !== 1 ? 's' : '') + ' done';
    document.getElementById('completed-toggle').textContent =
      completedExpanded ? 'Hide ▴' : 'Show ▾';
    if (completedExpanded) renderCompletedList();
  }

  function renderCompletedList() {
    const completed = allStops.filter(s => !s.isSectionHeader && s.done);
    const list = document.getElementById('completed-list');
    list.innerHTML = completed.map(s => stopCardHtml(s, true)).join('');
    attachStopListeners(list);
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
      routeDate = data.routeDate || '';
      render();
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
        if (s) { s.done = msg.done; render(); }
      }
      if (msg.type === 'note-updated') {
        const s = allStops.find(s => s.rowNumber === msg.rowNumber);
        if (s) { s.notes = msg.notes; s.noteUrgency = msg.noteUrgency; render(); }
      }
    };
  }

  // ── Completed toggle ─────────────────────────────────────────────────────

  document.getElementById('completed-summary').addEventListener('click', function (e) {
    if (e.target.closest('#completed-list')) return;
    completedExpanded = !completedExpanded;
    document.getElementById('completed-toggle').textContent =
      completedExpanded ? 'Hide ▴' : 'Show ▾';
    if (completedExpanded) {
      renderCompletedList();
    } else {
      document.getElementById('completed-list').innerHTML = '';
    }
  });

  // ── Start My Day (backup) ─────────────────────────────────────────────────

  document.getElementById('start-day-btn').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Creating backup…';
    try {
      const res = await fetch(
        `/api/routes/${encodeURIComponent(route.tabName)}/backup`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error();
      btn.textContent = '✓ Backup created';
      setTimeout(() => { btn.style.display = 'none'; }, 2500);
    } catch {
      btn.textContent = 'Backup failed';
      btn.disabled = false;
      showToast('Could not create backup');
    }
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

})();
