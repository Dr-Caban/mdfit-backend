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

// ---------------- Sunny's daily nudge ----------------
// A movable clock (UTC stands in for the clinic's zone here), a presence store, and a stubbed weather service.
function sunny({ clientsList = [], date = "2026-11-11", hour = 8, weather = { cloud_cover: 10, precipitation: 0, is_day: 1 }, pushed = {} } = {}) {
  const clock = { date, hour };
  const data = { devices: clientsList.map((c) => ({ clientId: c.id })), "pushsent-classes": {}, presence: {} };
  const store = { read: (k, d) => (k in data ? data[k] : d), write: (k, v) => { data[k] = v; } };
  const sentOut = [];
  const push = { enabled: true, toClient: (id, note) => sentOut.push({ id, ...note }) };
  let list = clientsList, calls = 0;
  const at = () => new Date(`${clock.date}T${String(clock.hour).padStart(2, "0")}:05:00Z`);
  const fetchImpl = async () => { calls++; if (weather === "fail") throw new Error("offline"); return { ok: true, json: async () => ({ current: weather }) }; };
  const n = createNudges({
    store, clients: () => list, save: (l) => { list = l; }, push,
    rewardsOf: (c) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], activities: c.activities || [] }, clock.date),
    nowParts: (tz, d) => { const x = (d || at()).toISOString(); return { date: x.slice(0, 10), time: x.slice(11, 16) }; },
    zonedToUtc: (d, t) => new Date(`${d}T${t}:00Z`), prettyTime: (t) => t, tz: "UTC", now: at, logger: { warn() {} },
    pushedOn: (id) => pushed[id] || "", fetchImpl
  });
  // the first sweep only records a starting point; later sweeps are the real ones
  const ready = async () => { n.sweep(); await n.prefetchWeather(clock.date); };
  return { n, clock, data, sentOut, list: () => list, ready, calls: () => calls, sunnyOut: () => sentOut.filter((x) => x.thread === "sunny") };
}
const member = (extra = {}) => ({ id: "c1", name: "Quinn Zebulon", createdAt: "2026-10-01T12:00:00Z", workouts: [{ date: "2026-11-10", kind: "normal", minutes: 20, exercises: 5, completedAt: "2026-11-10T08:10:00Z" }], ...extra });

test("Sunny: a clear Sarasota morning gets the sunlight line, once a day, after the weather is in", async () => {
  const h = sunny({ clientsList: [member()] });
  h.n.sweep();                                     // starting point
  h.n.sweep();                                     // the weather request is still out: wait, don't guess
  assert.equal(h.sunnyOut().length, 0);
  await h.n.prefetchWeather("2026-11-11");
  h.n.sweep();
  assert.equal(h.sunnyOut().length, 1);
  assert.equal(h.sunnyOut()[0].title, "Sunny");
  assert.match(h.sunnyOut()[0].body, /Florida sunlight|Gorgeous morning in Sarasota/);
  h.n.sweep(); h.clock.hour = 9; h.n.sweep();
  assert.equal(h.sunnyOut().length, 1, "one a day");
  assert.equal(h.calls(), 1, "the weather is asked once a day");
});

test("Sunny: a cloudy morning, or weather that cannot be read, gets a regular line", async () => {
  for (const weather of [{ cloud_cover: 90, precipitation: 0, is_day: 1 }, { cloud_cover: 0, precipitation: 1.2, is_day: 1 }, "fail"]) {
    const h = sunny({ clientsList: [member()], weather });
    await h.ready(); h.n.sweep();
    assert.equal(h.sunnyOut().length, 1, JSON.stringify(weather));
    assert.doesNotMatch(h.sunnyOut()[0].body, /sunlight|Gorgeous/, JSON.stringify(weather));
  }
});

