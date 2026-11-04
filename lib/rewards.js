// Rewards (Duolingo-style): XP, levels and badges, always recomputed from the client's real history
// (workouts, pain log, visits, daily check-ins), so progress can't be lost, reset or gamed by editing a counter.
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (d) => addDay(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));

const XP = {
  workout: (w) => 20 + Math.round(Math.min(w.minutes || 0, 60) / 2), // 20 to 50 per workout
  streakBonus: (day) => Math.min(day, 10) * 2,                       // day 2 of a streak +4 ... capped at +20
  pain: 5,                                                            // first 3 pain logs a day
  visit: 50,                                                          // completed visit with Dr. Jared
  badge: 25,                                                          // bonus for every milestone badge
  checkin: 5                                                          // per daily reading (weight, sleep, watch numbers), max 2 a day
};
const PAIN_XP_PER_DAY = 3;
// Everyday actions: XP each, max per day. Repeats of the same item (ref) on one day count once.
const ACTIONS = {
  video: { xp: 2, cap: 10 }, lecture: { xp: 10, cap: 3 }, message: { xp: 3, cap: 3 }, reaction: { xp: 1, cap: 3 },
  favorite: { xp: 2, cap: 5 }, program: { xp: 5, cap: 3 }, generate: { xp: 2, cap: 3 }, share: { xp: 5, cap: 1 },
  booking: { xp: 15, cap: 2 }, profile: { xp: 5, cap: 1 }
};
const DAILY_GOAL = 30;

// Level n starts at 50·n·(n-1) XP: 0, 100, 300, 600, 1000, 1500 ...
const levelStart = (n) => 50 * n * (n - 1);
const TITLES = ["Starter", "Mover", "Builder", "Strong", "Athlete", "Performer", "Elite", "Champion", "Legend"];

// Gemstone rank system — 8 lifetime achievement ranks ordered by Mohs hardness then rarity.
// Permanent once earned; not affected by inactivity. XP thresholds are initial values and will
// be admin-configurable later. Rank badges display on dashboard, profile, leaderboards, etc.
const GEMS = [
  { id: "peridot", name: "Peridot", xp: 0, mohs: 6.5, color: "#9ac85a" },
  { id: "garnet", name: "Garnet", xp: 500, mohs: 7.0, color: "#c13a5c" },
  { id: "onyx", name: "Onyx", xp: 1500, mohs: 7.0, color: "#1a1a1a" },
  { id: "emerald", name: "Emerald", xp: 4000, mohs: 7.75, color: "#2fa06a" },
  { id: "ruby", name: "Ruby", xp: 8000, mohs: 9.0, color: "#d8213c" },
  { id: "sapphire", name: "Sapphire", xp: 15000, mohs: 9.0, color: "#1d49a8" },
  { id: "diamond", name: "Diamond", xp: 30000, mohs: 10.0, color: "#c6edff" },
  { id: "platinum", name: "Platinum", xp: 60000, mohs: null, color: "#e5e5e5" }
];
function gemstoneOf(xp) {
  let cur = GEMS[0], next = null;
  for (let i = 0; i < GEMS.length; i++) {
    if (xp >= GEMS[i].xp) { cur = GEMS[i]; next = GEMS[i + 1] || null; }
  }
  const span = next ? next.xp - cur.xp : 0;
  const into = xp - cur.xp;
  return { current: cur, next, progress: next ? Math.max(0, Math.min(1, into / span)) : 1, xpIntoRank: into, xpToNext: next ? Math.max(0, next.xp - xp) : 0 };
}

// Streak repairs: every 3 consecutive qualifying days a user is awarded one "repair" token.
// Applying a repair bridges a missed day in the visual streak calculation without altering real
// activity history. `usedRepairs` is a list of ISO dates stored on the client object.
function repairsFrom(workouts = [], usedRepairs = []) {
  const days = [...new Set(workouts.map((w) => w.date))].sort();
  // Count completed 3-day streak blocks. A block = any date d where d-1 and d-2 are also workout days.
  let earned = 0;
  for (let i = 2; i < days.length; i++) {
    if (days[i - 1] === addDay(days[i], -1) && days[i - 2] === addDay(days[i], -2)) {
      // Award at most 1 per 3-day window to avoid stacking from a long streak
      if ((i - 2) % 3 === 0) earned++;
    }
  }
  return { earned, used: usedRepairs.length, available: Math.max(0, earned - usedRepairs.length), usedDates: usedRepairs };
}

const BADGES = [
  { id: "first-workout", title: "First Rep", desc: "Finish your first workout", icon: "bolt", kind: "workouts", target: 1 },
  { id: "workouts-10", title: "Ten Strong", desc: "Finish 10 workouts", icon: "dumbbell", kind: "workouts", target: 10 },
  { id: "workouts-50", title: "Half Century", desc: "Finish 50 workouts", icon: "dumbbell", kind: "workouts", target: 50 },
  { id: "workouts-100", title: "Century Club", desc: "Finish 100 workouts", icon: "trophy", kind: "workouts", target: 100 },
  { id: "streak-3", title: "On a Roll", desc: "Work out 3 days in a row", icon: "flame", kind: "streak", target: 3 },
  { id: "streak-7", title: "Week Warrior", desc: "Work out 7 days in a row", icon: "flame", kind: "streak", target: 7 },
  { id: "streak-30", title: "Unbreakable", desc: "Work out 30 days in a row", icon: "flame", kind: "streak", target: 30 },
  { id: "week-3", title: "Three-a-Week", desc: "3 workouts in one week (Mon to Sun)", icon: "calendar", kind: "week", target: 3 },
  { id: "hours-10", title: "Ten Hours In", desc: "Train for 10 hours total", icon: "clock", kind: "minutes", target: 600 },
  { id: "explorer", title: "Explorer", desc: "Try all 5 workout goals", icon: "compass", kind: "goals", target: 5 },
  { id: "checkin-7", title: "Check-in Habit", desc: "Log your daily check-in on 7 days", icon: "calendar", kind: "checkins", target: 7 },
  { id: "pain-5", title: "Listening to Your Body", desc: "Log your pain 5 times", icon: "pulse", kind: "pain", target: 5 },
  { id: "pain-down", title: "Feeling Better", desc: "Drop pain 3+ points in one area", icon: "heart", kind: "painDrop", target: 3 },
  { id: "first-visit", title: "Team MD Fit", desc: "Complete a visit with Dr. Jared", icon: "star", kind: "visits", target: 1 }
];

