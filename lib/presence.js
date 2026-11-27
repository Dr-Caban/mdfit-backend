// Time in app. The member app sends a heartbeat while it is open (about once a minute, plus when the tab is hidden or
// the page is left): how many seconds passed since the last beat, which tab was showing, and the platform. Nothing
// about content, health or messages is sent. The API keeps seconds per client per day, counts a new session after a
// 30-minute gap, and hands totals to the admin overview / activity chart (lib/clients.js, lib/habits.js).
//
// What they are using: the first beat goes out the moment the app opens and says whether it is the MD Fit app or a
// browser, on which kind of device, and whether that page can use a camera at all. It is kept as the member's latest
// device so staff know, before inviting anyone to a video session, who can be seen and heard and who can only watch.
// Four short words from fixed lists: no device identifier, no model, nothing that tells two phones apart.
"use strict";
const MAX_BEAT = 120;                 // seconds one beat may add (beats are ~60 s apart; a stuck tab can't inflate)
const SESSION_GAP = 30 * 60 * 1000;   // a beat after this long apart starts a new session
const KEEP_DAYS = 400;
// The screens the member app has (account.html's views, and the video visit page). Anything else counts as "app":
// a pattern alone let through words like "constructor", which are not screens and are not safe as a key.
const VIEWS = ["home", "programs", "generate", "videos", "pain", "progress", "leaders", "learn", "tips", "messages", "premium", "profile", "visit", "app"];
const PLATFORMS = ["web", "ios", "android"];
const OS = ["ios", "android", "mac", "windows", "other"], BROWSERS = ["safari", "chrome", "firefox", "edge", "other"];
const OS_NAME = { ios: "iPhone or iPad", android: "Android", mac: "Mac", windows: "Windows", other: "Other device" };
const BROWSER_NAME = { safari: "Safari", chrome: "Chrome", firefox: "Firefox", edge: "Edge", other: "browser" };
// What staff are shown. speak: true (camera and microphone work there), false (they can only watch there), or null
// (not known: the Android app has not been checked).
function describeDevice(d) {
  if (!d) return null;
  const app = !!d.app, label = app ? (d.os === "android" ? "Android app" : "iPhone app") : `${OS_NAME[d.os] || OS_NAME.other} · ${BROWSER_NAME[d.browser] || "browser"}`;
  const speak = app && d.os !== "android" ? false : app ? null : !!d.media;
  return { label, speak, at: d.at || null,
    note: speak === false ? (app ? "can watch here; to be seen and heard they continue in Safari" : "this browser cannot use a camera: watch only") : speak === null ? "camera in the Android app is not confirmed" : "can be seen and heard" };
}
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// The whole presence store (client id -> { lastAt, days, ... }), read and parsed once. Anything that asks about many
// members in one go (the workspace client list, the nudge sweep) reads it with this once and looks each member up in
// the copy: reading it again for every member parsed the whole file hundreds of times and held the server up for seconds.
const readPresence = (store) => { const all = store.read("presence", {}); return all && typeof all === "object" && !Array.isArray(all) ? all : {}; };

