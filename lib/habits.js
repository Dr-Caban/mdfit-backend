// Healthy habits and daily points (developer update items 11, 12 and 13, first slice of Release B).
//
// What it does:
//   - An admin-editable habit library (points, category, optional + safer alternative) with per-category daily caps.
//   - Members check habits off for today (clinic time zone). One check per habit per day; a second is refused.
//     Undo works the same day only. Finished workouts in the existing workout log count on their own
//     ("Completed workout" 30, or "Prescribed rehabilitation session" 25 for rehab sessions), never twice.
//   - The daily goal is computed at the member's first request of the day and frozen for that day. It can be
//     lowered during the day (member picks an easier level) but never raised. After 7+ days with no points the goal
//     restarts at 20 and rises 5 for every active day until it is back to normal (gentle re-entry, spec item 6/12).
//   - A qualifying day = points >= that day's goal. A recovery-only day (no workout, no rehab) can qualify.
//   - Streak = consecutive qualifying days. Every 3 in a row earns 1 repair. Repairs only bridge gaps in the
//     DISPLAYED streak; they never turn a missed day into a qualifying day (billing and history read the real days).
//
// Storage: one record per member in the `habits` collection (no health details: habit ids, dates, points, goals).
// Past days keep the points and caps they were earned with, so later admin edits don't rewrite history.
// The repair ledger is derived from the frozen history every time, so it can't drift from the real days.
"use strict";
const { ValidationError } = require("./validate");

const fail = (msg) => { throw new ValidationError(msg); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, MONTH_RE = /^\d{4}-\d{2}$/;
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);

// ---------------- Defaults (owner's proposed points; everything here is editable in Admin → Settings → Habits) ----------------
// Caps are per category per day. They keep one kind of activity from carrying a whole day while still letting a
// recovery-only day reach even the Elite goal of 75 without the optional sauna or cold
// (sun 10 + mind 15 + posture/mobility 25 + acupressure 10 + walking 15 = 75; with sauna/cold up to 90).
const DEFAULT_CATEGORIES = [
  { id: "outdoors", label: "Sun & outdoors", cap: 10 },
  { id: "mind", label: "Mind & breath", cap: 15 },
  { id: "mobility", label: "Posture & mobility", cap: 25 },
  { id: "recovery", label: "Recovery", cap: 25 },
  { id: "walking", label: "Walking", cap: 15 },
  { id: "rehab", label: "Rehabilitation", cap: 25 },
  { id: "workout", label: "Workout", cap: 30 }
];
const DEFAULT_HABITS = [
  { id: "sunlight", name: "Morning sunlight", category: "outdoors", points: 5, how: "10 minutes of daylight within an hour of waking." },
  { id: "barefoot", name: "Barefoot outdoor time", category: "outdoors", points: 5, how: "A few minutes on grass, sand or soil." },
  { id: "gratitude", name: "Gratitude or positivity", category: "mind", points: 5, how: "Write or say three things you're grateful for." },
  { id: "posture", name: "GOSD posture practice", category: "mobility", points: 5, how: "A few focused minutes of your GOSD posture drill." },
  { id: "breathing", name: "Box breathing", category: "mind", points: 5, how: "In 4, hold 4, out 4, hold 4. Five rounds." },
  { id: "meditation", name: "Meditation or prayer", category: "mind", points: 10, how: "10 quiet minutes." },
  { id: "mobility", name: "Mobility", category: "mobility", points: 10, how: "10 minutes of joint mobility work." },
  { id: "stretching", name: "Stretching", category: "mobility", points: 10, how: "10 minutes of stretching." },
  { id: "acupressure", name: "Acupressure mat", category: "recovery", points: 10, how: "10 to 20 minutes on the mat." },
  { id: "sauna", name: "Sauna or heat exposure", category: "recovery", points: 10, optional: true,
    alternative: "Warm shower or a heating pad for 10 minutes counts the same. Skip heat if you're pregnant, have a heart condition or were told to avoid it." },
  { id: "cold", name: "Cold plunge or ice bath", category: "recovery", points: 15, optional: true,
    alternative: "A cool shower finish (30 to 60 seconds) counts the same. Skip cold if you have a heart condition, Raynaud's or are pregnant. Never alone." },
  { id: "walking", name: "Walking", category: "walking", points: 15, how: "20 minutes or more." },
  { id: "rehab", name: "Prescribed rehabilitation session", category: "rehab", points: 25, auto: true, how: "Counts by itself when you finish a rehab session, protocol or pain track in the app. Did it on your own? Check it off." },
  { id: "workout", name: "Completed workout", category: "workout", points: 30, auto: true, how: "Counts by itself when you finish a workout in the app. Trained somewhere else? Check it off." }
];
const DEFAULT_LEVELS = { beginner: 30, advanced: 50, elite: 75 };
const LEVEL_LABEL = { beginner: "Beginner", advanced: "Advanced", elite: "Elite" };
const REENTRY = { after: 7, start: 20, step: 5 }; // 7+ quiet days → goal 20, +5 per active day, back to normal
const KEEP_DAYS = 800; // checks and frozen goals older than this are trimmed (billing only looks back a month or two)

