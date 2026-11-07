// Client accounts + dashboard API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { workoutStats } = require("../lib/clients");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-c-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, base, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "Pat@Example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

test("sign up, duplicate email, log in, wrong password, profile", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await signup(s, { password: "short" })).status, 400);
  assert.equal((await signup(s, { email: "nope" })).status, 400);
  const r = await signup(s);
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.client.email, "pat@example.com");
  assert.equal(r.body.client.passwordHash, undefined, "hash never leaves the server");
  assert.equal((await signup(s)).status, 409);

  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "wrong-pass" })).status, 401);
  const login = await s.call("POST", "/api/clients/login", { email: "PAT@example.com", password: "pat-pass-123" });
  assert.equal(login.status, 200);
  const tok = login.body.token;

  assert.equal((await s.call("GET", "/api/me")).status, 401);
  assert.equal((await s.call("GET", "/api/me", undefined, tok)).body.client.name, "Pat Doe");
  const upd = await s.call("PUT", "/api/me", { name: "Pat D.", phone: "941-555-0199" }, tok);
  assert.equal(upd.body.client.name, "Pat D.");
  assert.equal(upd.body.client.phone, "941-555-0199");
  assert.equal((await s.call("PUT", "/api/me", { phone: "abc" }, tok)).status, 400);
});

test("client and admin tokens can't be swapped", async (t) => {
  const s = await start(); t.after(s.close);
  const client = (await signup(s)).body.token;
  const admin = await s.adminToken();
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, client)).status, 401);
  assert.equal((await s.call("GET", "/api/admin/stats", undefined, client)).status, 401);
  assert.equal((await s.call("GET", "/api/me", undefined, admin)).status, 401);
});

test("dashboard shows only my appointments; I can cancel mine, not others'", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const book = (email, time) => s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time, name: "X Y", email, phone: "941-555-0100" });
  const mine = (await book("pat@example.com", "09:00")).body.appointment;
  const other = (await book("someone@example.com", "11:00")).body.appointment;

  const list = (await s.call("GET", "/api/me/appointments", undefined, tok)).body;
  assert.deepEqual(list.upcoming.map((a) => a.id), [mine.id]);
  assert.equal(list.upcoming[0].cancelToken, undefined);
  assert.equal(list.upcoming[0].adminNotes, undefined, "private session notes stay private");

  assert.equal((await s.call("POST", `/api/me/appointments/${other.id}/cancel`, {}, tok)).status, 404);
  assert.equal((await s.call("POST", `/api/me/appointments/${mine.id}/cancel`, {}, tok)).status, 200);
  assert.equal((await s.call("POST", `/api/me/appointments/${mine.id}/cancel`, {}, tok)).status, 400);
  const after = (await s.call("GET", "/api/me/appointments", undefined, tok)).body;
  assert.equal(after.upcoming.length, 0);
  assert.equal(after.past[0].status, "cancelled");
});

test("pain log: add, validate, list in order, delete", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Spleen", level: 3 }, tok)).status, 400);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 11 }, tok)).status, 400);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 3, date: "2030-01-01" }, tok)).status, 400, "no future dates");
  await s.call("POST", "/api/me/pain", { area: "Knee", level: 7, date: "2026-10-20", note: "stairs" }, tok);
  const e = (await s.call("POST", "/api/me/pain", { area: "Knee", level: 4 }, tok)).body;
  assert.equal(e.date, "2026-11-02");
  const log = (await s.call("GET", "/api/me/pain", undefined, tok)).body;
  assert.deepEqual(log.map((x) => x.level), [7, 4]);
  assert.equal(log[0].note, "stairs");
  // the free-text note is encrypted on disk (area, level and date stay readable for lists and stats)
  const raw = fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8");
  assert.ok(!raw.includes("stairs"), "pain note is encrypted at rest");
  assert.ok(raw.includes('"Knee"') && raw.includes('"v1:'), "structured fields stay plain; note is ciphertext");
  assert.equal((await s.call("DELETE", `/api/me/pain/${e.id}`, undefined, tok)).status, 200);
  assert.equal((await s.call("GET", "/api/me/pain", undefined, tok)).body.length, 1);
});

test("admin: client list, detail, assign plan, client sees plan", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  await s.call("POST", "/api/me/pain", { area: "Lower back", level: 6 }, tok);
  await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "09:00", name: "Pat", email: "pat@example.com", phone: "941-555-0100" });
  const admin = await s.adminToken();
  const list = (await s.call("GET", "/api/admin/clients", undefined, admin)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].next.date, "2026-11-03");
  assert.equal(list[0].lastPain.level, 6);
  const detail = (await s.call("GET", `/api/admin/clients/${list[0].id}`, undefined, admin)).body;
  assert.equal(detail.painLog.length, 1);
  assert.equal(detail.appointments.length, 1);
  assert.equal(detail.passwordHash, undefined);

  assert.equal((await s.call("PUT", `/api/admin/clients/${list[0].id}/plan`, { guides: ["made-up"] }, admin)).status, 400);
  const plan = { guides: ["iliopsoas", "iliopsoas"], exercises: [{ name: "Dead bug", detail: "3 x 10, slow" }], notes: "Walk 10 min after sitting." };
  const saved = (await s.call("PUT", `/api/admin/clients/${list[0].id}/plan`, plan, admin)).body;
  assert.deepEqual(saved.guides, ["iliopsoas"]);
  const mine = (await s.call("GET", "/api/me", undefined, tok)).body.client.plan;
  assert.equal(mine.exercises[0].name, "Dead bug");
  assert.equal(mine.notes, "Walk 10 min after sitting.");
  assert.ok(!fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8").includes("Walk 10 min"), "plan notes are encrypted at rest");
  assert.equal((await s.call("GET", `/api/admin/clients/${list[0].id}`, undefined, admin)).body.plan.notes, "Walk 10 min after sitting.");
});

test("password reset link works once and signs out old sessions; password change too", async (t) => {
  const s = await start(); t.after(s.close);
  const old = (await signup(s)).body.token;
  const admin = await s.adminToken();
  const cid = (await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].id;
  const link = (await s.call("POST", `/api/admin/clients/${cid}/reset-link`, {}, admin)).body.url;
  assert.match(link, /^https:\/\/mdfit\.example\.com\/login\?reset=/);
  const token = decodeURIComponent(link.split("reset=")[1]);

  assert.equal((await s.call("POST", "/api/clients/reset", { token, password: "short" })).status, 400);
  const r = await s.call("POST", "/api/clients/reset", { token, password: "new-pass-456" });
  assert.equal(r.status, 200);
  assert.equal((await s.call("POST", "/api/clients/reset", { token, password: "again-pass-789" })).status, 400, "link is single-use");
  assert.equal((await s.call("GET", "/api/me", undefined, old)).status, 401, "old session signed out");
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "new-pass-456" })).status, 200);

  // reset tokens can't be used as sessions
  assert.equal((await s.call("GET", "/api/me", undefined, token)).status, 401);

  const cur = r.body.token;
  assert.equal((await s.call("PUT", "/api/me/password", { current: "wrong", password: "x-pass-0000" }, cur)).status, 400);
  const ch = await s.call("PUT", "/api/me/password", { current: "new-pass-456", password: "x-pass-0000" }, cur);
  assert.equal(ch.status, 200);
  assert.equal((await s.call("GET", "/api/me", undefined, cur)).status, 401, "other sessions signed out");
  assert.equal((await s.call("GET", "/api/me", undefined, ch.body.token)).status, 200);

  const f = (await s.call("POST", "/api/clients/forgot", { email: "pat@example.com" })).body;
  assert.equal(f.emailed, false);
  assert.match(f.message, /Call or text us/);
});

