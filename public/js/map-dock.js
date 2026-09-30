// map-dock.js — the round controls along the top of the map, on both pages.
//
// Its own file for the same reason map-ui.css is: the driver app and the demo
// both draw this dock, and the moment the behaviour is written twice the two
// start to drift. It already had: the demo got the dock's new position from
// the shared stylesheet but none of the script behind it, so its buttons sat
// on top of the compass and there was no way to fold them away.
//
// Nothing here knows anything about a route, a stop or a map — it is the tray
// and its handle. The driver app's map.js calls measureDock() when the map is
// resized; the demo needs no code at all.

(function () {

  const FOLDED_KEY = 'ev_dock_folded';

  function dockEl() { return document.getElementById('map-dock'); }

  /* The dock's height, published as --dock-h for everything that sits under
     it: the compass and coordinates, the live directions, the hazard picker,
     the navigation-app strip.
   *
   * It cannot be a constant. The tray is one row on a desktop and two on a
   * phone, and a stub of a row when it is folded — and folding it is the whole
   * point of the handle, so the things below have to come up with it.
   *
   * Measured after a frame: a fold changes the layout, and offsetHeight read
   * in the same tick is the height it had before. */
  function measureDock() {
    const el = dockEl();
    if (!el) return;
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (h > 0) {
        document.documentElement.style.setProperty('--dock-h', (h + 8) + 'px');
      }
    });
  }

  /* The compass's real height, published as --geo-h for the directions that
     start below it.
   *
   * It is no more constant than the dock. The rose on its own is about 52px;
   * where the screen is wide enough to carry them, the coordinates sit under
   * it and the corner grows to around 76px — and a tap on the rose brings
   * them out on a phone too, for eight seconds. Clearance written as a flat
   * 62px was right for exactly one of those states, which is why the
   * directions and the road conditions came down on top of the compass on
   * anything wider than a phone. */
  function measureGeo() {
    const el = document.getElementById('geo-chip');
    if (!el) return;
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--geo-h', h + 'px');
    });
  }

  function applyDockFolded(folded) {
    const el = dockEl();
    if (!el) return;
    const wasFolded = el.classList.contains('folded');
    el.classList.toggle('folded', folded);

    /* Fly the buttons out, but only when they are actually arriving. Replaying
       the animation on every measure — or when the page loads already open —
       makes the whole tray twitch for no reason. */
    if (wasFolded && !folded) {
      el.classList.remove('flying');
      void el.offsetWidth;          // restart the animation rather than ignore it
      el.classList.add('flying');
    }

    /* The handle is optional. The demo's dock is three buttons that never need
       folding away, and a page without one still gets the measurement. */
    const btn = document.getElementById('dock-toggle');
    if (btn) {
      /* Shut, it has to say what it is, and "Menu" did not: a driver glancing
         down could not tell what it opened. "Map tools" names the contents.
         Not "Google" anything — Driving, Photo, Hazard, GPS and the rest are
         this app's, and only the Directions row comes from Google, so that
         label would send somebody to the wrong app to find them. */
      btn.textContent = folded ? '\u2630' : '\u2715';   // the word is added in CSS
      btn.title = folded ? 'Show the map buttons' : 'Hide the map buttons';
      btn.setAttribute('aria-label', folded ? 'Show the map buttons' : 'Hide the map buttons');
      btn.setAttribute('aria-expanded', String(!folded));
    }
    measureDock();
  }

  /* Remembered per device: it is a preference, and re-folding it at every stop
     would be its own annoyance. localStorage can throw outright in a private
     window, so every touch of it is wrapped. */
  window.toggleDock = function () {
    const el = dockEl();
    if (!el) return;
    const folded = !el.classList.contains('folded');
    applyDockFolded(folded);
    try { localStorage.setItem(FOLDED_KEY, folded ? '1' : '0'); } catch {}
  };

  window.measureDock = measureDock;

  function start() {
    /* A page can ask to start shut. The driver app does: nine buttons in two
       rows is a third of a phone screen laid over the map. The demo's three
       fit on one row and are the point of the page, so it starts open.

       A driver who has opened or shut it themselves keeps their choice — that
       is a decision, and this default is only for the first time. */
    const el = dockEl();
    const byDefault = el ? el.dataset.defaultFolded === '1' : false;
    let folded = byDefault;
    try {
      const saved = localStorage.getItem(FOLDED_KEY);
      if (saved === '1' || saved === '0') folded = saved === '1';
    } catch {}
    applyDockFolded(folded);

    /* Watched rather than measured at a few likely moments. The coordinates
       appear on a tap, leave again on a timer, and appear on their own when a
       phone is turned sideways past 700px — an observer catches all three
       without every one of them having to remember to say so. */
    const geo = document.getElementById('geo-chip');
    if (geo && window.ResizeObserver) {
      new ResizeObserver(measureGeo).observe(geo);
    }
    measureGeo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* A narrower window wraps the tray onto another row, and a web font
     arriving late changes the captions' height. Both move everything below. */
  addEventListener('resize', () => { measureDock(); measureGeo(); });
  addEventListener('orientationchange', () => { measureDock(); measureGeo(); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { measureDock(); measureGeo(); }).catch(() => {});
  }

})();
