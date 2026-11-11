// Achievement and reminder pushes: what goes out, what stays quiet, and what never goes out twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createNudges } = require("../lib/nudges");
const { rewards } = require("../lib/rewards");

function harness({ hour = 12, clientsList = [], devices = [{ clientId: "c1" }] } = {}) {
  const data = { devices, "pushsent-classes": {} };
  const store = { read: (k, d) => (k in data ? data[k] : d), write: (k, v) => { data[k] = v; } };
  const sentOut = [];
  const push = { enabled: true, toClient: (id, note) => sentOut.push({ id, ...note }) };
  let list = clientsList;
  const today = "2026-11-11";
  const n = createNudges({
    store, clients: () => list, save: (l) => { list = l; }, push,
    rewardsOf: (c) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], activities: c.activities || [] }, today),
    nowParts: () => ({ date: today, time: String(hour).padStart(2, "0") + ":00" }),
    zonedToUtc: (d, t) => new Date(`${d}T${t}:00Z`),
    prettyTime: (t) => t, tz: "America/New_York", now: () => new Date(`${today}T${String(hour).padStart(2, "0")}:00:00Z`),
    logger: { warn() {} }
  });
  return { n, sentOut, list: () => list, data };
}
const days = (...d) => d.map((date) => ({ date, kind: "normal", minutes: 20, exercises: 5 }));

test("the first sweep records what a member already has without congratulating them for it", async () => {
  const h = harness({ clientsList: [{ id: "c1", workouts: days("2026-11-09", "2026-11-10", "2026-11-11") }] });
  h.n.sweep();
  assert.equal(h.sentOut.length, 0, "nothing is announced on the first sweep");
  const seen = h.list()[0].notified;
  assert.ok(seen.level >= 1 && seen.badges.length >= 1, "but it is remembered");
});

test("a badge earned after the first sweep is announced once", async () => {
  const c = { id: "c1", workouts: days("2026-11-11") };
  const h = harness({ clientsList: [c] });
  h.n.sweep();                                   // records the starting point
  assert.equal(h.sentOut.length, 0);
  c.workouts = days("2026-11-09", "2026-11-10", "2026-11-11");   // now a 3-day streak badge
  h.n.sweep();
  const badge = h.sentOut.filter((x) => /Badge earned/.test(x.title));
  assert.equal(badge.length, 1, "announced");
  assert.equal(badge[0].route, "progress");
  h.n.sweep();
  assert.equal(h.sentOut.filter((x) => /Badge earned/.test(x.title)).length, 1, "and never again");
});

test("the daily goal is announced once a day, and nothing is sent during quiet hours", async () => {
  const c = { id: "c1", workouts: days("2026-11-11") };
  const quiet = harness({ hour: 23, clientsList: [{ ...c, notified: { badges: ["streak-3"], level: 2, goal: "", streak: "" } }] });
  quiet.n.sweep();
  assert.equal(quiet.sentOut.length, 0, "9 PM to 8 AM stays silent");

  const day = harness({ hour: 12, clientsList: [{ ...c, notified: { badges: [], level: 2, goal: "", streak: "" } }] });
  day.n.sweep();
  const goal = day.sentOut.filter((x) => x.title === "Daily goal reached");
  assert.equal(goal.length, 1);
  day.n.sweep();
  assert.equal(day.sentOut.filter((x) => x.title === "Daily goal reached").length, 1, "once a day");
});

test("the streak nudge goes out at 6 PM only to someone with a streak and nothing logged today", async () => {
  const withStreak = { id: "c1", workouts: days("2026-11-09", "2026-11-10"), notified: { badges: ["streak-3"], level: 2, goal: "", streak: "" } };
  const h = harness({ hour: 18, clientsList: [withStreak] });
  h.n.sweep();
  const nudge = h.sentOut.filter((x) => /Keep your/.test(x.title));
  assert.equal(nudge.length, 1);
  assert.match(nudge[0].title, /2-day streak/);
  h.n.sweep();
  assert.equal(h.sentOut.filter((x) => /Keep your/.test(x.title)).length, 1, "once that day");

  // someone who already trained today is left alone
  const done = harness({ hour: 18, clientsList: [{ id: "c1", workouts: days("2026-11-10", "2026-11-11"), notified: { badges: ["streak-3"], level: 2, goal: "2026-11-11", streak: "" } }] });
  done.n.sweep();
  assert.equal(done.sentOut.filter((x) => /Keep your/.test(x.title)).length, 0);
});

test("a member with no device is never swept", async () => {
  const h = harness({ devices: [], clientsList: [{ id: "c1", workouts: days("2026-11-09", "2026-11-10", "2026-11-11"), notified: { badges: [], level: 1, goal: "", streak: "" } }] });
  h.n.sweep();
  assert.equal(h.sentOut.length, 0);
});

test("a class is reminded the evening before and an hour before, each once", async () => {
  const booking = { id: "b1", clientId: "c1", title: "Mobility & Core", date: "2026-11-12", time: "09:00" };
  const eve = harness({ hour: 18, clientsList: [] });
  eve.n.sweep([booking]);
  assert.equal(eve.sentOut.filter((x) => x.title === "Class tomorrow").length, 1);
  eve.n.sweep([booking]);
  assert.equal(eve.sentOut.filter((x) => x.title === "Class tomorrow").length, 1, "not twice");

  const hour = harness({ hour: 8, clientsList: [] });
  hour.n.sweep([{ ...booking, date: "2026-11-11" }]);
  assert.equal(hour.sentOut.filter((x) => x.title === "Class in an hour").length, 1);
});
