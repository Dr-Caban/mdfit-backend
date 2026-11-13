// Phone push notifications: iPhones through Apple's APNs (HTTP/2, token-based auth; APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID)
// and Android phones through Firebase Cloud Messaging (FCM_SERVICE_ACCOUNT). Off until configured. Never throws: a failed push must not fail the booking or message that triggered it.
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

const TOKEN_RE = /^[0-9a-f]{64}$/i;             // APNs device token
const FCM_RE = /^[A-Za-z0-9_:\-]{100,400}$/;     // Firebase registration token
const JWT_TTL_MS = 50 * 60 * 1000; // Apple accepts a token for an hour; refresh before that
const MAX_DEVICES_PER_PERSON = 5;

function createPush({ key = "", keyId = "", teamId = "", bundleId = "com.mdfitsrq.MDfit", sandbox = false, fcmServiceAccount = "", store, tz = "America/New_York", nowParts, zonedToUtc, prettyTime, fetchImpl = fetch }) {
  const pem = normaliseKey(key);
  const apns = Boolean(pem && keyId && teamId);
  // Android phones (MD Fit app from Google Play) get the same notifications through Firebase Cloud Messaging:
  // FCM_SERVICE_ACCOUNT = the Firebase project's service-account JSON (Firebase console → Project settings → Service accounts)
  let sa = null; try { sa = fcmServiceAccount ? JSON.parse(fcmServiceAccount) : null; } catch { sa = null; }
  const fcm = Boolean(sa && sa.client_email && sa.private_key && sa.project_id);
  const enabled = Boolean((apns || fcm) && store);
  const host = sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";

  // ---- device registry: [{ token, clientId | admin, platform, at }]
  const devices = () => (store ? store.read("devices", []) : []);
  const saveDevices = (list) => store && store.write("devices", list);

  const validToken = (token, platform) => (platform === "android" ? FCM_RE : TOKEN_RE).test(String(token || ""));
  const normToken = (token, platform) => (platform === "android" ? String(token) : String(token).toLowerCase());
  function register({ token, clientId = null, admin = false, platform = "ios" }) {
    platform = platform === "android" ? "android" : "ios";
    if (!store || !validToken(token, platform)) return false;
    const t = normToken(token, platform);
    const list = devices().filter((d) => d.token !== t); // a phone that changes hands moves to its new owner
    list.push({ token: t, clientId: admin ? null : clientId, admin: !!admin, platform, at: new Date().toISOString() });
    // Keep the newest few devices per person
    const mine = list.filter((d) => (admin ? d.admin : d.clientId === clientId)).sort((a, b) => (a.at < b.at ? 1 : -1));
    const drop = new Set(mine.slice(MAX_DEVICES_PER_PERSON).map((d) => d.token));
    saveDevices(list.filter((d) => !drop.has(d.token)));
    return true;
  }
  function unregister(token) {
    if (!store || !(TOKEN_RE.test(String(token || "")) || FCM_RE.test(String(token || "")))) return false;
    const t = String(token), list = devices();
    const next = list.filter((d) => d.token !== t && d.token !== t.toLowerCase());
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

  // ---- FCM (Android): OAuth2 access token from the service account, cached
  let gtok = { value: "", exp: 0 };
  async function googleToken() {
    if (Date.now() < gtok.exp - 60e3) return gtok.value;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
    const sig = crypto.sign("RSA-SHA256", Buffer.from(head), sa.private_key).toString("base64url");
    const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${head}.${sig}`, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`google token HTTP ${r.status}`);
    const j = await r.json();
    gtok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return gtok.value;
  }
  async function deliverFcm(token, { title, body, route, collapseId }) {
    try {
      const msg = { token, data: { title: String(title), body: String(body), route: String(route), collapse: String(collapseId || route) },
        android: { priority: "high", ...(collapseId ? { collapse_key: String(collapseId).slice(0, 64) } : {}) } };
      const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { method: "POST",
        headers: { authorization: `Bearer ${await googleToken()}`, "content-type": "application/json" }, body: JSON.stringify({ message: msg }), signal: AbortSignal.timeout(15000) });
      if (r.ok) return { ok: true, status: 200, reason: "" };
      let reason = ""; try { reason = ((await r.json()).error || {}).status || ""; } catch {}
      return { ok: false, status: r.status, reason };
    } catch (err) { return { ok: false, status: 0, reason: err.message }; }
  }

  // Sends in the background; the caller never waits.
  function sendTo(list, note) {
    const { title, body, route = "home", badge, collapseId, thread } = note;
    if (!enabled || !list.length) return;
    const payload = {
      aps: { alert: { title: String(title || "MD Fit").slice(0, 100), body: String(body || "").slice(0, 300) }, sound: "notify.wav", // bundled in the app; iOS falls back to the default tone if it's missing
        ...(Number.isFinite(badge) ? { badge } : {}), ...(thread ? { "thread-id": thread } : {}) },
      route: String(route || "home").slice(0, 60)
    };
    (async () => {
      let gone = [];
      for (const d of list) {
        const android = d.platform === "android";
        if (android ? !fcm : !apns) continue;
        const r = android ? await deliverFcm(d.token, { title, body, route, collapseId }) : await deliver(d.token, payload, { collapseId });
        if (r.ok) continue;
        if (r.status === 410 || r.status === 404 || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "UNREGISTERED", "NOT_FOUND"].includes(r.reason)) gone.push(d.token);
        logger.warn("push_failed", { status: r.status, reason: r.reason, token: d.token.slice(0, 6) + "…" });
      }
      if (gone.length) saveDevices(devices().filter((d) => !gone.includes(d.token)));
    })().catch(() => {});
  }

  // The clinic day each member was last pushed anything (visit reminders, rewards, messages...), so Sunny's daily
  // nudge never lands on a day something else already went out (lib/nudges.js). Kept in memory: a restart only
  // forgets today's, at worst allowing one extra nudge.
  const lastPushed = new Map();
  const pushedOn = (clientId) => lastPushed.get(clientId) || "";
  const toClient = (clientId, note) => {
    if (clientId && nowParts) { try { lastPushed.set(clientId, nowParts(tz, new Date()).date); } catch {} }
    return sendTo(devices().filter((d) => clientId && d.clientId === clientId), note);
  };
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

  return { enabled, apns, fcm, register, unregister, forgetClient, toClient, pushedOn, toOwner, ownerActivity, remind, _authToken: authToken, _deliver: deliver };
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