// The workout log has no "type" field; rehab sessions are the ones the app names that way (protocols, pain tracks,
// rehab programs and generator rehab sessions).
const isRehabWorkout = (w) => /rehab/i.test(w.goal || "") || /rehab|pain track|protocol/i.test(w.title || "");

function configFrom(saved) {
  const g = saved && typeof saved === "object" ? saved : {};
  const categories = Array.isArray(g.categories) && g.categories.length ? g.categories : DEFAULT_CATEGORIES;
  const habits = Array.isArray(g.habits) && g.habits.length ? g.habits : DEFAULT_HABITS;
  return {
    categories: categories.map((c) => ({ ...c })),
    habits: habits.map((h) => ({ optional: false, alternative: "", how: "", auto: false, active: true, ...h })),
    levels: { ...DEFAULT_LEVELS, ...(g.levels || {}) }
  };
}
const capsOf = (cfg) => Object.fromEntries(cfg.categories.map((c) => [c.id, c.cap]));
const autoOf = (cfg) => {
  const h = (id) => cfg.habits.find((x) => x.id === id && x.active !== false);
  return { workout: h("workout") ? h("workout").points : 0, rehab: h("rehab") ? h("rehab").points : 0 };
};

// ---------------- Points for one day ----------------
// checks: this member's check rows for the day ({habitId, points, category}); workouts: workout log rows that day.
// snap: { caps, auto } in force that day (frozen with the day's goal, or today's config).
// A logged workout fills the "workout" habit (rehab sessions fill "rehab") unless the member already checked it by
// hand, so the same session is never counted twice; a second workout the same day adds nothing.
function dayPoints(checks, workouts, snap) {
  const rows = [];
  const seen = new Set();
  for (const x of checks) if (!seen.has(x.habitId)) { seen.add(x.habitId); rows.push({ habitId: x.habitId, category: x.category, points: x.points, source: "check" }); }
  const hasRehab = workouts.some(isRehabWorkout), hasWorkout = workouts.some((w) => !isRehabWorkout(w));
  if (hasWorkout && !seen.has("workout") && snap.auto.workout) rows.push({ habitId: "workout", category: "workout", points: snap.auto.workout, source: "workout log" });
  if (hasRehab && !seen.has("rehab") && snap.auto.rehab) rows.push({ habitId: "rehab", category: "rehab", points: snap.auto.rehab, source: "workout log" });
  const byCategory = {}, byHabit = {}, capped = new Set();
  for (const r of rows) {
    const cap = Number.isFinite(snap.caps[r.category]) ? snap.caps[r.category] : Infinity;
    const got = Math.max(0, Math.min(r.points, cap - (byCategory[r.category] || 0)));
    if (got < r.points) capped.add(r.category);
    byCategory[r.category] = (byCategory[r.category] || 0) + got;
    byHabit[r.habitId] = { points: got, source: r.source };
  }
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const trained = !!(byHabit.workout || byHabit.rehab);
  return { total, byHabit, byCategory, capped: [...capped], recoveryOnly: total > 0 && !trained };
}

// ---------------- Daily goal ----------------
// normal = the member's chosen current level (Beginner 30 / Advanced 50 / Elite 75; default Beginner).
// re-entry: after REENTRY.after or more days in a row with no points, goal = 20 and +5 for each active day since,
// capped at normal. Another long gap restarts it.
function goalFor({ cfg, level, inactiveBefore, ramp }) {
  const lv = cfg.levels[level] ? level : "beginner";
  const normal = cfg.levels[lv];
  if (ramp) {
    const goal = Math.min(normal, REENTRY.start + REENTRY.step * ramp.active);
    if (goal < normal) {
      const quiet = ramp.quiet;
      return { goal, normal, level: lv, reentry: true,
        reason: `Welcome back. After ${quiet} quiet days, today's goal is ${goal} points. It goes up ${REENTRY.step} for each active day until it's back to your ${LEVEL_LABEL[lv]} goal of ${normal}.` };
    }
  }
  return { goal: normal, normal, level: lv, reentry: false, reason: `${LEVEL_LABEL[lv]} level: ${normal} points a day.` };
}