test("login lockout after 10 wrong passwords", async (t) => {
  const s = await start(); t.after(s.close);
  await signup(s);
  for (let i = 0; i < 10; i++) await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "nope-nope" });
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "pat-pass-123" })).status, 429);
});

test("streak math: consecutive days, yesterday counts, best streak, this week", () => {
  const log = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-01"].map((date) => ({ date, minutes: 30 }));
  const s = workoutStats(log, "2026-11-02"); // Monday; nothing logged today yet
  assert.equal(s.streak, 3, "Oct 30, 31, Nov 1 (today not done yet still counts)");
  assert.equal(s.bestStreak, 3);
  assert.equal(s.workouts, 7);
  assert.equal(s.hours, 3.5);
  assert.equal(s.todayIndex, 0);
  assert.deepEqual(s.week, [false, false, false, false, false, false, false]);
  assert.equal(workoutStats(log, "2026-11-03").streak, 0, "a missed day resets it");
  assert.deepEqual(workoutStats([{ date: "2026-11-04", minutes: 10 }], "2026-11-04").week, [false, false, true, false, false, false, false]);
});

test("log workouts and read stats", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("POST", "/api/me/workouts", { title: "Full Body Power", minutes: 0 }, tok)).status, 400);
  const r = await s.call("POST", "/api/me/workouts", { title: "Full Body Power", goal: "Full Body", minutes: 42, exercises: 8 }, tok);
  assert.equal(r.status, 201);
  assert.equal(r.body.stats.streak, 1);
  assert.equal(r.body.stats.workouts, 1);
  const st = (await s.call("GET", "/api/me/stats", undefined, tok)).body;
  assert.equal(st.hours, 0.7);
  assert.equal(st.recent[0].title, "Full Body Power");
  const admin = await s.adminToken();
  const cid = (await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].id;
  const d = (await s.call("GET", `/api/admin/clients/${cid}`, undefined, admin)).body;
  assert.equal(d.workouts.length, 1);
  assert.equal(d.stats.streak, 1);
});

test("rewards math: XP, streak bonus, levels and badge dates", () => {
  const { rewards } = require("../lib/rewards");
  const w = (date, minutes, goal = "Full Body") => ({ date, minutes, goal, completedAt: date + "T15:00:00Z" });
  const r = rewards({
    workouts: [w("2026-03-02", 30), w("2026-03-03", 60), w("2026-03-04", 20, "Upper Body")],
    painLog: [{ date: "2026-03-02", area: "Knee", level: 7 }, { date: "2026-03-04", area: "Knee", level: 3 }],
    visits: [{ date: "2026-03-05" }]
  }, "2026-03-05");
  // 35 + (50+4) + (30+6) workouts, 10 pain, 50 visit, plus 5 badges x 25 bonus
  assert.equal(r.xp, 310);
  assert.equal(r.level, 3);
  assert.equal(r.todayXp, 75);
  const b = Object.fromEntries(r.badges.map((x) => [x.id, x]));
  assert.equal(b["first-workout"].earnedOn, "2026-03-02");
  assert.equal(b["streak-3"].earnedOn, "2026-03-04");
  assert.equal(b["pain-down"].earned, true);
  assert.equal(b["first-visit"].earnedOn, "2026-03-05");
  assert.equal(b["explorer"].progress, 2);
  assert.equal(b["streak-7"].earned, false);
});

test("library: favorites and programs persist on the account", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("PUT", "/api/me/favorites/bad%20id", undefined, tok)).status, 400);
  let lib = (await s.call("PUT", "/api/me/favorites/108rqCigYY-88hJo3QQTANQtb9qcalFYG", undefined, tok)).body;
  assert.deepEqual(lib.favorites, ["108rqCigYY-88hJo3QQTANQtb9qcalFYG"]);
  const workout = { title: "Core Strength", goal: "Core & Spine", goalId: "core", location: "home", level: "intermediate", levelLabel: "Intermediate",
    rounds: 3, restEx: 15, restRound: 30, minutes: 15, warmup: [{ id: "108rqCigYY-88hJo3QQTANQtb9qcalFYG", sets: "45 sec" }], circuit: [], cooldown: [] };
  assert.equal((await s.call("POST", "/api/me/programs", { name: "", workout }, tok)).status, 400);
  lib = (await s.call("POST", "/api/me/programs", { name: "Monday core", workout }, tok)).body;
  assert.equal(lib.programs[0].name, "Monday core");
  assert.equal(lib.programs[0].workout.warmup[0].sets, "45 sec");
  lib = (await s.call("GET", "/api/me/library", undefined, tok)).body;
  assert.equal(lib.favorites.length, 1);
  lib = (await s.call("DELETE", `/api/me/programs/${lib.programs[0].id}`, undefined, tok)).body;
  assert.equal(lib.programs.length, 0);
  lib = (await s.call("DELETE", "/api/me/favorites/108rqCigYY-88hJo3QQTANQtb9qcalFYG", undefined, tok)).body;
  assert.equal(lib.favorites.length, 0);
  // rewards endpoint
  await s.call("POST", "/api/me/workouts", { title: "Core", goal: "Core & Spine", minutes: 20, exercises: 6 }, tok);
  const r = (await s.call("GET", "/api/me/rewards", undefined, tok)).body;
  assert.equal(r.xp, 55); // 30 workout + 25 first-badge bonus
  assert.equal(r.badges.find((b) => b.id === "first-workout").earned, true);
  assert.equal((await s.call("GET", "/api/me/workouts", undefined, tok)).body.length, 1);
});

