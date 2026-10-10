# Evidence file: what the Google Cloud / Maps Platform suspension cost us

**Status: raw material, not the finished piece.** Collected while the incident
was fresh, to be written up as feedback to Google once the billing case closes.

Purpose: argue from a documented incident with checkable specifics rather than
from "the console is confusing". Every claim below has a date, an exact string,
or a commit behind it. Nothing here is recalled from memory — it is drawn from
`CLAUDE_LOG.md` entries written at the time.

**Who this happened to:** one solo developer, building prototypes, on a narrow
budget. Not a team, not a company, no finance function. That is the relevant
user profile for every complaint in this file.

---

## 1. The incident, in order

| When | What |
| --- | --- |
| before 2026-10-04 | `fetchNextEta` fires from the GPS handler on every position fix — roughly once a second in a moving vehicle — each one a Distance Matrix request carrying a traffic model. Bill reaches ~$200. |
| ~2026-10-04 | Google suspends the Cloud project `evergreen-driver-app`. The app loses all read/write access to the route sheet. Nine driver routes go offline. |
| 2026-10-04 | Diagnosis session. Concludes from the error strings that the service account has been **deleted** and the project is under **Acceptable Use Policy enforcement**. Both wrong. |
| 2026-10-04 (later) | Owner establishes the real cause: an unpaid balance of about **$200**. A billing suspension, not an abuse finding. |
| 2026-10-06 | Google Maps Platform Billing Support (Macario) confirms the technical report supports an adjustment proposal. Quotes 1–5 business days. Sends a list of prevention best practices. |
| 2026-10-10 | Still suspended. Dispatch board shows the raw error nine times over. Owner chases; balance still showing. |

The spend cause was fixed in code (commit `807683c`):
`ETA_MIN_REFETCH_MS = 180000` plus a 200 m movement guard, and a geocode cache
so an address is looked up once rather than on every map open. Google's own
technical team confirmed "the unexpected usage has stopped".

---

## 2. The error messages actively caused a wrong diagnosis

This is the strongest item, because the cost is measurable.

**What an unpaid invoice produced:**

```
GET /health
  sheet.tabsReadable: 0 of 9, every tab:
  "invalid_grant: Invalid grant: account not found"
```

```
Geocoding API:
  "status": "REQUEST_DENIED"
  "error_message": "Google has disabled the use of APIs from this API project."
```

**What that reasonably reads as:** the service account
`evergreen-driver-service-acc@evergreen-driver-app.iam.gserviceaccount.com`
has been deleted. `account not found` is not the language of a billing hold.

**What it cost.** The 2026-10-04 entry recorded, as its headline, that the
project was "under AUP enforcement" and that recovery would probably require a
**new Cloud project, a new service account, and re-sharing the route sheet** —
a rebuild. None of that was necessary. A billing suspension does not delete
service accounts. The correction had to be written into the same entry hours
later, overriding its own conclusion.

Time was also spent on a 400 from the driver map page and on three Maps
deprecation warnings (`DirectionsService`, `DirectionsRenderer`,
`DistanceMatrix`, all deprecated 25 Feb 2026), including considering a Routes
API migration. Both were the project already being disabled. The log's own
words: **"Both were red herrings."**

**The ask:** a billing suspension should say it is a billing suspension, and
link to the balance. One string — `"billing account suspended: unpaid
balance"` — would have removed the entire wrong branch.

---

## 3. The console accused us of misconduct over an unpaid bill

The banner the owner saw:

> "A potential violation of our Acceptable Use Policy has been detected for a
> project you own."

For owing $200. This is what cemented the enforcement diagnosis — the
2026-10-04 entry treats the banner and the API failures as "the same event",
and reasonably so, because they appeared together.

It is also frightening in a way the facts did not warrant. A solo developer
reading that has to consider whether they have been accused of abuse, and
what that means for their Google account generally.

**The ask:** do not surface nonpayment through the abuse-policy channel.

---

## 4. There is no circuit breaker, and Google's own email says so

From Macario's best-practices list, verbatim:

> "Set Budget Alerts: Create alerts in the Billing Console to be notified when
> spend reaches a threshold. (Note: Budget alerts do not automatically pause
> your APIs or stop usage; they only work as email notifications)."