// ---------------- Timeline: one entry per day, first activity → today ----------------
// Days with a frozen record use its goal, caps and auto points; other days (the member never opened the app but
// logged a workout) are judged by the same formula with today's settings.
function timeline(doc, workouts, today, cfg) {
  const buckets = new Map();
  const at = (d) => { if (!buckets.has(d)) buckets.set(d, { checks: [], workouts: [] }); return buckets.get(d); };
  for (const x of doc.checks || []) if (x.date <= today) at(x.date).checks.push(x);
  for (const w of workouts || []) if (w.date && w.date <= today) at(w.date).workouts.push(w);
  let from = doc.since || today;
  for (const d of buckets.keys()) if (d < from) from = d;
  if (daysBetween(from, today) > KEEP_DAYS) from = addDay(today, -KEEP_DAYS);
  const liveSnap = { caps: capsOf(cfg), auto: autoOf(cfg) };
  const out = [];
  let inactive = 0, ramp = null;
  for (let d = from; d <= today; d = addDay(d, 1)) {
    if (inactive >= REENTRY.after) ramp = { active: 0, quiet: inactive };
    const computed = goalFor({ cfg, level: doc.level, inactiveBefore: inactive, ramp });
    if (ramp && !computed.reentry) ramp = null;
    const frozen = doc.days && doc.days[d];
    const g = frozen ? { ...computed, ...frozen, frozen: true } : { ...computed, inactiveBefore: inactive, frozen: false };
    const b = buckets.get(d) || { checks: [], workouts: [] };
    const pts = dayPoints(b.checks, b.workouts, frozen && frozen.caps ? { caps: frozen.caps, auto: frozen.auto || liveSnap.auto } : liveSnap);
    const qualifying = pts.total > 0 && pts.total >= g.goal;
    out.push({ date: d, ...pts, goal: g.goal, goalRec: g, qualifying });
    if (ramp && pts.total > 0) ramp.active++;
    inactive = pts.total > 0 ? 0 : inactive + 1;
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
    // grants dated inside the gap still count
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
  const docOf = (clientId, list = docs()) => list.find((d) => d.clientId === clientId) || { clientId, level: null, checks: [], days: {}, grants: [] };
  function saveDoc(doc) {
    const keepFrom = addDay(todayFn(), -KEEP_DAYS);
    doc.checks = (doc.checks || []).filter((x) => x.date >= keepFrom);
    doc.days = Object.fromEntries(Object.entries(doc.days || {}).filter(([d]) => d >= keepFrom));
    const list = docs().filter((d) => d.clientId !== doc.clientId);
    list.push(doc);
    store.write("habits", list);
  }
  const workoutsOf = (clientId) => { const c = clients().find((x) => x.id === clientId); return (c && c.workouts) || []; };

  // Everything for one member. With persist, today's goal is frozen on the first call of the day.
  function summary(clientId, { persist = false } = {}) {
    const cfg = config(), t = todayFn();
    const doc = docOf(clientId);
    let changed = false;
    if (persist && !doc.since) { doc.since = t; changed = true; }
    let tl = timeline(doc, workoutsOf(clientId), t, cfg);
    if (persist && !(doc.days || {})[t]) {
      const g = tl[tl.length - 1].goalRec;
      doc.days = { ...(doc.days || {}), [t]: { goal: g.goal, normal: g.normal, level: g.level, reentry: g.reentry, reason: g.reason, inactiveBefore: g.inactiveBefore,
        caps: capsOf(cfg), auto: autoOf(cfg), at: new Date().toISOString() } };
      changed = true;
      tl = timeline(doc, workoutsOf(clientId), t, cfg);
    }
    if (changed) saveDoc(doc);
    return { cfg, doc, tl, t, day: tl[tl.length - 1], st: streaks(tl, t, doc.grants || []) };
  }

  function todayView(s) {
    const { cfg, day, st, doc } = s, g = day.goalRec;
    const label = (cid) => (cfg.categories.find((c) => c.id === cid) || {}).label || cid;
    return {
      date: s.t, goal: day.goal, points: day.total, remaining: Math.max(0, day.goal - day.total), qualifying: day.qualifying,
      level: g.level, chosenLevel: doc.level || null, levels: cfg.levels, normalGoal: g.normal, reentry: !!g.reentry, reason: g.reason, frozenAt: g.at || null,
      recoveryOnly: day.recoveryOnly,
      habits: cfg.habits.filter((h) => h.active !== false).map((h) => {
        const got = day.byHabit[h.id];
        return { id: h.id, name: h.name, category: h.category, categoryLabel: label(h.category), points: h.points, optional: !!h.optional, alternative: h.alternative || "",
          how: h.how || "", auto: !!h.auto, done: !!got, earned: got ? got.points : 0, source: got ? got.source : null };
      }),
      categories: cfg.categories.map((c) => ({ id: c.id, label: c.label, cap: c.cap, earned: day.byCategory[c.id] || 0, capped: day.capped.includes(c.id) })),
      streak: { current: st.current, actual: st.actual, best: st.best, missed: st.missed, lifetimeQualifying: st.lifetimeQualifying },
      repairs: { available: st.repairs.available, earned: st.repairs.earned, used: st.repairs.used, ledger: st.repairs.ledger.slice(-20).reverse() }
    };
  }

  // ----- Exports for other modules (Earned membership credits, referrals) -----
  // Real qualifying days for a calendar month (clinic dates). Repairs never add days here.
  function qualifyingDays(client, month) {
    if (!MONTH_RE.test(String(month))) fail("Month must look like 2026-11.");
    const id = client && typeof client === "object" ? client.id : client;
    return summary(id).tl.filter((d) => d.qualifying && d.date.slice(0, 7) === month).map((d) => d.date);
  }
  // A verified referral (or an admin) can grant streak repairs. They only bridge the displayed streak.
  function grantRepair(clientId, reason = "Referral bonus", n = 1) {
    const doc = docOf(clientId), t = todayFn();
    doc.grants = [...(doc.grants || []), ...Array.from({ length: Math.max(1, Math.min(10, Math.floor(n))) }, () => ({ date: t, reason: String(reason).slice(0, 80), at: new Date().toISOString() }))];
    if (!doc.since) doc.since = t;
    saveDoc(doc);
  }

  // ================= Member =================
  me.get("/habits/today", (req, res) => res.json(todayView(summary(req.client.id, { persist: true }))));

  me.post("/habits/checkin", (req, res) => {
    const habitId = String((req.body && req.body.habitId) || "");
    const cfg = config();
    const h = cfg.habits.find((x) => x.id === habitId && x.active !== false);
    if (!h) fail("Pick a habit from the list.");
    const s = summary(req.client.id, { persist: true });
    if (s.day.byHabit[h.id]) {
      const fromLog = s.day.byHabit[h.id].source === "workout log";
      return res.status(409).json({ error: fromLog ? `${h.name} already counts from the session you logged today.` : `${h.name} is already checked off today.`, duplicate: true });
    }
    s.doc.checks = [...(s.doc.checks || []), { date: s.t, habitId: h.id, category: h.category, points: h.points, at: new Date().toISOString() }];
    saveDoc(s.doc);
    const out = todayView(summary(req.client.id));
    const got = out.habits.find((x) => x.id === h.id);
    out.checked = { habitId: h.id, earned: got ? got.earned : 0,
      note: got && got.earned < h.points ? `Saved. ${(cfg.categories.find((c) => c.id === h.category) || {}).label || "This category"} is capped at ${(cfg.categories.find((c) => c.id === h.category) || {}).cap} points a day.` : null };
    res.status(201).json(out);
  });

  // Undo: today's own check only. Points from the workout log can't be undone here (delete the workout instead).
  me.delete("/habits/checkin/:habitId", (req, res) => {
    const s = summary(req.client.id, { persist: true });
    const before = (s.doc.checks || []).length;
    s.doc.checks = (s.doc.checks || []).filter((x) => !(x.date === s.t && x.habitId === req.params.habitId));
    if (s.doc.checks.length === before) {
      const fromLog = s.day.byHabit[req.params.habitId] && s.day.byHabit[req.params.habitId].source === "workout log";
      return res.status(fromLog ? 409 : 404).json({ error: fromLog ? "That one comes from a session you logged, so it can't be unchecked here." : "That habit isn't checked off today." });
    }
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

  // Current level: changes the goal from tomorrow. Today's frozen goal may go down at once, never up.
  me.put("/habits/level", (req, res) => {
    const level = String((req.body && req.body.level) || "");
    const cfg = config();
    if (!cfg.levels[level]) fail("Pick Beginner, Advanced or Elite.");
    const s = summary(req.client.id, { persist: true });
    s.doc.level = level;
    const rec = s.doc.days[s.t];
    const others = { ...s.doc, days: { ...s.doc.days } }; delete others.days[s.t];
    const would = timeline(others, workoutsOf(req.client.id), s.t, cfg).pop().goalRec;
    if (rec && would.goal < rec.goal) s.doc.days[s.t] = { ...rec, goal: would.goal, normal: would.normal, level: would.level, reentry: would.reentry, reason: would.reason, loweredAt: new Date().toISOString() };
    saveDoc(s.doc);
    const out = todayView(summary(req.client.id));
    out.note = rec && would.goal > rec.goal ? `Saved. Your new goal of ${would.goal} starts tomorrow; today stays at ${rec.goal}.` : null;
    res.json(out);
  });

  // ================= Admin =================
  const str = (v, label, max, min = 0) => { const s = String(v ?? "").trim(); if (s.length < min) fail(`${label} is required.`); if (s.length > max) fail(`${label} is too long.`); return s; };
  const int = (v, label, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${label} must be a whole number from ${lo} to ${hi}.`); return n; };
  const adminView = () => ({ ...config(), defaults: { habits: DEFAULT_HABITS, categories: DEFAULT_CATEGORIES, levels: DEFAULT_LEVELS }, reentry: REENTRY });
  admin.get("/habits", (req, res) => res.json(adminView()));
  admin.put("/habits", (req, res) => {
    const b = req.body || {}, cur = config(), next = { ...(store.read("habit-config", null) || {}) };
    let categories = cur.categories;
    if (b.categories !== undefined) {
      if (!Array.isArray(b.categories) || !b.categories.length || b.categories.length > 30) fail("1 to 30 categories.");
      const seen = new Set();
      categories = b.categories.map((c, i) => {
        const id = str(c && c.id, `Category ${i + 1} id`, 30, 1).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (seen.has(id)) fail(`Category "${id}" is listed twice.`); seen.add(id);
        return { id, label: str(c.label, `Category ${i + 1} name`, 40, 1), cap: int(c.cap, `${c.label || id} daily cap`, 0, 500) };
      });
      next.categories = categories;
    }
    if (b.habits !== undefined) {
      if (!Array.isArray(b.habits) || !b.habits.length || b.habits.length > 60) fail("1 to 60 habits.");
      const seen = new Set(), cats = new Set(categories.map((c) => c.id));
      next.habits = b.habits.map((h, i) => {
        const id = str(h && h.id, `Habit ${i + 1} id`, 40, 1).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (seen.has(id)) fail(`Habit "${id}" is listed twice.`); seen.add(id);
        const name = str(h.name, `Habit ${i + 1} name`, 80, 1);
        if (!cats.has(h.category)) fail(`${name}: pick one of the categories.`);
        const optional = !!h.optional, alternative = str(h.alternative, `${name} safer alternative`, 300);
        if (optional && !alternative) fail(`${name} is optional, so give a safer alternative.`);
        // workout and rehab are filled from the workout log; their ids are fixed so that keeps working
        return { id, name, category: h.category, points: int(h.points, `${name} points`, 0, 100), optional, alternative, how: str(h.how, `${name} how-to`, 200),
          auto: id === "workout" || id === "rehab", active: h.active !== false };
      });
      for (const id of ["workout", "rehab"]) if (!seen.has(id)) fail(`Keep the "${id}" habit (switch it off instead of deleting it).`);
    } else if (b.categories !== undefined) {
      const cats = new Set(categories.map((c) => c.id));
      const orphan = cur.habits.find((h) => !cats.has(h.category));
      if (orphan) fail(`${orphan.name} uses a category you removed.`);
    }
    if (b.levels !== undefined) {
      const lv = {};
      for (const k of Object.keys(DEFAULT_LEVELS)) lv[k] = int(b.levels[k] ?? cur.levels[k], `${LEVEL_LABEL[k]} goal`, 10, 300);
      next.levels = lv;
    }
    store.write("habit-config", next);
    res.json(adminView());
  });

  const api = { qualifyingDays, grantRepair, summary, config };
  app.set("habits", api);
  Object.assign(exported, api);
  return api;
}

// Module-level handles, set when mounted, so other modules can `require("./habits").qualifyingDays(client, "2026-11")`.
const exported = {
  mountHabits, configFrom, dayPoints, goalFor, timeline, streaks, isRehabWorkout,
  DEFAULT_HABITS, DEFAULT_CATEGORIES, DEFAULT_LEVELS, REENTRY,
  qualifyingDays: () => { throw new Error("habits module is not mounted yet"); },
  grantRepair: () => { throw new Error("habits module is not mounted yet"); }
};
module.exports = exported;