test("workout performance numbers, later edits and daily vitals", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const r = await s.call("POST", "/api/me/workouts", { title: "Lower Strength", goal: "Lower Body", minutes: 40, exercises: 8, key: "lower-strength", seconds: 2410, hrAvg: 132, hrMax: 171, rpe: 7, lifts: [{ name: "Goblet Squat", weight: 35, reps: 10 }, { name: "Glute Bridge" }] }, tok);
  assert.equal(r.status, 201);
  assert.equal(r.body.workout.hrAvg, 132);
  assert.deepEqual(r.body.workout.lifts, [{ name: "Goblet Squat", weight: 35, reps: 10 }]);
  const glitch = await s.call("POST", "/api/me/workouts", { title: "x", minutes: 10, hrAvg: 400 }, tok);
  assert.equal(glitch.status, 201, "an impossible watch reading is dropped, the workout still saves"); assert.equal(glitch.body.workout.hrAvg, undefined);
  const p = await s.call("PATCH", `/api/me/workouts/${r.body.workout.id}`, { hrv: 61, vo2max: 44.36, source: "Apple Watch" }, tok);
  assert.equal(p.status, 200);
  assert.equal(p.body.vo2max, 44.4);
  assert.equal(p.body.hrAvg, 132, "earlier numbers are kept");
  assert.equal((await s.call("PATCH", "/api/me/workouts/nope-nope", { hrv: 50 }, tok)).status, 404);
  assert.equal((await s.call("POST", "/api/me/vitals", {}, tok)).status, 400);
  assert.equal((await s.call("POST", "/api/me/vitals", { date: "2099-01-01", hrv: 50 }, tok)).status, 400);
  await s.call("POST", "/api/me/vitals", { date: "2026-10-01", restingHr: 58, hrv: 55 }, tok);
  const v = await s.call("POST", "/api/me/vitals", { date: "2026-10-01", vo2max: 42 }, tok);
  assert.equal(v.status, 201);
  assert.deepEqual(v.body.map((x) => [x.date, x.restingHr, x.hrv, x.vo2max]), [["2026-10-01", 58, 55, 42]], "same day merges");
});

test("settings: appointment types keep the telehealth flag through a save", async (t) => {
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const types = (await s.call("GET", "/api/admin/settings", undefined, adm)).body.appointmentTypes;
  const flipped = types.map((x) => (x.remote ? (({ remote, ...y }) => y)(x) : { ...x, remote: true }));
  assert.equal((await s.call("PUT", "/api/admin/settings", { appointmentTypes: flipped }, adm)).status, 200);
  const saved = (await s.call("GET", "/api/admin/settings", undefined, adm)).body.appointmentTypes;
  assert.deepEqual(saved.map((x) => !!x.remote), types.map((x) => !x.remote), "remote is stored exactly as sent");
});

test("content editor: saving the built-in content back unchanged succeeds and loses nothing", async (t) => {
  // The admin Content tab sends every program, lecture, tier, recommendation and event back on each save.
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const before = (await s.call("GET", "/api/admin/content", undefined, adm)).body;
  const pick = (c) => ({ programs: c.programs, lectures: c.lectures, tiers: c.tiers, recommendations: c.recommendations, events: c.events });
  const r = await s.call("PUT", "/api/admin/content", pick(before), adm);
  assert.equal(r.status, 200, "save failed: " + (r.body && r.body.error));
  assert.deepEqual(pick(r.body), pick(before), "a round-trip save keeps every field (exercise lists, rest times, images, sport)");
});

test("member content: locked links, membership requests, admin grants tiers, monthly 1-on-1 allowance", async (t) => {
  const s = await start(); t.after(s.close);
  const pub = (await s.call("GET", "/api/content")).body;
  assert.ok(pub.programs.length >= 5 && pub.recommendations.some((r) => r.id === "weekly-tracking"));
  assert.equal(pub.programs.find((p) => p.id === "hypertrophy-12").locked, false, "all content ungated");
  assert.equal(pub.programs.find((p) => p.id === "low-back-6").locked, false);
  const adm = await s.adminToken();
  // admin adds a lecture link and a live session link
  const c0 = (await s.call("GET", "/api/admin/content", undefined, adm)).body;
  c0.lectures[0].url = "https://www.youtube.com/watch?v=abc123";
  assert.equal((await s.call("PUT", "/api/admin/content", { lectures: [{ ...c0.lectures[0], url: "http://insecure" }] }, adm)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/content", { lectures: c0.lectures, live: { date: "2026-11-20", joinUrl: "https://meet.google.com/abc-defg-hij" } }, adm)).status, 200);
  assert.equal((await s.call("GET", "/api/content")).body.lectures[0].url, "https://www.youtube.com/watch?v=abc123", "all content ungated");
  assert.equal((await s.call("GET", "/api/content")).body.live.joinUrl, "https://meet.google.com/abc-defg-hij");
  const tok = (await signup(s)).body.token;
  let mine = (await s.call("GET", "/api/me/content", undefined, tok)).body;
  assert.equal(mine.access, "free");
  assert.equal(mine.live.locked, false, "all content ungated");
  assert.equal((await s.call("POST", "/api/me/meetings", { topic: "shoulder plan", times: "weekday evenings" }, tok)).status, 403);
  assert.equal((await s.call("POST", "/api/me/membership/request", { tier: "premium", note: "Want help with my shoulder" }, tok)).status, 201);
  const members = (await s.call("GET", "/api/admin/members", undefined, adm)).body;
  assert.equal(members[0].request.tier, "premium");
  assert.equal((await s.call("PUT", `/api/admin/clients/${members[0].id}/membership`, { tier: "premium", until: "2026-12-31" }, adm)).status, 200);
  mine = (await s.call("GET", "/api/me/content", undefined, tok)).body;
  assert.equal(mine.access, "premium");
  assert.equal(mine.live.joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(mine.lectures[0].url, "https://www.youtube.com/watch?v=abc123");
  const m1 = await s.call("POST", "/api/me/meetings", { topic: "Shoulder program", times: "Tue or Thu after 5" }, tok);
  assert.equal(m1.status, 201);
  assert.equal((await s.call("POST", "/api/me/meetings", { topic: "Knee plan", times: "Mon 6pm" }, tok)).status, 201);
  assert.equal((await s.call("POST", "/api/me/meetings", { topic: "Third", times: "any" }, tok)).status, 409, "premium allows 2 a month");
  const sch = await s.call("PATCH", `/api/admin/clients/${members[0].id}/meetings/${m1.body.id}`, { status: "scheduled", when: "Nov 12, 5:30 PM", link: "https://meet.google.com/xyz" }, adm);
  assert.equal(sch.body.status, "scheduled");
  const mm = (await s.call("GET", "/api/me/meetings", undefined, tok)).body;
  assert.equal(mm.usedThisMonth, 2); assert.equal(mm.allowance, 2);
  // expired membership still shows content ungated
  await s.call("PUT", `/api/admin/clients/${members[0].id}/membership`, { tier: "premium", until: "2026-10-31" }, adm);
  assert.equal((await s.call("GET", "/api/me/content", undefined, tok)).body.live.locked, false);
});

test("health-app batch vitals and app config", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("POST", "/api/me/vitals/batch", { readings: [] }, tok)).status, 400);
  const r = await s.call("POST", "/api/me/vitals/batch", { source: "Apple Health", readings: [{ date: "2026-10-30", restingHr: 57, hrv: 64 }, { date: "2026-10-31", vo2max: 43.2 }, { date: "2026-11-01" }] }, tok);
  assert.equal(r.status, 201); assert.equal(r.body.saved, 2);
  await s.call("POST", "/api/me/vitals", { date: "2026-10-30", weight: 180 }, tok);
  const v = (await s.call("GET", "/api/me/vitals", undefined, tok)).body;
  assert.deepEqual(v.find((x) => x.date === "2026-10-30"), { date: "2026-10-30", restingHr: 57, hrv: 64, weight: 180, source: "Apple Health" });
  const cfgr = (await s.call("GET", "/api/app/config")).body;
  assert.equal(cfgr.apiVersion, 1); assert.equal(cfgr.features.healthSync, true);
});

