// Driver report panel — contamination, overflow, skip, photo note

(function () {

  // ── State ─────────────────────────────────────────────────────────────────

  /* Which stop the report being filed belongs to. Set by every entry point
     before it writes, because writeNote() needs the row and the tab and the
     caller is the only one who knows them. */
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
  const ICON = {
    contamination: '🚫', overflow: '📦', skip: '⏭', photo: '📷',
    combo: '⚠️', locked: '🔒', bear: '🐻',
  };
  /* Short on purpose, for the same reason 'Recyclables' became 'Recycling'
     below: these are read off a circle, and with seven buttons three now
     share a row on a phone. 'Contamination' broke as 'Contami' + 'nation'.
     Any of them can be renamed in the style editor. */
  const FALLBACK = {
    contamination: 'Contam',
    overflow: 'Overflow',
    /* Contamination AND overflow on the same bin, as one report. Filing the
       two separately means two notes on one stop, and the second overwrites
       the first in the sheet's notes column.
       'Both' rather than a name of its own: it sits between Contam and
       Overflow, so what it means is legible from where it is. */
    combo: 'Both',
    /* A lock was only reachable through Skip, so a driver who got in anyway,
       or who wants the locked gate on record without skipping the stop, had
       nowhere to put it. */
    locked: 'Locked',
    /* Bears open compost bins in this valley. It was going in as free text
       or not at all, which means it never counted for anything. */
    bear: 'Bear',
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
    /* One tap covers both problems. The words describe the bin, not each
       problem separately — a driver is not going to grade them apart. */
    combo:         { l2: ['Slight', 'Moderate', 'Severe', 'Left behind'], l3: [] },
    /* What was locked, not whether the stop was skipped. If it was skipped
       that is a Skip; this records the lock either way. */
    locked:        { l2: ['Gate', 'Bin lid', 'Enclosure', 'Code failed', 'Got in anyway'], l3: [] },
    bear:          { l2: ['In the bin', 'Knocked over', 'Bin damaged', 'Latch broken', 'Bear on site'], l3: [] },
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
    /* Replace a previous report of our own rather than stacking them up.
       Read from ICON rather than a list written out here: this was four
       icons hard-coded, and adding a button without noticing meant its
       reports appended forever — "🐻 Bear · 🐻 Bear: In the bin · 🐻 Bear…"
       down the notes column. Now a new kind is covered the moment it has an
       icon. startsWith, not a regex, because ⚠️ is two code points and does
       not survive being dropped into a character class. */
    const reportIcons = Object.values(ICON);
    const cleaned = existing
      .split(' · ')
      .filter(part => {
        const t = part.trim();
        return !reportIcons.some(icon => t.startsWith(icon));
      })
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

  function classifyReportNote(text) {
    if (text.startsWith('⏭') || text.includes('hold')) return 'hold';
    if (text.startsWith('🚫') || text.includes('severe')) return 'urgent';
    return 'info';
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

})();
