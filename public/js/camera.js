/* camera.js — take a picture of a stop and get it somewhere useful.
 *
 * One tap opens the rear camera straight to the shutter. The photo is shrunk
 * on the phone, uploaded, and a link appended to the stop's note so it is
 * reachable from the spreadsheet.
 *
 * Shrinking first is the whole trick. A modern phone photo is 3-5 MB; at
 * 1600px and quality 0.8 it lands around 200-400 KB. On rural cell service
 * that is the difference between a driver waiting at the bin and not
 * noticing. The detail lost is irrelevant for showing a contaminated bin.
 */
(function () {
  const MAX_EDGE = 1600;
  const QUALITY = 0.8;

  /* Hidden input, created once. capture="environment" opens the rear camera
     directly rather than a file browser — that is what makes it one tap. */
  let input = null;
  function ensureInput() {
    if (input) return input;
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    return input;
  }

  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Could not process the photo'))),
          'image/jpeg',
          QUALITY
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the photo')); };
      img.src = url;
    });
  }

  function say(message, isError) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), isError ? 7000 : 4000);
  }

  /**
   * Called by the 📷 button on a stop card.
   * Deliberately NOT queued for later like notes are: an upload needs the
   * image bytes, and holding several megabytes of photo in phone storage
   * across a shift is a different problem from holding a line of text. If
   * there is no signal it says so plainly and the driver can retry.
   */
  window.capturePhoto = function (rowNumber, tabName, accountName) {
    const el = ensureInput();
    el.value = '';                       // so picking the same file twice still fires
    el.onchange = async () => {
      const file = el.files && el.files[0];
      if (!file) return;

      say('Preparing photo…');
      let blob;
      try {
        blob = await shrink(file);
      } catch (err) {
        return say(err.message, true);
      }

      const kb = Math.round(blob.size / 1024);
      say('Uploading photo (' + kb + ' KB)…');

      try {
        const res = await fetch(
          '/api/photo?tab=' + encodeURIComponent(tabName) +
          '&row=' + encodeURIComponent(rowNumber) +
          '&account=' + encodeURIComponent(accountName || ''),
          { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

        // Put the link on the stop so it is reachable from the spreadsheet,
        // through the same queue everything else uses.
        const existing = (typeof existingNote === 'function' ? existingNote(rowNumber) : '').trim();
        const stripped = existing
          .split(' · ')
          .filter(part => !/^📷 Photo/.test(part.trim()))
          .join(' · ')
          .trim();
        const note = (stripped ? stripped + ' · ' : '') + '📷 Photo: ' + data.link;

        if (typeof queueNoteWrite === 'function') await queueNoteWrite(rowNumber, note);
        say('Photo saved');
      } catch (err) {
        say('Photo not saved — ' + err.message, true);
      }
    };
    el.click();
  };
})();
