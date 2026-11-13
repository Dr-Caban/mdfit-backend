// Progress report: one calculation for the member's "My progress" (Profile) and for the owner's view of that member
// (Workspace -> Clients -> Progress), so the two always show the same numbers. Read-only: it never writes anything.
//
//   GET /api/me/progress?days=N               the signed-in member's own report
//   GET /api/admin/clients/:id/progress?days=N the same report for one client (staff with the "clients" permission)
//
// Built only from what members already log: workouts, pain check-ins, daily activity (lib/habits.js) and vitals.
// How far back a member can see: free accounts see the last 30 days; full access (an active membership, an active
// paid treatment plan, or a client marked inpatient) sees up to 365. The workspace always sees up to 365.
// Nothing here is logged: the report is health information.
"use strict";

const DEFAULT_DAYS = 90, FREE_DAYS = 30, FULL_DAYS = 365;
const VITALS = ["weight", "restingHr", "sleep"];
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (date) => addDay(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Full access: active membership, an active paid treatment plan, or an inpatient (the whole app is free to them)
const fullAccess = (c, activeMembership) => !!(activeMembership(c) || (c.protocols || []).some((p) => p && p.status === "active") || c.clientType === "inpatient");

// Total sessions in a program and how many are done, from the logged program workouts (same keys as programProgress)
function programRow(p, prog, label) {
  const pr = prog || { sessions: 0, weeksStarted: [], daysDone: [] };
  const perWeek = Array.isArray(p.perWeek) && p.perWeek.length ? p.perWeek.reduce((n, x) => n + (Number(x) || 0), 0) : 0;
  const byWeek = pr.weeksStarted.length > 0 && !pr.daysDone.length; // a week-by-week protocol: progress = weeks started
  const total = Math.max(1, byWeek ? Number(p.weeks) || pr.weeksStarted.length : perWeek || (Number(p.weeks) || 1) * ((p.days || []).length || 1));
  const done = Math.min(total, byWeek ? pr.weeksStarted.length : pr.sessions);
  return { id: p.id, title: p.title, label, done, total, pct: Math.round((done / total) * 100) };
}

function report(c, { today, days, maxDays, member, programs, programProgress, habits, workoutStats }) {
  const to = today, n = Math.max(1, Math.min(days, maxDays)), from = addDay(to, -(n - 1));
  const inRange = (d) => typeof d === "string" && DATE_RE.test(d) && d >= from && d <= to;
  const workouts = (c.workouts || []).filter((w) => w && DATE_RE.test(w.date || ""));
  const pain = (c.painLog || []).filter((p) => p && inRange(p.date) && Number.isFinite(Number(p.level)));

  // Active days: the habits timeline when it is there (the same "active" the app shows), else any workout or check-in
  let series = null;
  try { series = habits ? habits.series(c, Math.max(n, 30)) : null; } catch { series = null; }
  const days_ = series && Array.isArray(series.days) ? series.days : Array.isArray(series) ? series : null;
  const active = new Set();
  if (days_) for (const d of days_) { if (d && d.active) active.add(d.date); }
  else { for (const w of workouts) active.add(w.date); for (const p of c.painLog || []) if (p && p.date) active.add(p.date); }

  // Weeks, Monday first, oldest to newest, covering the whole range
  const weeks = [];
  for (let wk = mondayOf(from); wk <= to; wk = addDay(wk, 7)) {
    const end = addDay(wk, 6), inWeek = (d) => d >= wk && d <= end && d >= from && d <= to;
    const ws = workouts.filter((w) => inWeek(w.date));
    let activeDays = 0; for (let d = wk; d <= end; d = addDay(d, 1)) if (inWeek(d) && active.has(d)) activeDays++;
    weeks.push({ week: wk, workouts: ws.length, minutes: ws.reduce((m, w) => m + (Number(w.minutes) || 0), 0), activeDays });
  }

  // Pain by body area, most-logged area first; each area's points in date order
  const byArea = new Map();
  for (const p of pain.slice().sort((a, b) => (a.date + (a.createdAt || "") < b.date + (b.createdAt || "") ? -1 : 1))) {
    const area = String(p.area || "general");
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push({ date: p.date, level: Math.max(0, Math.min(10, Number(p.level))) });
  }
  const areas = [...byArea.entries()].map(([area, points]) => ({ area, points })).sort((a, b) => b.points.length - a.points.length || (a.area < b.area ? -1 : 1));
  const top = areas[0];
  const painChange = top && top.points.length ? { area: top.area, first: top.points[0].level, last: top.points[top.points.length - 1].level, delta: top.points[top.points.length - 1].level - top.points[0].level } : null;

  // Streak: the number the app already shows (habits), else consecutive workout days
  let streak = 0;
  try { const s = habits && habits.summary ? habits.summary(c.id) : null; streak = s && s.streak && Number.isFinite(s.streak.current) ? s.streak.current : workoutStats(workouts, to).streak; }
  catch { streak = workoutStats(workouts, to).streak; }
  const month = to.slice(0, 8) + "01";
  let activeDays30 = 0; for (let d = addDay(to, -29); d <= to; d = addDay(d, 1)) if (active.has(d)) activeDays30++;

  // Programs: Recommended (assigned by Dr. Jared) first, then Saved (pinned by the member); unknown ids left out
  const byId = new Map((programs || []).map((p) => [p.id, p]));
  const assigned = (c.assignedPrograms || []).filter((a) => a && byId.has(a.id));
  const prog = programProgress([...assigned, ...(c.pinnedPrograms || []).map((id) => ({ id }))], workouts);
  const rows = [...assigned.map((a) => programRow(byId.get(a.id), prog[a.id], "Recommended")),
    ...(c.pinnedPrograms || []).filter((id) => byId.has(id) && !assigned.some((a) => a.id === id)).map((id) => programRow(byId.get(id), prog[id], "Saved"))];

  // Vitals: only the readings this person actually has, in date order
  const vitals = {};
  const vs = (c.vitals || []).filter((v) => v && inRange(v.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const k of VITALS) { const pts = vs.filter((v) => Number.isFinite(Number(v[k])) && v[k] !== null && v[k] !== "").map((v) => ({ date: v.date, value: Number(v[k]) })); if (pts.length) vitals[k] = pts; }

  return {
    range: { days: n, from, to, maxDays, member, capped: days > maxDays },
    headline: { workoutsThisMonth: workouts.filter((w) => w.date >= month && w.date <= to).length, activeDays30, streak, painChange },
    weeks, pain: { areas }, programs: rows, vitals
  };
}

function mountProgress({ app, admin, me, store, clients, today, activeMembership, programProgress, workoutStats }) {
  const asked = (q) => { const n = parseInt(q, 10); return Number.isInteger(n) && n > 0 ? Math.min(n, 3650) : DEFAULT_DAYS; };
  const ctx = (c, days, maxDays) => ({ today: today(), days, maxDays, member: fullAccess(c, activeMembership),
    programs: require("./content").programsOf(store.read("content", {})), programProgress, workoutStats, habits: app.get("habitsApi") || null });

  me.get("/progress", (req, res) => {
    const c = req.client, days = asked(req.query.days), max = fullAccess(c, activeMembership) ? FULL_DAYS : FREE_DAYS;
    res.set("Cache-Control", "no-store").json(report(c, ctx(c, days, max)));
  });
  admin.get("/clients/:id/progress", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.set("Cache-Control", "no-store").json(report(c, ctx(c, asked(req.query.days), FULL_DAYS)));
  });
}

module.exports = { mountProgress, report, fullAccess, DEFAULT_DAYS, FREE_DAYS, FULL_DAYS };
