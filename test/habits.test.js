// Healthy habits: points, category caps, duplicates, the frozen daily goal, the re-entry ramp, recovery-only days,
// streak repairs that never create qualifying days, and the month list the billing credits will read.
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
const RECOVERY = ["sunlight", "barefoot", "gratitude", "breathing", "meditation", "posture", "mobility", "stretching", "acupressure", "walking"]; // no sauna, no cold
const day = (n) => `2026-11-${String(n).padStart(2, "0")}`;

test("points, duplicates refused, workouts count automatically once, undo the same day", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  assert.equal((await s.call("GET", "/api/me/habits/today")).status, 401);
  const first = (await today(s, tok)).body;
  assert.equal(first.date, "2026-11-02");
  assert.equal(first.goal, 30); assert.equal(first.points, 0); assert.equal(first.remaining, 30);
  assert.equal(first.habits.length, 14);
  const sauna = first.habits.find((h) => h.id === "sauna");
  assert.equal(sauna.optional, true); assert.match(sauna.alternative, /Warm shower/);

  let r = await check(s, tok, "sunlight");
  assert.equal(r.status, 201); assert.equal(r.body.points, 5); assert.equal(r.body.checked.earned, 5);
  r = await check(s, tok, "sunlight");
  assert.equal(r.status, 409); assert.equal(r.body.duplicate, true);
  assert.equal((await check(s, tok, "nope")).status, 400);

  // the workout log fills "Completed workout" (30); a second workout adds nothing; checking it by hand is refused
  await workout(s, tok); await workout(s, tok, { title: "Core" });
  let card = (await today(s, tok)).body;
  assert.equal(card.points, 35); assert.equal(card.qualifying, true); assert.equal(card.remaining, 0);
  assert.equal(card.habits.find((h) => h.id === "workout").source, "workout log");
  r = await check(s, tok, "workout");
  assert.equal(r.status, 409); assert.match(r.body.error, /session you logged/);
  assert.equal((await s.call("DELETE", "/api/me/habits/checkin/workout", undefined, tok)).status, 409);
  // a rehab session fills the rehab habit (25), not a second workout
  await workout(s, tok, { title: "6-Week Hip Protocol: Week 1", goal: "Rehab" });
  card = (await today(s, tok)).body;
  assert.equal(card.points, 60); assert.equal(card.recoveryOnly, false);

  // undo today's check; undoing something not checked is a 404
  r = await s.call("DELETE", "/api/me/habits/checkin/sunlight", undefined, tok);
  assert.equal(r.status, 200); assert.equal(r.body.points, 55);
  assert.equal((await s.call("DELETE", "/api/me/habits/checkin/sunlight", undefined, tok)).status, 404);
  // yesterday's check can't be undone tomorrow
  await check(s, tok, "walking");
  s.setDay(day(3));
  assert.equal((await s.call("DELETE", "/api/me/habits/checkin/walking", undefined, tok)).status, 404);
  // a hand-checked workout followed by a logged one still counts once
  await check(s, tok, "workout"); await workout(s, tok);
  assert.equal((await today(s, tok)).body.points, 30);
  // no habit data on the client record (separate store)
  const raw = JSON.parse(fs.readFileSync(path.join(s.dataDir, "habits.json"), "utf8"));
  assert.equal(raw.length, 1); assert.ok(raw[0].checks.every((x) => x.habitId && x.date && Number.isInteger(x.points)));
});

test("category caps apply, and admins can change them", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  // Mind & breath: gratitude 5 + box breathing 5 + meditation 10 = 20, capped at 15
  const r = await checkAll(s, tok, ["gratitude", "breathing", "meditation"]);
  assert.equal(r.body.points, 15);
  assert.equal(r.body.checked.earned, 5); assert.match(r.body.checked.note, /capped at 15/);
  assert.equal(r.body.categories.find((c) => c.id === "mind").capped, true);
  // Recovery: acupressure 10 + sauna 10 + cold 15 = 35, capped at 25
  assert.equal((await checkAll(s, tok, ["acupressure", "sauna", "cold"])).body.points, 40);

  const at = await s.adminToken();
  assert.equal((await s.call("GET", "/api/admin/habits", undefined, tok)).status, 401);
  const cfg = (await s.call("GET", "/api/admin/habits", undefined, at)).body;
  assert.equal(cfg.habits.find((h) => h.id === "workout").points, 30);
  assert.equal(cfg.habits.find((h) => h.id === "cold").points, 15);
  // today's caps are frozen with today's goal: an admin change applies from tomorrow
  const categories = cfg.categories.map((c) => (c.id === "mind" ? { ...c, cap: 20 } : c));
  assert.equal((await s.call("PUT", "/api/admin/habits", { categories }, at)).status, 200);
  assert.equal((await today(s, tok)).body.points, 40);
  s.setDay(day(3));
  assert.equal((await checkAll(s, tok, ["gratitude", "breathing", "meditation"])).body.points, 20);

  // validation: optional habit needs a safer alternative; workout/rehab can't be deleted; bad category
  const habits = cfg.habits.map((h) => (h.id === "cold" ? { ...h, alternative: "" } : h));
  assert.match((await s.call("PUT", "/api/admin/habits", { habits }, at)).body.error, /safer alternative/);
  assert.match((await s.call("PUT", "/api/admin/habits", { habits: cfg.habits.filter((h) => h.id !== "workout") }, at)).body.error, /Keep the "workout"/);
  assert.equal((await s.call("PUT", "/api/admin/habits", { habits: [...cfg.habits, { id: "sleep", name: "Sleep 8 hours", category: "nope", points: 10 }] }, at)).status, 400);
  // a new habit (sleep) works for members
  const ok = await s.call("PUT", "/api/admin/habits", { habits: [...cfg.habits, { id: "sleep", name: "Sleep 8 hours", category: "mind", points: 10 }] }, at);
  assert.equal(ok.status, 200); assert.equal(ok.body.habits.length, 15);
  assert.equal((await check(s, tok, "sleep")).status, 201);
});

