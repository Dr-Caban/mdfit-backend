// Calendar sync: Google Calendar (two-way) + SimplePractice (read-only busy times).
//
// Google Calendar: a Google Cloud service account. Dr. Jared shares his calendar with the service account's email
// ("Make changes to events"). We read his busy times (freeBusy) so those slots can't be booked, and add each booking
// as an event (removed again if cancelled). Env: GOOGLE_SERVICE_ACCOUNT (the JSON key, raw or base64) and
// GOOGLE_CALENDAR_ID (usually his Gmail / Workspace address). Several calendars can be listed, comma-separated:
// the first gets the website's bookings, and busy times are read from all of them (e.g. his main calendar plus the
// "SimplePractice" calendar SimplePractice syncs into his Google account). Each must be shared with the service account.
//
// SimplePractice has no public API. Its supported sync is the private calendar feed (Settings → Calendar → Calendar
// sync → subscribe link, .ics). We read that feed every few minutes and block those times. Env or admin setting:
// SIMPLEPRACTICE_ICS_URL. SimplePractice's feed hides client names by default; keep it that way (HIPAA).
//
// HIPAA: events we create contain only the visit type and the client's first name + last initial, never pain notes.
// Use Google Workspace with Google's BAA signed if any patient details go to Google Calendar.
"use strict";
const crypto = require("crypto");

const b64u = (b) => Buffer.from(b).toString("base64url");