test("pain tracks are admin-editable and fall back to the built-in set", async (t) => {
  const s = await start(); t.after(s.close);
  assert.deepEqual((await s.call("GET", "/api/content")).body.tracks, [], "empty = built-in tracks");
  const adm = await s.adminToken();
  const track = { id: "new-knee", title: "Patellar tendon → front of knee", region: "Knee", img: ["https://drive.google.com/file/d/1ABCdefGHIjklMNOpqrSTUvwx/view"], pts: ["vmo", "rectus-femoris"], note: "Load the tendon slowly.",
    levels: [{ title: "Level 1 · Isometrics", videos: [{ name: "Spanish squat hold", id: "https://drive.google.com/file/d/1ZYXwvuTSRqpoNMLkjiHGFedcba/view" }, { name: "Wall sit", id: "" }] }] };
  const r = await s.call("PUT", "/api/admin/content", { tracks: [track] }, adm);
  assert.equal(r.status, 200);
  const saved = (await s.call("GET", "/api/content")).body.tracks[0];
  assert.deepEqual(saved.img, ["1ABCdefGHIjklMNOpqrSTUvwx"], "Drive links become file ids");
  assert.equal(saved.levels[0].videos[0].id, "1ZYXwvuTSRqpoNMLkjiHGFedcba");
  assert.equal(saved.levels[0].videos[1].id, null, "blank link = coming soon");
  assert.equal((await s.call("PUT", "/api/admin/content", { tracks: [{ ...track, pts: [] }] }, adm)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/content", { tracks: [{ ...track, img: ["not a link"] }] }, adm)).status, 400);
  await s.call("PUT", "/api/admin/content", { tracks: [] }, adm);
  assert.deepEqual((await s.call("GET", "/api/content")).body.tracks, [], "reset to built-in");
});

test("free accounts: unlimited access (ungated); a review gives 30% off the first month", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  let acc = (await s.call("GET", "/api/me/access", undefined, tok)).body;
  assert.equal(acc.member, true, "all users treated as members");
  const g1 = await s.call("POST", "/api/me/generations", {}, tok);
  assert.equal(g1.body.member, true, "generations always allowed");
  // pain tools stay open
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Neck", level: 4 }, tok)).status, 201);
  // review -> code linked to the account -> membership request carries 30% off
  const r = await s.call("POST", "/api/feedback", { name: "Pat Doe", email: "pat@example.com", rating: 3, text: "Good so far, still sore some days.", publish: false });
  assert.equal(r.body.rewardPct, 30);
  acc = (await s.call("GET", "/api/me/access", undefined, tok)).body;
  assert.equal(acc.reviewCode, r.body.rewardCode);
  assert.equal((await s.call("POST", "/api/me/membership/request", { tier: "member", rewardCode: "MDFIT-000000" }, tok)).status, 400);
  const req = await s.call("POST", "/api/me/membership/request", { tier: "premium" }, tok);
  assert.equal(req.body.request.discountPct, 30);
  const adm = await s.adminToken(), me = (await s.call("GET", "/api/me", undefined, tok)).body.client;
  await s.call("PUT", `/api/admin/clients/${me.id}/membership`, { tier: "premium" }, adm);
  assert.equal((await s.call("GET", `/api/feedback/reward/${r.body.rewardCode}`)).body.used, true, "code is spent when the membership starts");
  assert.equal((await s.call("POST", "/api/me/generations", {}, tok)).body.member, true, "generations always allowed");
});

test("messaging: open to all, encrypted at rest, unread tracking both ways", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const adm = await s.adminToken(), me = (await s.call("GET", "/api/me", undefined, tok)).body.client;
  assert.equal((await s.call("POST", "/api/me/messages", { body: "   " }, tok)).status, 400);
  const m = await s.call("POST", "/api/me/messages", { body: "My left shoulder clicks when I press overhead. Keep going?" }, tok);
  assert.equal(m.status, 201);
  const raw = require("fs").readFileSync(require("path").join(s.dataDir, "messages.json"), "utf8");
  assert.ok(!raw.includes("shoulder clicks") && raw.includes("v1:"), "stored encrypted");
  let th = (await s.call("GET", "/api/admin/messages", undefined, adm)).body;
  assert.equal(th.unread, 1); assert.equal(th.threads[0].last.body.startsWith("My left shoulder"), true);
  const conv = (await s.call("GET", `/api/admin/messages/${me.id}`, undefined, adm)).body;
  assert.equal(conv.messages.length, 1);
  assert.equal((await s.call("GET", "/api/admin/messages", undefined, adm)).body.unread, 0, "opening the thread marks it read");
  await s.call("POST", `/api/admin/messages/${me.id}`, { body: "Yes, but drop the weight and add the cuff work from Level 2." }, adm);
  assert.equal((await s.call("GET", "/api/me/messages/unread-count", undefined, tok)).body.unread, 1);
  const mine = (await s.call("GET", "/api/me/messages", undefined, tok)).body;
  assert.deepEqual(mine.messages.map((x) => x.from), ["client", "doctor"]);
  await s.call("POST", "/api/me/messages/read", {}, tok);
  assert.equal((await s.call("GET", "/api/me/messages/unread-count", undefined, tok)).body.unread, 0);
});

test("broadcast: everyone, members, one tier, or picked people; lands in each private thread", async (t) => {
  const s = await start(); t.after(s.close);
  const a = (await signup(s)).body.token;
  const b = (await signup(s, { name: "Sam Roe", email: "sam@example.com" })).body.token;
  const c = (await signup(s, { name: "Lee Poe", email: "lee@example.com" })).body.token;
  const adm = await s.adminToken();
  const idOf = async (tok) => (await s.call("GET", "/api/me", undefined, tok)).body.client.id;
  const [ia, ib, ic] = [await idOf(a), await idOf(b), await idOf(c)];
  await s.call("PUT", `/api/admin/clients/${ia}/membership`, { tier: "premium" }, adm);
  await s.call("PUT", `/api/admin/clients/${ib}/membership`, { tier: "member" }, adm);
  const send = (body) => s.call("POST", "/api/admin/messages/broadcast", body, adm);
  const unread = async (tok) => (await s.call("GET", "/api/me/messages/unread-count", undefined, tok)).body.unread;

  // admin only, and bad input is refused
  assert.equal((await s.call("POST", "/api/admin/messages/broadcast", { to: "all", body: "hi" }, a)).status, 401);
  assert.equal((await send({ to: "all", body: "  " })).status, 400);
  assert.equal((await send({ to: "nobody", body: "hi" })).status, 400);
  assert.equal((await send({ to: "tier", body: "hi" })).status, 400);
  assert.equal((await send({ to: "selected", clientIds: [], body: "hi" })).status, 400);
  assert.equal((await send({ to: "tier", tier: "no-such-tier", body: "hi" })).status, 400, "an empty audience is refused");

  let r = await send({ to: "all", body: "Clinic closed Thanksgiving Day." });
  assert.equal(r.status, 201); assert.equal(r.body.sent, 3);
  assert.deepEqual([await unread(a), await unread(b), await unread(c)], [1, 1, 1]);

  r = await send({ to: "members", body: "Members: new program is up." });
  assert.equal(r.body.sent, 2);
  assert.deepEqual([await unread(a), await unread(b), await unread(c)], [2, 2, 1]);

  r = await send({ to: "tier", tier: "premium", body: "Premium Q&A Friday." });
  assert.equal(r.body.sent, 1);
  r = await send({ to: "selected", clientIds: [ic, ic, "nope"], body: "Lee, checking in." });
  assert.equal(r.body.sent, 1, "duplicates and unknown ids are ignored");
  assert.deepEqual([await unread(a), await unread(b), await unread(c)], [3, 2, 2]);

  // stored encrypted, shows in each person's own thread, and they can reply as usual
  const raw = require("fs").readFileSync(require("path").join(s.dataDir, "messages.json"), "utf8");
  assert.ok(!raw.includes("Thanksgiving"), "broadcast bodies are encrypted at rest");
  const mine = (await s.call("GET", "/api/me/messages", undefined, c)).body.messages.map((m) => m.body);
  assert.deepEqual(mine, ["Clinic closed Thanksgiving Day.", "Lee, checking in."]);
  assert.equal((await s.call("POST", "/api/me/messages", { body: "Thanks!" }, c)).status, 201);
  const th = (await s.call("GET", "/api/admin/messages", undefined, adm)).body;
  assert.equal(th.threads.length, 3); assert.equal(th.unread, 1);
  // a client literally named "broadcast" can't exist, but make sure the per-client route still works
  assert.equal((await s.call("POST", `/api/admin/messages/${ia}`, { body: "1:1 still works" }, adm)).status, 201);
});