test("Sunny: never in quiet hours, never on a day something else was pushed, never at the wrong hour", async () => {
  const early = sunny({ clientsList: [member()], hour: 7 });
  await early.ready(); early.n.sweep();
  assert.equal(early.sunnyOut().length, 0, "before 8 AM");
  const busy = sunny({ clientsList: [member()], pushed: { c1: "2026-11-11" } });
  await busy.ready(); busy.n.sweep();
  assert.equal(busy.sunnyOut().length, 0, "a visit reminder or a message already went today");
  // someone who trains in the afternoon hears from Sunny then, not at 8
  const pm = (d) => ({ date: d, kind: "normal", minutes: 20, exercises: 5, completedAt: `${d}T15:20:00Z` });
  const h = sunny({ clientsList: [member({ workouts: [pm("2026-11-01"), pm("2026-11-05"), pm("2026-11-09")] })] });
  await h.ready(); h.n.sweep();
  assert.equal(h.sunnyOut().length, 0, "not at 8 AM");
  h.clock.hour = 15; h.n.sweep();
  assert.equal(h.sunnyOut().length, 1, "at their usual hour");
});

test("Sunny: someone with a streak worth keeping gets only the evening streak nudge", async () => {
  const d = (x) => ({ date: x, kind: "normal", minutes: 20, exercises: 5, completedAt: `${x}T08:10:00Z` });
  const h = sunny({ clientsList: [member({ workouts: [d("2026-11-08"), d("2026-11-09"), d("2026-11-10")] })] });
  await h.ready(); h.n.sweep();
  assert.equal(h.sunnyOut().length, 0, "no morning nudge");
  h.clock.hour = 18; h.n.sweep();
  const streak = h.sentOut.filter((x) => /Keep your/.test(x.title));
  assert.equal(streak.length, 1); assert.match(streak[0].body, /hanging on by a thread/);
  assert.equal(h.sentOut.length, 1, "one push that day, in all");
});

