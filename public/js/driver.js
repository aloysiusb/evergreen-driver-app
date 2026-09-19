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
  /* The variable loop lives in styles.js. The route colour is the exception:
     it is stored under a per-route key rather than as a CSS variable, so it
     has to be picked out by hand.

     No socket option — this page already has one, and hands style messages to
     window.onStyleMessage from its own handler. */
  initStyles(styles => {
    const routeColor = (styles && styles['route-' + route.id]) || route.color;
    root.style.setProperty('--route-color', routeColor);
  });

  // Whatever happens to the request, the route must still have its colour.
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
    attachReportListeners(list);
  }

  /* Black or white text on a sheet colour, decided by real contrast.
   *
   * The old rule was (r*299 + g*587 + b*114)/1000 > 150. That formula is a
   * 1950s television approximation and it badly underweights green: pure
   * #00ff00 — about as bright as a colour gets — scores 149.7 and lost to a
   * threshold of 150 by a third of a point, so every neon green row in the
   * Tuesday sheet got WHITE text on it.
   *
   * This is the WCAG relative-luminance calculation instead, with the standard
   * 0.179 crossover. It gets #00ff00 right, still puts white on genuinely dark
   * colours like the #9900ff purple, and will keep being right for whatever
   * colour someone reaches for in the sheet next.
   */
  function textOn(r, g, b) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.179 ? '#1a1a1a' : '#ffffff';
  }

  function sectionHeaderHtml(item) {
    let style = '';
    let textColor = 'var(--route-color-dark)';
    if (item.rowColor) {
      const r = Math.round((item.rowColor.red   ?? 0) * 255);
      const g = Math.round((item.rowColor.green ?? 0) * 255);
      const b = Math.round((item.rowColor.blue  ?? 0) * 255);
      textColor = textOn(r, g, b);
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

    // Incident buttons lived only on the map card, so a driver working from
    // this list never saw them. One tap files the report.
    const reportBtns = isCompleted ? '' : `
      <div class="stop-report-row">
        <button class="stop-report-btn" data-report="contamination" data-row="${item.rowNumber}"
                title="Contamination" aria-label="Report contamination">🚫</button>
        <button class="stop-report-btn" data-report="overflow" data-row="${item.rowNumber}"
                title="Overflow" aria-label="Report overflow">📦</button>
        <button class="stop-report-btn" data-report="skip" data-row="${item.rowNumber}"
                title="Skipped" aria-label="Report skipped">⏭</button>
        <button class="stop-report-btn" data-report="photo" data-row="${item.rowNumber}"
                title="Photo taken" aria-label="Note that a photo was taken">📷</button>
      </div>`;
    const dirBtn = '';  // directions shown as chip now
    const accessChip = item.directions
      ? `<div class="stop-access-chip">🔑 ${esc(item.directions)}</div>`
      : '';

    // Row color from sheet as card background
    let colorStyle = '';
    let sheetColored = '';
    if (item.rowColor) {
      const r = Math.round((item.rowColor.red   ?? 0) * 255);
      const g = Math.round((item.rowColor.green ?? 0) * 255);
      const b = Math.round((item.rowColor.blue  ?? 0) * 255);
      const textColor = textOn(r, g, b);
      colorStyle = `style="background:rgb(${r},${g},${b}); border-color:rgba(0,0,0,0.12); color:${textColor};"`;
      sheetColored = ' has-sheet-color';
    }

    return `
      <div class="stop-card${isCompleted ? ' completed' : ''}${sheetColored}" data-row="${item.rowNumber}" ${colorStyle}>
        <div class="stop-main">
          <div class="stop-info">
            <div class="stop-account">${esc(nameOrAddr)}</div>
            ${addrLine ? `<div class="stop-address">${esc(addrLine)}</div>` : ''}
            ${mapBtn ? `<div class="stop-action-row">${mapBtn}</div>` : ''}
            ${reportBtns}
            ${accessChip}
            ${noteHtml}
          </div>
          ${actionBtn}
        </div>
      </div>`;
  }

  function attachReportListeners(container) {
    container.querySelectorAll('.stop-report-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();          // never let it also toggle the stop
        const row = Number(btn.dataset.row);
        if (btn.dataset.report === 'photo') {
          // 📷 means take one, not note that one was taken.
          const stop = allStops.find(s => s.rowNumber === row);
          if (typeof capturePhoto === 'function') capturePhoto(row, route.tabName, stop && stop.accountName);
        } else if (typeof reportFile === 'function') {
          reportFile(btn.dataset.report, row, route.tabName);
        }
      });
    });
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

  // ── Offline write queue ──────────────────────────────────────────────────
  //
  // Drivers work in dead zones. A write that fails used to REVERT the local
  // state — turning "not synced yet" into "never happened", with only a 3
  // second toast to notice it by. Now the driver's action stands, the write
  // is parked here, and it goes out when signal returns.
  //
  // Entries are keyed so repeated edits to the same field collapse: we replay
  // the driver's final intent, not every toggle along the way. Retries are
  // safe because every queued write is an idempotent PATCH of absolute state
  // ({done:true}, {notes:"..."}) rather than a delta.

  const QUEUE_KEY = 'pending_writes_' + route.id;
  let pendingWrites = readQueue();
  let flushing = false;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
    catch { return []; }   // private mode, cleared storage, corrupt JSON
  }

  function persistQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(pendingWrites)); }
    catch {}               // storage full or blocked — queue still works in memory
    renderPendingBadge();
  }

  function queueWrite(key, url, body) {
    const entry = { key, url, body, ts: Date.now() };
    const i = pendingWrites.findIndex(w => w.key === key);
    if (i >= 0) pendingWrites[i] = entry; else pendingWrites.push(entry);
    persistQueue();
  }

  function dropQueued(key) {
    const i = pendingWrites.findIndex(w => w.key === key);
    if (i >= 0) { pendingWrites.splice(i, 1); persistQueue(); }
  }

  // Single place every stop write goes through: try it now, park it if the
  // network says no. Never rewinds what the driver did.
  async function sendOrQueue(key, url, body) {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      dropQueued(key);     // a later successful write supersedes a parked one
      return true;
    } catch {
      queueWrite(key, url, body);
      return false;
    }
  }

  // Server data is authoritative EXCEPT where the driver has work that hasn't
  // reached it yet. Without this, a reload inside a dead zone would repaint
  // every parked stop as not-done and the driver would watch their morning
  // disappear — the exact fear the queue exists to remove.
  function applyPendingToStops() {
    for (const w of pendingWrites) {
      const m = w.key.match(/^(done|notes):(\d+)$/);
      if (!m) continue;
      const stop = allStops.find(st => st.rowNumber === Number(m[2]));
      if (!stop) continue;
      if (m[1] === 'done') {
        stop.done = w.body.done;
      } else {
        stop.notes = w.body.notes;
        stop.noteUrgency = classifyNote(w.body.notes);
      }
    }
  }

  async function flushQueue() {
    if (flushing || !pendingWrites.length) return;
    if (navigator.onLine === false) return;
    flushing = true;
    try {
      // Oldest first, and stop at the first failure — if we're still down
      // there's no point burning the rest, and order is preserved.
      while (pendingWrites.length) {
        const w = pendingWrites[0];
        try {
          const res = await fetch(w.url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(w.body),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
        } catch {
          break;
        }
        pendingWrites.shift();
        persistQueue();
      }
      if (!pendingWrites.length) showToast('All changes saved');
    } finally {
      flushing = false;
    }
  }

  // Standing indicator, not a toast — a driver who glanced away still sees
  // exactly where they stand.
  function renderPendingBadge() {
    const el = document.getElementById('pending-status');
    if (!el) return;
    const n = pendingWrites.length;
    el.style.display = n ? 'block' : 'none';
    if (n) el.textContent = n === 1
      ? '1 change waiting for signal — it will save automatically'
      : n + ' changes waiting for signal — they will save automatically';
  }

  /* report.js writes notes too, and was doing it with a bare fetch — so an
     incident filed in a dead zone was lost with nothing but an alert. Hand it
     the same queue the done-button uses. */
  window.queueNoteWrite = function (rowNumber, notes) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (stop) { stop.notes = notes; stop.noteUrgency = classifyNote(notes); render(); }
    return sendOrQueue(
      'notes:' + rowNumber,
      `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}/notes`,
      { notes }
    );
  };

  /* What is already on the stop, so an incident can be added to the office's
     note instead of erasing it. */
  window.existingNote = function (rowNumber) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    return stop && stop.notes ? String(stop.notes) : '';
  };

  window.addEventListener('online', flushQueue);
  setInterval(flushQueue, 30000);

  // ── Actions ──────────────────────────────────────────────────────────────

  async function markDone(rowNumber) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (!stop) return;
    stop.done = true;
    render();
    await sendOrQueue(
      'done:' + rowNumber,
      `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}`,
      { done: true }
    );
  }

  async function markUndone(rowNumber) {
    const stop = allStops.find(s => s.rowNumber === rowNumber);
    if (!stop) return;
    stop.done = false;
    render();
    // Shares the 'done:' key with markDone so a done/undone flip collapses to
    // whichever the driver landed on. This used to ignore res.ok entirely, so
    // a server 500 counted as success and the sheet kept saying done.
    await sendOrQueue(
      'done:' + rowNumber,
      `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}`,
      { done: false }
    );
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
      await sendOrQueue(
        'notes:' + rowNumber,
        `/api/routes/${encodeURIComponent(route.tabName)}/stops/${rowNumber}/notes`,
        { notes: val }
      );
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
      applyPendingToStops();              // keep unsynced work visible
      window.allStops = allStops;         // expose for map.js
      window._routeTabName = route.tabName; // expose for report.js
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
      flushQueue();   // socket is proof we have signal again
    };

    ws.onclose = () => {
      document.getElementById('ws-status').style.display = 'block';
      wsReconnectTimer = setTimeout(connectWS, 4000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.tabName && msg.tabName !== route.tabName) return;

      if (msg.type === 'stop-updated') {
        // If we have an unsent change for this stop, ours is the newer intent —
        // don't let an echo of older server state undo it on screen.
        if (pendingWrites.some(w => w.key === 'done:' + msg.rowNumber)) return;
        const s = allStops.find(s => s.rowNumber === msg.rowNumber);
        if (s) { s.done = msg.done; render(); if (window.notifyStopsUpdated) window.notifyStopsUpdated(); }
      }
      if (msg.type === 'note-updated') {
        const s = allStops.find(s => s.rowNumber === msg.rowNumber);
        if (s) { s.notes = msg.notes; s.noteUrgency = msg.noteUrgency; render(); if (window.notifyStopsUpdated) window.notifyStopsUpdated(); }
      }
      if (msg.type === 'style-updated' && window.onStyleMessage) {
        window.onStyleMessage(msg);
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

  // ── Keep the screen awake ────────────────────────────────────────────────
  // A driver working a route shouldn't have to keep waking the phone with wet
  // or gloved hands. The lock drops automatically when the tab is hidden, so
  // it costs nothing once they put the phone down, and it must be re-taken on
  // every return to visibility — the browser does not restore it.

  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;   // iOS < 16.4, Firefox
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}   // denied, low battery, or not permitted — not worth surfacing
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      flushQueue();   // coming back to the app is a good moment to retry
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
  initStartDayBtn();
  initViewOriginalBtn();
  requestWakeLock();
  renderPendingBadge();   // writes parked in a previous session still count
  flushQueue();

})();
