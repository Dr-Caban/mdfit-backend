// Calendar sync: Google Calendar (two-way) + SimplePractice (read-only busy times).
//
// Google Calendar: a Google Cloud service account. Dr. Jared shares his calendar with the service account's email
// ("Make changes to events"). We read his busy times (freeBusy) so those slots can't be booked, and add each booking
// as an event (removed again if cancelled). Env: GOOGLE_SERVICE_ACCOUNT (the JSON key, raw or base64) and
// GOOGLE_CALENDAR_ID (usually his Gmail / Workspace address).
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

// ---- ICS (SimplePractice feed) parsing: DTSTART/DTEND in UTC (Z), with TZID, floating, or all-day
function unfold(text) { return text.replace(/\r?\n[ \t]/g, ""); }
function icsTime(value, params, zonedToUtc) {
  if (/^\d{8}$/.test(value)) return { allDay: true, date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  return { at: zonedToUtc(`${y}-${mo}-${d}`, `${h}:${mi}`, tz) };
}
function parseIcs(text, zonedToUtc) {
  const out = [];
  for (const block of unfold(text).split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    if (/^STATUS:CANCELLED/m.test(body) || /^TRANSP:TRANSPARENT/m.test(body)) continue;
    const get = (k) => { const m = body.match(new RegExp(`^${k}((?:;[^:\\r\\n]*)?):([^\\r\\n]*)`, "m")); return m ? { params: m[1] || "", value: m[2].trim() } : null; };
    const st = get("DTSTART"), en = get("DTEND");
    if (!st) continue;
    const a = icsTime(st.value, st.params, zonedToUtc), b = en ? icsTime(en.value, en.params, zonedToUtc) : null;
    if (!a) continue;
    if (a.allDay) { out.push({ allDay: true, date: a.date }); continue; }
    out.push({ start: a.at, end: b && b.at ? b.at : new Date(a.at.getTime() + 3600e3) });
  }
  return out;
}

function createCalSync({ serviceAccount = "", calendarId = "", icsUrl = "", tz = "America/New_York", zonedToUtc, fetchImpl = fetch, logger, now = () => new Date() }) {
  let sa = null;
  try { sa = parseServiceAccount(serviceAccount); } catch (e) { logger && logger.error("gcal_bad_credentials", { error: e.message }); }
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

  async function googleBusy(fromIso, toIso) {
    const j = await gapi("POST", "/freeBusy", { timeMin: fromIso, timeMax: toIso, timeZone: tz, items: [{ id: calendarId }] });
    const cal = j.calendars && j.calendars[calendarId];
    if (cal && cal.errors && cal.errors.length) throw new Error(`Google Calendar: ${cal.errors[0].reason} (share the calendar with ${sa.client_email})`);
    return ((cal && cal.busy) || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end), source: "google" }));
  }
  async function spBusy(url) {
    const r = await fetchImpl(url.replace(/^webcal:/i, "https:"), { headers: { accept: "text/calendar" } });
    if (!r.ok) throw new Error(`SimplePractice feed: HTTP ${r.status}`);
    return parseIcs(await r.text(), zonedToUtc).map((e) => ({ ...e, source: "simplepractice" }));
  }

  // Busy intervals for a date range, cached 3 minutes. Failures are logged and treated as "no extra busy times"
  // so booking keeps working, but the error shows in Admin.
  async function busy(fromDate, toDate, opts = {}) {
    const url = opts.icsUrl || icsUrl;
    const key = `${fromDate}|${toDate}|${url}`;
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < 180e3) return hit.data;
    const fromIso = zonedToUtc(fromDate, "00:00", tz).toISOString(), toIso = zonedToUtc(toDate, "23:59", tz).toISOString();
    const out = [];
    const jobs = [];
    if (googleOn) jobs.push(googleBusy(fromIso, toIso).then((x) => out.push(...x)).catch((e) => { status.lastError = e.message; logger && logger.error("gcal_busy_failed", { error: e.message }); }));
    if (url) jobs.push(spBusy(url).then((x) => out.push(...x)).catch((e) => { status.lastError = e.message; logger && logger.error("sp_feed_failed", { error: e.message }); }));
    await Promise.all(jobs);
    status.lastSync = new Date().toISOString();
    cache.set(key, { at: now().getTime(), data: out });
    return out;
  }

  async function addBooking(appt) {
    if (!googleOn) return null;
    const start = zonedToUtc(appt.date, appt.time, tz), end = new Date(start.getTime() + appt.minutes * 60e3);
    const [first, last = ""] = String(appt.name).trim().split(/\s+/);
    const ev = await gapi("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: `MD Fit: ${appt.typeName} · ${first}${last ? " " + last[0] + "." : ""}`,
      description: "Booked on the MD Fit website. Details are in MD Fit Admin.",
      start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz },
      extendedProperties: { private: { mdfitAppointmentId: appt.id } }, reminders: { useDefault: true }
    });
    cache.clear();
    return ev && ev.id;
  }
  async function removeBooking(eventId) {
    if (!googleOn || !eventId) return;
    await gapi("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    cache.clear();
  }

  return { busy, addBooking, removeBooking, status: () => ({ ...status, serviceAccountEmail: sa ? sa.client_email : null, calendarId: calendarId || null }), googleOn: () => googleOn, clear: () => cache.clear() };
}

module.exports = { createCalSync, parseIcs };