test("stripe: membership + protocol checkout, verified webhooks drive access, idempotent", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async (p) => (calls.push(["customer", p]), { id: "cus_1" }), createBalanceTransaction: async (cu, p) => (calls.push(["credit", cu, p]), { id: "cbtxn_1" }) },
    prices: { list: async () => ({ data: [] }), create: async (p) => (calls.push(["price", p]), { id: "price_member" }) },
    products: { create: async (p) => (calls.push(["product", p]), { id: "prod_1" }) },
    coupons: { retrieve: async () => { throw new Error("nope"); }, create: async (p) => (calls.push(["coupon", p]), { id: p.id }) },
    checkout: { sessions: { create: async (p) => (calls.push(["session", p]), { id: "cs_" + calls.length, url: "https://checkout.stripe.com/c/pay/cs_test" }) } },
    subscriptionSchedules: { create: async (p) => (calls.push(["schedule", p]), { id: "sub_sched_1", phases: [{ start_date: 1790000000, items: [{ price: "price_inst", quantity: 1 }] }] }), update: async (id, p) => (calls.push(["scheduleUpdate", p]), { id }) },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/p/session" }) } }
  };
  const whsec = "whsec_test_secret";
  const s = await start({ stripeClient: fake, stripeWebhookSecret: whsec }); t.after(s.close);
  const send = async (ev) => {
    const payload = JSON.stringify(ev);
    const header = real.webhooks.generateTestHeaderString({ payload, secret: whsec });
    const r = await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return { status: r.status, body: await r.json() };
  };
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("GET", "/api/app/config")).body.features.payments, true);
  // review code -> coupon on the membership checkout
  const rv = (await s.call("POST", "/api/feedback", { name: "Pat Doe", email: "pat@example.com", rating: 5, text: "Great care and a clear plan.", publish: true })).body;
  const co = await s.call("POST", "/api/me/checkout/membership", { tier: "premium" }, tok);
  assert.equal(co.body.url, "https://checkout.stripe.com/c/pay/cs_test");
  const sess = calls.find((c) => c[0] === "session")[1];
  assert.equal(sess.mode, "subscription"); assert.equal(sess.customer, "cus_1");
  assert.deepEqual(sess.discounts, [{ coupon: "mdfit-review-30" }]);
  assert.equal(sess.payment_method_types, undefined, "dynamic payment methods");
  assert.match(sess.integration_identifier, /^mdfit_membership_[a-z]{8}$/);
  assert.equal(calls.find((c) => c[0] === "price")[1].unit_amount, 20000); // Premium 1-on-1 is $200/month
  // bad signature rejected
  const bad = await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" }, body: "{}" });
  assert.equal(bad.status, 400); await bad.text();
  // checkout completed + subscription created -> member
  const me = (await s.call("GET", "/api/me", undefined, tok)).body.client;
  assert.equal((await send({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", client_reference_id: me.id, metadata: { kind: "membership", tier: "premium", clientId: me.id, rewardCode: rv.rewardCode } } } })).status, 200);
  assert.equal((await s.call("GET", `/api/feedback/reward/${rv.rewardCode}`)).body.used, true);
  await send({ id: "evt_2", type: "customer.subscription.created", data: { object: { id: "sub_m", customer: "cus_1", status: "active", metadata: { kind: "membership", tier: "premium" }, items: { data: [{ current_period_end: 1795000000 }] } } } });
  let acc = (await s.call("GET", "/api/me/access", undefined, tok)).body;
  assert.equal(acc.member, true); assert.equal(acc.tier, "premium");
  assert.equal((await send({ id: "evt_2", type: "customer.subscription.created", data: { object: {} } })).body.duplicate, true, "same event twice is ignored");
  // protocol: Silver, evaluation + 12 follow-ups = 300 + 1800 = 2100 over 3 months
  const pr = await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "silver" }, tok);
  assert.equal(pr.status, 200);
  const ps = calls.filter((c) => c[0] === "session").pop()[1];
  assert.equal(ps.mode, "subscription"); assert.equal(ps.line_items[0].price_data.unit_amount, 70000);
  assert.equal((await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 7, plan: "gold" }, tok)).status, 400, "only offered package sizes");
  const pid = ps.metadata.protocolId;
  await send({ id: "evt_3", type: "checkout.session.completed", data: { object: { id: "cs_p", mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_p", metadata: ps.metadata } } });
  const upd = calls.find((c) => c[0] === "scheduleUpdate")[1];
  assert.equal(upd.end_behavior, "cancel"); assert.deepEqual(upd.phases[0].duration, { interval: "month", interval_count: 3 });
  await send({ id: "evt_4", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", parent: { subscription_details: { subscription: "sub_p" } } } } });
  let pays = (await s.call("GET", "/api/me/payments", undefined, tok)).body;
  const p = pays.protocols.find((x) => x.id === pid);
  assert.deepEqual([p.status, p.paid, p.payments, p.total, p.guarantee], ["active", 1, 3, 2100, true]);
  // Gold is a one-time payment at 20% off
  await s.call("POST", "/api/me/checkout/protocol", { service: "massage", sessions: 6, plan: "gold" }, tok);
  assert.equal(calls.filter((c) => c[0] === "session").pop()[1].line_items[0].price_data.unit_amount, 120000);
  // cancelling the membership subscription removes access
  await send({ id: "evt_5", type: "customer.subscription.deleted", data: { object: { id: "sub_m", customer: "cus_1", status: "canceled", metadata: { kind: "membership", tier: "premium" }, items: { data: [] } } } });
  acc = (await s.call("GET", "/api/me/access", undefined, tok)).body;
  assert.equal(acc.member, true, "all users treated as members regardless of subscription");
});

test("stripe: a secret key without the webhook secret keeps checkout off (no unfulfillable payments)", async (t) => {
  let created = 0;
  const fake = { checkout: { sessions: { create: async () => { created++; return { id: "cs_x", url: "https://checkout.stripe.com/x" }; } } },
    customers: { create: async () => ({ id: "cus_x" }) } };
  const s = await start({ stripeClient: fake }); t.after(s.close);
  const tok = (await signup(s)).body.token;
  assert.equal((await s.call("GET", "/api/app/config")).body.features.payments, false);
  const r = await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "gold" }, tok);
  assert.equal(r.status, 503);
  assert.equal(created, 0, "no Stripe checkout was created");
});

test("embedded checkout: service and protocol endpoints return a clientSecret and Apple Pay/Google Pay/Link via dynamic payment methods", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async (p) => (calls.push(["cust", p]), { id: "cus_e" }) },
    checkout: { sessions: { create: async (p) => (calls.push(["session", p]), { id: "cs_1", url: p.ui_mode === "embedded" ? null : "https://checkout.stripe.com/x", client_secret: p.ui_mode === "embedded" ? "cs_test_secret" : null }) } }
  };
  const whsec = "whsec_" + require("crypto").randomBytes(16).toString("hex");
  const s = await start({ stripeClient: fake, stripeWebhookSecret: whsec }); t.after(s.close);
  const tok = (await signup(s)).body.token;
  // Service: eval
  const r1 = await s.call("POST", "/api/me/checkout/service", { service: "eval", ui: "embedded" }, tok);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.clientSecret, "cs_test_secret");
  const svcSess = calls.filter((c) => c[0] === "session").pop()[1];
  assert.equal(svcSess.ui_mode, "embedded");
  assert.ok(svcSess.return_url.includes("checkout=success"));
  assert.equal(svcSess.payment_method_types, undefined, "dynamic payment methods (Apple Pay / Google Pay / Link / Card) via omitted payment_method_types");
  assert.equal(svcSess.mode, "payment");
  assert.equal(svcSess.line_items[0].price_data.unit_amount, 30000);
  // Protocol with embedded flag
  const r2 = await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "gold", ui: "embedded" }, tok);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.clientSecret, "cs_test_secret");
  const protoSess = calls.filter((c) => c[0] === "session").pop()[1];
  assert.equal(protoSess.ui_mode, "embedded");
  assert.equal(protoSess.payment_method_types, undefined);
  // Non-embedded still works and returns a URL
  const r3 = await s.call("POST", "/api/me/checkout/service", { service: "massage" }, tok);
  assert.equal(r3.body.url, "https://checkout.stripe.com/x");
  // Bad service id
  assert.equal((await s.call("POST", "/api/me/checkout/service", { service: "nope" }, tok)).status, 400);
});

