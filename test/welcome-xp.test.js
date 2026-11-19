"use strict";
// "Welcome back": the first time a member opens the app each clinic day earns 5 XP, and the server says it was the
// first, so the app celebrates it once (one device) and never twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { rewards } = require("../lib/rewards");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

test("welcome back: +5 XP once a day, flagged first only the first time", async (t) => {
  let now = new Date("2026-11-02T15:00:00Z");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => now }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  const xpToday = async () => (await call("GET", "/api/me/rewards")).body.todayXp;
  const before = await xpToday();
  const first = await call("POST", "/api/me/xp", { kind: "open" });
  assert.equal(first.status, 200); assert.equal(first.body.first, true); assert.equal(first.body.xp, 5);
  assert.equal(await xpToday(), before + 5);
  const again = await call("POST", "/api/me/xp", { kind: "open" });
  assert.equal(again.body.first, false, "a second device or a reopen doesn't celebrate again");
  assert.equal(await xpToday(), before + 5, "and earns nothing more");
});

test("arrival: the first opening of a day says how long they were away and whether it is earlier than they usually train", async (t) => {
  let now = new Date("2026-11-02T15:00:00Z");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => now }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  const open = async () => (await call("POST", "/api/me/xp", { kind: "open" })).body;
  const a = await open();
  assert.deepEqual(a.arrive, { away: null, usual: null, hour: 10 }, "a brand-new member has no day to have missed");
  assert.equal((await open()).arrive, undefined, "only the first opening of the day carries it");
  now = new Date("2026-11-03T15:00:00Z"); assert.equal((await open()).arrive.away, 1, "here yesterday");
  now = new Date("2026-11-05T15:00:00Z"); assert.equal((await open()).arrive.away, 2, "missed a day");
  // Three sessions at about 5 PM: an opening at 7 AM is earlier than usual
  const f = path.join(dataDir, "clients.json"), all = JSON.parse(fs.readFileSync(f, "utf8")), me = all.find((c) => c.email === "pat@example.com");
  me.workouts = ["2026-11-06", "2026-11-07", "2026-11-08"].map((d, i) => ({ id: "w" + i, date: d, title: "Session", minutes: 20, exercises: 4, completedAt: d + "T22:1" + i + ":00Z" }));
  fs.writeFileSync(f, JSON.stringify(all));
  now = new Date("2026-11-09T12:00:00Z");
  assert.deepEqual((await open()).arrive, { away: 1, usual: 17, hour: 7 });
  now = new Date("2026-11-20T12:00:00Z"); assert.equal((await open()).arrive.away, 11, "back after a while");
});

test("welcome back counts once per day in the XP total", () => {
  const r = rewards({ actions: [{ date: "2026-11-02", kind: "open" }, { date: "2026-11-02", kind: "open" }, { date: "2026-11-03", kind: "open" }] }, "2026-11-03");
  assert.equal(r.xp >= 10, true);
  assert.equal(r.todayXp, 5);
});

test("first descent: six stops, 10 XP each once ever, the checkable ones must be true, skip and replay", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => new Date("2026-11-02T15:00:00Z") }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  const xp = async () => (await call("GET", "/api/me/rewards")).body.xp;
  let i = (await call("GET", "/api/me/intro")).body;
  assert.equal(i.offered, true); assert.equal(i.done, false); assert.deepEqual(Object.keys(i.steps), ["solomon", "know", "pain", "program", "session", "friend"]); assert.deepEqual(Object.values(i.steps), [false, false, false, false, false, false]);
  const start = await xp();
  const a = await call("POST", "/api/me/xp", { kind: "intro", ref: "solomon" });
  assert.equal(a.body.first, true); assert.equal(a.body.xp, 10); assert.equal(a.body.intro.steps.solomon, true);
  assert.equal(await xp(), start + 10);
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "solomon" })).body.first, false, "once ever");
  assert.equal(await xp(), start + 10);
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "session" })).status, 409, "no workout logged yet");
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "nope" })).status, 400);
  await call("POST", "/api/me/workouts", { title: "First", minutes: 20, exercises: 4 });
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "session" })).body.first, true);
  assert.equal((await call("GET", "/api/me/intro")).body.offered, true, "started, so still offered with a workout logged");
  // One stop passed over: no XP, the road can still finish, and doing it later still pays
  const before = await xp();
  const passed = (await call("POST", "/api/me/intro/skip", { ref: "program" })).body;
  assert.equal(passed.steps.program, "skipped"); assert.equal(passed.offered, true); assert.equal(await xp(), before);
  await call("POST", "/api/me/intro/skip", { ref: "pain" }); await call("POST", "/api/me/intro/skip", { ref: "friend" }); await call("POST", "/api/me/intro/skip", { ref: "know" });
  assert.equal((await call("GET", "/api/me/intro")).body.done, true, "every stop done or passed: finished");
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "friend" })).body.xp, 10, "a passed stop still pays when it is done later");
  assert.equal((await call("POST", "/api/me/intro/skip", { skip: true })).body.offered, false);
  assert.equal((await call("POST", "/api/me/intro/skip", { skip: false })).body.offered, true, "replay");
});

