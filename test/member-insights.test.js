// Insights: what members do inside the app. Counts only, from the app's heartbeat and what was logged. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-mi-"));
  // Accounts are stamped with the real clock when they are made, so the story is told backwards from today at noon
  const noon = new Date(new Date().toISOString().slice(0, 10) + "T17:00:00Z").getTime(), dayAgo = (n) => new Date(noon - n * 864e5);
  const clock = { now: dayAgo(19) };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(clock.now), calWatchMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const beat = (who, view, seconds = 60) => call("POST", "/api/me/presence", { seconds, view, platform: "web" }, who.token);
  return { call, signup, beat, at: (n) => { clock.now = dayAgo(n); }, backdate: (n) => { const f = path.join(dataDir, "clients.json"); const l = JSON.parse(fs.readFileSync(f, "utf8")); for (const c of l) c.createdAt = dayAgo(n).toISOString(); fs.writeFileSync(f, JSON.stringify(l)); }, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("member insights: active, came back, screens used and drop-off are counted with no names", async (t) => {
  const s = await start(); t.after(s.close);
  // 19 days ago: three people join and open Home
  const ana = await s.signup("Ana Reed"), ben = await s.signup("Ben Cole"), cara = await s.signup("Cara Diaz");
  for (const who of [ana, ben, cara]) await s.beat(who, "home");
  s.backdate(19);
  // 17 days ago: Ben is back once, in the pain tool, and then never again
  s.at(17); await s.beat(ben, "pain", 120);
  // Today: Ana is back, in the pain tool and videos; a fourth person joins
  s.at(0); await s.beat(ana, "pain"); await s.beat(ana, "videos", 90);
  const dee = await s.signup("Dee Elm"); await s.beat(dee, "home");
  const A = (await s.call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const r = await s.call("GET", "/api/admin/analytics/members?days=30", undefined, A);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.members, 4);
  assert.deepEqual(b.active, { today: 2, week: 2, month: 4 });
  assert.deepEqual(b.cameBack, { eligible: 3, returned: 1 }, "only Ana was active a week or more after joining");
  assert.deepEqual(b.dropOff, { eligible: 3, neverReturned: 1, wentQuiet: 1 }, "Cara never returned; Ben returned and went quiet");
  assert.equal(b.screens[0].key, "home"); assert.equal(b.screens[0].people, 4);
  const pain = b.screens.find((x) => x.key === "pain");
  assert.equal(pain.people, 2); assert.equal(pain.minutes, 3);
  assert.deepEqual(b.paid, { signups: 4, paying: 0, payingAll: 0, before: [] });
  assert.equal(b.actions.workouts.count, 0);
  assert.ok(!/Ana|Ben|Cara|Dee|example\.com/.test(JSON.stringify(b)), "counts only");
  // A shorter period only narrows the period figures
  const w = (await s.call("GET", "/api/admin/analytics/members?days=7", undefined, A)).body;
  assert.equal(w.screens.find((x) => x.key === "home").people, 1);
  assert.equal((await s.call("GET", "/api/admin/analytics/members", undefined, ana.token)).status, 401);
});

// ---- The figures themselves, from a hand-built store (no server): the route is mounted on its own.
const { mountMemberInsights } = require("../lib/member-insights");
// The clinic's calendar day for a moment in time, as server.js works it out ("" when it is not a date)
const clinicDay = (iso) => { const ms = Date.parse(iso || ""); return Number.isNaN(ms) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)); };
function insights(data, { today = "2026-11-26", days = 30, withClinicDay = true } = {}) {
  let handler;
  const store = { read: (k, d) => (k in data ? data[k] : d) };
  mountMemberInsights({ admin: { get: (p, fn) => { handler = fn; } }, store, clients: () => data.clients, today: () => today, ...(withClinicDay ? { clinicDay } : {}) });
  let out; handler({ query: { days: String(days) } }, { json: (b) => { out = b; } });
  return out;
}
const acct = (id, createdAt, more = {}) => ({ id, name: "Made Up", email: `${id}@example.com`, createdAt, lastLoginAt: createdAt, painLog: [], ...more });
const opened = (views) => ({ seconds: Object.values(views).reduce((a, b) => a + b, 0), sessions: 1, views, platforms: { web: 1 } });

