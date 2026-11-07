// Rewards (Duolingo-style): XP, levels and badges, always recomputed from the client's real history
// (workouts, pain log, visits, daily check-ins), so progress can't be lost, reset or gamed by editing a counter.
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (d) => addDay(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));

const XP = {
  // Workouts (owner's rules, Nov 2026): the day's best workout counts once a day. 30 for any finished workout,
  // 35 for one the member built themselves, 50 for a Dr. Jared program (content programs/protocols, incl. assigned).
  workout: { normal: 30, custom: 35, challenge: 30, program: 50 },
  challengeDone: 10,                                                  // + for finishing a challenge someone sent you (once a day)
  challengeSent: 5,                                                   // + for sending a challenge (once a day)
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

// Gemstone levels by lifetime XP (owner's ladder, Nov 7 2026): Peridot 0-50, Amber 51-500, Amethyst 501-2,500, Emerald 2,501-7,500,
// Ruby 7,501-15,000, Sapphire 15,001-30,000, Diamond 30,001-60,000, Platinum 60,001+. `xp` is where each gem starts.
// Permanent once earned (XP never goes down); level n = the n-th gem.
const GEMS = [
  { id: "peridot", name: "Peridot", xp: 0, mohs: 6.5, color: "#9ac85a" },
  { id: "amber", name: "Amber", xp: 51, mohs: 2.5, color: "#f2a900" },
  { id: "amethyst", name: "Amethyst", xp: 501, mohs: 7.0, color: "#8b5cf6" },
  { id: "emerald", name: "Emerald", xp: 2501, mohs: 7.75, color: "#2fa06a" },
  { id: "ruby", name: "Ruby", xp: 7501, mohs: 9.0, color: "#d8213c" },
  { id: "sapphire", name: "Sapphire", xp: 15001, mohs: 9.0, color: "#1d49a8" },
  { id: "diamond", name: "Diamond", xp: 30001, mohs: 10.0, color: "#c6edff" },
  { id: "platinum", name: "Platinum", xp: 60001, mohs: null, color: "#e5e5e5" }
];
// Level n (1-8) starts where gem n starts; past the top gem there is no next level (null).
const levelStart = (n) => (n >= 1 && n <= GEMS.length ? GEMS[n - 1].xp : n < 1 ? 0 : null);
const levelOf = (xp) => GEMS.reduce((lv, g, i) => (xp >= g.xp ? i + 1 : lv), 1);
const TITLES = GEMS.map((g) => g.name);

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

// ---- Workout XP (owner's rules) ----
// kind: "program" (a Dr. Jared program or protocol), "custom" (built by the member), "challenge" (a custom workout another
// member sent), anything else "normal". The server sets kind when the workout is logged; older rows without one count as
// a program when their key is a program key ("prog-<id>-...").
const WORKOUT_KINDS = ["normal", "custom", "challenge", "program"];
const workoutKind = (w) => (WORKOUT_KINDS.includes(w.kind) ? w.kind : /^prog-/.test(String(w.key || "")) ? "program" : "normal");
// Per clinic day: only the most valuable workout earns its base XP (30 / 35 / 50); more workouts that day earn 0 but still
// count for badges and streaks. Finishing a challenge adds +10 (once per challenge, once a day). Sending a challenge
// adds +5 to the sender (once a day, however many they send).
function workoutEvents(workouts = [], challengesSent = []) {
  const events = [], byDate = new Map(), bonusRefs = new Set();
  for (const w of workouts) if (w && w.date) byDate.set(w.date, [...(byDate.get(w.date) || []), w]);
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date).sort((a, b) => (String(a.completedAt) < String(b.completedAt) ? -1 : 1));
    let best = null, bestXp = 0;
    for (const w of list) { const v = XP.workout[workoutKind(w)]; if (v > bestXp) { best = w; bestXp = v; } }
    for (const w of list) events.push({ date, type: "workout", xp: w === best ? bestXp : 0, w });
    const ch = list.find((w) => workoutKind(w) === "challenge" && w.ref && !bonusRefs.has(w.ref));
    if (ch) { bonusRefs.add(ch.ref); events.push({ date, type: "bonus", reason: "challenge-done", xp: XP.challengeDone }); }
  }
  for (const date of [...new Set(challengesSent.map((c) => c && c.date).filter(Boolean))]) events.push({ date, type: "bonus", reason: "challenge-sent", xp: XP.challengeSent });
  return events;
}
// Daily activities (sunlight, sauna, ...): points are frozen on each check when it's made; one per activity per day.
function activityEvents(activities = []) {
  const seen = new Set(), out = [];
  for (const a of activities) {
    if (!a || !a.date || !a.habitId) continue;
    const k = `${a.date}|${a.habitId}`; if (seen.has(k)) continue; seen.add(k);
    const xp = Math.max(0, Math.min(100, Math.round(Number(a.points) || 0)));
    out.push({ date: a.date, type: "activity", xp, habitId: a.habitId });
  }
  return out;
}

