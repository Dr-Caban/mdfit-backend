// Daily activities: the owner's list of everyday things that earn extra XP (sunlight 15, ice bath 20, prayer 10, ...).
//
// What it does:
//   - An admin-editable activity list (name, XP, a short "how" line, on/off). Defaults are the owner's list, Nov 2026.
//   - Members check activities off for today (clinic time zone). One check per activity per day; a second is refused.
//     Undo works the same day only. The XP of each check is frozen when it's made, so later admin edits don't rewrite
//     anyone's history. These checks feed lifetime XP and the gem levels (lib/rewards.js reads them).
//   - "Sending challenge workout" (+5) and "Doing challenge workout" (+10) are listed too, but they're earned by the
//     challenge flow (lib/custom-workouts.js), never by ticking a box.
//   - Flat points: no per-category caps and no frozen or re-entry goal (they conflicted with the owner's per-activity
//     points). A day "qualifies" when activities + workout XP reach the daily goal (admin-editable, default 30, i.e. one
//     workout or a few activities). Streak = qualifying days in a row; every 3 in a row earns a repair, and repairs only
//     bridge the DISPLAYED streak (never turn a missed day into a qualifying day). qualifyingDays(client, month) is exported.
//
// Storage: one record per member in the `habits` collection (activity ids, dates and XP only; no health details).
"use strict";
const { ValidationError } = require("./validate");
const { XP, workoutEvents, activityEvents } = require("./rewards");

const fail = (msg) => { throw new ValidationError(msg); };
const MONTH_RE = /^\d{4}-\d{2}$/;
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);

// ---------------- Defaults: the owner's list (Admin → Settings → Activities can change names, XP, how-to and on/off) ----------------
const AUTO = { "challenge-send": XP.challengeSent, "challenge-do": XP.challengeDone };
const DEFAULT_HABITS = [
  { id: "sunlight", name: "Sunlight", points: 5, how: "20 minutes outside in daylight." },
  { id: "acupressure", name: "Acupressure mat", points: 10, how: "10 to 20 minutes lying or standing on the mat." },
  { id: "foam-rolling", name: "Foam rolling", points: 10, how: "10 minutes rolling the areas that feel tight." },
  { id: "ice-bath", name: "Ice bath", points: 10, how: "Cold plunge or ice bath, 2 to 5 minutes. Never alone; skip it if your doctor said to avoid cold." },
  { id: "health-shot", name: "Health shot", points: 5, how: "Your daily wellness shot (ginger, turmeric, greens)." },
  { id: "prayer", name: "Prayer", points: 5, how: "A few quiet minutes of prayer." },
  { id: "meditation", name: "Meditation", points: 5, how: "10 minutes of meditation." },
  { id: "grounding", name: "Grounding", points: 5, how: "Bare feet on grass, sand or soil for a few minutes." },
  { id: "box-breathing", name: "Box breathing", points: 5, how: "In 4, hold 4, out 4, hold 4. Five rounds." },
  { id: "walk", name: "Walk (10 min)", points: 5, how: "A 10-minute walk or longer." },
  { id: "sauna", name: "Sauna", points: 5, how: "15 to 20 minutes of sauna. Hydrate; skip it if your doctor said to avoid heat." },
  { id: "stretching", name: "Stretching", points: 5, how: "10 minutes of stretching." },
  { id: "yoga", name: "Yoga", points: 10, how: "A yoga class or 20+ minutes of yoga at home." },
  { id: "no-screens", name: "No screens after 9 PM", points: 10, how: "Phone, TV and laptop off from 9 PM until bed. Check it off before you sleep." },
  { id: "massage", name: "Massage", points: 5, how: "A massage session (at MD Fit or anywhere)." },
  { id: "journaling", name: "Journaling", points: 5, how: "Write a few lines about your day." },
  { id: "red-light", name: "Red light", points: 5, how: "A red light therapy session." },
  { id: "active-recreation", name: "Active recreation", points: 10, how: "Pickleball, golf, swimming, a bike ride, playing with the kids." },
  { id: "challenge-send", name: "Sending challenge workout", points: AUTO["challenge-send"], auto: true, how: "Earned automatically when you send one of your workouts to another member (once a day)." },
  { id: "challenge-do", name: "Doing challenge workout", points: AUTO["challenge-do"], auto: true, how: "Earned automatically when you finish a challenge workout someone sent you (on top of the workout's 30)." }
];
const DEFAULT_GOAL = 50;
// Daily XP norms the member picks (owner): Beginner 50, Advanced 75, Elite 100+ (stored as beginner / intermediate / pro). A change applies from that
// day forward (goalLog), so raising the bar never turns past goal days into misses.
const GOAL_LEVELS = { beginner: 50, intermediate: 75, pro: 100 };
const goalOn = (doc, date) => { let lv = "beginner"; for (const g of (doc && doc.goalLog) || []) if (g.from <= date && GOAL_LEVELS[g.level]) lv = g.level; return { level: lv, goal: GOAL_LEVELS[lv] }; };
const CONFIG_VERSION = 2; // configs saved by the older habits build (categories, caps, levels) are replaced by the new defaults
const KEEP_DAYS = 800;

