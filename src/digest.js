// digest.js — the evening summary of the day.
//
// The pitch has promised this for a while: "notes drivers add in the app are
// already stored in real time; this can be extended to a daily summary that
// emails Alyssa each evening — what was skipped, what needs follow-up, what
// complaints came in". The storing half was built. This is the other half.
//
// It reads what the day already recorded rather than asking the sheet again:
// activity.js has every broadcast worth keeping, and requests.js has the
// queue. Nothing here writes, so a failed digest cannot damage a day's work —
// the worst case is an email that does not arrive, and the preview endpoint
// says exactly what it would have said.

import { activityBetween } from "./activity.js";
import { listRequests, KIND_LABELS } from "./requests.js";

/* The valley, not the server. Render runs in UTC, so a digest sent at 6pm
   local would otherwise be summarising a day that ends at 6pm — cutting the
   afternoon off the report it exists to deliver. */
export const DIGEST_TZ = process.env.DIGEST_TZ || "America/Denver";

/**
 * The UTC instant of local midnight for the day containing `ref`.
 *
 * Worked out by asking Intl what the wall clock reads there and subtracting
 * it, rather than by hardcoding an offset — the valley is on daylight saving
 * for most of the year and a fixed -7 would silently slip by an hour in
 * November.
 */
export function localDayStart(ref = new Date(), tz = DIGEST_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ref).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  // Intl renders midnight as hour 24 rather than 0 in some ICU versions.
  const hour = Number(parts.hour) % 24;
  const msIntoDay =
    (hour * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000
    + ref.getMilliseconds();

  return new Date(ref.getTime() - msIntoDay);
}

/** What the clock reads in `tz` right now, as { hour, minute }. */
export function localClock(ref = new Date(), tz = DIGEST_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(ref).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

function dayLabel(dayStart, tz = DIGEST_TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  }).format(dayStart);
}