function mountPresence({ app, me, store, today, cfg, clients }) {
  const nowMs = () => (cfg && typeof cfg.now === "function" ? cfg.now().getTime() : Date.now()); // the test clock when there is one
  const read = () => readPresence(store);
  const write = (all) => store.write("presence", all);
  // Whose rows stay: anyone in the client list (a closed account included) or in the 30-day trash, so a Restore brings
  // their minutes back. An id in neither was erased: its row is left out of what staff are shown and is dropped the
  // next time the store is written. Done here because the code that ends an account (finalize in lib/clients.js) is
  // a locked part.
  const kept = () => {
    const ids = new Set(), list = clients(), trash = store.read("clients-trash", []);
    for (const c of Array.isArray(list) ? list : []) if (c && c.id) ids.add(c.id);
    for (const e of Array.isArray(trash) ? trash : []) if (e && e.id) ids.add(e.id);
    return ids;
  };
  const withoutErased = (all) => { if (typeof clients !== "function") return all; const ids = kept(); for (const id of Object.keys(all)) if (!ids.has(id)) delete all[id]; return all; };

  me.post("/presence", (req, res) => {
    const b = req.body || {};
    const seconds = Math.max(0, Math.min(MAX_BEAT, Math.round(Number(b.seconds) || 0)));
    const view = VIEWS.includes(b.view) ? b.view : "app";
    const platform = PLATFORMS.includes(b.platform) ? b.platform : "web";
    const all = read(), id = req.client.id, t = today(), now = nowMs();
    const c = all[id] || (all[id] = { lastAt: 0, days: {} });
    const day = c.days[t] || (c.days[t] = { seconds: 0, sessions: 0, views: {}, platforms: {} });
    // (the first beat of a day opens it too: someone still in the app at midnight was there that day)
    if (!c.lastAt || now - c.lastAt > SESSION_GAP || !day.sessions) day.sessions += 1;
    c.lastAt = now; c.lastView = view; c.lastPlatform = platform;
    const dv = b.device;
    if (dv && typeof dv === "object") c.device = { app: !!dv.app, os: OS.includes(dv.os) ? dv.os : "other", browser: BROWSERS.includes(dv.browser) ? dv.browser : "other", media: !!dv.media, at: new Date(now).toISOString() };
    if (seconds) { day.seconds += seconds; day.views[view] = (day.views[view] || 0) + seconds; day.platforms[platform] = (day.platforms[platform] || 0) + seconds; }
    const keepFrom = addDay(t, -KEEP_DAYS);
    for (const d of Object.keys(c.days)) if (d < keepFrom) delete c.days[d];
    write(withoutErased(all));
    res.json({ ok: true, sessions: day.sessions, seconds: day.seconds });
  });

  // Every function below that takes a client id also takes, last, a copy of the store from all(). Asking about many
  // members: call all() once and pass it each time. Asking about one: leave it out and the store is read for you.
  const all = () => read();
  const of = (clientId, from) => (from && typeof from === "object" ? from : read())[clientId] || { lastAt: 0, days: {} };
  // minutes per day (date -> minutes), for the activity chart
  const minutesByDay = (clientId, from) => Object.fromEntries(Object.entries(of(clientId, from).days).map(([d, x]) => [d, Math.round(x.seconds / 60)]));
  // totals over the last N days ending today
  function summary(clientId, t, days = 30, from) {
    const c = of(clientId, from), since = addDay(t, -(days - 1));
    const rows = Object.entries(c.days).filter(([d]) => d >= since && d <= t).map(([, x]) => x);
    const sum = (k) => rows.reduce((n, x) => n + (x[k] || 0), 0);
    const merge = (k) => { const m = {}; for (const x of rows) for (const [key, v] of Object.entries(x[k] || {})) m[key] = (m[key] || 0) + v; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, s]) => ({ [k === "views" ? "view" : "platform"]: key, minutes: Math.round(s / 60) })); };
    const seconds = sum("seconds"), daysOpened = rows.filter((x) => x.sessions > 0).length;
    return { days, seconds, minutes: Math.round(seconds / 60), sessions: sum("sessions"), daysOpened,
      avgMinutesPerDay: daysOpened ? Math.round(seconds / 60 / daysOpened) : 0, views: merge("views").slice(0, 6), platforms: merge("platforms"),
      lastSeenAt: c.lastAt ? new Date(c.lastAt).toISOString() : null, lastView: c.lastView || null, lastPlatform: c.lastPlatform || null };
  }
  const minutesIn = (clientId, t, days = 30, from) => summary(clientId, t, days, from).minutes;
  const device = (clientId, from) => describeDevice(of(clientId, from).device);
  const devices = () => Object.fromEntries(Object.entries(withoutErased(read())).filter(([, c]) => c && c.device).map(([id, c]) => [id, describeDevice(c.device)]));
  const api = { all, summary, minutesByDay, minutesIn, device, devices };
  app.set("presenceApi", api);
  return api;
}

module.exports = { mountPresence, readPresence, describeDevice, MAX_BEAT, SESSION_GAP };
