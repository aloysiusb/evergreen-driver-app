// gate.js — a shared access code, so the app can be handed to drivers by text
// without the route data (customer names and addresses) sitting one guessed
// hostname away.
//
// This is deliberately NOT per-driver identity. There is no record of which
// driver marked a stop done — that is a later job if Alyssa wants it. All this
// does is stop the route sheet being readable by anyone who finds the URL.
//
// How a driver experiences it:
//   1. Taps the link you texted:  https://…/?c=THECODE
//   2. The code is stored in their browser, then stripped from the address bar
//   3. Every visit afterwards just works, including from a home-screen icon
//
// Two codes, two audiences:
//   ACCESS_CODE  — drivers. Travels in the URL, because a driver on a phone in
//                  the cab will not tolerate a login form.
//   ADMIN_CODE   — the style editor. Separate, so a driver cannot push styles
//                  to everybody else's screen.
//
// If ACCESS_CODE is unset the gate stays open, so local development and the
// current deploy keep working until the variable is set in Render.

import { timingSafeEqual } from "node:crypto";

const ACCESS_CODE = process.env.ACCESS_CODE || "";
const ADMIN_CODE = process.env.ADMIN_CODE || "";

// The customer-facing surface. These are meant to be reachable by members of
// the public who will never have a code — the whole point of the portal is
// that a customer can request a hold without ringing the office. Gating them
// would leave the intake endpoint open but the page that posts to it locked,
// which is the same as having no portal at all.
//
// Nothing here exposes the route sheet: the portal is a form, and the pages
// pull their data from endpoints that ARE gated.
// walkthrough.html is here because it is the thing you send people to show
// them the app. It is safe to expose: it makes no network calls at all and
// every name and address in it is invented, so there is nothing real behind it
// to leak. Demo links should not need a driver's access code.
const PUBLIC_PAGES = new Set(["/portal.html", "/pay.html", "/walkthrough.html"]);

// Stylesheets, client scripts and the manifest. No secrets live in these — the
// sensitive thing is the route API, not the CSS — and leaving them gated would
// render the public pages unstyled and inert.
const PUBLIC_PREFIXES = ["/css/", "/js/", "/fonts/"];

const DRIVER_JAR = "ev_access";
const ADMIN_JAR = "ev_admin";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Constant-time compare that does not leak length. */
function matches(supplied, expected) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // spend comparable time
    return false;
  }
  return timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

/** A code may arrive in the URL, a header, or a cookie set on a previous visit. */
function suppliedCode(req, jar) {
  return (
    req.query?.c ||
    req.query?.code ||
    req.get("x-access-code") ||
    readCookie(req, jar) ||
    ""
  );
}

const DENIED_PAGE = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evergreen — access needed</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;
       background:#f4f6f4;color:#1d2a24;text-align:center;padding:1.5rem}
  main{max-width:22rem}
  h1{font-size:1.2rem;margin:0 0 .6rem;font-weight:600}
  p{margin:0 0 .5rem;line-height:1.5;color:#4c5a52}
  code{background:#e6ebe7;padding:.15em .4em;border-radius:4px;font-size:.9em}
</style>
<main>
  <h1>Open the app from the link you were sent</h1>
  <p>The full link ends with <code>?c=…</code> — that part is what lets you in.</p>
  <p>Tap it once and the app will keep working afterwards.</p>
</main>`;

/**
 * Mount the access gate.
 * Call immediately after express.json(), before any routes or static files.
 */
export function mountGate(app) {
  if (!ACCESS_CODE) {
    console.warn(
      "WARNING: ACCESS_CODE is not set, so anyone with the URL can read the " +
      "routes. Set ACCESS_CODE in Render to require a code."
    );
    return;
  }

  app.use((req, res, next) => {
    // Render pings /health, and Intuit redirects to /qbo/callback — both must
    // stay reachable without a code.
    if (req.path === "/health" || req.path.startsWith("/qbo/")) return next();

    // The website's "request service" form posts here from a page that has no
    // access code and never will. ONLY the POST is open: reading the queue
    // back, or deciding on a request, still needs a code. The endpoint itself
    // validates and rate-limits, and nothing it accepts reaches the route
    // sheet until someone approves it.
    if (req.path === "/api/requests" && req.method === "POST") return next();

    // Customer-facing pages and the assets they need to render.
    if (PUBLIC_PAGES.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some(prefix => req.path.startsWith(prefix))) return next();
    if (req.path === "/manifest.json") return next();

    // The public walkthrough loads real satellite imagery, which needs this.
    // The key is already visible to any browser that opens the driver app — it
    // is a browser key, protected by an HTTP-referrer restriction in the Google
    // console, not by being secret. If that restriction is not set, set it.
    if (req.path === "/api/maps-key") return next();

    // The portal's "get my invoice link" button. Customer-facing by design and
    // reachable before the gate existed, so gating it now would take away a
    // feature customers already use. Worth knowing it will confirm whether an
    // email address belongs to a customer.
    if (req.path === "/api/payment-link" && req.method === "POST") return next();

    // Writing styles is an admin act. Reading them is not: every driver page
    // fetches /api/styles to paint itself.
    const touchesStyles = req.path === "/admin.html" || req.path.startsWith("/api/styles");
    const isStyleRead = req.method === "GET" && req.path.startsWith("/api/styles");
    const needsAdmin = touchesStyles && !isStyleRead && Boolean(ADMIN_CODE);

    const expected = needsAdmin ? ADMIN_CODE : ACCESS_CODE;
    const jar = needsAdmin ? ADMIN_JAR : DRIVER_JAR;

    const supplied = suppliedCode(req, jar);

    if (!matches(supplied, expected)) {
      if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Access code required." });
      }
      return res.status(401).type("html").send(DENIED_PAGE);
    }

    // Arrived with the code in the URL: remember it, then strip it from the
    // address bar so it is not left sitting in a screenshot or a shared tab.
    const cameFromUrl = Boolean(req.query?.c || req.query?.code);
    if (cameFromUrl) {
      const secure = req.secure || req.get("x-forwarded-proto") === "https";
      res.setHeader(
        "Set-Cookie",
        `${jar}=${encodeURIComponent(expected)}; Max-Age=${YEAR_SECONDS}; Path=/; SameSite=Lax` +
          (secure ? "; Secure" : "")
      );
      if (req.method === "GET" && !req.path.startsWith("/api/")) {
        return res.redirect(302, req.path);
      }
    }

    next();
  });

  console.log("Access gate on — drivers need ?c=… once.");
  if (!ADMIN_CODE) {
    console.warn(
      "Note: ADMIN_CODE is not set, so the style editor accepts the driver " +
      "code. Set ADMIN_CODE in Render to separate them."
    );
  }
}
