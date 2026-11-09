// Time in app. The member app sends a heartbeat while it is open (about once a minute, plus when the tab is hidden or
// the page is left): how many seconds passed since the last beat, which tab was showing, and the platform. Nothing
// about content, health or messages is sent. The API keeps seconds per client per day, counts a new session after a
// 30-minute gap, and hands totals to the admin overview / activity chart (lib/clients.js, lib/habits.js).
"use strict";
const MAX_BEAT = 120;                 // seconds one beat may add (beats are ~60 s apart; a stuck tab can't inflate)
const SESSION_GAP = 30 * 60 * 1000;   // a beat after this long apart starts a new session
const KEEP_DAYS = 400;
const VIEWS = /^[a-z][a-z-]{0,23}$/;
const PLATFORMS = ["web", "ios", "android"];
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function mountPresence({ app, me, store, today, cfg }) {
  const nowMs = () => (cfg && typeof cfg.now === "function" ? cfg.now().getTime() : Date.now()); // the test clock when there is one
  const read = () => store.read("presence", {});
  const write = (all) => store.write("presence", all);

  me.post("/presence", (req, res) => {
    const b = req.body || {};
    const seconds = Math.max(0, Math.min(MAX_BEAT, Math.round(Number(b.seconds) || 0)));
    const view = VIEWS.test(String(b.view || "")) ? String(b.view) : "app";
    const platform = PLATFORMS.includes(b.platform) ? b.platform : "web";
    const all = read(), id = req.client.id, t = today(), now = nowMs();
    const c = all[id] || (all[id] = { lastAt: 0, days: {} });
    const day = c.days[t] || (c.days[t] = { seconds: 0, sessions: 0, views: {}, platforms: {} });
    if (!c.lastAt || now - c.lastAt > SESSION_GAP) day.sessions += 1;
    c.lastAt = now; c.lastView = view; c.lastPlatform = platform;
    if (seconds) { day.seconds += seconds; day.views[view] = (day.views[view] || 0) + seconds; day.platforms[platform] = (day.platforms[platform] || 0) + seconds; }
    const keepFrom = addDay(t, -KEEP_DAYS);
    for (const d of Object.keys(c.days)) if (d < keepFrom) delete c.days[d];
    write(all);
    res.json({ ok: true, sessions: day.sessions, seconds: day.seconds });
  });

  const of = (clientId) => read()[clientId] || { lastAt: 0, days: {} };
  // minutes per day (date -> minutes), for the activity chart
  const minutesByDay = (clientId) => Object.fromEntries(Object.entries(of(clientId).days).map(([d, x]) => [d, Math.round(x.seconds / 60)]));
  // totals over the last N days ending today
  function summary(clientId, t, days = 30) {
    const c = of(clientId), since = addDay(t, -(days - 1));
    const rows = Object.entries(c.days).filter(([d]) => d >= since && d <= t).map(([, x]) => x);
    const sum = (k) => rows.reduce((n, x) => n + (x[k] || 0), 0);
    const merge = (k) => { const m = {}; for (const x of rows) for (const [key, v] of Object.entries(x[k] || {})) m[key] = (m[key] || 0) + v; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, s]) => ({ [k === "views" ? "view" : "platform"]: key, minutes: Math.round(s / 60) })); };
    const seconds = sum("seconds"), daysOpened = rows.filter((x) => x.sessions > 0).length;
    return { days, seconds, minutes: Math.round(seconds / 60), sessions: sum("sessions"), daysOpened,
      avgMinutesPerDay: daysOpened ? Math.round(seconds / 60 / daysOpened) : 0, views: merge("views").slice(0, 6), platforms: merge("platforms"),
      lastSeenAt: c.lastAt ? new Date(c.lastAt).toISOString() : null, lastView: c.lastView || null, lastPlatform: c.lastPlatform || null };
  }
  const minutesIn = (clientId, t, days = 30) => summary(clientId, t, days).minutes;
  const api = { summary, minutesByDay, minutesIn };
  app.set("presenceApi", api);
  return api;
}

module.exports = { mountPresence, MAX_BEAT, SESSION_GAP };