// events: [{ date, type, xp, ... }] in date order; returns totals plus per-badge progress with the day it was earned
function rewards({ workouts = [], painLog = [], visits = [], vitals = [], actions = [], bookings = [] }, today) {
  const events = [];
  const workoutDays = [...new Set(workouts.map((w) => w.date))].sort();
  const streakOn = new Map(); // date -> streak length ending that day
  workoutDays.forEach((d, i) => streakOn.set(d, i && workoutDays[i - 1] === addDay(d, -1) ? streakOn.get(workoutDays[i - 1]) + 1 : 1));
  const firstOfDay = new Set();
  for (const w of [...workouts].sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1))) {
    let xp = XP.workout(w);
    if (!firstOfDay.has(w.date)) { firstOfDay.add(w.date); xp += streakOn.get(w.date) > 1 ? XP.streakBonus(streakOn.get(w.date)) : 0; }
    events.push({ date: w.date, type: "workout", xp, w });
  }
  const painPerDay = new Map();
  for (const p of painLog) {
    const n = (painPerDay.get(p.date) || 0) + 1;
    painPerDay.set(p.date, n);
    events.push({ date: p.date, type: "pain", xp: n <= PAIN_XP_PER_DAY ? XP.pain : 0, p });
  }
  for (const v of visits) events.push({ date: v.date, type: "visit", xp: XP.visit });
  const perDay = new Map(), seen = new Set();
  const action = (date, kind, ref) => {
    const a = ACTIONS[kind]; if (!a || !date) return;
    const k = `${date}|${kind}`, r = `${k}|${ref || ""}`;
    if (ref && seen.has(r)) return; seen.add(r);
    const n = (perDay.get(k) || 0) + 1; perDay.set(k, n);
    if (n <= a.cap) events.push({ date, type: "action", xp: a.xp });
  };
  [...actions].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((x) => action(x.date, x.kind, x.ref));
  bookings.forEach((b) => action(b.date > today ? today : b.date, "booking", b.id));
  for (const v of vitals) {
    const n = ["weight", "sleep", "restingHr", "hrv", "vo2max"].filter((k) => v[k] !== undefined && v[k] !== null).length;
    if (n) events.push({ date: v.date, type: "checkin", xp: Math.min(n, 2) * XP.checkin });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Walk history once, recording the day each badge was first earned
  const state = { workouts: 0, streak: 0, week: 0, minutes: 0, goals: new Set(), pain: 0, painDrop: 0, visits: 0, checkins: 0 };
  const firstPain = new Map(), weekCount = new Map();
  const earnedOn = {};
  let xp = 0;
  const byDay = new Map();
  for (const e of events) {
    xp += e.xp;
    byDay.set(e.date, (byDay.get(e.date) || 0) + e.xp);
    if (e.type === "workout") {
      state.workouts++; state.minutes += e.w.minutes || 0;
      state.streak = Math.max(state.streak, streakOn.get(e.date));
      const wk = mondayOf(e.date); weekCount.set(wk, (weekCount.get(wk) || 0) + 1);
      state.week = Math.max(state.week, weekCount.get(wk));
      if (e.w.goal) state.goals.add(e.w.goal);
    } else if (e.type === "pain") {
      state.pain++;
      if (!firstPain.has(e.p.area)) firstPain.set(e.p.area, e.p.level);
      state.painDrop = Math.max(state.painDrop, firstPain.get(e.p.area) - e.p.level);
    } else if (e.type === "checkin") state.checkins++;
    else if (e.type === "action") {}
    else state.visits++;
    for (const b of BADGES) {
      const v = b.kind === "goals" ? state.goals.size : state[b.kind];
      if (!earnedOn[b.id] && v >= b.target) { earnedOn[b.id] = e.date; xp += XP.badge; byDay.set(e.date, (byDay.get(e.date) || 0) + XP.badge); }
    }
  }
  const progress = { ...state, goals: state.goals.size };
  let level = 1;
  while (xp >= levelStart(level + 1)) level++;
  const week = Array.from({ length: 7 }, (_, i) => { const d = addDay(mondayOf(today), i); return { date: d, xp: byDay.get(d) || 0 }; });
  const rank = gemstoneOf(xp);
  return {
    xp, level, title: TITLES[Math.min(level, TITLES.length) - 1],
    levelStart: levelStart(level), nextLevel: levelStart(level + 1),
    rank, gems: GEMS,
    todayXp: byDay.get(today) || 0, dailyGoal: DAILY_GOAL, week,
    badges: BADGES.map((b) => ({ ...b, progress: Math.min(b.target, b.kind === "goals" ? progress.goals : progress[b.kind]), earned: Boolean(earnedOn[b.id]), earnedOn: earnedOn[b.id] || null }))
  };
}

module.exports = { rewards, BADGES, XP, ACTIONS, levelStart, GEMS, gemstoneOf, repairsFrom };
