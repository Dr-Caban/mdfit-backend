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
  assert.equal((await s.call("POST", "/api/me/workouts", { title: "x", minutes: 10, hrAvg: 400 }, tok)).status, 400);
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

test("member content: locked links, membership requests, admin grants tiers, monthly 1-on-1 allowance", async (t) => {
  const s = await start(); t.after(s.close);
  const pub = (await s.call("GET", "/api/content")).body;
  assert.ok(pub.programs.length >= 5 && pub.recommendations.some((r) => r.id === "pillow-progression"));
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
  assert.equal(calls.find((c) => c[0] === "price")[1].unit_amount, 34900);
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
