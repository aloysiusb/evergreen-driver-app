/* camera.js — take a picture of a stop and get it somewhere useful.
 *
 * One tap opens the rear camera straight to the shutter. The photo is shrunk
 * on the phone, uploaded, and a link appended to the stop's note so it is
 * reachable from the spreadsheet.
 *
 * Shrinking first is the whole trick. A modern phone photo is 3-5 MB. At
 * 1280px WebP it lands around 60-120 KB — small enough that the upload
 * finishes before the driver has put the phone away, even on one bar. Where
 * WebP is not available it falls back to JPEG at roughly double that, which
 * is still well under what it was.
 *
 * 1280px is a deliberate floor, not a minimum-viable guess: it is wide enough
 * to read a label or show what is wrong with a bin, which is the entire job.
 */
(function () {
  const MAX_EDGE = 1280;
  const QUALITY_WEBP = 0.7;
  const QUALITY_JPEG = 0.72;   // JPEG needs more to look the same

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
        /* Ask for WebP first — roughly 30% smaller than JPEG at the same
           visible quality. A browser that cannot encode it does NOT error:
           toBlob quietly hands back a PNG, which is far LARGER than the JPEG
           we were sending before. So check what actually came back rather
           than trusting the request, and re-encode as JPEG if it is not WebP. */
        canvas.toBlob(
          (webp) => {
            if (webp && webp.type === 'image/webp') return resolve(webp);
            canvas.toBlob(
              (jpeg) => (jpeg ? resolve(jpeg) : reject(new Error('Could not process the photo'))),
              'image/jpeg',
              QUALITY_JPEG
            );
          },
          'image/webp',
          QUALITY_WEBP
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
          {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'image/jpeg' },
            body: blob,
          }
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
        // So the app does not ask for a second photo of a stop that has one.
        window.photoTakenFor = window.photoTakenFor || {};
        window.photoTakenFor[rowNumber] = true;
        say('Photo saved');
      } catch (err) {
        say('Photo not saved — ' + err.message, true);
      }
    };
    el.click();
  };
})();