test("member insights: an evening sign-up joined on the clinic's day, not the next one", () => {
  // Joined Nov 19 at 8:30 PM in Sarasota (already Nov 20 in UTC), opened Home, and came back the next morning
  const data = { clients: [acct("m1", "2026-11-20T01:30:00.000Z")], presence: { m1: { days: { "2026-11-19": opened({ home: 60 }), "2026-11-20": opened({ programs: 60 }) } } } };
  const b = insights(data);
  assert.deepEqual(b.cameBack, { eligible: 1, returned: 0 }, "a week old today (Nov 26), counted from Nov 19");
  assert.deepEqual(b.dropOff, { eligible: 1, neverReturned: 0, wentQuiet: 0 }, "back the next day is not 'never came back'");
  assert.equal(insights(data, { days: 7 }).paid.signups, 0, "the last 7 days begin on Nov 20; they joined on the 19th");
  assert.equal(b.paid.signups, 1);
  // Without the helper the UTC date is used, as before (the fallback the two sides agreed)
  const utc = insights(data, { withClinicDay: false });
  assert.deepEqual(utc.cameBack, { eligible: 0, returned: 0 });
  assert.deepEqual(utc.dropOff, { eligible: 1, neverReturned: 1, wentQuiet: 0 });
  assert.equal(insights(data, { days: 7, withClinicDay: false }).paid.signups, 1);
  // A daytime sign-up reads the same either way
  const noon = { clients: [acct("m2", "2026-11-19T17:00:00.000Z")], presence: { m2: { days: { "2026-11-19": opened({ home: 60 }), "2026-11-26": opened({ home: 60 }) } } } };
  assert.deepEqual(insights(noon).cameBack, { eligible: 1, returned: 1 });
  assert.deepEqual(insights(noon, { withClinicDay: false }).cameBack, { eligible: 1, returned: 1 });
});

test("member insights: a lapsed card subscription is not paying, and 'before the membership began' stops the day before", () => {
  const card = (since, until, status = "active") => ({ tier: "member", since, until, stripeSubscriptionId: "sub_made_up", status });
  const data = { clients: [
    acct("pays", "2026-11-01T15:00:00.000Z", { membership: card("2026-11-10", "2026-12-10") }),
    acct("lastday", "2026-11-01T15:00:00.000Z", { membership: card("2026-10-26", "2026-11-26") }),             // paid through today
    acct("lapsed", "2026-11-02T15:00:00.000Z", { membership: card("2026-11-02", "2026-11-15", "past_due") }),  // the card failed; paid-through date is behind us
    acct("byhand", "2026-11-03T15:00:00.000Z", { membership: { tier: "member", since: "2026-11-03", until: "2026-12-03" } }), // given by the office: no card
    acct("free", "2026-11-04T15:00:00.000Z")
  ], presence: {
    pays: { days: { "2026-11-08": opened({ premium: 120, home: 60 }), "2026-11-10": opened({ programs: 300 }), "2026-11-15": opened({ videos: 60 }) } },
    lapsed: { days: { "2026-11-01": opened({ leaders: 60 }) } }
  } };
  const b = insights(data);
  assert.deepEqual({ signups: b.paid.signups, paying: b.paid.paying, payingAll: b.paid.payingAll }, { signups: 5, paying: 2, payingAll: 2 });
  // Programs was first opened on the day the membership began (as a paying member), videos after: neither is "before"
  assert.deepEqual(b.paid.before.map((x) => [x.key, x.people]).sort(), [["home", 1], ["premium", 1]]);
  assert.deepEqual(Object.keys(b.paid).sort(), ["before", "paying", "payingAll", "signups"]);
});