// events: [{ date, type, xp, ... }] in date order; returns totals plus per-badge progress with the day it was earned
function rewards({ workouts = [], painLog = [], visits = [], vitals = [], actions = [], bookings = [], activities = [], challengesSent = [] }, today) {
  const events = [];
  const workoutDays = [...new Set(workouts.map((w) => w.date))].sort();
  const streakOn = new Map(); // date -> streak length ending that day
  workoutDays.forEach((d, i) => streakOn.set(d, i && workoutDays[i - 1] === addDay(d, -1) ? streakOn.get(workoutDays[i - 1]) + 1 : 1));
  events.push(...workoutEvents(workouts, challengesSent), ...activityEvents(activities));
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
    else if (e.type === "visit") state.visits++;
    for (const b of BADGES) {
      const v = b.kind === "goals" ? state.goals.size : state[b.kind];
      if (!earnedOn[b.id] && v >= b.target) { earnedOn[b.id] = e.date; xp += XP.badge; byDay.set(e.date, (byDay.get(e.date) || 0) + XP.badge); }
    }
  }
  const progress = { ...state, goals: state.goals.size };
  const level = levelOf(xp);
  const week = Array.from({ length: 7 }, (_, i) => { const d = addDay(mondayOf(today), i); return { date: d, xp: byDay.get(d) || 0 }; });
  const rank = gemstoneOf(xp);
  return {
    xp, level, title: TITLES[level - 1],
    levelStart: levelStart(level), nextLevel: levelStart(level + 1),
    rank, gems: GEMS,
    todayXp: byDay.get(today) || 0,
    // Today's XP split for the Home gem card: workouts (with challenge bonuses), daily activities, everything else
    todayParts: (() => {
      const o = { workouts: 0, activities: 0, other: 0 };
      for (const e of events) if (e.date === today) { if (e.type === "workout" || e.type === "bonus") o.workouts += e.xp; else if (e.type === "activity") o.activities += e.xp; }
      o.other = (byDay.get(today) || 0) - o.workouts - o.activities; // pain logs, check-ins, visits, badge bonuses, app actions
      return o;
    })(), dailyGoal: DAILY_GOAL, week,
    // XP earned since the 1st of this month (the monthly leaderboard resets on the 1st)
    monthXp: [...byDay].reduce((n, [d, x]) => n + (d.slice(0, 7) === today.slice(0, 7) && d <= today ? x : 0), 0),
    badges: BADGES.map((b) => ({ ...b, progress: Math.min(b.target, b.kind === "goals" ? progress.goals : progress[b.kind]), earned: Boolean(earnedOn[b.id]), earnedOn: earnedOn[b.id] || null }))
  };
}

module.exports = { rewards, BADGES, XP, ACTIONS, levelStart, levelOf, GEMS, gemstoneOf, repairsFrom, workoutKind, workoutEvents, activityEvents };