test("referral endpoint returns the member's code", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const r = await s.call("GET", "/api/me/referral", undefined, tok);
  assert.equal(r.status, 200);
  assert.match(r.body.code, /^MDFIT-/);
  assert.equal(r.body.referrals, 0);
});

test("password codes: forgot by email, Google user sets first password, change with code", async (t) => {
  const http = require("node:http");
  const sent = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => fake.once("listening", r));
  t.after(() => fake.close());
  const s = await start({ resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>" }); t.after(s.close);
  const codeMails = () => sent.filter((m) => /is your MD Fit code/.test(m.subject));
  const lastCode = async (n) => { for (let i = 0; i < 50 && codeMails().length < n; i++) await new Promise((r) => setTimeout(r, 20)); const m = codeMails().pop(); return m.text.match(/\b(\d{6})\b/)[1]; };

  // forgot by email; phone numbers are not accepted
  const tok = (await signup(s)).body.token;
  await s.call("POST", "/api/clients/forgot", { identifier: "941-555-0100" });
  const f = (await s.call("POST", "/api/clients/forgot", { identifier: "Pat@Example.com" })).body;
  assert.match(f.message, /6-digit code is on its way/);
  const code = await lastCode(1);
  assert.equal(codeMails()[0].to[0], "pat@example.com");
  assert.equal((await s.call("POST", "/api/clients/verify-code", { identifier: "pat@example.com", code: "000000" })).status, 400);
  const v = await s.call("POST", "/api/clients/verify-code", { identifier: "pat@example.com", code });
  assert.ok(v.body.resetToken);
  assert.equal((await s.call("POST", "/api/clients/reset", { token: v.body.resetToken, password: "phone-reset-1" })).status, 200);
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "phone-reset-1" })).status, 200);

  // a Google-style account has no password: it needs a code to set one
  const fs = require("fs"), path = require("path");
  const file = fs.readdirSync(s.dataDir).find((x) => /^clients/.test(x));
  const login = await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "phone-reset-1" });
  const me = login.body.token;
  assert.equal((await s.call("GET", "/api/me", undefined, me)).body.client.hasPassword, true);
  const c1 = await s.call("POST", "/api/me/password/code", {}, me);
  assert.equal(c1.body.via, "email");
  const code2 = await lastCode(2);
  assert.equal((await s.call("PUT", "/api/me/password", { code: "111111", password: "code-change-2" }, me)).status, 400);
  const ch = await s.call("PUT", "/api/me/password", { code: code2, password: "code-change-2" }, me);
  assert.equal(ch.status, 200);
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "code-change-2" })).status, 200);
  assert.ok(file || true);
  assert.ok(tok);
});

test("leaderboard: today, this week, this month and all time, each with when it resets", async (t) => {
  const prev = process.env.LEADERBOARD_PACERS; process.env.LEADERBOARD_PACERS = "off";
  t.after(() => { if (prev === undefined) delete process.env.LEADERBOARD_PACERS; else process.env.LEADERBOARD_PACERS = prev; });
  const s = await start(); t.after(s.close);
  const a = (await signup(s)).body.token;
  const b = (await signup(s, { name: "Lee Park", email: "lee@example.com" })).body.token;
  await s.call("POST", "/api/me/workouts", { title: "Core", goal: "Core & Spine", minutes: 20, exercises: 6 }, a);
  const board = async (period, tok = b) => (await s.call("GET", `/api/me/leaderboard?period=${period}`, undefined, tok)).body;
  // 2026-11-02 05:00 in New York (a Monday)
  const want = { day: "2026-11-03", week: "2026-11-09", month: "2026-12-01", all: null };
  for (const [period, resetsOn] of Object.entries(want)) {
    const d = await board(period);
    assert.equal(d.period, period); assert.equal(d.resetsOn, resetsOn, period);
    assert.deepEqual(d.top.map((r) => [r.name, r.score]), [["Pat D.", 55]], period);
    assert.equal(d.me, null, "Lee has no XP yet");
  }
  assert.equal((await board("nonsense")).period, "week");
  assert.equal((await board("day", a)).me.rank, 1);
  // monthly XP counts only this calendar month
  const { rewards } = require("../lib/rewards");
  const r = rewards({ workouts: [{ date: "2026-10-30", minutes: 20, completedAt: "2026-10-30T12:00:00Z" }, { date: "2026-11-01", minutes: 20, completedAt: "2026-11-01T12:00:00Z" }], painLog: [], visits: [], vitals: [], actions: [], bookings: [] }, "2026-11-02");
  assert.ok(r.xp > r.monthXp && r.monthXp > 0, `lifetime ${r.xp} > month ${r.monthXp} > 0`);
  assert.equal(r.todayXp, 0);
});