So the control that is *named* after limiting spend does not limit spend. The
parenthetical is honest, and it concedes the whole problem.

The actual recommended control is per-API daily quotas — which are expressed
in **request counts, not dollars**. To convert a budget into a quota you must
already know the unit price of every API you call, and keep that mapping
correct as pricing changes. That is a finance exercise, imposed on someone
whose stated requirement is "don't let this cost more than $20".

**The ask:** a hard spending cap that stops service. Opt-in is fine. Default-on
for new projects with no payment history would be better.

---

## 5. All the prevention advice arrived after the bill

The best-practices list — daily quotas as a circuit breaker, application and
API restrictions on every key, budget alerts — is good advice. It was sent on
2026-10-06, by a human, in response to a complaint, **after** the $200 was
incurred and the project was already suspended.

None of it appeared at project creation, at first API call, at the first
unusual-spend day, or anywhere in the path a new developer actually walks.

**The ask:** surface it at project creation and on the first abnormal-usage
day, not in a support reply.

---

## 6. The dangerous page is the default; the safe page is hidden

Looking for "quotas" for a low-traffic nonprofit website lands you on
**Quotas & System Limits**, which reported **6,594 rows** for that project —
Address Validation, Aerial View, Air Quality, BigQuery, Analytics Hub, Cloud
Monitoring, regional storage quotas across dozens of regions. For a site that
draws a map.

The Maps-scoped console at `console.cloud.google.com/google/maps-apis` has
four relevant items: Metrics, APIs & Services, Quotas, Credentials. It is the
correct page for this user and **you have to already know it exists.**

The owner's analogy, which is the right one: *this is like sending somebody to
the source code first.*

This is not only a navigation complaint. The generic page holds live limits
across every enabled service, so someone trying to protect a map embed can
throttle something unrelated and get no warning that they have. **The page
where you can do harm is the default; the page scoped to what you built is a
side door.**

**The ask:** when a project's enabled APIs are all Maps APIs, send "quotas" to
the Maps console.

---

## 7. Nothing warns you about blast radius

One runaway loop in one app disabled every API in its project. Nothing in the
console ever suggests one app per project, and you learn the rule by breaking
it.

**Worth stating precisely, because it bears on how bad this could have been:**
`earlymusicsa.org` — a separate nonprofit's website — was **confirmed on
2026-10-10 to be in a different project and unaffected.** That was luck, not
design. Had its Maps key been in the same project, a compost-route app's GPS
bug would have taken a music charity's website maps down, and nothing would
have connected those two facts for the person debugging it.

**The ask:** at project creation, when a second unrelated API is enabled, say
plainly that everything in a project shares one billing fate.

---

## 8. Cloud and Workspace share a brand and little else

Owner's words: *"Google this, Google that... I use the Google suite all the
time and I'm invested in it... but this particular facet, this Google Cloud,
and then Google Workspace — how does that intertwine? There's no roadmap."*

Same account, same sign-in, same brand. Then two consoles, two billing models,
two identity models, two sets of documentation, and no map between them. A
service account key pasted into a hosting dashboard is a Cloud concept; the
spreadsheet it reads is a Workspace one; nothing explains the seam.

---

## 9. What NOT to argue

Kept deliberately, because it makes the rest credible.

**Do not claim the platform is badly built.** Google Cloud is enterprise
infrastructure and most of that complexity is legitimate — a bank really does
need 6,594 knobs. The failure is not that the enterprise path exists.

**The argument is that there is no small path at all.** A solo developer
building a prototype is handed the enterprise console, with no spending cap, no
signpost to the scoped view, and error messages written for someone with a
support contract. That is specific and fixable. "It's all too complicated" is
neither.

---

## 10. Where this should go

The open support case is probably the best channel — Macario has read the
technical report, has already partly agreed, and support staff can route
product feedback internally in a way a public form cannot.

Send it **after the case closes**, not during. A resolved case is a stronger
place to speak from, and the ending is part of the evidence.

---

## Still to add when known

- How the adjustment resolved, and how much of the $200 remained.
- Whether API access was restored on payment, on approval, or only after asking
  separately — i.e. whether the credit and the reinstatement are one step or
  two. (If two, that is another item for the list.)
- Total days offline, start to finish.
