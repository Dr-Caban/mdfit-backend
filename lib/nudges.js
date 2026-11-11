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
"use strict";

const QUIET_FROM = 21, QUIET_TO = 8;        // 9 PM .. 8 AM
const STREAK_NUDGE_HOUR = 18;               // 6 PM: time to still do something about it
const GOAL_HOUR_MIN = 9;                    // don't shout about a goal reached at 3 AM

const hourOf = (t) => Number(String(t || "").slice(0, 2)) || 0;
const prevDay = (d) => new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);

function createNudges({ store, clients, save, push, rewardsOf, nowParts, zonedToUtc, prettyTime, tz, now = () => new Date(), logger }) {
  const quiet = (hour) => hour >= QUIET_FROM || hour < QUIET_TO;

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
      const firstSweep = !c.notified;
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
      if (!firstSweep && hour === STREAK_NUDGE_HOUR && streak >= 2 && r.todayXp === 0 && seen.streak !== today) {
        push.toClient(c.id, { title: `Keep your ${streak}-day streak`, body: "Nothing logged yet today. A short session or a check-in keeps it alive.", route: "home", thread: "rewards", collapseId: `streak:${today}` });
        seen.streak = today; sent++; changed = true;
      }
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

  return { sweep };
}

module.exports = { createNudges };