test("goal is frozen for the day: never raised during the day, may be lowered, new level from tomorrow", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  assert.equal((await today(s, tok)).body.goal, 30);
  let r = await s.call("PUT", "/api/me/habits/level", { level: "elite" }, tok);
  assert.equal(r.status, 200); assert.equal(r.body.goal, 30, "not raised today"); assert.match(r.body.note, /starts tomorrow/);
  assert.equal(r.body.chosenLevel, "elite");
  assert.equal((await s.call("PUT", "/api/me/habits/level", { level: "pro" }, tok)).status, 400);
  // an admin raising level goals mid-day doesn't touch today either
  const at = await s.adminToken();
  await s.call("PUT", "/api/admin/habits", { levels: { beginner: 35, advanced: 55, elite: 80 } }, at);
  assert.equal((await today(s, tok)).body.goal, 30);
  await check(s, tok, "walking");
  s.setDay(day(3));
  r = (await today(s, tok)).body;
  assert.equal(r.goal, 80); assert.equal(r.level, "elite"); assert.match(r.reason, /Elite level: 80/);
  // lowering applies at once
  r = (await s.call("PUT", "/api/me/habits/level", { level: "advanced" }, tok)).body;
  assert.equal(r.goal, 55); assert.equal(r.note, null);
  // later in the day it stays
  s.setDay(day(3), 20);
  assert.equal((await today(s, tok)).body.goal, 55);
});

test("re-entry: after 7+ quiet days the goal is 20 and rises 5 per active day back to normal", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  await s.call("PUT", "/api/me/habits/level", { level: "advanced" }, tok);
  await workout(s, tok); // Nov 2 active
  s.setDay(day(3)); assert.equal((await today(s, tok)).body.goal, 50);
  // Nov 3..11 quiet (9 days), back on Nov 12
  s.setDay(day(12));
  let r = (await today(s, tok)).body;
  assert.equal(r.goal, 20); assert.equal(r.reentry, true); assert.match(r.reason, /Welcome back\. After 9 quiet days/);
  r = (await checkAll(s, tok, ["walking", "sunlight"])).body;
  assert.equal(r.points, 20); assert.equal(r.qualifying, true);
  s.setDay(day(13)); assert.equal((await today(s, tok)).body.goal, 25);
  await check(s, tok, "walking");
  s.setDay(day(14)); assert.equal((await today(s, tok)).body.goal, 30); // a quiet day keeps the easier goal
  s.setDay(day(15)); assert.equal((await today(s, tok)).body.goal, 30);
  // six more active days: 30 → 35 → … → 50, then normal again
  const goals = [];
  for (let d = 15; d <= 21; d++) { s.setDay(day(d)); goals.push((await today(s, tok)).body.goal); await check(s, tok, "walking"); }
  assert.deepEqual(goals, [30, 35, 40, 45, 50, 50, 50]);
  s.setDay(day(22)); const n = (await today(s, tok)).body;
  assert.equal(n.reentry, false); assert.match(n.reason, /Advanced level: 50/);
  // pure function: the ramp is capped at the normal goal
  assert.equal(H.goalFor({ cfg: H.configFrom(null), level: "beginner", ramp: { active: 5, quiet: 10 } }).goal, 30);
});

test("recovery-only day qualifies, without the optional sauna or cold", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: tok } = await signup(s);
  await s.call("PUT", "/api/me/habits/level", { level: "elite" }, tok);
  s.setDay(day(3));
  assert.equal((await today(s, tok)).body.goal, 75);
  const r = (await checkAll(s, tok, RECOVERY)).body;
  assert.equal(r.points, 75); assert.equal(r.qualifying, true); assert.equal(r.recoveryOnly, true);
  assert.equal(r.habits.find((h) => h.id === "sauna").done, false);
  assert.equal(r.habits.find((h) => h.id === "cold").done, false);
  const h = (await s.call("GET", "/api/me/habits/history?month=2026-11", undefined, tok)).body;
  assert.equal(h.days.find((d) => d.date === day(3)).recoveryOnly, true);
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
  s.setDay(day(3)); await check(s, tok, "walking"); // 15 < 30
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
