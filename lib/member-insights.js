// What members do once they are inside the app, for the owner (Insights). Counts only: no names, no ids, nothing
// that says which member did what.
//
//   active      accounts that opened the app (or logged something) today, in the last 7 days, in the last 30 days
//   cameBack    of accounts at least a week old, how many were active again a week or more after joining
//   screens     for each screen of the app in the period: how many members opened it, and minutes spent
//   actions     workouts logged, pain check-ins, daily checks and things sent to another member in the period
//   paid        of the accounts created in the period, how many pay by card now; and which screens paying members
//               had opened before the day their membership began
//   dropOff     accounts that never returned after the day they joined; accounts that used the app and then went
//               quiet for 14 days
//
// "Active" comes from the app's own heartbeat (lib/presence.js: seconds per day per screen) plus the dates of
// anything logged, so an account that only uses an older app build is still counted.
//
// An account here is a record someone has signed in to. A patient the office added or imported who has never signed
// in has no app account yet, and is not counted anywhere on this screen.
// Every day compared here is a clinic day: today, the heartbeat's days, the days things were logged, and the day an
// account was made (clinicDay, passed in by server.js; without it the UTC date of createdAt is used).
"use strict";
const SCREENS = { home: "Home", programs: "Programs", generate: "Workout builder", videos: "Videos", pain: "Pain tool", progress: "Progress", leaders: "Leaderboard", learn: "Learn", tips: "Guides and nutrition", messages: "Messages", premium: "Membership page", profile: "Profile", visit: "Video visit" };
const addDay = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// One odd value in the store (a list saved as something else, a date that is not a date) must not take the whole
// screen down: it is read as empty and the rest is still counted.
const arr = (v) => (Array.isArray(v) ? v : []);
const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T12:00:00Z"));

function mountMemberInsights({ admin, store, clients, today, clinicDay }) {
  // The day an account was made, on the clinic's calendar. The UTC date of createdAt is the next day for anyone who
  // signed up in the evening (after 7 PM in Sarasota, 8 PM in summer), so they looked a day younger than they were:
  // back the next morning read as "never came back", and they missed "a week old" by a day.
  const dayOf = typeof clinicDay === "function" ? clinicDay : (iso) => String(iso || "").slice(0, 10);
  const joinDay = (c) => { let d = ""; try { d = dayOf(c.createdAt); } catch { d = ""; } return isDay(d) ? d : ""; };

  admin.get("/analytics/members", (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const t = today(), from = addDay(t, -(days - 1)), d7 = addDay(t, -6), d30 = addDay(t, -29), d14 = addDay(t, -13);
    const list = arr(clients()).filter((c) => c && !c.deletedAt && c.lastLoginAt), pres = store.read("presence", {}) || {};
    const habits = new Map(arr(store.read("habits", [])).filter(Boolean).map((h) => [h.clientId, h]));
    const sends = arr(store.read("sends", []));
    const inRange = (d) => !!d && d >= from && d <= t;
    const dateOf = (x) => (x && String(x.date || x.completedAt || "").slice(0, 10)) || "";

    const active = { today: 0, week: 0, month: 0 }, cameBack = { eligible: 0, returned: 0 }, dropOff = { eligible: 0, neverReturned: 0, wentQuiet: 0 };
    const screens = Object.fromEntries(Object.keys(SCREENS).map((k) => [k, { people: 0, seconds: 0 }]));
    const actions = { workouts: { count: 0, people: 0 }, pain: { count: 0, people: 0 }, checks: { count: 0, people: 0 }, sends: { count: 0, people: 0 } };
    const paid = { signups: 0, paying: 0, payingAll: 0, before: Object.fromEntries(Object.keys(SCREENS).map((k) => [k, 0])) };
    const tally = (a, n) => { if (n) { a.count += n; a.people += 1; } };

    for (const c of list) {
      const pd = (pres[c.id] || {}).days || {}, checks = arr((habits.get(c.id) || {}).checks), workouts = arr(c.workouts), painLog = arr(c.painLog);
      const on = new Set(Object.keys(pd));
      for (const x of [...workouts, ...painLog, ...checks]) { const d = dateOf(x); if (d) on.add(d); }
      const dates = [...on].filter((d) => d <= t).sort(), last = dates[dates.length - 1] || "";
      const joined = joinDay(c);
      if (on.has(t)) active.today++;
      if (last >= d7) active.week++;
      if (last >= d30) active.month++;
      if (joined && joined <= addDay(t, -7)) { cameBack.eligible++; if (dates.some((d) => d >= addDay(joined, 7))) cameBack.returned++; }
      if (joined && joined < addDay(t, -1)) {
        dropOff.eligible++;
        if (!dates.some((d) => d > joined)) dropOff.neverReturned++;
        else if (last < d14) dropOff.wentQuiet++;
      }
      const seen = new Set();
      for (const [d, x] of Object.entries(pd)) if (inRange(d)) for (const [v, s] of Object.entries((x && x.views) || {})) if (screens[v] && Number(s) > 0) { screens[v].seconds += Number(s); seen.add(v); }
      for (const v of seen) screens[v].people++;
      tally(actions.workouts, workouts.filter((x) => inRange(dateOf(x))).length);
      tally(actions.pain, painLog.filter((x) => inRange(dateOf(x))).length);
      tally(actions.checks, checks.filter((x) => inRange(dateOf(x))).length);
      tally(actions.sends, sends.filter((s) => s && s.fromId === c.id && inRange(s.date)).length);
      // Paying by card now: a card subscription whose paid-through date has not passed, the same test Economics and
      // the partner statements use. One whose card failed and whose paid-through date is behind us is not paying.
      const m = c.membership, pays = !!(m && m.stripeSubscriptionId && (!m.until || String(m.until) >= t));
      if (joined && joined >= from) { paid.signups++; if (pays) paid.paying++; }
      if (pays) {
        paid.payingAll++;
        // Before the day the membership began: what they open on that day, as a paying member, is not counted
        const since = String(m.since || "").slice(0, 10), was = new Set();
        for (const [d, x] of Object.entries(pd)) if (!since || d < since) for (const [v, s] of Object.entries((x && x.views) || {})) if (screens[v] && Number(s) > 0) was.add(v);
        for (const v of was) paid.before[v]++;
      }
    }
    res.json({ days, members: list.length, active, cameBack, dropOff, actions,
      screens: Object.entries(screens).map(([key, x]) => ({ key, label: SCREENS[key], people: x.people, minutes: Math.round(x.seconds / 60) })).filter((x) => x.people).sort((a, b) => b.people - a.people || b.minutes - a.minutes),
      paid: { signups: paid.signups, paying: paid.paying, payingAll: paid.payingAll,
        before: Object.entries(paid.before).map(([key, people]) => ({ key, label: SCREENS[key], people })).filter((x) => x.people).sort((a, b) => b.people - a.people).slice(0, 5) } });
  });
}

module.exports = { mountMemberInsights };
