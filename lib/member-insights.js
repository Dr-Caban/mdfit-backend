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
"use strict";
const SCREENS = { home: "Home", programs: "Programs", generate: "Workout builder", videos: "Videos", pain: "Pain tool", progress: "Progress", leaders: "Leaderboard", learn: "Learn", tips: "Guides and nutrition", messages: "Messages", premium: "Membership page", profile: "Profile", visit: "Video visit" };
const addDay = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function mountMemberInsights({ admin, store, clients, today }) {
  admin.get("/analytics/members", (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const t = today(), from = addDay(t, -(days - 1)), d7 = addDay(t, -6), d30 = addDay(t, -29), d14 = addDay(t, -13);
    const list = clients().filter((c) => c && !c.deletedAt), pres = store.read("presence", {}) || {};
    const habits = new Map((store.read("habits", []) || []).map((h) => [h.clientId, h]));
    const sends = store.read("sends", []) || [];
    const inRange = (d) => !!d && d >= from && d <= t;
    const dateOf = (x) => (x && String(x.date || x.completedAt || "").slice(0, 10)) || "";

    const active = { today: 0, week: 0, month: 0 }, cameBack = { eligible: 0, returned: 0 }, dropOff = { eligible: 0, neverReturned: 0, wentQuiet: 0 };
    const screens = Object.fromEntries(Object.keys(SCREENS).map((k) => [k, { people: 0, seconds: 0 }]));
    const actions = { workouts: { count: 0, people: 0 }, pain: { count: 0, people: 0 }, checks: { count: 0, people: 0 }, sends: { count: 0, people: 0 } };
    const paid = { signups: 0, paying: 0, payingAll: 0, before: Object.fromEntries(Object.keys(SCREENS).map((k) => [k, 0])) };
    const tally = (a, n) => { if (n) { a.count += n; a.people += 1; } };

    for (const c of list) {
      const pd = (pres[c.id] || {}).days || {}, checks = (habits.get(c.id) || {}).checks || [];
      const on = new Set(Object.keys(pd));
      for (const x of [...(c.workouts || []), ...(c.painLog || []), ...checks]) { const d = dateOf(x); if (d) on.add(d); }
      const dates = [...on].filter((d) => d <= t).sort(), last = dates[dates.length - 1] || "";
      const joined = String(c.createdAt || "").slice(0, 10);
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
      for (const [d, x] of Object.entries(pd)) if (inRange(d)) for (const [v, s] of Object.entries((x && x.views) || {})) if (screens[v] && s > 0) { screens[v].seconds += s; seen.add(v); }
      for (const v of seen) screens[v].people++;
      tally(actions.workouts, (c.workouts || []).filter((x) => inRange(dateOf(x))).length);
      tally(actions.pain, (c.painLog || []).filter((x) => inRange(dateOf(x))).length);
      tally(actions.checks, checks.filter((x) => inRange(dateOf(x))).length);
      tally(actions.sends, sends.filter((s) => s && s.fromId === c.id && inRange(s.date)).length);
      const pays = !!(c.membership && c.membership.stripeSubscriptionId);
      if (joined && joined >= from) { paid.signups++; if (pays) paid.paying++; }
      if (pays) {
        paid.payingAll++;
        const since = String(c.membership.since || "").slice(0, 10), was = new Set();
        for (const [d, x] of Object.entries(pd)) if (!since || d <= since) for (const [v, s] of Object.entries((x && x.views) || {})) if (screens[v] && s > 0) was.add(v);
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
