// Achievement and reminder pushes for members with the app.
//
// Rewards are computed from history rather than stored, so "new gem" and "new badge" are found by comparing what a
// member has now against what they were last told (`c.notified`). The sweep runs on a timer instead of inside every
// XP route: a member who earns three badges in one session gets three notifications once, not a burst per tap, and
// nothing has to be threaded through the workout, habit and challenge handlers.
//
// What goes out, and nothing else:
//   - a new gem (rank up), which is rare and worth interrupting for
//   - a badge earned
//   - the daily XP goal reached
//   - a streak about to break, once, in the evening, and only to people who have a streak to lose
//   - a group class tomorrow and an hour before, the same shape as visit reminders
//
// Quiet hours are respected: nothing is sent before 8 AM or after 9 PM in the practice's timezone, except the
// one-hour class reminder, which is useless late.
//
// Sunny's daily nudge (owner, Nov 2026: "Duolingo-like, make sure you get that beautiful Florida sunlight"). At most
// ONE a day per member, and only on a day nothing else has been pushed to them. Sent at the hour they usually train
// (the middle of their logged workouts and check-ins over 30 days, 8 AM to 8 PM), else 8 AM. The first that applies:
//   - comeback: 2, 7, 14 and 30 days after they were last active, once each; after the 30-day one, nothing until
//     they are active again (tapering beats nagging people into uninstalling)
//   - new picks: Sunny suggested things since they last opened the app
//   - morning motivation: on a clear morning in Sarasota, the sunlight line; otherwise a friendly rotating one
// The evening streak nudge above is the fourth kind: someone with a streak worth keeping gets only that one, so a
// day never brings two. Members choose all / streaks only / off in their profile (appPrefs.nudges); class reminders
// are not nudges and always go.
//
// HIPAA: a push shows on a locked screen. These lines never name a body area, a condition, a pain level, a program
// or anything else from the member's record; the only personal word is their first name. The copy is all in
// SUNNY_LINES below so the owner can change it.
//
// The weather comes from Open-Meteo for Sarasota (no key; nothing about any member is sent), once a day. If it
// cannot be read, the regular line goes out.
"use strict";

const QUIET_FROM = 21, QUIET_TO = 8;        // 9 PM .. 8 AM
const STREAK_NUDGE_HOUR = 18;               // 6 PM: time to still do something about it
const GOAL_HOUR_MIN = 9;                    // don't shout about a goal reached at 3 AM