// Owner's rule (Nov 2026): activities are worth 5 XP, or 10 for the demanding ones (acupressure mat, foam rolling,
// ice bath, yoga, no screens after 9 PM, active recreation). A saved config from before this gets the new values once.
const POINTS_REVISION = 3;
function configFrom(saved) {
  const g = saved && typeof saved === "object" && saved.version === CONFIG_VERSION ? saved : {};
  const habits = (Array.isArray(g.habits) && g.habits.length ? g.habits : DEFAULT_HABITS).map((h) => ({ how: "", auto: false, active: true, ...h }));
  if ((g.pointsRevision || 0) < POINTS_REVISION) {
    const def = new Map(DEFAULT_HABITS.map((h) => [h.id, h.points]));
    for (const h of habits) if (def.has(h.id)) h.points = def.get(h.id);
  }
  for (const h of habits) if (AUTO[h.id] !== undefined) { h.auto = true; h.points = AUTO[h.id]; }
  return { habits, dailyGoal: Number.isInteger(g.dailyGoal) ? g.dailyGoal : DEFAULT_GOAL };
}

// ---------------- XP for each day: activities + workouts (same rules as lib/rewards.js) ----------------
function dayTotals(checks, workouts, challengesSent) {
  const byDay = new Map();
  const at = (d) => { if (!byDay.has(d)) byDay.set(d, { activities: 0, workouts: 0, checks: new Map(), sent: false, challengeDone: false }); return byDay.get(d); };
  for (const e of activityEvents(checks)) { const d = at(e.date); d.activities += e.xp; d.checks.set(e.habitId, e.xp); }
  for (const e of workoutEvents(workouts, challengesSent)) {
    const d = at(e.date); d.workouts += e.xp;
    if (e.reason === "challenge-sent") d.sent = true;
    if (e.reason === "challenge-done") d.challengeDone = true;
  }
  return byDay;
}

// ---------------- Timeline: one entry per day, first activity → today ----------------
function timeline(doc, workouts, challengesSent, today, cfg) {
  const totals = dayTotals((doc.checks || []).filter((x) => x.date <= today), (workouts || []).filter((w) => w.date && w.date <= today), (challengesSent || []).filter((c) => c.date <= today));
  let from = doc.since || today;
  for (const d of totals.keys()) if (d < from) from = d;
  if (daysBetween(from, today) > KEEP_DAYS) from = addDay(today, -KEEP_DAYS);
  const out = [];
  for (let d = from; d <= today; d = addDay(d, 1)) {
    const t = totals.get(d) || { activities: 0, workouts: 0, checks: new Map(), sent: false, challengeDone: false };
    const total = t.activities + t.workouts, g = goalOn(doc, d);
    out.push({ date: d, total, activities: t.activities, workouts: t.workouts, checks: t.checks, sent: t.sent, challengeDone: t.challengeDone, goal: g.goal, goalLevel: g.level,
      qualifying: total > 0 && total >= g.goal, recoveryOnly: t.workouts === 0 && t.activities > 0 });
  }
  return out;
}