test("member insights: a record nobody has signed in to is not an account", () => {
  const never = (id, more = {}) => ({ id, name: "Not Yet", email: `${id}@example.com`, createdAt: "2026-11-20T15:00:00.000Z", lastLoginAt: null, painLog: [], ...more });
  const real = acct("m1", "2026-11-20T15:00:00.000Z");
  const presence = { m1: { days: { "2026-11-20": opened({ home: 60 }), "2026-11-26": opened({ home: 60 }) } } };
  const alone = insights({ clients: [real], presence });
  const office = Array.from({ length: 5 }, (_, i) => never("office" + i, { addedBy: "coach@example.com" }));
  const imported = Array.from({ length: 5 }, (_, i) => never("imp" + i, { imported: { source: "simplepractice", at: "2026-11-20T15:00:00.000Z", batch: "b1" } }));
  const withThem = insights({ clients: [real, ...office, ...imported], presence });
  assert.deepEqual(withThem, alone, "ten patients the office added or imported change nothing");
  assert.equal(alone.members, 1); assert.equal(alone.paid.signups, 1);
  assert.deepEqual(alone.dropOff, { eligible: 1, neverReturned: 0, wentQuiet: 0 });
  // The first time one of them signs in, they count
  office[0].lastLoginAt = "2026-11-26T15:00:00.000Z";
  assert.equal(insights({ clients: [real, ...office, ...imported], presence }).members, 2);
});

test("member insights: one odd value in the store does not take the screen down", () => {
  const good = () => ({
    clients: [acct("m1", "2026-11-01T15:00:00.000Z", { workouts: [{ id: "w1", date: "2026-11-10", completedAt: "2026-11-10T16:00:00.000Z" }], painLog: [{ id: "p1", date: "2026-11-26" }] }), acct("m2", "2026-11-05T15:00:00.000Z")],
    presence: { m1: { days: { "2026-11-01": opened({ home: 120 }), "2026-11-26": opened({ pain: 60 }) } }, m2: { days: { "2026-11-05": opened({ home: 60 }) } } },
    habits: [{ clientId: "m2", checks: [{ date: "2026-11-16", habitId: "water" }] }],
    sends: [{ id: "s1", fromId: "m2", toId: "m1", kind: "video", ref: "x", date: "2026-11-16" }]
  });
  const base = insights(good());
  assert.equal(base.members, 2); assert.equal(base.actions.workouts.count, 1); assert.equal(base.actions.checks.count, 1); assert.equal(base.actions.sends.count, 1);
  const odd = {
    "habits an object": (d) => { d.habits = {}; }, "habits a string": (d) => { d.habits = "x"; }, "habits null": (d) => { d.habits = null; }, "a null habits entry": (d) => { d.habits.push(null); },
    "checks a string": (d) => { d.habits[0].checks = "x"; }, "a null check": (d) => { d.habits[0].checks.push(null); },
    "createdAt a number": (d) => { d.clients[0].createdAt = 1764000000000; }, "createdAt an object": (d) => { d.clients[0].createdAt = { a: 1 }; }, "createdAt not a date": (d) => { d.clients[0].createdAt = "2026-13-45T00:00:00Z"; }, "createdAt missing": (d) => { delete d.clients[0].createdAt; },
    "workouts an object": (d) => { d.clients[0].workouts = { a: 1 }; }, "workouts a string": (d) => { d.clients[0].workouts = "abc"; }, "a null workout": (d) => { d.clients[0].workouts.push(null); },
    "painLog a string": (d) => { d.clients[0].painLog = "abc"; }, "painLog an object": (d) => { d.clients[0].painLog = { a: 1 }; },
    "sends an object": (d) => { d.sends = {}; }, "sends a string": (d) => { d.sends = "x"; }, "a null send": (d) => { d.sends.push(null); },
    "presence a list": (d) => { d.presence = []; }, "presence null": (d) => { d.presence = null; }, "a presence entry that is text": (d) => { d.presence.m1 = "x"; }, "presence days a list": (d) => { d.presence.m1.days = [1, 2]; },
    "a null client": (d) => { d.clients.push(null); }, "clients not a list": (d) => { d.clients = { a: 1 }; }, "membership a string": (d) => { d.clients[0].membership = "member"; }
  };
  for (const [what, spoil] of Object.entries(odd)) {
    const d = good(); spoil(d);
    let b; assert.doesNotThrow(() => { b = insights(d); }, what);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(base).sort(), what);
    // the other member's figures are still counted
    if (what !== "clients not a list") assert.equal(b.members, 2, what);
  }
  // Seconds saved as text are added as numbers, not joined end to end
  const d = good(); d.presence.m1.days["2026-11-26"].views = { pain: "60" }; d.presence.m2.days["2026-11-05"].views = { pain: 120 };
  assert.equal(insights(d).screens.find((x) => x.key === "pain").minutes, 3);
});
