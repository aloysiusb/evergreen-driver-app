# The September 2026 Google Maps bill — $207.21

**This is a closed record of a specific incident, not a living document.** It is
dated and should not be rewritten. If the situation changes, add a dated section
at the end rather than editing what is above it.

Written 2026-10-04, covering 2026-09-29 to 2026-10-04.

---

## What happened

The September Google Maps Platform bill came to **$207.21** on an app serving
two or three drivers and a few hundred stops. Two PayPal threshold charges
failed on **29 September**, which suspended the Maps key — so the first symptom
anyone saw was the driver app reporting "the routes are not loading."

The charge was not a pricing surprise or a mistake by Google. It was one
defect, made three times:

> **A billed call inside something that repeats, with nothing remembering the
> answer.**

### The usage, as Google reported it

| API | Calls | Against |
|---|---|---|
| **Geocoding** | **11,542** | ~200 customer addresses that had not moved |

The map geocoded every stop on the round every time the map screen opened. A
fifty-stop route is fifty billed lookups, the same fifty again on the next open,
again for the next driver, and again on every test drive.

**This was misdiagnosed first.** Distance Matrix was blamed and optimisation
work had already started on it before the actual usage report was read, which
said Geocoding. Reading the report took a minute. Recorded here because the
wrong answer was confident and plausible.

---

## What was changed

| PR | Change |
|---|---|
| **#41** | `fetchNextEta` was firing on effectively every GPS fix. Gated by `ETA_MIN_REFETCH_MS` (3 minutes) and `ETA_MIN_MOVE_M` (200 m). |
| **#42** | Added `src/geocache.js`. `geocodeAndPlot()` now asks `GET /api/geocodes` what is already known and geocodes only the misses, posting new ones back. |
| **#43** | Added the *"Paid APIs: answer this before shipping"* section to `CLAUDE.md` — four questions mandatory in any PR body touching a billed call. Test drives (`?sim=1`) route to `GOOGLE_MAPS_API_KEY_DEV` when set. |
| **#44** | Removed every `drivingOptions`/`trafficModel` (five sites) and `optimizeWaypoints`; dropped `libraries=places` from the script URL. Gave the geocode cache a 30-day expiry and a daily sweep. |

**The auto-reroute watcher was deleted outright** — 3,419 characters. A
three-minute timer calling a premium-tier route API, running all night with
nobody driving. Without a traffic model its premise is gone anyway: the best
order of a fixed list does not change minute to minute, so it would have billed
every three minutes to compute an identical answer. The manual **Live route**
button still does the same optimisation when a driver asks for it. There is a
comment block in `public/js/map.js` explaining this, because the instinct is to
add it back.

### The claim that matters most

Every timer in the codebase was read afterwards, and:

> **There is no timer anywhere in the app that can reach Google.** Every
> remaining billed call is triggered by something a person or a moving truck
> does — opening the map, pressing Live route, or a GPS fix (throttled). A page
> left open on a desk, or a phone forgotten in a cab overnight, spends nothing.

That was not true before this work.

Measured end to end after all of it: **20 → 0 → 0 geocodes**, all stops still
pinned.

---

## The cache had no expiry, and that was a terms problem

The first version of `src/geocache.js` kept coordinates **for ever**, because it
was written thinking about cost and not about Google's terms. The Maps Platform
terms permit only *temporary* caching of a lat/lng — 30 days, on our reading —
with Place IDs the exception that may be kept indefinitely.

**That would have been a quiet breach of the agreement while asking Google for a
goodwill credit.** It was caught only because Google's support engineer asked
what was being stored.

Fixed in #44: `MAX_AGE_DAYS = 30`, a daily sweep that deletes rather than merely
ignores expired rows, verified by ageing a row 31 days and confirming it is both
no longer served and actually gone from disk. The comment in that file says the
limit is a terms decision and not a performance one, **so that nobody removes it
as an optimisation.**

Compliance costs almost nothing: ~200 lookups a month against 11,542. Still a
98% cut.

---

## The appeal letter, as sent

Kept verbatim because it worked as a structure and may be needed again.

> Hi — thanks for your time.
>
> I'm the developer of a small route app used by a compost hauler in Colorado.
> Two or three drivers, a few hundred stops. My September bill came to $207.21,
> and I'd like to ask whether a one-time adjustment is possible.
>
> I'm not disputing that the requests happened. I've looked at the usage report
> and the cause is mine: the Geocoding API shows 11,542 requests against a list
> of roughly 200 customer addresses. My application was re-requesting the
> coordinates for every address every single time the map screen was opened, and
> never storing the results. The same few hundred addresses were looked up tens
> of thousands of times for no reason at all.
>
> I've since found and fixed it — the app now looks up each address once and
> keeps the result, so that number should drop to near zero. I've also corrected
> two other calls that were firing far more often than they needed to, and I'm
> setting daily quota limits so this can't run away again.
>
> This is a very small account and it's my first bill of any size. The usage came
> from a defect rather than from real use, and it's now corrected. If there's any
> goodwill adjustment available for a first-time overage like this, I'd be very
> grateful — and if not, I understand.
>
> Separately, two payment attempts failed on 29 September. I'm sorting the
> payment method out now and will clear the balance either way.
>
> Thank you,
> Virginia Payson