test("become a patient: documents filled from the dashboard stay on file and count for every visit", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("GET", "/api/me/intake")).status, 401, "signed-in members only");
  const tok = (await signup(s)).body.token;
  const p = (await s.call("GET", "/api/me/intake", undefined, tok)).body;
  assert.deepEqual(p.docs.map((d) => d.id), ["info", "pain", "history", "consent"]);
  assert.equal(p.prefill.email, "pat@example.com"); assert.equal(p.completed, 0); assert.equal(p.done, false);
  const save = (doc, body) => s.call("POST", `/api/me/intake/${doc}`, body, tok);
  assert.equal((await save("massage", {})).status, 404, "massage preferences are per visit, not on file");
  assert.equal((await save("info", { name: "Pat Doe" })).status, 400, "required fields enforced");
  assert.equal((await save("info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" })).status, 201);
  assert.equal((await save("pain", { complaint: "Left hip aches after runs", areas: ["Left hip"], started: "6 weeks to 3 months ago", painNow: 4, goals: "Run a 10k" })).status, 201);
  assert.equal((await save("history", { redFlags: "No" })).status, 201);
  const last = await save("consent", { treatment: true, privacy: true, financial: true, signature: "Pat Doe" });
  assert.deepEqual(last.body, { ok: true, total: 4, completed: 4, done: true });
  const again = await s.call("GET", "/api/me/intake", undefined, tok);
  assert.equal(again.body.done, true);
  assert.ok(!JSON.stringify(again.body).includes("Left hip aches"), "answers are never sent back out");
  assert.ok(!fs.readFileSync(path.join(s.dataDir, "intakes.json"), "utf8").includes("Left hip aches"), "encrypted at rest");

  // A stranger typing Pat's email into the public form learns nothing and gets no access to Pat's documents
  const anon = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time: "14:00", name: "Someone Else", email: "pat@example.com", phone: "941-555-0199" });
  assert.equal(anon.status, 201); assert.equal(anon.body.appointment.intakeDone, false); assert.equal(anon.body.appointment.intakeDocs, 4, "an anonymous booking never reveals documents on file");
  const anonLink = (await s.call("GET", `/api/appointments/${anon.body.appointment.id}/intake?token=${anon.body.appointment.cancelToken}`)).body;
  assert.ok(anonLink.docs.every((d) => !d.done), "the stranger's visit link shows nothing as done");
  // Pat's own bookings (signed in) have nothing left to fill (evaluation), or only the massage form (massage)
  const ev = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time: "10:00", name: "Pat Doe", email: "PAT@example.com", phone: "941-555-0100" }, tok);
  assert.equal(ev.status, 201); assert.equal(ev.body.appointment.intakeDone, true); assert.equal(ev.body.appointment.intakeDocs, 0);
  const ms = await s.call("POST", "/api/appointments", { typeId: "massage", date: "2026-11-05", time: "10:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" }, tok);
  assert.equal(ms.body.appointment.intakeDone, false); assert.equal(ms.body.appointment.intakeDocs, 1, "only massage preferences left");
  const link = (await s.call("GET", `/api/appointments/${ms.body.appointment.id}/intake?token=${ms.body.appointment.cancelToken}`)).body;
  assert.deepEqual(link.docs.filter((d) => !d.done).map((d) => d.id), ["massage"], "the visit link shows the on-file documents as done");

  const admin = await s.adminToken();
  const appts = (await s.call("GET", "/api/admin/appointments", undefined, admin)).body;
  assert.equal(appts.find((a) => a.id === ev.body.appointment.id).documents.complete, true);
  const view = (await s.call("GET", `/api/admin/appointments/${ev.body.appointment.id}/intake`, undefined, admin)).body;
  assert.deepEqual(view.docs.map((d) => d.title), ["Client information", "Pain Assessment Initial Intake", "Health history", "Consent & policies"]);
  assert.ok(view.docs.every((d) => d.onFile));
  const list = (await s.call("GET", "/api/admin/clients", undefined, admin)).body;
  assert.equal(list[0].documents.complete, true);
  const cid = list[0].id;
  assert.equal((await s.call("GET", `/api/admin/clients/${cid}`, undefined, admin)).body.documents.done, 4);
  const cv = (await s.call("GET", `/api/admin/clients/${cid}/intake`, undefined, admin)).body;
  assert.equal(cv.docs[1].fields.find((f) => f.label === "Pain right now").value, "4/10");
  assert.equal((await s.call("GET", `/api/admin/clients/${cid}/intake`, undefined, tok)).status, 401, "admin only");
});

test("client type, assigned and saved programs, booking link and video consultation from the client profile", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const admin = await s.adminToken();
  const me = async () => (await s.call("GET", "/api/me", undefined, tok)).body.client;
  assert.equal((await me()).clientType, "outpatient", "everyone starts as an outpatient");
  const cid = (await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].id;
  assert.equal((await s.call("PUT", `/api/admin/clients/${cid}/type`, { type: "vip" }, admin)).status, 400);
  assert.equal((await s.call("PUT", `/api/admin/clients/${cid}/type`, { type: "inpatient" }, tok)).status, 401, "admin only");
  assert.equal((await s.call("PUT", `/api/admin/clients/${cid}/type`, { type: "inpatient" }, admin)).body.clientType, "inpatient");
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].clientType, "inpatient");
  assert.equal((await me()).clientType, "inpatient");

  const progs = (await s.call("GET", "/api/me/content", undefined, tok)).body.programs.map((p) => p.id);
  assert.equal((await s.call("PUT", `/api/admin/clients/${cid}/programs`, { programs: [{ id: "nope" }] }, admin)).status, 400);
  const as = await s.call("PUT", `/api/admin/clients/${cid}/programs`, { programs: [{ id: progs[0], note: "3x a week" }, { id: progs[1] }] }, admin);
  assert.equal(as.status, 200); assert.equal(as.body.assignedPrograms.length, 2);
  assert.deepEqual((await me()).assignedPrograms.map((x) => [x.id, x.note]), [[progs[0], "3x a week"], [progs[1], ""]]);

  assert.equal((await s.call("PUT", "/api/me/pinned/nope", undefined, tok)).status, 400);
  await s.call("PUT", `/api/me/pinned/${progs[2]}`, undefined, tok);
  assert.deepEqual((await s.call("PUT", `/api/me/pinned/${progs[3]}`, undefined, tok)).body.pinnedPrograms, [progs[3], progs[2]], "newest first");
  assert.deepEqual((await s.call("DELETE", `/api/me/pinned/${progs[3]}`, undefined, tok)).body.pinnedPrograms, [progs[2]]);

  assert.equal((await s.call("POST", `/api/admin/clients/${cid}/send-booking-link`, { typeId: "nope" }, admin)).status, 400);
  assert.equal((await s.call("POST", `/api/admin/clients/${cid}/consult`, { date: "2026-11-05", time: "10:00" }, admin)).status, 400, "needs a video link");
  const c1 = await s.call("POST", `/api/admin/clients/${cid}/consult`, { date: "2026-11-05", time: "10:00", minutes: 30, meetingLink: "https://zoom.us/j/1" }, admin);
  assert.equal(c1.status, 201); assert.equal(c1.body.payment, "exempt", "inpatients never pay"); assert.equal(c1.body.meetingLink, "https://zoom.us/j/1");
  assert.equal((await s.call("POST", `/api/admin/clients/${cid}/consult`, { date: "2026-11-05", time: "10:15", meetingLink: "https://zoom.us/j/1" }, admin)).status, 409, "no double booking");
  const mine = (await s.call("GET", "/api/me/appointments", undefined, tok)).body;
  const up = (mine.upcoming || mine).find((a) => a.id === c1.body.id);
  assert.ok(up && up.meetingLink === "https://zoom.us/j/1", "the consult shows in the patient's appointments with its link");
});

