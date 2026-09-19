// Driver report panel — contamination, overflow, skip, photo note

(function () {

  // ── Panel HTML injected once ─────────────────────────────────────────────

  const PANEL_HTML = `
<div id="report-overlay" onclick="reportClose(event)">
  <div id="report-panel">
    <div id="report-handle"></div>
    <div id="report-content"></div>
  </div>
</div>`;

  document.body.insertAdjacentHTML('beforeend', PANEL_HTML);

  // ── Screens ──────────────────────────────────────────────────────────────

  const SCREENS = {

    contamination: {
      title: '🚫 Contamination',
      color: '#dc2626',
      steps: [
        {
          label: 'What type?',
          key: 'type',
          options: [
            { value: 'black_bags',     label: 'Black trash bags' },
            { value: 'recyclables',    label: 'Recyclables mixed in' },
            { value: 'non_compost',    label: 'Non-compostable items' },
            { value: 'food_waste',     label: 'Excessive food waste' },
            { value: 'other',          label: 'Other' },
          ],
        },
        {
          label: 'How many / how much?',
          key: 'amount',
          optionsFn: (answers) => {
            if (answers.type === 'black_bags') {
              return [
                { value: '1',    label: '1 bag' },
                { value: '2',    label: '2 bags' },
                { value: '3+',   label: '3+ bags' },
              ];
            }
            return [
              { value: 'minor',    label: 'Minor' },
              { value: 'moderate', label: 'Moderate' },
              { value: 'severe',   label: 'Severe' },
            ];
          },
        },
      ],
      format: (answers, photo) => {
        const typeMap = {
          black_bags: 'black trash bags', recyclables: 'recyclables mixed in',
          non_compost: 'non-compostable items', food_waste: 'excessive food waste', other: 'contamination',
        };
        const t = typeMap[answers.type] || answers.type;
        const a = answers.amount === '3+' ? '×3+' : answers.amount === '1' ? '×1' : answers.amount === '2' ? '×2' : `· ${answers.amount}`;
        return `🚫 Contamination: ${t} ${a}${photo ? ' · 📷 photo taken' : ''}`;
      },
    },

    overflow: {
      title: '📦 Overflow',
      color: '#d97706',
      steps: [
        {
          label: 'Bin overflow — how much?',
          key: 'severity',
          options: [
            { value: 'slight',   label: 'Slight (< 25% over)' },
            { value: 'moderate', label: 'Moderate (25–50% over)' },
            { value: 'severe',   label: 'Severe (> 50% / cannot collect)' },
          ],
        },
        {
          label: 'Anything else?',
          key: 'extra',
          options: [
            { value: 'collected',     label: 'Collected anyway' },
            { value: 'left_behind',   label: 'Left behind — too full' },
            { value: 'partial',       label: 'Partial collection' },
          ],
        },
      ],
      format: (answers, photo) =>
        `📦 Overflow: ${answers.severity}${answers.extra ? ' · ' + answers.extra.replace('_', ' ') : ''}${photo ? ' · 📷 photo taken' : ''}`,
    },

    skip: {
      title: '⏭ Skip Stop',
      color: '#6b7280',
      steps: [
        {
          label: 'Reason for skip?',
          key: 'reason',
          options: [
            { value: 'bin_not_out',   label: 'Bin not at curb' },
            { value: 'gate_locked',   label: 'Gate locked / no access' },
            { value: 'cust_request',  label: 'Customer called to skip' },
            { value: 'on_hold',       label: 'Account on hold' },
            { value: 'other',         label: 'Other' },
          ],
        },
      ],
      format: (answers, photo) => {
        const map = {
          bin_not_out: 'bin not at curb', gate_locked: 'gate locked',
          cust_request: 'customer request', on_hold: 'account on hold', other: 'skipped',
        };
        return `⏭ Skipped: ${map[answers.reason] || answers.reason}${photo ? ' · 📷 photo taken' : ''}`;
      },
    },

    photo: {
      title: '📷 Photo Note',
      color: '#2563eb',
      steps: [
        {
          label: 'What does this photo show?',
          key: 'subject',
          options: [
            { value: 'general',       label: 'General note / condition' },
            { value: 'damage',        label: 'Bin damage' },
            { value: 'access',        label: 'Access issue' },
            { value: 'contamination', label: 'Contamination' },
            { value: 'overflow',      label: 'Overflow' },
          ],
        },
      ],
      format: (answers, photo) =>
        `📷 Photo note: ${answers.subject}${photo ? ' · 📷 photo taken' : ''}`,
      requiresPhoto: true,
    },

  };

  // ── State ─────────────────────────────────────────────────────────────────

  let activeScreen = null;
  let answers = {};
  let currentStep = 0;
  let photoTaken = false;
  let activeRowNumber = null;
  let activeTabName = null;

  // ── Open / close ──────────────────────────────────────────────────────────

  /* One tap is the whole point. Tapping Contamination files "🚫 Contamination"
     immediately and says so; the confirmation offers "Add detail" for anyone
     who wants to say which kind and how much. Fast by default, precise when it
     matters — and we stop losing reports because a driver could not face three
     more taps in the rain. */
  /* What gets written into the sheet for each button.

     The words are the ones shown ON the button, so changing the wording in
     settings changes both at once — there is no way for the button to promise
     one thing and the sheet to record another. The icon is fixed, because
     writeNote() below uses it to recognise and replace a previous report on
     the same stop. */
  const ICON = { contamination: '🚫', overflow: '📦', skip: '⏭', photo: '📷' };
  const FALLBACK = {
    contamination: 'Contamination',
    overflow: 'Overflow',
    skip: 'Skipped',
    photo: 'Photo',
  };
  const LABELS = { ...FALLBACK };

  // Called by driver.js whenever settings arrive or change.
  window.reportLabels = function (styles) {
    for (const kind of Object.keys(FALLBACK)) {
      const v = styles && styles['report-' + kind + '-label'];
      LABELS[kind] = (typeof v === 'string' && v.trim()) ? v.trim() : FALLBACK[kind];
    }
  };

  function headlineFor(type) {
    return ICON[type] ? ICON[type] + ' ' + LABELS[type] : null;
  }

  window.reportFile = function(type, rowNumber, tabName) {
    const headline = headlineFor(type);
    if (!headline) return;

    activeRowNumber = rowNumber;
    activeTabName = tabName;

    writeNote(rowNumber, headline);
    toastFiled(headline, type, rowNumber, tabName);
  };

  /* Add to the note rather than replace it. Filing an incident used to
     overwrite whatever the office had written on that stop — a gate code, a
     dog warning — with no way to get it back. */
  function writeNote(rowNumber, addition) {
    const existing = (typeof existingNote === 'function' ? existingNote(rowNumber) : '').trim();
    // Replace a previous report of our own rather than stacking them up.
    const cleaned = existing
      .split(' · ')
      .filter(part => !/^(🚫|📦|⏭|📷)/.test(part.trim()))
      .join(' · ')
      .trim();
    const combined = cleaned ? cleaned + ' · ' + addition : addition;

    if (typeof queueNoteWrite === 'function') return queueNoteWrite(rowNumber, combined);
    return fetch(
      `/api/routes/${encodeURIComponent(activeTabName)}/stops/${rowNumber}/notes`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: combined }) }
    );
  }

  function toastFiled(headline, type, rowNumber, tabName) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerHTML = escHtml(headline) + ' logged ' +
      '<button id="report-detail-btn" style="margin-left:8px;padding:4px 10px;border:none;' +
      'border-radius:var(--r-control);background:var(--done-btn-bg);color:var(--done-btn-text);' +
      'font-weight:700;font-family:inherit;cursor:pointer;">Add detail</button>';
    toast.classList.add('show');

    const btn = document.getElementById('report-detail-btn');
    if (btn) btn.addEventListener('click', () => {
      toast.classList.remove('show');
      reportOpen(type, rowNumber, tabName);
    });

    setTimeout(() => toast.classList.remove('show'), 6000);
  }

  window.reportOpen = function(type, rowNumber, tabName) {
    activeScreen = SCREENS[type];
    answers = {};
    currentStep = 0;
    photoTaken = false;
    activeRowNumber = rowNumber;
    activeTabName = tabName;
    if (!activeScreen) return;
    document.getElementById('report-overlay').classList.add('open');
    renderStep();
  };

  window.reportClose = function(e) {
    if (e && e.target !== document.getElementById('report-overlay')) return;
    document.getElementById('report-overlay').classList.remove('open');
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderStep() {
    const screen = activeScreen;
    const step = screen.steps[currentStep];
    const options = step.optionsFn ? step.optionsFn(answers) : step.options;
    const isLast = currentStep === screen.steps.length - 1;
    const totalSteps = screen.steps.length;

    const optHtml = options.map(o => `
      <button class="report-option ${answers[step.key] === o.value ? 'selected' : ''}"
              style="${answers[step.key] === o.value ? `background:${screen.color};color:#fff;border-color:${screen.color};` : ''}"
              onclick="reportSelect('${step.key}', '${o.value}')">
        ${escHtml(o.label)}
      </button>`).join('');

    const photoHtml = `
      <div class="report-photo-row">
        <label class="report-photo-btn ${photoTaken ? 'taken' : ''}">
          ${photoTaken ? '📷 Photo taken ✓' : '📷 Take photo (optional)'}
          <input type="file" accept="image/*" capture="environment" onchange="reportPhoto(this)" style="display:none;">
        </label>
      </div>`;

    const progressHtml = totalSteps > 1
      ? `<div class="report-progress">${Array.from({length: totalSteps}, (_, i) =>
          `<div class="report-dot ${i <= currentStep ? 'active' : ''}" style="${i <= currentStep ? `background:${screen.color};` : ''}"></div>`
        ).join('')}</div>`
      : '';

    document.getElementById('report-content').innerHTML = `
      <div class="report-header" style="border-top: 4px solid ${screen.color};">
        <div class="report-title">${screen.title}</div>
        <button class="report-close-btn" onclick="document.getElementById('report-overlay').classList.remove('open')">✕</button>
      </div>
      ${progressHtml}
      <div class="report-step-label">${escHtml(step.label)}</div>
      <div class="report-options">${optHtml}</div>
      ${isLast ? photoHtml : ''}
      <div class="report-footer">
        ${currentStep > 0 ? `<button class="report-back" onclick="reportBack()">← Back</button>` : '<span></span>'}
        ${isLast
          ? `<button class="report-submit" style="background:${screen.color};"
                     onclick="reportSubmit()" ${!answers[step.key] ? 'disabled' : ''}>
               ✓ Save Report
             </button>`
          : `<button class="report-next" style="background:${screen.color};"
                     onclick="reportNext()" ${!answers[step.key] ? 'disabled' : ''}>
               Next →
             </button>`}
      </div>`;
  }

  window.reportSelect = function(key, value) {
    answers[key] = value;
    renderStep();
  };

  window.reportNext = function() {
    const step = activeScreen.steps[currentStep];
    if (!answers[step.key]) return;
    currentStep++;
    renderStep();
  };

  window.reportBack = function() {
    if (currentStep > 0) { currentStep--; renderStep(); }
  };

  window.reportPhoto = function(input) {
    if (input.files && input.files[0]) {
      photoTaken = true;
      renderStep();
    }
  };

  window.reportSubmit = async function() {
    const step = activeScreen.steps[currentStep];
    if (!answers[step.key]) return;

    const noteText = activeScreen.format(answers, photoTaken);
    document.getElementById('report-overlay').classList.remove('open');

    // Get route tab from driver.js context
    const tabName = activeTabName;
    const rowNumber = activeRowNumber;

    if (!tabName || !rowNumber) {
      alert('Could not save — route info missing.');
      return;
    }

    // Goes through the same queue as everything else, so a report filed in a
    // dead zone waits rather than being lost to an alert nobody reads.
    await writeNote(rowNumber, noteText);
    if (window.notifyStopsUpdated) window.notifyStopsUpdated();
    if (typeof renderNavCard === 'function') renderNavCard();
  };

  function classifyReportNote(text) {
    if (text.startsWith('⏭') || text.includes('hold')) return 'hold';
    if (text.startsWith('🚫') || text.includes('severe')) return 'urgent';
    return 'info';
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

})();