test("Sunny: the comeback ladder goes out at 2, 7, 14 and 30 days, once each, then stays quiet", async () => {
  const h = sunny({ clientsList: [member()], date: "2026-11-12" });     // last active Nov 10
  await h.ready(); h.n.sweep();
  const said = () => h.sunnyOut().map((x) => x.body);
  assert.equal(said().length, 1); assert.match(said()[0], /We saved your spot, Quinn/);
  for (const [date, expect] of [["2026-11-13", 1], ["2026-11-16", 1], ["2026-11-17", 2], ["2026-11-20", 2], ["2026-11-24", 3], ["2026-12-09", 3], ["2026-12-10", 4], ["2026-12-11", 4], ["2027-01-20", 4]]) {
    h.clock.date = date; await h.n.prefetchWeather(date); h.n.sweep();
    assert.equal(said().length, expect, date);
  }
  assert.match(said()[1], /No guilt, just progress/); assert.match(said()[2], /miss you/); assert.match(said()[3], /Still here whenever you're ready/);
  // active again: a new lapse starts its own ladder
  h.list()[0].workouts.push({ date: "2027-01-20", kind: "normal", minutes: 10, exercises: 3, completedAt: "2027-01-20T08:00:00Z" });
  h.clock.date = "2027-01-22"; await h.n.prefetchWeather("2027-01-22"); h.n.sweep();
  assert.equal(said().length, 5); assert.match(said()[4], /We saved your spot/);
});

test("Sunny: new picks since they last opened the app, said as a number", async () => {
  const c = member({ suggested: { programs: [{ id: "p1", at: "2026-11-10T20:00:00Z" }], videos: [{ id: "v1", at: "2026-11-10T20:00:00Z" }], guides: [], tips: [] } });
  const h = sunny({ clientsList: [c] });
  h.data.presence = { c1: { lastAt: Date.parse("2026-11-10T19:00:00Z"), days: { "2026-11-10": { sessions: 1 } } } };
  await h.ready(); h.n.sweep();
  assert.equal(h.sunnyOut().length, 1); assert.match(h.sunnyOut()[0].body, /^Sunny found 2 new picks for you/);
  h.clock.date = "2026-11-12"; await h.n.prefetchWeather("2026-11-12"); h.n.sweep();
  assert.doesNotMatch(h.sunnyOut()[1].body, /new picks/, "the same picks are not announced twice");
});

test("Sunny: 'streaks only' keeps just the evening streak nudge; 'off' sends none (class reminders still go)", async () => {
  const d = (x) => ({ date: x, kind: "normal", minutes: 20, exercises: 5, completedAt: `${x}T08:10:00Z` });
  const streaky = { workouts: [d("2026-11-08"), d("2026-11-09"), d("2026-11-10")] };
  const s = sunny({ clientsList: [member({ ...streaky, appPrefs: { nudges: "streaks" } })] });
  await s.ready(); s.n.sweep(); s.clock.hour = 18; s.n.sweep();
  assert.equal(s.sentOut.filter((x) => /Keep your/.test(x.title)).length, 1);
  const s2 = sunny({ clientsList: [member({ appPrefs: { nudges: "streaks" } })] });
  await s2.ready(); s2.n.sweep();
  assert.equal(s2.sunnyOut().length, 0, "no morning or comeback nudge");
  const off = sunny({ clientsList: [member({ ...streaky, appPrefs: { nudges: "off" } })] });
  await off.ready(); off.n.sweep(); off.clock.hour = 18; off.n.sweep();
  assert.equal(off.sentOut.length, 0);
  off.clock.date = "2026-11-11"; off.clock.hour = 18;
  off.n.sweep([{ id: "b1", clientId: "c1", title: "Mobility & Core", date: "2026-11-12", time: "09:00" }]);
  assert.equal(off.sentOut.filter((x) => x.title === "Class tomorrow").length, 1, "class reminders are not nudges");
});

test("Sunny: nothing from the member's record reaches a lock screen but their first name", async () => {
  const private_ = { firstName: "Quinn", painLog: [{ date: "2026-11-01", area: "Knee", level: 7, note: "meniscus after surgery", createdAt: "2026-11-01T08:00:00Z" }],
    assignedPrograms: [{ id: "knee-rehab", note: "post-op protocol" }], suggested: { programs: [{ id: "knee-rehab", at: "2026-11-10T20:00:00Z" }], videos: [], guides: [], tips: [{ id: "t1", text: "ice your knee", at: "2026-11-10T20:00:00Z" }] } };
  const out = [];
  for (const [date, hour] of [["2026-11-11", 8], ["2026-11-12", 8], ["2026-11-17", 8], ["2026-11-24", 8], ["2026-12-10", 8]]) {
    const h = sunny({ clientsList: [member(private_)], date, hour });
    await h.ready(); h.n.sweep(); out.push(...h.sentOut);
  }
  const d = (x) => ({ date: x, kind: "normal", minutes: 20, exercises: 5, completedAt: `${x}T08:10:00Z` });
  const st = sunny({ clientsList: [member({ ...private_, workouts: [d("2026-11-08"), d("2026-11-09"), d("2026-11-10")] })], hour: 18 });
  await st.ready(); st.n.sweep(); out.push(...st.sentOut);
  assert.ok(out.length >= 5, "every kind went out at least once: " + out.length);
  for (const p of out) assert.doesNotMatch(`${p.title} ${p.body}`, /knee|menisc|surgery|post-op|rehab|protocol|pain|ice your|level|7\/10|lower back|back pain|shoulder|\bhip|neck|ankle/i, p.body);
});

test("Sunny: the owner's numbers count what went out, what was opened within 6 hours, and who came back", async () => {
  const h = sunny({ clientsList: [member()], date: "2026-11-12" });
  await h.ready(); h.n.sweep();                                       // a comeback nudge at 08:05
  assert.match(h.sunnyOut()[0].body, /We saved your spot/);
  h.data.presence = { c1: { lastAt: Date.parse("2026-11-12T10:00:00Z"), days: { "2026-11-12": { sessions: 1 } } } };  // opened 2 hours later
  h.clock.hour = 11; h.n.sweep();
  const s = h.n.stats(7), back = s.kinds.find((k) => k.kind === "comeback");
  assert.deepEqual(back, { kind: "comeback", sent: 1, opened: 1, comebacks: 1 });
  assert.deepEqual(s.kinds.map((k) => k.kind), ["streak", "comeback", "picks", "morning"]);
  h.n.sweep();
  assert.deepEqual(h.n.stats(7).kinds.find((k) => k.kind === "comeback"), { kind: "comeback", sent: 1, opened: 1, comebacks: 1 }, "counted once");
  assert.equal(JSON.stringify(h.data["nudge-stats"]).includes("c1"), false, "the numbers hold no member ids");
});