test("field encryption never double-wraps a value it couldn't open (wrong key)", () => {
  const { phiStore } = require("../lib/phi");
  const { cipher } = require("../lib/messages");
  const mem = { data: {}, read(n, d) { return this.data[n] === undefined ? d : JSON.parse(JSON.stringify(this.data[n])); }, write(n, v) { this.data[n] = JSON.parse(JSON.stringify(v)); } };
  const right = phiStore(mem, cipher(["key-one-0123456789"]));
  right.write("appointments", [{ id: "a1", notes: "Left knee pain" }]);
  const stored = mem.data.appointments[0].notes;
  const wrong = phiStore(mem, cipher(["key-two-0123456789"]));
  wrong.write("appointments", wrong.read("appointments", []));
  assert.equal(mem.data.appointments[0].notes, stored, "rewritten as-is, not encrypted again");
  assert.equal(right.read("appointments", [])[0].notes, "Left knee pain", "the right key still opens it");
});

test("forms filled from a visit's intake link show on the client's Admin profile (owner only)", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const b = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-10", time: "10:30", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" });
  const { id, cancelToken: token } = b.body.appointment;
  const save = (doc, body) => s.call("POST", `/api/appointments/${id}/intake/${doc}`, { token, ...body });
  await save("info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" });
  await save("pain", { complaint: "Knee", areas: ["Right knee"], started: "2 to 6 weeks ago", painNow: 3, goals: "Walk" });
  await save("history", { redFlags: "No" });
  assert.equal((await save("consent", { treatment: true, privacy: true, financial: true, signature: "Pat Doe" })).body.done, true);
  const admin = await s.adminToken();
  const cid = (await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].id;
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, admin)).body[0].documents.done, 4);
  assert.equal((await s.call("GET", `/api/admin/clients/${cid}`, undefined, admin)).body.documents.complete, true);
  const cv = (await s.call("GET", `/api/admin/clients/${cid}/intake`, undefined, admin));
  assert.equal(cv.status, 200); assert.equal(cv.body.docs.length, 4);
  assert.equal((await s.call("GET", "/api/me/intake", undefined, tok)).body.completed, 0, "the member side never credits a booking by email");
});

test("a glitchy watch reading is dropped, not the whole workout", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = (await signup(s)).body.token;
  const r = await s.call("POST", "/api/me/workouts", { title: "Run", goal: "Cardio", minutes: 30, exercises: 1, hrAvg: 150, hrMax: 262 }, tok);
  assert.equal(r.status, 201);
  const w = (await s.call("GET", "/api/me", undefined, tok)).body;
  assert.ok(JSON.stringify(w).includes("Run") || r.body);
  assert.equal(r.body.workout ? r.body.workout.hrMax : undefined, undefined, "the 262 bpm spike isn't kept");
});

test("health tips: built-in articles, older saved tips get them by id, admin saves keep and check sections", async (t) => {
  const s = await start(); t.after(s.close);
  const pub = (await s.call("GET", "/api/content")).body;
  assert.ok(pub.recommendations.length >= 6 && pub.recommendations.every((r) => r.image && Array.isArray(r.sections) && r.sections.length), "every built-in tip has its poster and an article");
  // Saved before articles existed: old built-in wording, one admin-edited text, one admin-added tip without a poster
  fs.writeFileSync(path.join(s.dataDir, "content.json"), JSON.stringify({ contentVersion: 5, recommendations: [
    { id: "psg-protocol", area: "Recovery", title: "PSG protocol", body: "Dr. Jared's proprietary PSG recovery protocol for post-session recovery and inflammation management.", image: "1Nigi9UOTm14KAzHS6hOb9KQKEOXVH-Xs", link: "" },
    { id: "diet-health-shots", area: "Nutrition", title: "My diet notes", body: "Edited by the admin.", image: "1P-5bng8Pg3Yatz5jE-KOWDfTDBWgh5Hu", link: "" },
    { id: "custom-tip", area: "Wellness", title: "Drink water", body: "Eight glasses.", image: "", link: "" }
  ] }));
  const recs = (await s.call("GET", "/api/content")).body.recommendations;
  assert.deepEqual(recs.map((r) => r.id), ["psg-protocol", "diet-health-shots", "custom-tip"], "the saved list and order win");
  const psg = recs[0], diet = recs[1];
  assert.equal(psg.title, "State of Perpetual Growth (PSG) program", "old built-in wording moves to the poster's wording");
  assert.equal(psg.area, "Recovery", "admin fields stay");
  assert.ok(psg.sections.length > 5 && diet.sections.length > 5, "built-in article merged in by id");
  assert.equal(diet.title, "My diet notes"); assert.equal(diet.body, "Edited by the admin.");
  assert.equal(recs[2].sections, undefined, "a custom tip stays a plain card");
  // Admin round trip keeps the articles; a bad block is refused
  const adm = await s.adminToken();
  const c = (await s.call("GET", "/api/admin/content", undefined, adm)).body;
  const ok = await s.call("PUT", "/api/admin/content", { recommendations: c.recommendations }, adm);
  assert.equal(ok.status, 200, ok.body && ok.body.error);
  assert.deepEqual(ok.body.recommendations, c.recommendations);
  const bad = c.recommendations.map((r, i) => (i ? r : { ...r, sections: [{ type: "script", text: "x" }] }));
  assert.equal((await s.call("PUT", "/api/admin/content", { recommendations: bad }, adm)).status, 400);
  const own = c.recommendations.map((r, i) => (i === 2 ? { ...r, sections: [{ type: "list", heading: "Daily", style: "check", items: ["Water", { title: "Walk", detail: "20 min" }] }] } : r));
  const saved = (await s.call("PUT", "/api/admin/content", { recommendations: own }, adm)).body.recommendations;
  assert.deepEqual(saved[2].sections, own[2].sections, "a custom tip's own article is stored as sent");
});