function parseServiceAccount(raw) {
  if (!raw) return null;
  let txt = raw.trim();
  if (!txt.startsWith("{")) txt = Buffer.from(txt, "base64").toString("utf8");
  const j = JSON.parse(txt);
  if (!j.client_email || !j.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key.");
  return j;
}

// ---- ICS (SimplePractice feed) parsing: DTSTART/DTEND in UTC (Z), with TZID, floating, or all-day; DURATION in place
// of DTEND; an all-day event over several days; and repeating events (RRULE with EXDATE), written out occurrence by
// occurrence for the dates being looked at. Whatever cannot be read exactly is read as busy rather than dropped.
function unfold(text) { return text.replace(/\r?\n[ \t]/g, ""); }
const MAX_WALK = 4000, MAX_PER_EVENT = 1000; // days a repeating event is walked, and what one event may add
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const pad2 = (n) => String(n).padStart(2, "0");
const dayAdd = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const dateOf = (x) => { const d = new Date(x); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
function icsStamp(value, params = "") {
  let m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  const real = (d) => dateOf(d + "T12:00:00Z") === d; // not the 31st of February
  if (m) return real(`${m[1]}-${m[2]}-${m[3]}`) ? { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` } : null;
  m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m || !real(`${m[1]}-${m[2]}-${m[3]}`) || +m[4] > 23 || +m[5] > 59) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, sec: +m[6], utc: !!m[7], tz: ((params.match(/TZID=([^;:]+)/) || [])[1] || "").replace(/^"|"$/g, "") };
}
// The instant of a stamp, on its own date or (a repeat) on another. A TZID this server does not know (a Windows zone
// name, say) is read in the practice's zone instead of throwing: one odd event must not lose the whole feed, and the
// time stays blocked. A time that does not exist (02:30 on the night the clocks go forward) is the same moment read
// an hour later on the clock, not an hour earlier.
function icsInstant(s, zonedToUtc, fallbackTz, date = s.date) {
  if (s.utc) { const [y, mo, d] = date.split("-").map(Number), [h, mi] = s.time.split(":").map(Number); return new Date(Date.UTC(y, mo - 1, d, h, mi, s.sec)); }
  let tz = s.tz || fallbackTz, at;
  try { at = zonedToUtc(date, s.time, tz); } catch { tz = fallbackTz; at = zonedToUtc(date, s.time, tz); }
  const [h, mi] = s.time.split(":").map(Number);
  if (h >= 1 && zonedToUtc(date, `${pad2(h - 1)}:${pad2(mi)}`, tz).getTime() === at.getTime()) at = new Date(at.getTime() + 3600e3);
  return at;
}
function icsDuration(v) {
  const m = String(v || "").trim().match(/^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  return m ? ((+m[1] || 0) * 7 * 86400 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000 : 0;
}
// The dates (YYYY-MM-DD, on the event's own calendar) a repeating event falls on, from `from` to `to`. DAILY, WEEKLY,
// MONTHLY and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY and BYMONTHDAY; a rule it does not know gives the first date
// only. Parts it does not read (BYSETPOS, BYMONTH) are left out, which can only block more, never less.
function recurDates(start, rule, from, to) {
  const r = Object.fromEntries(String(rule).split(";").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim().toUpperCase(), v.trim().toUpperCase()]));
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1), count = parseInt(r.COUNT, 10) || 0;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.FREQ)) return [start];
  const um = String(r.UNTIL || "").match(/^(\d{4})(\d{2})(\d{2})/), until = um ? `${um[1]}-${um[2]}-${um[3]}` : "";
  const byday = String(r.BYDAY || "").split(",").map((x) => x.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/)).filter(Boolean).map((m) => ({ n: m[1] ? parseInt(m[1], 10) : 0, d: WEEKDAYS.indexOf(m[2]) }));
  const bymd = String(r.BYMONTHDAY || "").split(",").map((x) => parseInt(x, 10)).filter((n) => n && Math.abs(n) <= 31);
  const parts = (date) => { const x = new Date(date + "T12:00:00Z"); return { dow: x.getUTCDay(), dom: x.getUTCDate(), mon: x.getUTCMonth(), yr: x.getUTCFullYear() }; };
  const s = parts(start), week = (date) => Math.floor(dayDiff("1970-01-05", date) / 7); // weeks run Monday to Sunday
  const fits = (date) => {
    const x = parts(date), dim = new Date(Date.UTC(x.yr, x.mon + 1, 0)).getUTCDate();
    const onDay = !byday.length || byday.some((b) => b.d === x.dow);
    if (r.FREQ === "DAILY") return dayDiff(start, date) % interval === 0 && onDay;
    if (r.FREQ === "WEEKLY") return (week(date) - week(start)) % interval === 0 && (byday.length ? onDay : x.dow === s.dow);
    if (r.FREQ === "MONTHLY") {
      if (((x.yr - s.yr) * 12 + x.mon - s.mon) % interval) return false;
      if (bymd.length) return bymd.some((n) => (n > 0 ? n : dim + 1 + n) === x.dom);
      if (byday.length) return byday.some((b) => b.d === x.dow && (!b.n || (b.n > 0 ? Math.ceil(x.dom / 7) === b.n : Math.ceil((dim - x.dom + 1) / 7) === -b.n)));
      return x.dom === s.dom;
    }
    return (x.yr - s.yr) % interval === 0 && x.mon === s.mon && x.dom === s.dom;
  };
  const last = [to || dayAdd(start, 366), until].filter(Boolean).sort()[0], out = [];
  // With a COUNT every occurrence since the first has to be counted; without one the walk starts where the looking does
  let d = !count && from && from > start ? from : start, n = 0;
  for (let i = 0; d <= last && i < MAX_WALK && out.length < MAX_PER_EVENT; i++, d = dayAdd(d, 1)) {
    if (d !== start && !fits(d)) continue;
    if (count && ++n > count) break;
    if (!from || d >= from) out.push(d);
  }
  return out;
}
// opts: { from, to } the dates being looked at (repeats are only written out for those), tz: the practice's zone
function parseIcs(text, zonedToUtc, opts = {}) {
  const out = [], from = opts.from ? dateOf(opts.from) : "", to = opts.to ? dateOf(opts.to) : "";
  for (const block of unfold(text).split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    if (/^STATUS:CANCELLED/m.test(body) || /^TRANSP:TRANSPARENT/m.test(body)) continue;
    const all = (k) => [...body.matchAll(new RegExp(`^${k}((?:;[^:\\r\\n]*)?):([^\\r\\n]*)`, "gm"))].map((m) => ({ params: m[1] || "", value: m[2].trim() }));
    const get = (k) => all(k)[0] || null;
    try {
      const st = get("DTSTART"), en = get("DTEND"), du = get("DURATION"), rr = get("RRULE");
      if (!st) continue;
      const a = icsStamp(st.value, st.params), b = en ? icsStamp(en.value, en.params) : null, dur = du ? icsDuration(du.value) : 0;
      if (!a) continue;
      const first = a.allDay ? null : icsInstant(a, zonedToUtc, opts.tz);
      if (first && Number.isNaN(first.getTime())) continue;
      // how long it runs: whole days for an all-day event (its end date is the day after its last day), else milliseconds
      const days = a.allDay ? Math.min(366, Math.max(1, b && b.allDay ? dayDiff(a.date, b.date) : Math.ceil(dur / 864e5))) : 0;
      let ms = a.allDay ? 0 : b && !b.allDay ? icsInstant(b, zonedToUtc, opts.tz).getTime() - first.getTime() : dur;
      if (!(ms > 0)) ms = 3600e3;
      const span = a.allDay ? days : Math.ceil(ms / 864e5);
      const skip = new Set(all("EXDATE").flatMap((x) => x.value.split(",").map((v) => icsStamp(v.trim(), x.params))).filter(Boolean)
        .map((x) => (x.allDay ? x.date : String(icsInstant(x, zonedToUtc, opts.tz).getTime()))));
      const dates = rr ? recurDates(a.date, rr.value, from ? dayAdd(from, -span - 1) : "", to ? dayAdd(to, 1) : "") : [a.date];
      for (const d of dates) {
        if (a.allDay) { if (!skip.has(d)) for (let k = 0; k < days; k++) out.push({ allDay: true, date: dayAdd(d, k) }); continue; }
        const at = d === a.date ? first : icsInstant(a, zonedToUtc, opts.tz, d);
        if (!skip.has(String(at.getTime()))) out.push({ start: at, end: new Date(at.getTime() + ms) });
      }
    } catch { /* an event that cannot be read at all is left out; the rest of the feed still counts */ }
  }
  return out;
}

function createCalSync({ serviceAccount = "", calendarId = "", icsUrl = "", tz = "America/New_York", zonedToUtc, fetchImpl = fetch, logger, now = () => new Date() }) {
  let sa = null;
  try { sa = parseServiceAccount(serviceAccount); } catch (e) { logger && logger.error("gcal_bad_credentials", { error: e.message }); }
  const calendarIds = String(calendarId || "").split(",").map((x) => x.trim()).filter(Boolean);
  calendarId = calendarIds[0] || ""; // bookings go on the first calendar
  const googleOn = !!(sa && calendarId);
  let token = { value: "", exp: 0 };
  const cache = new Map(); // key -> { at, data }
  const status = { google: googleOn ? "configured" : "off", simplepractice: icsUrl ? "configured" : "off", lastError: "", lastSync: null };

  async function accessToken() {
    if (token.value && Date.now() < token.exp - 60e3) return token.value;
    const iat = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claim}`), sa.private_key).toString("base64url");
    const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`Google token: ${j.error_description || j.error || r.status}`);
    token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return token.value;
  }
  async function gapi(method, path, body) {
    const r = await fetchImpl(`https://www.googleapis.com/calendar/v3${path}`, { method, headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204 || r.status === 410) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google Calendar ${method} ${path.split("?")[0]}: ${(j.error && j.error.message) || r.status}`);
    return j;
  }

  // What each source (each Google calendar, the SimplePractice feed) last answered, kept so that a read that fails can
  // be answered from it. Before this a failed read looked like an empty calendar: times that were taken were offered
  // and could be booked. source -> [{ from, to, data }], newest first; a read whose dates lie inside a newer one's is dropped.
  const lastGood = new Map(), KEEP_GOOD = 20;
  // The same failure is written to the log at most once a minute per source (a read with a failure in it is not cached,
  // so every booking-page view would otherwise write one); a different failure, or the first one after a clean read,
  // is always written. Staff see the current one in Admin (lastError) on every call.
  const loggedAt = new Map(), LOG_GAP_MS = 60e3; // source -> { t, msg } of the last line written
  const logOnce = (source, type, msg) => {
    const t = now().getTime(), last = loggedAt.get(source);
    if (last && last.msg === msg && t - last.t < LOG_GAP_MS) return;
    loggedAt.set(source, { t, msg }); logger && logger.error(type, { error: msg });
  };
  function keep(source, from, to, data) {
    lastGood.set(source, [{ from, to, data }, ...(lastGood.get(source) || []).filter((g) => g.from < from || g.to > to)].slice(0, KEEP_GOOD));
    return data;
  }
  // The last good answer for these dates: the newest read that covers all of them (for the one day a booking checks,
  // that is the freshest there is); if no read covers them all, every read that covers some, put together (a time may
  // then stay blocked after it was freed, never the other way round). Nothing if this source has not answered since
  // the server started.
  function recall(source, from, to, lo, hi) {
    const reads = (lastGood.get(source) || []).filter((g) => g.from <= to && g.to >= from), whole = reads.find((g) => g.from <= from && g.to >= to);
    const seen = new Set();
    return (whole ? [whole] : reads).flatMap((g) => g.data).filter((b) => {
      if (b.allDay ? b.date < from || b.date > to : b.end <= lo || b.start >= hi) return false; // not on the dates asked for
      const k = JSON.stringify(b); if (seen.has(k)) return false; // the same time from two reads counts once
      seen.add(k); return true;
    });
  }

  // Busy times from every listed calendar, one answer per calendar: { source, busy }, with busy null for a calendar
  // that gave an error. One calendar failing (e.g. not shared yet) doesn't hide the others' times; its error still
  // shows in Admin.
  const sourceOf = (i) => (i === 0 ? "google" : "google-" + (i + 1));
  async function googleBusy(fromIso, toIso) {
    const j = await gapi("POST", "/freeBusy", { timeMin: fromIso, timeMax: toIso, timeZone: tz, items: calendarIds.map((id) => ({ id })) });
    const out = [], errors = [];
    calendarIds.forEach((id, i) => {
      const cal = j.calendars && j.calendars[id], source = sourceOf(i);
      if (cal && cal.errors && cal.errors.length) { errors.push(`${i === 0 ? id : "calendar " + (i + 1)}: ${cal.errors[0].reason}`); out.push({ source, busy: null }); return; }
      out.push({ source, busy: ((cal && cal.busy) || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end), source })) });
    });
    if (errors.length) {
      const msg = `Google Calendar: ${errors.join("; ")} (share the calendar with ${sa.client_email})`;
      if (errors.length === calendarIds.length) throw new Error(msg);
      status.lastError = msg;
      logOnce("google-partial", "gcal_busy_partial", msg);
    } else loggedAt.delete("google-partial"); // every calendar answered: the next refusal is written at once
    return out;
  }
  // What each busy time actually is, for the practice's own calendar screen. Titles go straight to the signed-in
  // staff screen: they are never stored, never logged, and never reach the public booking pages (those use busy()).
  // Left out: events marked free, cancelled or declined, and the copies of MD Fit's own bookings. An event marked
  // private in Google keeps its title to itself.
  async function googleEvents(fromIso, toIso) {
    const out = [], owners = new Set(calendarIds.map((x) => x.toLowerCase()));
    for (let i = 0; i < calendarIds.length; i++) {
      const source = i === 0 ? "google" : "google-" + (i + 1);
      let page = "";
      for (let n = 0; n < 5; n++) {
        const q = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: tz,
          fields: "nextPageToken,items(summary,status,transparency,visibility,eventType,start,end,attendees(email,self,responseStatus),extendedProperties/private)" });
        if (page) q.set("pageToken", page);
        let j;
        try { j = await gapi("GET", `/calendars/${encodeURIComponent(calendarIds[i])}/events?${q}`); }
        catch (e) { if (i === 0) throw e; break; } // a second calendar that can't be read still shows as plain busy times
        for (const ev of (j && j.items) || []) {
          if (ev.status === "cancelled" || ev.transparency === "transparent" || ev.eventType === "workingLocation") continue;
          if ((ev.attendees || []).some((a) => (a.self || owners.has(String(a.email || "").toLowerCase())) && a.responseStatus === "declined")) continue;
          if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.mdfitAppointmentId) continue;
          const hidden = ev.visibility === "private" || ev.visibility === "confidential";
          const title = hidden ? "Private event" : String(ev.summary || "").replace(/\s+/g, " ").trim().slice(0, 120) || "(No title)";
          const st = ev.start || {}, en = ev.end || {};
          if (st.dateTime && en.dateTime) out.push({ start: new Date(st.dateTime), end: new Date(en.dateTime), title, source });
          else if (/^\d{4}-\d{2}-\d{2}$/.test(st.date || "")) {
            // all-day: the end date is the day after the last day
            const last = /^\d{4}-\d{2}-\d{2}$/.test(en.date || "") ? en.date : st.date;
            for (let d = new Date(st.date + "T00:00:00Z"), k = 0; k < 62; d = new Date(d.getTime() + 864e5), k++) {
              const date = d.toISOString().slice(0, 10);
              if (k > 0 && date >= last) break;
              out.push({ allDay: true, date, title, source });
            }
          }
        }
        page = (j && j.nextPageToken) || ""; if (!page) break;
      }
    }
    return out;
  }
  async function events(fromDate, toDate) {
    if (!googleOn) return [];
    const key = `ev|${fromDate}|${toDate}`, hit = cache.get(key);
    if (hit && now().getTime() - hit.at < 180e3) return hit.data;
    const data = await googleEvents(zonedToUtc(fromDate, "00:00", tz).toISOString(), zonedToUtc(toDate, "23:59", tz).toISOString());
    cache.set(key, { at: now().getTime(), data });
    return data;
  }
  async function spBusy(url, fromIso, toIso) {
    const r = await fetchImpl(url.replace(/^webcal:/i, "https:"), { headers: { accept: "text/calendar" } });
    if (!r.ok) throw new Error(`SimplePractice feed: HTTP ${r.status}`);
    return parseIcs(await r.text(), zonedToUtc, { from: fromIso, to: toIso, tz }).map((e) => ({ ...e, source: "simplepractice" }));
  }

  // Busy intervals for a date range, cached 3 minutes. A source that cannot be read is logged, shows in Admin, and is
  // answered with what it last said for those dates (recall, above), so a time that was taken stays taken while Google
  // or the feed is unreachable. An answer with a failure in it is not cached: the next call asks again.
  // A source that has never answered since this server started has nothing to fall back on. It then counts as "no
  // extra busy times" so booking keeps working, as it always has; whether booking should stop instead in that case
  // is for the owner to decide.
  async function busy(fromDate, toDate, opts = {}) {
    const url = opts.icsUrl || icsUrl;
    const key = `${fromDate}|${toDate}|${url}`;
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < 180e3) return hit.data;
    const lo = zonedToUtc(fromDate, "00:00", tz), hi = zonedToUtc(toDate, "23:59", tz), fromIso = lo.toISOString(), toIso = hi.toISOString();
    const jobs = [], sp = "simplepractice|" + url; // a feed's last answer is never used for another feed address
    let failed = false;
    const good = (source, list) => keep(source, fromDate, toDate, list);
    // A read with any failure in it, the whole read or one calendar inside Google's answer, is not cached: the next
    // call asks again, so a time taken in Google is seen the moment that calendar answers.
    const bad = (source) => { failed = true; return recall(source, fromDate, toDate, lo, hi); };
    // Every call after an outage asks the source again (a booking is checked against a fresh read the moment Google is
    // back), but the outage is written to the log at most once a minute per source, not on every booking-page view.
    // Staff see it in Admin (lastError) on every call.
    const down = (source, e, type) => { status.lastError = e.message; logOnce(source, type, e.message); };
    status.lastError = ""; // cleared on each fresh read; set again below if anything fails
    if (googleOn) jobs.push(googleBusy(fromIso, toIso).then((cals) => { loggedAt.delete("google"); return cals.flatMap((c) => (c.busy ? good(c.source, c.busy) : bad(c.source))); })
      .catch((e) => { down("google", e, "gcal_busy_failed"); return calendarIds.flatMap((id, i) => bad(sourceOf(i))); }));
    if (url) jobs.push(spBusy(url, fromIso, toIso).then((x) => { loggedAt.delete(sp); return good(sp, x); }).catch((e) => { down(sp, e, "sp_feed_failed"); return bad(sp); }));
    // Always Google's calendars first, then the feed, whichever answered first: the live calendar watch compares one
    // read with the next, and the same times in another order would look like a change.
    const out = (await Promise.all(jobs)).flat();
    status.lastSync = new Date().toISOString();
    if (!failed) cache.set(key, { at: now().getTime(), data: out });
    return out;
  }

  async function addBooking(appt) {
    if (!googleOn) return null;
    const start = zonedToUtc(appt.date, appt.time, tz), end = new Date(start.getTime() + appt.minutes * 60e3);
    const [first, last = ""] = String(appt.name).trim().split(/\s+/);
    const ev = await gapi("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: `MD Fit: ${appt.typeName} · ${first}${last ? " " + last[0] + "." : ""}`,
      description: "Booked on the MD Fit website. Details are in MD Fit Admin.",
      ...(appt.meetingLink ? { location: appt.meetingLink } : {}), // video visits: one tap to join from the calendar
      start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz },
      extendedProperties: { private: { mdfitAppointmentId: appt.id } }, reminders: { useDefault: true }
    });
    cache.clear();
    return ev && ev.id;
  }
  // An event the owner adds from the workspace calendar. It goes on the first calendar like any other entry there, so
  // it also blocks that time for online booking.
  async function addEvent({ title, date, time, minutes, note }) {
    if (!googleOn) return null;
    const start = zonedToUtc(date, time, tz), end = new Date(start.getTime() + minutes * 60e3);
    const ev = await gapi("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: title, ...(note ? { description: note } : {}),
      start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz },
      extendedProperties: { private: { mdfitAdded: "1" } }, reminders: { useDefault: true }
    });
    cache.clear();
    return ev && ev.id;
  }
  async function removeBooking(eventId) {
    if (!googleOn || !eventId) return;
    await gapi("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    cache.clear();
  }

  return { busy, events, addEvent, addBooking, removeBooking, status: () => ({ ...status, serviceAccountEmail: sa ? sa.client_email : null, calendarId: calendarId || null, calendars: calendarIds.length }), googleOn: () => googleOn, clear: () => cache.clear() };
}

module.exports = { createCalSync, parseIcs };