**Why it is written that way**, for anyone drafting the next one:

- **It does not dispute the charge.** Support agents have no discretion over
  usage that genuinely occurred, and arguing it spends the goodwill you actually
  want. Conceding the facts up front is what makes the ask credible.
- **It names the specific number and the specific defect.** "11,542 requests
  against 200 addresses" is self-evidently a bug. That is the whole argument,
  and it makes their internal case for them.
- **It says the fix is already done.** Adjustments are far likelier when there is
  no risk of the same bill next month.
- **It commits to paying regardless.**

---

## The answer given to Google's caching question

The support engineer (Jayson) asked what kind of API response was being stored.
The answer given:

> We cache **Geocoding API responses only** — specifically the latitude/longitude
> pair returned for a customer's street address, stored server-side and keyed by
> that address. No other API responses are stored. Nothing from Directions,
> Distance Matrix or Maps JavaScript is retained; those are used and discarded.
>
> Cached coordinates expire after **30 days** and are deleted from disk by a
> daily sweep, so no geocoding result is retained beyond that window. We're not
> storing Place IDs.
>
> The addresses themselves are our own customer records, held in our route
> spreadsheet independently of Google.

**Open question at the time of writing:** 30 days is our reading of the terms,
not a ruling from Google. If the window is confirmed as something else, it is
one constant in `src/geocache.js` (`MAX_AGE_DAYS`).

---

## The monitoring window, and what to expect

Google asked to monitor the project for 24–48 hours. What was said about it:

**Expect one spike, on purpose.** The server-side geocode cache starts empty. The
*first* map open after the balance clears will geocode the whole route in one
go — on the order of **200 Geocoding calls in a single burst** — then drop to
near zero. Say this to support up front so day one is not read as the fix having
failed:

> One thing to expect: the caching layer starts empty, so the first map load
> after service resumes will geocode the route once — on the order of 200
> requests in a single burst. That's the cache populating. It should drop to near
> zero immediately afterwards and stay there.

**Do not run test drives during a monitoring window.** Each one is real usage on
the project being watched. And note that a dev key in the **same Cloud project**
still counts toward that project's numbers — quotas and metrics are per-API
**per-project**, not per-key. A dev key only isolates anything if it lives in its
own project.

**Screenshot the metrics daily** —
https://console.cloud.google.com/google/maps-apis/metrics — flat near-zero
Geocoding after the first burst is the evidence worth having in hand.

**On key restriction:** look at *every* key in the project, not only the one the
app uses. Old or forgotten unrestricted keys are exactly what the
best-practices advice is about and the kind of thing that undermines a claim
that the project is secured.

---

## Preventive measures now in place

1. **The paid-API section in `CLAUDE.md`** — four questions that must be answered
   in the body of any PR touching a billed call. Not optional.
2. **No timer may reach a paid API.** See above.
3. **The geocode cache**, with its terms-mandated expiry.
4. **A separate dev key** for test drives (`?sim=1`), which should be given a
   small daily quota so a runaway in testing fails loudly instead of billing.
   *Still to confirm: whether it sits in its own Cloud project.*
5. **Daily quotas set in the Cloud console** by the owner. For reference, the
   standard monthly free tier works out to roughly **322 calls/day** (10,000 ÷
   31). Note that some APIs meter in *elements* or *map loads* rather than
   requests, and some SKUs sit in Pro/Enterprise tiers — check the Maps Platform
   core services pricing list rather than assuming one call is one unit.
6. **Removed from the standard tier deliberately:** `drivingOptions` /
   `trafficModel`, `optimizeWaypoints`, `libraries=places`. Each pushed requests
   out of standard pricing. **These must stay removed.**

---

## Still open at the time of writing

- [ ] Clear the **$207.21** balance and fix the payment method. The map stays
      suspended until this is done — this is the only reason the app's map is
      down, and no code change affects it.
- [ ] Rotate the **service-account key**. See `docs/credentials.md`.
- [ ] Confirm the **30-day caching window** with Google rather than relying on
      our reading.
- [ ] Confirm whether **`GOOGLE_MAPS_API_KEY_DEV` needs its own Cloud project.**
- [ ] Audit **every key in the project**, not just the two the app uses.

---

## Update: 2026-10-04 evening — goodwill adjustment expected

The case was deliberated with Google support. Virginia indicated that support
signaled willingness to grant a goodwill adjustment on the $207.21 balance. The
exact resolution is pending, but the direction is clear: the appeal worked.

When this is cleared, mark it below and move to clearing the balance and
verifying the cache behaviour during the first map load.
