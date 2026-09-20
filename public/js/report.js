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
      color: '#425512',
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
      color: '#194B0C',
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
      color: '#085B30',
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
      color: '#004E2E',
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
  /* Whatever the driver types on the last step. Held here rather than read off
     the element at submit time, because renderStep() rebuilds the panel's
     innerHTML and would throw the text away on any re-render. */
  let freeText = '';
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

      const l2 = styles && styles['report-' + kind + '-l2'];
      const l3 = styles && styles['report-' + kind + '-l3'];
      QUICK[kind] = {
        // A saved BLANK is a real choice — it means "no second level" — so
        // only fall back when the setting is absent altogether.
        l2: typeof l2 === 'string' ? splitOptions(l2) : QUICK_FALLBACK[kind].l2,
        l3: typeof l3 === 'string' ? splitOptions(l3) : QUICK_FALLBACK[kind].l3,
      };
      AUTO_PHOTO[kind] = String(styles && styles['report-' + kind + '-photo']) === 'yes';
    }
  };

  /* The second array — what appears when one of the four is tapped, and only
     then. Short labels on purpose: these are read off a circle, and they are
     also the words that land in the Driver Notes column.

     One level, not two. A driver standing at a bin in the rain will take two
     taps; asking for three is how a report stops being filed at all. */
  /* What shows if the settings have not loaded, or were never saved.
     'Recyclables' is deliberately 'Recycling': the longer word broke across
     two lines inside the circle as 'Recyclable' + 's'. */
  const QUICK_FALLBACK = {
    contamination: { l2: ['1 bag', '2 bags', '3+ bags', 'Recycling', 'Non-compost', 'Other'], l3: [] },
    overflow:      { l2: ['Slight', 'Moderate', 'Severe', 'Left behind'], l3: [] },
    skip:          { l2: ['Not at curb', 'Gate locked', 'Customer', 'On hold'], l3: [] },
    photo:         { l2: [], l3: [] },
  };
  let QUICK = JSON.parse(JSON.stringify(QUICK_FALLBACK));
  const AUTO_PHOTO = {};

  function splitOptions(text) {
    return String(text || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 8);           // more than eight circles is not a quick choice
  }

  /* @param level 2 or 3. An empty level means the report is filed at the one
     before it, so a route that needs no third step never shows one. */
  window.reportQuickOptions = function (type, level) {
    const set = QUICK[type];
    if (!set) return [];
    return (level === 3 ? set.l3 : set.l2) || [];
  };

  window.reportAutoPhoto = function (type) {
    return AUTO_PHOTO[type] === true;
  };

  /* Refine a report already filed by the first tap. Goes through the same
     writeNote, which strips the earlier marker rather than stacking a second
     one on the same stop. */
  window.reportFileDetail = function (type, rowNumber, tabName, detail) {
    const headline = headlineFor(type);
    if (!headline) return;
    activeRowNumber = rowNumber;
    activeTabName = tabName;
    const text = Array.isArray(detail) ? detail.filter(Boolean).join(' · ') : detail;
    return writeNote(rowNumber, text ? headline + ': ' + text : headline);
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
    toastFiled(headline);
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

  /* Says it landed, and nothing else. Detail is offered on the card itself
     now — a second array of buttons appearing where the first one was —
     rather than behind a button on a message that disappears after six
     seconds and was easy to miss entirely. */
  function toastFiled(headline) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = headline + ' logged';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  window.reportOpen = function(type, rowNumber, tabName) {
    freeText = '';
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

    /* The lists cover what happens most days. This is for the day they do
       not — "wrong bin left out", "third time this month", a gate code that
       changed. Optional: leaving it empty changes nothing. */
    const freeHtml = `
      <textarea id="report-free-text" class="report-free-text" rows="2"
                placeholder="Anything else? (optional)"
                oninput="reportFreeText(this.value)">${escHtml(freeText)}</textarea>`;

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
      ${isLast ? freeHtml : ''}
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

  window.reportFreeText = function(value) {
    freeText = value;      // no re-render: that would move the caret
  };

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

    const typed = freeText.trim().replace(/\s+/g, ' ').slice(0, 160);
    const noteText = activeScreen.format(answers, photoTaken) + (typed ? ' · ' + typed : '');
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