// Sunny's lines. {first} = the member's first name, {n} = a number. One is picked by the day, so they rotate.
const SUNNY_LINES = {
  sunny:   ["☀️ Make sure you get that beautiful Florida sunlight. A 10-minute walk counts toward your streak.",
            "☀️ Gorgeous morning in Sarasota, {first}. Take your session outside if you can."],
  regular: ["Your 8-minute session is ready when you are.",
            "Morning, {first}. One short session today keeps you moving forward.",
            "Small steps count. Five minutes of movement today is a win.",
            "Your body will thank you later. Today's session is waiting."],
  picks:   ["Sunny found {n} new picks for you. Take a look on your Home screen."],
  back2:   ["We saved your spot, {first}. 5 minutes today gets you back on track."],
  back7:   ["No guilt, just progress. Pick up where you left off?"],
  back14:  ["Dr. Jared's programs miss you. 😢 One short session gets you rolling again."],
  back30:  ["Still here whenever you're ready, {first}. Your plan is waiting on your Home screen."]
};
const NUDGE_TITLE = "Sunny";
const NUDGE_MODES = ["all", "streaks", "off"];
const COMEBACK_STEPS = [2, 7, 14, 30];
const OPEN_WINDOW_MS = 6 * 3600e3, BACK_WINDOW_DAYS = 2, STATS_DAYS = 100;
const MORNING_HOUR = 8, LATEST_HOUR = 20;
const SARASOTA = "https://api.open-meteo.com/v1/forecast?latitude=27.3364&longitude=-82.5307&current=cloud_cover,precipitation,is_day&timezone=America/New_York";
const isClear = (w) => !!(w && w.current && Number(w.current.cloud_cover) <= 40 && Number(w.current.precipitation) === 0 && Number(w.current.is_day) === 1);
const dayNum = (d) => Math.round(Date.parse(d + "T12:00:00Z") / 864e5);
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const firstName = (c) => String((c && (c.firstName || String(c.name || "").trim().split(/\s+/)[0])) || "").replace(/[^\p{L}'\- ]/gu, "").slice(0, 30) || "there";
const fill = (line, c, n) => line.replace(/\{first\}/g, firstName(c)).replace(/\{n\}/g, String(n));
const nudgeMode = (c) => { const m = c && c.appPrefs && c.appPrefs.nudges; return NUDGE_MODES.includes(m) ? m : "all"; };

const hourOf = (t) => Number(String(t || "").slice(0, 2)) || 0;
const prevDay = (d) => new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);

function createNudges({ store, clients, save, push, rewardsOf, nowParts, zonedToUtc, prettyTime, tz, now = () => new Date(), logger,
  pushedOn = () => "", fetchImpl = (typeof fetch === "function" ? fetch : null) }) {
  const quiet = (hour) => hour >= QUIET_FROM || hour < QUIET_TO;

  // ---------- the weather, once a day ----------
  let weather = { date: "", clear: null, pending: null };
  function prefetchWeather(date) {
    if (weather.date === date && (weather.clear !== null || weather.pending)) return weather.pending || Promise.resolve(weather.clear);
    weather = { date, clear: null, pending: null };
    const done = (clear) => { if (weather.date === date) { weather.clear = clear; weather.pending = null; } return clear; };
    if (!fetchImpl) return Promise.resolve(done(false));
    const ctl = typeof AbortController === "function" ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    weather.pending = Promise.resolve().then(() => fetchImpl(SARASOTA, ctl ? { signal: ctl.signal } : {}))
      .then((r) => (r && r.ok ? r.json() : null)).then((w) => done(isClear(w)))
      .catch(() => { if (logger) logger.warn("nudge_weather_failed", {}); return done(false); })
      .finally(() => timer && clearTimeout(timer));
    return weather.pending;
  }
  // true / false once known; undefined while the one request of the day is out (the line waits a minute for it)
  const clearToday = (date) => { if (weather.date !== date) prefetchWeather(date); return weather.clear === null ? undefined : weather.clear; };

  // ---------- what the member has been doing (dates only) ----------
  const presenceOf = (id) => (store.read("presence", {}) || {})[id] || { lastAt: 0, days: {} };
  function lastActive(c, pres) {
    let last = "";
    for (const w of c.workouts || []) if (w && w.date > last) last = w.date;
    for (const p of c.painLog || []) if (p && p.date > last) last = p.date;
    for (const [d, x] of Object.entries(pres.days || {})) if (x && x.sessions > 0 && d > last) last = d;
    return last || String(c.createdAt || "").slice(0, 10);
  }
  // The hour they usually train: the middle of their logged workouts and check-ins in the last 30 days
  function usualHour(c, today) {
    const floor = addDays(today, -30), hours = [];
    for (const w of c.workouts || []) if (w && w.date >= floor && w.completedAt) hours.push(hourOf(nowParts(tz, new Date(w.completedAt)).time));
    for (const p of c.painLog || []) if (p && p.date >= floor && p.createdAt) hours.push(hourOf(nowParts(tz, new Date(p.createdAt)).time));
    if (hours.length < 3) return MORNING_HOUR;
    hours.sort((a, b) => a - b);
    return Math.min(LATEST_HOUR, Math.max(MORNING_HOUR, hours[Math.floor(hours.length / 2)]));
  }
  const newPicks = (c, pres) => {
    const s = c.suggested || {}, since = pres.lastAt ? new Date(pres.lastAt).toISOString() : "";
    return ["programs", "videos", "guides", "tips"].flatMap((k) => s[k] || []).filter((x) => x && x.at && x.at > since && x.at > ((c.notified || {}).picksAt || ""));
  };

  // ---------- counts for the owner: sent, opened within 6 hours, came back within 2 days ----------
  const STATS = "nudge-stats";
  const kindOf = (k) => (k.startsWith("back") ? "comeback" : k === "sunny" || k === "regular" ? "morning" : k);
  function count(date, kind, field) {
    const st = store.read(STATS, {}) || {}, days = st.days || (st.days = {});
    const row = days[date] || (days[date] = {}), k = row[kind] || (row[kind] = { sent: 0, opened: 0, comebacks: 0 });
    k[field] = (k[field] || 0) + 1;
    const floor = addDays(date, -STATS_DAYS);
    for (const d of Object.keys(days)) if (d < floor) delete days[d];
    store.write(STATS, st);
  }
  function stats(days = 30) {
    const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 30, { date: today } = nowParts(tz, now()), from = addDays(today, -(n - 1));
    const all = (store.read(STATS, {}) || {}).days || {}, kinds = {};
    for (const [d, row] of Object.entries(all)) {
      if (d < from || d > today) continue;
      for (const [k, v] of Object.entries(row)) { const t = kinds[k] || (kinds[k] = { sent: 0, opened: 0, comebacks: 0 }); t.sent += v.sent || 0; t.opened += v.opened || 0; t.comebacks += v.comebacks || 0; }
    }
    const order = ["streak", "comeback", "picks", "morning"];
    return { days: n, kinds: order.map((k) => ({ kind: k, ...(kinds[k] || { sent: 0, opened: 0, comebacks: 0 }) })) };
  }
  // A nudge sent earlier: did they open the app within 6 hours, or (a comeback) get active again within 2 days?
  function follow(c, seen, pres, today) {
    const n = seen.lastNudge; if (!n || !n.at) return false;
    let changed = false;
    const sentMs = Date.parse(n.at);
    if (!n.opened && pres.lastAt > sentMs && pres.lastAt <= sentMs + OPEN_WINDOW_MS) { n.opened = true; count(n.date, kindOf(n.kind), "opened"); changed = true; }
    if (n.kind.startsWith("back") && !n.back) {
      const last = lastActive(c, pres);
      if (last >= n.date && dayNum(last) - dayNum(n.date) <= BACK_WINDOW_DAYS && last > (n.wasActive || "")) { n.back = true; count(n.date, "comeback", "comebacks"); changed = true; }
    }
    if (now().getTime() - sentMs > (BACK_WINDOW_DAYS + 1) * 864e5) { delete seen.lastNudge; changed = true; }
    return changed;
  }
  const record = (seen, today, kind, extra = {}) => { seen.sunny = today; seen.lastNudge = { date: today, at: now().toISOString(), kind, ...extra }; count(today, kindOf(kind), "sent"); };

  // One sweep. Safe to call every minute: everything it sends is recorded so it is never sent twice.
  function sweep(classBookings = []) {
    if (!push || !push.enabled) return { sent: 0 };
    const { date: today, time } = nowParts(tz, now());
    const hour = hourOf(time);
    const list = clients();
    const withDevice = new Set(store.read("devices", []).map((d) => d.clientId).filter(Boolean));
    let sent = 0, changed = false;

    for (const c of list) {
      if (!withDevice.has(c.id)) continue;           // nobody to notify
      const firstSweep = !c.notified, sentBefore = sent;
      const seen = c.notified || (c.notified = { badges: [], level: 0, goal: "", streak: "" });
      let r;
      try { r = rewardsOf(c); } catch { continue; }

      // 1. A new gem. Only after the first one, so a brand-new member is not congratulated for existing.
      if (r.level > (seen.level || 0)) {
        if (!firstSweep && !quiet(hour)) {
          push.toClient(c.id, { title: `${r.rank.current.name} unlocked`, body: `You reached ${r.title}. Tap to see your progress.`, route: "progress", thread: "rewards", collapseId: `gem:${r.level}` });
          sent++;
        }
        seen.level = r.level; changed = true;
      }

      // 2. Badges earned since the last sweep
      const earned = r.badges.filter((b) => b.earned).map((b) => b.id);
      const fresh = earned.filter((id) => !(seen.badges || []).includes(id));
      if (fresh.length) {
        if (!firstSweep && !quiet(hour)) {
          const b = r.badges.find((x) => x.id === fresh[0]);
          const more = fresh.length - 1;
          push.toClient(c.id, { title: b ? `Badge earned: ${b.title}` : "Badge earned",
            body: more > 0 ? `${b ? b.desc : ""} And ${more} more. Tap to see them.` : (b ? b.desc : "Tap to see it."),
            route: "progress", thread: "rewards", collapseId: `badge:${fresh[0]}` });
          sent++;
        }
        seen.badges = earned; changed = true;
      }

      // 3. Daily goal reached
      if (r.todayXp >= r.dailyGoal && seen.goal !== today) {
        if (!firstSweep && hour >= GOAL_HOUR_MIN && !quiet(hour)) {
          push.toClient(c.id, { title: "Daily goal reached", body: `${r.todayXp} XP today. Your streak is safe.`, route: "progress", thread: "rewards", collapseId: `goal:${today}` });
          sent++;
        }
        seen.goal = today; changed = true;
      }

      // 4. Streak about to break: evening, nothing logged today, and a streak worth keeping
      const streak = Math.max(0, ...r.badges.filter((b) => b.kind === "streak").map((b) => b.progress || 0));
      const mode = nudgeMode(c);
      if (!firstSweep && mode !== "off" && hour === STREAK_NUDGE_HOUR && streak >= 2 && r.todayXp === 0 && seen.streak !== today && seen.sunny !== today) {
        push.toClient(c.id, { title: `Keep your ${streak}-day streak`, body: `Your ${streak}-day streak is hanging on by a thread. One quick check-in saves it.`, route: "home", thread: "rewards", collapseId: `streak:${today}` });
        seen.streak = today; record(seen, today, "streak"); sent++; changed = true;
      }

      // 5. Sunny's daily nudge (see the top of this file)
      const pres = presenceOf(c.id);
      if (follow(c, seen, pres, today)) changed = true;
      if (firstSweep || mode !== "all" || quiet(hour) || seen.sunny === today) continue;
      if (sentBefore < sent || pushedOn(c.id) === today) continue;             // something else went to them today
      if (streak >= 2) continue;                                               // their one nudge is the evening streak one
      if (hour !== usualHour(c, today)) continue;
      const last = lastActive(c, pres), gap = last ? dayNum(today) - dayNum(last) : 0;
      let line = null, kind = "", nPicks = 0;
      if (gap >= COMEBACK_STEPS[0]) {
        const lapse = seen.lapse && seen.lapse.from === last ? seen.lapse : (seen.lapse = { from: last, sent: [] });
        const step = [...COMEBACK_STEPS].reverse().find((d) => gap >= d);
        if (!lapse.sent.includes(step)) { kind = `back${step}`; line = SUNNY_LINES[kind]; lapse.sent = COMEBACK_STEPS.filter((d) => d <= step); changed = true; }
        if (!line) continue;                                                   // between steps, or after the last one: quiet
      } else {
        const picks = newPicks(c, pres);
        if (picks.length) { kind = "picks"; line = SUNNY_LINES.picks; nPicks = picks.length; seen.picksAt = picks.map((x) => x.at).sort().pop(); }
        else {
          if (r.todayXp > 0) continue;                                         // already moving today: no need
          const clear = hour < 12 ? clearToday(today) : false;
          if (clear === undefined) continue;                                   // the weather is on its way; next minute
          kind = clear ? "sunny" : "regular"; line = SUNNY_LINES[kind];
        }
      }
      const text = fill(line[dayNum(today) % line.length], c, nPicks);
      push.toClient(c.id, { title: NUDGE_TITLE, body: text, route: "home", thread: "sunny", collapseId: `sunny:${today}` });
      record(seen, today, kind, kind.startsWith("back") ? { wasActive: last } : {}); sent++; changed = true;
    }
    if (changed) save(list);

    // 5. Group classes: the evening before, and an hour before
    sent += remindClasses(classBookings, today, time);
    return { sent };
  }

  const sentKey = "pushsent-classes";
  function remindClasses(bookings, today, time) {
    if (!zonedToUtc || !bookings.length) return 0;
    const done = store.read(sentKey, {});
    const nowMs = now().getTime();
    let sent = 0, changed = false;
    for (const k of Object.keys(done)) if (k.slice(-10) < today) { delete done[k]; changed = true; }
    for (const b of bookings) {
      if (!b || !b.clientId || !b.date || !b.time || b.date < today) continue;
      const at = zonedToUtc(b.date, b.time, tz).getTime();
      const when = prettyTime ? prettyTime(b.time) : b.time;
      for (const c of [
        { id: `${b.id}:eve:${b.date}`, fire: zonedToUtc(prevDay(b.date), "18:00", tz).getTime(), title: "Class tomorrow", body: `${b.title} tomorrow at ${when}.` },
        { id: `${b.id}:hour:${b.date}`, fire: at - 3600e3, title: "Class in an hour", body: `${b.title} at ${when}.` }
      ]) {
        if (done[c.id] || nowMs < c.fire || nowMs > c.fire + 30 * 60e3 || nowMs > at) continue;
        push.toClient(b.clientId, { title: c.title, body: c.body, route: "home", thread: "classes", collapseId: c.id });
        done[c.id] = new Date().toISOString(); sent++; changed = true;
      }
    }
    if (changed) store.write(sentKey, done);
    return sent;
  }

  return { sweep, stats, prefetchWeather };
}

module.exports = { createNudges, SUNNY_LINES, NUDGE_MODES, isClear };