function timeLabel(iso, tz = DIGEST_TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Build the day's summary. Pure read: activity for the local day, plus the
 * request queue as it stands.
 *
 * @param {Date} ref any instant inside the day wanted (defaults to now)
 */
export function buildDigest(ref = new Date(), tz = DIGEST_TZ) {
  const dayStart = localDayStart(ref, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const events = activityBetween(dayStart.toISOString(), dayEnd.toISOString());

  // Stops completed, per route. A stop ticked and then un-ticked should not
  // count, so the last state for each stop wins rather than each tick adding
  // one — a driver correcting a mis-tap is not a second collection.
  const stopState = new Map();
  for (const e of events) {
    if (e.type !== "stop-updated") continue;
    stopState.set(`${e.tabName}#${e.rowNumber}`, { tab: e.tabName, done: e.done });
  }
  const completedByRoute = {};
  for (const { tab, done } of stopState.values()) {
    if (done) completedByRoute[tab] = (completedByRoute[tab] || 0) + 1;
  }
  const completedTotal = Object.values(completedByRoute).reduce((a, b) => a + b, 0);

  /* Follow-ups. A note's urgency is already classified on the way through
     (classifyNote), so the digest does not re-invent the rules and cannot
     disagree with what the board showed. Only the LAST note on a stop is
     reported: an edited note is one situation, not two. */
  const noteByStop = new Map();
  for (const e of events) {
    if (e.type !== "note-updated") continue;
    if (!e.notes || !e.notes.trim()) { noteByStop.delete(`${e.tabName}#${e.rowNumber}`); continue; }
    noteByStop.set(`${e.tabName}#${e.rowNumber}`, e);
  }
  const notes = [...noteByStop.values()].map(e => ({
    route: e.tabName,
    rowNumber: e.rowNumber,
    text: e.notes.trim(),
    urgency: e.noteUrgency || "info",
    at: e.at,
  }));
  const followUps = notes.filter(n => n.urgency === "hold" || n.urgency === "urgent");

  // Free-text notes the driver filed against the log tab — the closest thing
  // the app has to "a driver said something happened".
  const logEntries = events
    .filter(e => e.type === "notes-log-entry" && e.text && e.text.trim())
    .map(e => ({
      driver: e.driverName || "",
      route: e.tabName || "",
      account: e.accountName || "",
      text: e.text.trim(),
      at: e.timestamp || e.at,
    }));

  const photos = events.filter(e => e.type === "photo-added").length;

  // The queue. Today's arrivals come from the requests table rather than the
  // activity feed, because the feed deliberately omits contact details.
  const all = listRequests({ limit: 500 });
  const inDay = r => {
    const t = new Date(r.created_at).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  };
  const requestsToday = all.filter(inDay).map(r => ({
    id: r.id, kind: r.kind, name: r.name, detail: r.detail || "",
    address: [r.address, r.city].filter(Boolean).join(", "),
    status: r.status, at: r.created_at,
  }));
  const pending = all.filter(r => r.status === "pending").map(r => ({
    id: r.id, kind: r.kind, name: r.name,
    address: [r.address, r.city].filter(Boolean).join(", "),
    at: r.created_at,
  }));

  return {
    tz,
    day: dayLabel(dayStart, tz),
    dayStart: dayStart.toISOString(),
    dayEnd: dayEnd.toISOString(),
    completedTotal,
    completedByRoute,
    followUps,
    notes,
    logEntries,
    photos,
    requestsToday,
    pending,
    /* Whether there is anything worth an email at all. A digest that says
       "nothing happened" every evening trains the reader to ignore it. */
    empty: completedTotal === 0 && notes.length === 0 && logEntries.length === 0
           && requestsToday.length === 0 && pending.length === 0,
  };
}

const URGENCY_MARK = { hold: "⏸", urgent: "❗️" };

/** The email body. Plain text on purpose — it has to read in any client. */
export function digestText(d, baseUrl = "https://evergreen-driver-app.onrender.com") {
  const lines = [`Evergreen — ${d.day}`, ""];

  if (d.completedTotal) {
    const routes = Object.entries(d.completedByRoute)
      .sort((a, b) => b[1] - a[1])
      .map(([tab, n]) => `  ${tab}: ${n}`);
    lines.push(`Stops collected: ${d.completedTotal}`, ...routes, "");
  } else {
    lines.push("No stops were ticked off today.", "");
  }

  if (d.followUps.length) {
    lines.push(`Needs follow-up (${d.followUps.length}):`);
    for (const n of d.followUps) {
      lines.push(`  ${URGENCY_MARK[n.urgency] || "•"} ${n.route} row ${n.rowNumber} — ${n.text}`);
    }
    lines.push("");
  }

  if (d.logEntries.length) {
    lines.push(`Driver notes (${d.logEntries.length}):`);
    for (const e of d.logEntries) {
      const who = [e.driver, e.route].filter(Boolean).join(" · ");
      lines.push(`  ${timeLabel(e.at, d.tz)}${who ? " " + who : ""}${e.account ? " — " + e.account : ""}: ${e.text}`);
    }
    lines.push("");
  }

  if (d.requestsToday.length) {
    lines.push(`Requests in today (${d.requestsToday.length}):`);
    for (const r of d.requestsToday) {
      const what = r.detail || r.address || "";
      lines.push(`  ${KIND_LABELS[r.kind] || r.kind} — ${r.name}${what ? ": " + what : ""} [${r.status}]`);
    }
    lines.push("");
  }

  if (d.pending.length) {
    lines.push(
      `Waiting on you: ${d.pending.length} request${d.pending.length === 1 ? "" : "s"} still pending.`,
      `  ${baseUrl}/approval.html`,
      ""
    );
  }

  if (d.photos) lines.push(`${d.photos} photo${d.photos === 1 ? "" : "s"} added.`, "");

  lines.push("— sent automatically by the Evergreen driver app");
  return lines.join("\n");
}

export function digestSubject(d) {
  const bits = [];
  if (d.completedTotal) bits.push(`${d.completedTotal} stops`);
  if (d.followUps.length) bits.push(`${d.followUps.length} follow-up${d.followUps.length === 1 ? "" : "s"}`);
  if (d.pending.length) bits.push(`${d.pending.length} pending`);
  return `Evergreen ${d.day}${bits.length ? " — " + bits.join(", ") : ""}`;
}