test("first descent is not pushed on a member who already trains", () => {
  const r = rewards({ actions: [{ date: "2026-11-02", kind: "intro", ref: "solomon" }, { date: "2026-11-02", kind: "intro", ref: "pain" }] }, "2026-11-02");
  assert.equal(r.xp, 20);
});

test("let me get to know you: history and goal on the account, choices only, and the pain tracks on the road", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => new Date("2026-11-02T15:00:00Z") }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  assert.equal((await call("GET", "/api/me/about")).status, 401);
  token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  const empty = (await call("GET", "/api/me/about")).body;
  assert.equal(empty.about.known, false); assert.deepEqual(empty.about.foods, []); assert.equal(empty.about.aim, ""); assert.deepEqual(empty.tracks, []);
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "know" })).status, 409, "the stop needs the conversation to have happened");
  for (const bad of [{ aim: "world domination" }, { foods: "meat" }, { foods: ["meat", "my own text"] }, { athlete: 3 }, { competitive: 11 }, { competitive: "very" }, { sports: ["quidditch"] }]) assert.equal((await call("PUT", "/api/me/about", bad)).status, 400, JSON.stringify(bad));
  const saved = (await call("PUT", "/api/me/about", { athlete: "comp", sports: ["cheer", "chess"], competitive: 8, foods: ["seafood", "homecooked", "seafood"], diet: "protein", free: ["outdoors", "family"], aim: "stronger" })).body;
  assert.equal(saved.about.known, true); assert.equal(saved.about.aim, "stronger"); assert.deepEqual(saved.about.sports, ["cheer", "chess"]); assert.equal(saved.about.competitive, 8); assert.deepEqual(saved.about.foods, ["seafood", "homecooked"], "the same choice twice is one");
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "know" })).body.xp, 10);
  // one answer changed later keeps the rest; a question left out ("") is allowed
  const again = (await call("PUT", "/api/me/about", { aim: "pain", diet: "" })).body.about;
  assert.equal(again.aim, "pain"); assert.equal(again.diet, ""); assert.equal(again.athlete, "comp");
  // pain tracks on the road: on the account, newest last, no doubles
  assert.equal((await call("PUT", "/api/me/about/tracks/Not%20An%20Id")).status, 400);
  await call("PUT", "/api/me/about/tracks/supraspinatus"); await call("PUT", "/api/me/about/tracks/scalene-chest");
  assert.deepEqual((await call("PUT", "/api/me/about/tracks/supraspinatus")).body.tracks, ["scalene-chest", "supraspinatus"]);
  assert.deepEqual((await call("DELETE", "/api/me/about/tracks/scalene-chest")).body.tracks, ["supraspinatus"]);
  assert.deepEqual((await call("GET", "/api/me/about")).body.tracks, ["supraspinatus"]);
  // the program on the road and its start date
  assert.equal((await call("GET", "/api/me/about")).body.plan, null);
  for (const bad of [{ program: "knee-6", start: "next monday" }, { program: "knee-6", start: "2027-06-01" }, { program: "Bad Id", start: "2026-11-03" }]) assert.equal((await call("PUT", "/api/me/about/plan", bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call("PUT", "/api/me/about/plan", { program: "knee-6", start: "2026-11-09" })).body.plan, { program: "knee-6", start: "2026-11-09" });
  assert.deepEqual((await call("GET", "/api/me/about")).body.plan, { program: "knee-6", start: "2026-11-09" });
  // skipping today's session: today only, on the account, and it can be taken back
  assert.deepEqual((await call("GET", "/api/me/about")).body.skips, []);
  assert.equal((await call("PUT", "/api/me/about/skip/2026-11-01")).status, 400, "not yesterday's");
  assert.deepEqual((await call("PUT", "/api/me/about/skip/2026-11-02")).body.skips, ["2026-11-02"]);
  assert.deepEqual((await call("PUT", "/api/me/about/skip/2026-11-02")).body.skips, ["2026-11-02"], "once");
  assert.deepEqual((await call("DELETE", "/api/me/about/skip/2026-11-02")).body.skips, []);
});