// ---------------- Streaks and the repair ledger ----------------
// Walks the real days oldest → newest. Every 3rd consecutive qualifying day earns a repair (and referral grants add
// one on their date). A gap of N missed days is bridged in the displayed streak only if N repairs are available;
// otherwise the streak restarts and no repair is spent. Today is never "missed" while it's still today.
function streaks(tl, today, grants = []) {
  const grantsBy = new Map();
  for (const g of grants) grantsBy.set(g.date, [...(grantsBy.get(g.date) || []), g]);
  let actual = 0, shown = 0, best = 0, available = 0, missed = 0;
  const ledger = [];
  for (let i = 0; i < tl.length; i++) {
    const d = tl[i];
    for (const g of grantsBy.get(d.date) || []) { available++; ledger.push({ date: d.date, type: "earned", reason: g.reason || "Bonus repair" }); }
    if (d.qualifying) {
      actual++; shown++; best = Math.max(best, actual);
      if (actual % 3 === 0) { available++; ledger.push({ date: d.date, type: "earned", reason: "3 qualifying days in a row" }); }
      continue;
    }
    if (d.date >= today) continue; // today isn't over
    let j = i; while (j < tl.length && !tl[j].qualifying && tl[j].date < today) j++;
    const gap = j - i;
    missed += gap;
    if (shown > 0 && available >= gap) {
      for (let k = i; k < j; k++) ledger.push({ date: tl[k].date, type: "used", reason: "Missed day bridged in your streak" });
      available -= gap;
    } else shown = 0;
    actual = 0;
    for (let k = i + 1; k < j; k++) for (const g of grantsBy.get(tl[k].date) || []) { available++; ledger.push({ date: tl[k].date, type: "earned", reason: g.reason || "Bonus repair" }); }
    i = j - 1;
  }
  const earned = ledger.filter((x) => x.type === "earned").length, used = ledger.length - earned;
  return { current: shown, actual, best, missed, lifetimeQualifying: tl.filter((d) => d.qualifying).length,
    repairs: { available, earned, used, repairedDates: ledger.filter((x) => x.type === "used").map((x) => x.date), ledger } };
}

