// iPhone push notifications through Apple's APNs (HTTP/2, token-based auth). Off unless APNS_KEY, APNS_KEY_ID and
// APNS_TEAM_ID are set. Never throws: a failed push must not fail the booking or message that triggered it.
//
//  - Members' phones register from the MD Fit app (POST /api/me/devices); Dr. Jared's registers from Admin in the
//    app (POST /api/admin/devices). Tokens Apple reports as gone (410 / BadDeviceToken) are dropped.
//  - Payloads carry no health details: the visit type and time, who wrote, never notes or pain areas.
//  - Appointment reminders (the day before at 6 PM, and 1 hour before) come from a timer; what was already sent is
//    remembered on disk so a restart doesn't repeat it.
"use strict";
const crypto = require("crypto");
const http2 = require("http2");
const { logger, mask } = require("./logger");

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const JWT_TTL_MS = 50 * 60 * 1000; // Apple accepts a token for an hour; refresh before that
const MAX_DEVICES_PER_PERSON = 5;

function createPush({ key = "", keyId = "", teamId = "", bundleId = "com.mdfitsrq.MDfit", sandbox = false, store, tz = "America/New_York", nowParts, zonedToUtc, prettyTime }) {
  const pem = normaliseKey(key);
  const enabled = Boolean(pem && keyId && teamId && store);
  const host = sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";

  // ---- device registry: [{ token, clientId | admin, platform, at }]
  const devices = () => (store ? store.read("devices", []) : []);
  const saveDevices = (list) => store && store.write("devices", list);

  function register({ token, clientId = null, admin = false, platform = "ios" }) {
    if (!store || !TOKEN_RE.test(String(token || ""))) return false;
    const t = String(token).toLowerCase();
    const list = devices().filter((d) => d.token !== t); // a phone that changes hands moves to its new owner
    list.push({ token: t, clientId: admin ? null : clientId, admin: !!admin, platform, at: new Date().toISOString() });
    // Keep the newest few devices per person
    const mine = list.filter((d) => (admin ? d.admin : d.clientId === clientId)).sort((a, b) => (a.at < b.at ? 1 : -1));
    const drop = new Set(mine.slice(MAX_DEVICES_PER_PERSON).map((d) => d.token));
    saveDevices(list.filter((d) => !drop.has(d.token)));
    return true;
  }
  function unregister(token) {
    if (!store || !TOKEN_RE.test(String(token || ""))) return false;
    const t = String(token).toLowerCase(), list = devices();
    const next = list.filter((d) => d.token !== t);
    if (next.length !== list.length) saveDevices(next);
    return next.length !== list.length;
  }
  function forgetClient(clientId) { // account deleted
    if (!store) return;
    saveDevices(devices().filter((d) => d.clientId !== clientId));
  }

  // ---- APNs auth token (ES256 JWT), cached
  let jwt = { value: "", at: 0 };
  function authToken() {
    if (Date.now() - jwt.at < JWT_TTL_MS) return jwt.value;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${b64({ alg: "ES256", kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign("sha256", Buffer.from(head), { key: pem, dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = { value: `${head}.${sig}`, at: Date.now() };
    return jwt.value;
  }

  // ---- one HTTP/2 connection, reopened when Apple closes it
  let session = null;
  function conn() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(host);
    session.on("error", () => { session = null; });
    session.on("close", () => { session = null; });
    session.setTimeout(10 * 60 * 1000, () => { try { session.close(); } catch {} });
    return session;
  }

  function deliver(token, payload, { collapseId } = {}) {
    return new Promise((resolve) => {
      let s;
      try {
        s = conn().request({
          ":method": "POST", ":path": `/3/device/${token}`,
          authorization: `bearer ${authToken()}`, "apns-topic": bundleId, "apns-push-type": "alert", "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
          ...(collapseId ? { "apns-collapse-id": String(collapseId).slice(0, 64) } : {}),
          "content-type": "application/json"
        });
      } catch (err) { return resolve({ ok: false, status: 0, reason: err.message }); }
      let status = 0, body = "";
      s.setTimeout(15000, () => { s.close(); resolve({ ok: false, status: 0, reason: "timeout" }); });
      s.on("response", (h) => { status = h[":status"]; });
      s.on("data", (c) => { body += c; });
      s.on("error", (err) => resolve({ ok: false, status: 0, reason: err.message }));
      s.on("end", () => {
        let reason = ""; try { reason = JSON.parse(body).reason || ""; } catch {}
        resolve({ ok: status === 200, status, reason });
      });
      s.end(JSON.stringify(payload));
    });
  }

  // Sends in the background; the caller never waits.
  function sendTo(list, { title, body, route = "home", badge, collapseId, thread }) {
    if (!enabled || !list.length) return;
    const payload = {
      aps: { alert: { title: String(title || "MD Fit").slice(0, 100), body: String(body || "").slice(0, 300) }, sound: "notify.wav", // bundled in the app; iOS falls back to the default tone if it's missing
        ...(Number.isFinite(badge) ? { badge } : {}), ...(thread ? { "thread-id": thread } : {}) },
      route: String(route || "home").slice(0, 60)
    };
    (async () => {
      let gone = [];
      for (const d of list) {
        const r = await deliver(d.token, payload, { collapseId });
        if (r.ok) continue;
        if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "DeviceTokenNotForTopic") gone.push(d.token);
        logger.warn("push_failed", { status: r.status, reason: r.reason, token: d.token.slice(0, 6) + "…" });
      }
      if (gone.length) saveDevices(devices().filter((d) => !gone.includes(d.token)));
    })().catch(() => {});
  }

  const toClient = (clientId, note) => sendTo(devices().filter((d) => clientId && d.clientId === clientId), note);
  const toOwner = (note) => sendTo(devices().filter((d) => d.admin), { ...note, route: note.route || "admin" });

  // What Dr. Jared's phone says for each activity type (same wording as the live Admin toasts). Emails shown masked.
  const OWNER = {
    appointment: (d) => ({ title: "New booking", body: `${d.typeName || "Appointment"}${d.when ? `, ${d.when}` : ""}${d.email ? ` · ${mask(d.email)}` : ""}` }),
    appointment_cancelled: (d) => ({ title: "Appointment cancelled", body: `${d.typeName || "A visit"}${d.when ? `, ${d.when}` : ""}${d.email ? ` · ${mask(d.email)}` : ""}` }),
    consult_scheduled: null,
    booking: (d) => ({ title: "New class booking", body: `${d.title || "Group class"}${d.when ? `, ${d.when}` : ""}` }),
    booking_cancelled: (d) => ({ title: "Class booking cancelled", body: `${d.title || "Group class"}${d.when ? `, ${d.when}` : ""}` }),
    lead: () => ({ title: "New evaluation request", body: "Open Admin → Leads to reply." }),
    message: (d) => ({ title: "New message", body: `${d.name || "A member"} wrote to you in the app.`, route: "admin/messages" }),
    meeting_request: (d) => ({ title: "1-on-1 request", body: `${d.name || "A member"} asked for a session.`, route: "admin/members" }),
    membership_request: (d) => ({ title: "Membership request", body: `${d.name || "A member"} wants to upgrade.`, route: "admin/members" }),
    client_signup: () => ({ title: "New member", body: "Someone just created an account." }),
    feedback: () => ({ title: "New review", body: "Read it in Admin → Reviews." }),
    intake: (d) => ({ title: "Documents completed", body: d.when ? `For the visit on ${d.when}.` : "A patient finished their intake forms." })
  };
  function ownerActivity(type, detail = {}) {
    const f = OWNER[type];
    if (!f) return;
    const n = f(detail);
    toOwner({ ...n, thread: "admin", collapseId: `${type}:${detail.id || detail.date || ""}` });
  }

  // ---- Appointment reminders
  const sentKey = "pushsent";
  const sent = () => (store ? store.read(sentKey, {}) : {});
  function remind(appointments) {
    if (!enabled || !zonedToUtc) return;
    const now = Date.now(), done = sent(); let changed = false;
    const todayKey = nowParts ? nowParts(tz, new Date()).date : "";
    // Forget entries for past days so the file stays small
    for (const k of Object.keys(done)) if (k.slice(-10) < todayKey) { delete done[k]; changed = true; }
    for (const a of appointments) {
      if (!a || a.status !== "booked" || !a.clientId || !a.date || !a.time) continue;
      const at = zonedToUtc(a.date, a.time, tz).getTime();
      const when = `${prettyTime ? prettyTime(a.time) : a.time}`;
      const checks = [
        // Tomorrow's visit: at 6 PM the day before
        { id: `${a.id}:eve:${a.date}`, fire: zonedToUtc(prevDay(a.date), "18:00", tz).getTime(), title: "Tomorrow at MD Fit",
          body: `${a.typeName || "Your visit"} tomorrow at ${when}.${a.meetingLink ? " The video link is in your account." : ""}` },
        // One hour before
        { id: `${a.id}:hour:${a.date}`, fire: at - 3600e3, title: "Coming up in an hour",
          body: `${a.typeName || "Your visit"} at ${when}.${a.meetingLink ? " Tap to open your account for the video link." : ""}` }
      ];
      for (const c of checks) {
        if (done[c.id] || now < c.fire || now > c.fire + 30 * 60e3 || now > at) continue; // missed by more than 30 min: skip quietly
        toClient(a.clientId, { title: c.title, body: c.body, route: "home", thread: "appointments", collapseId: c.id });
        done[c.id] = new Date().toISOString(); changed = true;
      }
    }
    if (changed && store) store.write(sentKey, done);
  }

  return { enabled, register, unregister, forgetClient, toClient, toOwner, ownerActivity, remind, _authToken: authToken, _deliver: deliver };
}

function prevDay(date) { return new Date(Date.parse(date + "T12:00:00Z") - 864e5).toISOString().slice(0, 10); }

// APNS_KEY can be the .p8 file's text, the same with "\n" written out, or base64 of the file
function normaliseKey(raw) {
  let k = String(raw || "").trim();
  if (!k) return "";
  if (!k.includes("-----BEGIN")) { try { k = Buffer.from(k, "base64").toString("utf8").trim(); } catch {} }
  k = k.replace(/\\n/g, "\n");
  if (!k.includes("-----BEGIN")) return "";
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return "";
  const body = m[2].replace(/\s+/g, "").replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN ${m[1]}-----\n${body}\n-----END ${m[1]}-----\n`;
}

module.exports = { createPush, normaliseKey };
