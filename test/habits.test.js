// Daily activities (the owner's list): flat XP per activity once a day, undo the same day, auto challenge items,
// admin edits that don't rewrite history, qualifying days, streak repairs that never create qualifying days,
// and the month list the billing credits will read.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const H = require("../lib/habits");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

// Same as test/clients.test.js plus a movable clock. November 2026 is EST (UTC-5), so 13:00Z is 8 AM at the clinic.
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-h-"));
  const clock = { at: new Date("2026-11-02T13:00:00Z") };
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => clock.at, siteUrl: "https://mdfit.example.com"
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const setDay = (date, hour = 8) => { clock.at = new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 5) * 36e5); }; // EST = UTC-5
  return { app, call, adminToken, dataDir, setDay, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = async (s) => (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
const today = (s, tok) => s.call("GET", "/api/me/habits/today", undefined, tok);
const check = (s, tok, habitId) => s.call("POST", "/api/me/habits/checkin", { habitId }, tok);
const checkAll = async (s, tok, ids) => { let r; for (const id of ids) r = await check(s, tok, id); return r; };
const workout = (s, tok, over = {}) => s.call("POST", "/api/me/workouts", { title: "Full Body Power", goal: "Full Body", minutes: 30, exercises: 8, ...over }, tok);
const day = (n) => `2026-11-${String(n).padStart(2, "0")}`;
const xpOf = async (s, tok) => (await s.call("GET", "/api/me/rewards", undefined, tok)).body;

test("owner's activity list: exact XP, once a day, undo the same day, feeds lifetime XP", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  assert.equal((await s.call("GET", "/api/me/habits/today")).status, 401);
  const first = (await today(s, tok)).body;
  assert.equal(first.date, "2026-11-02");
  assert.equal(first.points, 0); assert.equal(first.goal, 30);
  const want = { sunlight: 15, acupressure: 15, "foam-rolling": 15, "ice-bath": 20, "health-shot": 5, prayer: 10, meditation: 10, grounding: 5, "box-breathing": 5,
    walk: 15, sauna: 15, stretching: 5, yoga: 20, "no-screens": 15, massage: 20, journaling: 5, "red-light": 10, "active-recreation": 10, "challenge-send": 5, "challenge-do": 10 };
  assert.deepEqual(Object.fromEntries(first.habits.map((h) => [h.id, h.points])), want);
  assert.ok(first.habits.every((h) => h.how.length > 5), "every activity has a how line");
  assert.match(first.habits.find((h) => h.id === "sunlight").how, /20 minutes/);
  assert.deepEqual(first.habits.filter((h) => h.auto).map((h) => h.id), ["challenge-send", "challenge-do"]);
  assert.deepEqual(first.workoutRules, { normal: 30, custom: 35, program: 50, challengeBonus: 10, challengeSent: 5 });

  let r = await check(s, tok, "sunlight");
  assert.equal(r.status, 201); assert.equal(r.body.points, 15); assert.equal(r.body.checked.earned, 15);
  r = await check(s, tok, "sunlight");
  assert.equal(r.status, 409); assert.equal(r.body.duplicate, true, "once a day");
  assert.equal((await check(s, tok, "nope")).status, 400);
  assert.equal((await check(s, tok, "challenge-do")).status, 409, "challenge items are earned by the challenge flow, not by ticking");
  // no caps: every activity counts in full
  r = await checkAll(s, tok, ["ice-bath", "yoga", "massage", "sauna", "acupressure", "foam-rolling"]);
  assert.equal(r.body.points, 15 + 20 + 20 + 20 + 15 + 15 + 15);
  assert.equal(r.body.qualifying, true);
  assert.equal((await xpOf(s, tok)).todayParts.activities, 120);

  // undo today's check; undoing something not checked is a 404; XP follows
  r = await s.call("DELETE", "/api/me/habits/checkin/sunlight", undefined, tok);
  assert.equal(r.status, 200); assert.equal(r.body.points, 105);
  assert.equal((await xpOf(s, tok)).todayParts.activities, 105);
  assert.equal((await s.call("DELETE", "/api/me/habits/checkin/sunlight", undefined, tok)).status, 404);
  // a new day (clinic time zone): the same activity can be claimed again; yesterday's can't be undone
  s.setDay(day(2), 23); // 11 PM in Sarasota is already Nov 3 in UTC, still Nov 2 at the clinic
  assert.equal((await check(s, tok, "walk")).status, 201);
  assert.equal((await check(s, tok, "walk")).status, 409);
  s.setDay(day(3));
  assert.equal((await check(s, tok, "walk")).status, 201);
  assert.equal((await s.call("DELETE", "/api/me/habits/checkin/sauna", undefined, tok)).status, 404);
  const x = await xpOf(s, tok);
  assert.equal(x.todayParts.activities, 15);
  assert.equal(x.xp, 105 + 15 + 15, "lifetime XP = every claimed activity");
  // stored apart from the client record, with ids, dates and XP only
  const raw = JSON.parse(fs.readFileSync(path.join(s.dataDir, "habits.json"), "utf8"));
  assert.equal(raw.length, 1); assert.ok(raw[0].checks.every((c) => Object.keys(c).sort().join() === "at,date,habitId,points"));
});

test("admins edit the list; past checks keep the XP they were earned with", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  await check(s, tok, "prayer"); // 10
  const at = await s.adminToken();
  assert.equal((await s.call("GET", "/api/admin/habits", undefined, tok)).status, 401);
  const cfg = (await s.call("GET", "/api/admin/habits", undefined, at)).body;
  assert.equal(cfg.habits.length, 20); assert.equal(cfg.dailyGoal, 30);
  const habits = cfg.habits.map((h) => (h.id === "prayer" ? { ...h, points: 25 } : h.id === "challenge-do" ? { ...h, points: 99 } : h));
  let r = await s.call("PUT", "/api/admin/habits", { habits: [...habits, { id: "sleep", name: "Sleep 8 hours", points: 10, how: "In bed by 10." }], dailyGoal: 40 }, at);
  assert.equal(r.status, 200);
  assert.equal(r.body.habits.find((h) => h.id === "prayer").points, 25);
  assert.equal(r.body.habits.find((h) => h.id === "challenge-do").points, 10, "challenge XP is fixed by the rules");
  assert.equal(r.body.dailyGoal, 40);
  assert.equal((await today(s, tok)).body.points, 10, "today's earlier check keeps its 10");
  assert.equal((await check(s, tok, "sleep")).status, 201);
  s.setDay(day(3));
  assert.equal((await check(s, tok, "prayer")).body.points, 25);
  assert.equal((await xpOf(s, tok)).xp, 10 + 10 + 25);
  // validation
  assert.match((await s.call("PUT", "/api/admin/habits", { habits: cfg.habits.filter((h) => h.id !== "challenge-send") }, at)).body.error, /Keep the "challenge-send"/);
  assert.equal((await s.call("PUT", "/api/admin/habits", { habits: [{ ...cfg.habits[0], points: 500 }, ...cfg.habits.slice(1)] }, at)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/habits", { dailyGoal: 2 }, at)).status, 400);
  // switching one off hides it from members
  await s.call("PUT", "/api/admin/habits", { habits: cfg.habits.map((h) => (h.id === "red-light" ? { ...h, active: false } : h)) }, at);
  assert.ok(!(await today(s, tok)).body.habits.some((h) => h.id === "red-light"));
  assert.equal((await check(s, tok, "red-light")).status, 400);
});

test("a day qualifies on activities alone or with a workout (no caps, no frozen goal)", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  let r = (await checkAll(s, tok, ["grounding", "box-breathing", "journaling"])).body; // 15
  assert.equal(r.qualifying, false); assert.equal(r.remaining, 15);
  r = (await check(s, tok, "sunlight")).body; // 30
  assert.equal(r.qualifying, true); assert.equal(r.recoveryOnly, true);
  s.setDay(day(3));
  await workout(s, tok);
  r = (await today(s, tok)).body;
  assert.equal(r.workoutXp, 30); assert.equal(r.points, 0); assert.equal(r.total, 30); assert.equal(r.qualifying, true); assert.equal(r.recoveryOnly, false);
});

test("streak repairs: 3 in a row earn one; repairs bridge the shown streak but never create qualifying days", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok, client } = await signup(s);
  for (const d of [2, 3, 4]) { s.setDay(day(d)); await workout(s, tok); }
  let r = (await today(s, tok)).body;
  assert.equal(r.streak.current, 3); assert.equal(r.repairs.available, 1);
  // Nov 5 missed, Nov 6 back
  s.setDay(day(6)); await workout(s, tok);
  r = (await today(s, tok)).body;
  assert.equal(r.streak.current, 4, "shown streak bridges the repaired day (it doesn't count as a day itself)");
  assert.equal(r.streak.actual, 1); assert.equal(r.streak.missed, 1);
  assert.equal(r.repairs.available, 0); assert.equal(r.repairs.used, 1);
  assert.deepEqual(r.repairs.ledger.map((x) => [x.date, x.type]), [[day(5), "used"], [day(4), "earned"]]);
  const hist = (await s.call("GET", "/api/me/habits/history?month=2026-11", undefined, tok)).body;
  const nov5 = hist.days.find((d) => d.date === day(5));
  assert.equal(nov5.qualifying, false); assert.equal(nov5.repaired, true); assert.equal(nov5.missed, true);
  assert.equal(hist.qualifyingDays, 4);
  // billing reads only real days
  const api = s.app.get("habits");
  assert.deepEqual(api.qualifyingDays(client, "2026-11"), [day(2), day(3), day(4), day(6)]);
  assert.deepEqual(H.qualifyingDays(client.id, "2026-11"), [day(2), day(3), day(4), day(6)]);
  assert.throws(() => api.qualifyingDays(client, "Nov"), /Month/);
  // a 2-day gap with no repairs left resets the shown streak, and nothing is spent
  s.setDay(day(9)); await workout(s, tok);
  r = (await today(s, tok)).body;
  assert.equal(r.streak.current, 1); assert.equal(r.repairs.used, 1);
  // a granted (referral) repair is earned but still can't create a day
  api.grantRepair(client.id, "Referral bonus");
  r = (await today(s, tok)).body;
  assert.equal(r.repairs.available, 1); assert.equal(r.streak.lifetimeQualifying, 5);
  assert.deepEqual(api.qualifyingDays(client, "2026-11"), [day(2), day(3), day(4), day(6), day(9)]);
});

test("month history lists qualifying days, future days and today's partial", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  s.setDay(day(2)); await workout(s, tok);
  s.setDay(day(3)); await check(s, tok, "walk"); // 15 < 30
  s.setDay(day(4)); await today(s, tok);
  const h = (await s.call("GET", "/api/me/habits/history?month=2026-11", undefined, tok)).body;
  assert.equal(h.month, "2026-11"); assert.equal(h.days.length, 30);
  assert.equal(h.qualifyingDays, 1);
  assert.equal(h.days[0].points, 0); assert.equal(h.days[0].missed, false, "before the first activity nothing is missed");
  assert.deepEqual([h.days[1].qualifying, h.days[2].qualifying, h.days[2].points, h.days[2].missed], [true, false, 15, true]);
  assert.equal(h.days[3].today, true); assert.equal(h.days[3].missed, false);
  assert.equal(h.days[4].future, true);
  const oct = (await s.call("GET", "/api/me/habits/history?month=2026-10", undefined, tok)).body;
  assert.equal(oct.days.length, 31); assert.equal(oct.qualifyingDays, 0);
});