function mountHabits({ app, admin, me, store, clients, today: todayFn }) {
  const config = () => configFrom(store.read("habit-config", null));
  const docs = () => store.read("habits", []);
  const docOf = (clientId, list = docs()) => list.find((d) => d.clientId === clientId) || { clientId, checks: [], grants: [] };
  function saveDoc(doc) {
    const keepFrom = addDay(todayFn(), -KEEP_DAYS);
    doc.checks = (doc.checks || []).filter((x) => x.date >= keepFrom);
    const list = docs().filter((d) => d.clientId !== doc.clientId);
    list.push(doc);
    store.write("habits", list);
  }
  const workoutsOf = (clientId) => { const c = clients().find((x) => x.id === clientId); return (c && c.workouts) || []; };
  const sentBy = (clientId) => store.read("challenges", []).filter((c) => c.fromId === clientId).map((c) => ({ date: c.date }));

  function summary(clientId, { persist = false } = {}) {
    const cfg = config(), t = todayFn();
    const doc = docOf(clientId);
    if (persist && !doc.since) { doc.since = t; saveDoc(doc); }
    const tl = timeline(doc, workoutsOf(clientId), sentBy(clientId), t, cfg);
    return { cfg, doc, tl, t, day: tl[tl.length - 1], st: streaks(tl, t, doc.grants || []) };
  }

  function todayView(s) {
    const { cfg, day, st } = s;
    const autoDone = { "challenge-send": day.sent, "challenge-do": day.challengeDone };
    return {
      date: s.t, goal: day.goal, goalLevel: day.goalLevel, goalLevels: GOAL_LEVELS, points: day.activities, workoutXp: day.workouts, total: day.total, remaining: Math.max(0, day.goal - day.total),
      qualifying: day.qualifying, recoveryOnly: day.recoveryOnly,
      habits: cfg.habits.filter((h) => h.active !== false).map((h) => {
        const done = h.auto ? !!autoDone[h.id] : day.checks.has(h.id);
        return { id: h.id, name: h.name, points: h.points, how: h.how || "", auto: !!h.auto, done, earned: done ? (h.auto ? h.points : day.checks.get(h.id)) : 0 };
      }),
      workoutRules: { normal: XP.workout.normal, custom: XP.workout.custom, program: XP.workout.program, challengeBonus: XP.challengeDone, challengeSent: XP.challengeSent },
      streak: { current: st.current, actual: st.actual, best: st.best, missed: st.missed, lifetimeQualifying: st.lifetimeQualifying },
      repairs: { available: st.repairs.available, earned: st.repairs.earned, used: st.repairs.used, ledger: st.repairs.ledger.slice(-20).reverse() }
    };
  }

  // ----- Exports for other modules (Earned membership credits, referrals) -----
  function qualifyingDays(client, month) {
    if (!MONTH_RE.test(String(month))) fail("Month must look like 2026-11.");
    const id = client && typeof client === "object" ? client.id : client;
    return summary(id).tl.filter((d) => d.qualifying && d.date.slice(0, 7) === month).map((d) => d.date);
  }
  function grantRepair(clientId, reason = "Referral bonus", n = 1) {
    const doc = docOf(clientId), t = todayFn();
    doc.grants = [...(doc.grants || []), ...Array.from({ length: Math.max(1, Math.min(10, Math.floor(n))) }, () => ({ date: t, reason: String(reason).slice(0, 80), at: new Date().toISOString() }))];
    if (!doc.since) doc.since = t;
    saveDoc(doc);
  }
  // Activity checks for lib/clients.js (lifetime XP, leaderboard): [{ date, habitId, points }]
  const checksOf = (clientId) => (docOf(clientId).checks || []).map(({ date, habitId, points }) => ({ date, habitId, points }));

  // ================= Member =================
  me.get("/habits/today", (req, res) => res.json(todayView(summary(req.client.id, { persist: true }))));

  // The member's daily XP norm: beginner 50 / intermediate 75 / pro 100, from today on
  me.put("/habits/goal", (req, res) => {
    const level = String((req.body && req.body.level) || "");
    if (!GOAL_LEVELS[level]) fail("Pick Beginner, Advanced or Elite.");
    const t = todayFn(), doc = docOf(req.client.id);
    doc.goalLog = [...(doc.goalLog || []).filter((g) => g.from < t), { from: t, level }];
    if (!doc.since) doc.since = t;
    saveDoc(doc);
    res.json(todayView(summary(req.client.id)));
  });
  me.post("/habits/checkin", (req, res) => {
    const habitId = String((req.body && req.body.habitId) || "");
    const cfg = config();
    const h = cfg.habits.find((x) => x.id === habitId && x.active !== false);
    if (!h) fail("Pick an activity from the list.");
    if (h.auto) return res.status(409).json({ error: `${h.name} counts by itself through challenges, so there's nothing to check off.`, auto: true });
    const s = summary(req.client.id, { persist: true });
    if (s.day.checks.has(h.id)) return res.status(409).json({ error: `${h.name} is already checked off today.`, duplicate: true });
    s.doc.checks = [...(s.doc.checks || []), { date: s.t, habitId: h.id, points: h.points, at: new Date().toISOString() }];
    saveDoc(s.doc);
    const out = todayView(summary(req.client.id));
    out.checked = { habitId: h.id, earned: h.points };
    res.status(201).json(out);
  });

  // Undo: today's own check only (yesterday's can't be undone).
  me.delete("/habits/checkin/:habitId", (req, res) => {
    const s = summary(req.client.id, { persist: true });
    const before = (s.doc.checks || []).length;
    s.doc.checks = (s.doc.checks || []).filter((x) => !(x.date === s.t && x.habitId === req.params.habitId));
    if (s.doc.checks.length === before) return res.status(404).json({ error: "That activity isn't checked off today." });
    saveDoc(s.doc);
    res.json(todayView(summary(req.client.id)));
  });

  me.get("/habits/history", (req, res) => {
    const s = summary(req.client.id);
    const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : s.t.slice(0, 7);
    const [y, m] = month.split("-").map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const byDate = new Map(s.tl.map((d) => [d.date, d])), repaired = new Set(s.st.repairs.repairedDates);
    const days = [];
    for (let i = 1; i <= last; i++) {
      const date = `${month}-${String(i).padStart(2, "0")}`, d = byDate.get(date);
      if (date > s.t) { days.push({ date, future: true }); continue; }
      if (!d) { days.push({ date, points: 0, goal: null, qualifying: false, missed: false, repaired: false }); continue; }
      days.push({ date, points: d.total, goal: d.goal, qualifying: d.qualifying, recoveryOnly: d.qualifying && d.recoveryOnly,
        missed: !d.qualifying && date < s.t, repaired: repaired.has(date), today: date === s.t });
    }
    res.json({ month, today: s.t, days, qualifyingDays: days.filter((d) => d.qualifying).length,
      streak: { current: s.st.current, best: s.st.best, lifetimeQualifying: s.st.lifetimeQualifying, missed: s.st.missed }, repairs: { available: s.st.repairs.available } });
  });

  // ================= Admin =================
  const str = (v, label, max, min = 0) => { const s = String(v ?? "").trim(); if (s.length < min) fail(`${label} is required.`); if (s.length > max) fail(`${label} is too long.`); return s; };
  const int = (v, label, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${label} must be a whole number from ${lo} to ${hi}.`); return n; };
  const adminView = () => ({ ...config(), defaults: { habits: DEFAULT_HABITS, dailyGoal: DEFAULT_GOAL }, autoIds: Object.keys(AUTO) });
  // Admin → Clients: one client's activity, day by day (XP, workouts, pain check-ins, goal days) for the chart
  function series(c, daysWanted) {
    const days = Math.min(365, Math.max(7, parseInt(daysWanted, 10) || 90)), t = todayFn(), from = addDay(t, -(days - 1));
    const byDate = new Map(timeline(docOf(c.id), c.workouts || [], sentBy(c.id), t, config()).map((d) => [d.date, d]));
    const count = (list) => { const m = new Map(); for (const x of list || []) if (x && x.date) m.set(x.date, (m.get(x.date) || 0) + 1); return m; };
    const pain = count(c.painLog), wk = count(c.workouts);
    const pres = app.get("presenceApi"), mins = pres ? pres.minutesByDay(c.id) : {};
    const out = [];
    for (let d = from; d <= t; d = addDay(d, 1)) {
      const x = byDate.get(d);
      out.push({ date: d, xp: x ? x.total : 0, activities: x ? x.activities : 0, workouts: wk.get(d) || 0, pain: pain.get(d) || 0, minutes: mins[d] || 0, goal: x ? x.goal : null,
        qualifying: !!(x && x.qualifying), active: !!((x && x.total > 0) || wk.get(d) || pain.get(d)), opened: !!mins[d] });
    }
    const activeIn = (n) => out.slice(-n).filter((d) => d.active).length, last = [...out].reverse().find((d) => d.active), first = out.find((d) => d.active);
    return { days: out, summary: { days, active7: activeIn(7), active30: activeIn(30), activeAll: activeIn(out.length), qualifying30: out.slice(-30).filter((d) => d.qualifying).length,
      xp30: out.slice(-30).reduce((n, d) => n + d.xp, 0), workouts30: out.slice(-30).reduce((n, d) => n + d.workouts, 0), minutes30: out.slice(-30).reduce((n, d) => n + d.minutes, 0),
      minutesAll: out.reduce((n, d) => n + d.minutes, 0), opened30: out.slice(-30).filter((d) => d.opened).length, lastActive: last ? last.date : null, firstActive: first ? first.date : null } };
  }
  // Which daily activities a client logs most (last N days), for the admin overview
  function topHabits(clientId, daysBack = 30) {
    const since = addDay(todayFn(), -(daysBack - 1)), names = new Map(config().habits.map((h) => [h.id, h.name]));
    const n = new Map();
    for (const x of docOf(clientId).checks || []) if (x.date >= since) n.set(x.habitId, (n.get(x.habitId) || 0) + 1);
    return [...n.entries()].map(([id, count]) => ({ id, name: names.get(id) || id, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  }
  admin.get("/clients/:id/activity", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json(series(c, req.query.days));
  });
  // Other modules (the admin client overview in lib/clients.js) read these at request time
  app.set("habitsApi", { summary: (clientId) => todayView(summary(clientId)), series, topHabits });
  admin.get("/habits", (req, res) => res.json(adminView()));
  admin.put("/habits", (req, res) => {
    const b = req.body || {}, cur = config();
    const next = { version: CONFIG_VERSION, pointsRevision: POINTS_REVISION, habits: cur.habits, dailyGoal: cur.dailyGoal }; // an admin save keeps its own point values from here on
    if (b.habits !== undefined) {
      if (!Array.isArray(b.habits) || !b.habits.length || b.habits.length > 60) fail("1 to 60 activities.");
      const seen = new Set();
      next.habits = b.habits.map((h, i) => {
        const id = str(h && h.id, `Activity ${i + 1} id`, 40, 1).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (seen.has(id)) fail(`Activity "${id}" is listed twice.`); seen.add(id);
        const name = str(h.name, `Activity ${i + 1} name`, 80, 1);
        const auto = AUTO[id] !== undefined;
        // the two challenge items are earned by the challenge flow; their XP is fixed in lib/rewards.js
        return { id, name, points: auto ? AUTO[id] : int(h.points, `${name} XP`, 0, 100), how: str(h.how, `${name} how-to`, 200), auto, active: h.active !== false };
      });
      for (const id of Object.keys(AUTO)) if (!seen.has(id)) fail(`Keep the "${id}" activity (switch it off instead of deleting it).`);
    }
    if (b.dailyGoal !== undefined) next.dailyGoal = int(b.dailyGoal, "Daily goal", 10, 500);
    store.write("habit-config", next);
    res.json(adminView());
  });

  const api = { qualifyingDays, grantRepair, summary, config, checksOf };
  app.set("habits", api);
  Object.assign(exported, api);
  return api;
}

const exported = {
  mountHabits, configFrom, dayTotals, timeline, streaks, DEFAULT_HABITS, DEFAULT_GOAL, AUTO,
  qualifyingDays: () => { throw new Error("habits module is not mounted yet"); },
  grantRepair: () => { throw new Error("habits module is not mounted yet"); }
};
module.exports = exported;
