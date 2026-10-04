# Credentials and environment variables

Every variable the app reads, what it is, and whether it is a secret. **No
values appear in this file and none ever should** — it is a map of what exists
and where it is managed, not a store.

This is a living reference: **edit it in place** when a variable is added,
removed or renamed. `CLAUDE.md` carries a shorter table aimed at getting a
session running; this file is the fuller account, including risk and rotation.

Last reviewed: 2026-10-04. All of these are set in **Render → Environment**
unless noted.

---

## Google

| Variable | What it is | Secret? | Managed in |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | The Maps key. **Billed per call** — read the paid-API section of `CLAUDE.md` before touching anything that uses it. | **Yes** | Cloud console → Credentials |
| `GOOGLE_MAPS_API_KEY_DEV` | Second Maps key, served only to test drives (`?sim=1`). Give it a small daily quota so a runaway in testing fails loudly instead of billing. Unset, the simulator uses the real key. | **Yes** | Cloud console → Credentials |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | **Service-account private key, full JSON.** Reads *and writes* the route spreadsheet. The highest-value secret here. | **Yes — treat as a password** | Cloud console → Service Accounts |
| `GOOGLE_MAPS_MAP_ID` | A map style ID. Not a secret, and optional. | No | Maps Studio |

`src/sheets.js` reads the service-account key from `process.env` only. **It is
never committed**, and the repo has no credentials file.

## Email

| Variable | What it is | Secret? |
|---|---|---|
| `RESEND_API_KEY` | Sends request notifications and the evening digest. | **Yes** |
| `REQUESTS_FROM_EMAIL` | The sending address. **See the warning below.** | No |

## QuickBooks Online

Built but **never called against Intuit** — there are no `QBO_*` credentials in
any environment reached so far, so no request has ever been made. Worth a
sandbox run (`QBO_SANDBOX=true`) before it touches a real customer.

| Variable | What it is | Secret? |
|---|---|---|
| `QBO_CLIENT_SECRET` | App secret. | **Yes** |
| `QBO_REFRESH_TOKEN` | Long-lived token — obtained once via `/qbo/auth`, **shown in the browser only and deliberately never logged.** | **Yes — treat as a password** |
| `QBO_CLIENT_ID`, `QBO_REALM_ID` | Identifiers. Lower risk, but not for publishing. | Mild |
| `QBO_SANDBOX`, `QBO_REDIRECT_URI`, `QBO_SERVICE_ITEM_ID` | Configuration. | No |

## Access gates

| Variable | What it is | Current state |
|---|---|---|
| `ACCESS_CODE` | Shared code drivers need. Travels in the link as `?c=CODE`, then a cookie. **If unset, the gate is off and the app is open to anyone with the URL.** | **Unset, deliberately** — see below |
| `ADMIN_CODE` | Gate on the style editor (`/admin`). | Unset |

## Not secrets

`ROUTE_SHEET_ID`, `PHOTOS_FOLDER_ID`, `DATA_DIR`, `DIGEST_TZ`, `PORT`,
`PUBLIC_BASE_URL`, `RENDER_GIT_COMMIT`.

---

## `ACCESS_CODE` being off is a decision, not an oversight

The owner switched it off while the app is being demonstrated and tested, and
has confirmed it more than once in plain terms. **Do not turn it on to tidy a
stale-looking note.**

When it does go back on, **the link handed out must carry the code** (`?c=…`).
Last time it was on, the code only ever travelled inside a text message, and the
owner could not open his own app once that message had scrolled away.

## The `REQUESTS_FROM_EMAIL` trap

Request mail goes through **Resend's shared sandbox sender** unless
`REQUESTS_FROM_EMAIL` names a **verified domain**. That shared sender generally
only delivers to the address the Resend account was registered with.

So changing `notify_email` on the Approvals page to a shared office inbox would
**stop the notification emails arriving, with nothing on screen to say so.** Do
not propose that change until a verified sending domain is in place.

Customer-facing confirmation emails need the same verified domain and are not
sent at all yet.

Related, for whoever reads the code: **`notifyNewRequest` returns silently** when
notifications are switched off or the address is blank — no log line at all.
Only the missing-API-key branch logs anything. That is the quietest of the three
ways it can fail to send.

---

## Rotation

**Outstanding: `GOOGLE_SERVICE_ACCOUNT_KEY` should be rotated.**

A live Maps API key and a complete service-account private key were pasted into
a chat session during debugging in late September. Neither was written to this
repository. The owner decided at the time not to rotate, which was reasonable
for a test app, and has since agreed to replace the service-account key.

It is the one worth doing: a service-account key with **write access to the
customer spreadsheet** is a larger exposure than the Maps key ever was, and
nothing done during the billing work touched it. Rotating is a few minutes in
the Cloud console and a paste into Render.

**If you are auditing credentials, this file is not the authority** — it lists
what the *app* reads. The Cloud console's credentials page may hold keys nothing
uses any more, and an old unrestricted key sitting there is exactly what
Google's key-restriction advice is about.
