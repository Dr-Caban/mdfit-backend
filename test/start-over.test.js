"use strict";
// Start over (Profile, behind the password): the tutorial and the road begin again; history and XP stay.
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

async function boot(t) {
  let now = new Date("2026-11-02T15:00:00Z");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => now }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = { token: "", dataDir, tick: (ms) => { now = new Date(now.getTime() + ms); } };
  s.call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(s.token ? { authorization: "Bearer " + s.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return s;
}

test("start over: wrong password changes nothing; the right one resets the tutorial and the road and keeps history and XP", async (t) => {
  const s = await boot(t), { call } = s;
  s.token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  // a member some way along: answers, a program on the road, a track, a check-in, a workout, stops credited
  await call("PUT", "/api/me/about", { athlete: "comp", aim: "pain" });
  await call("PUT", "/api/me/about/plan", { program: "plantar-4", start: "2026-11-02" });
  await call("PUT", "/api/me/about/tracks/track-scalenes");
  await call("POST", "/api/me/pain", { area: "Knee", level: 3 });
  await call("POST", "/api/me/workouts", { title: "Upper Body", minutes: 20, exercises: 6 });
  for (const ref of ["solomon", "know", "pain", "session"]) assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref })).status, 200);
  const xpBefore = (await call("GET", "/api/me/rewards")).body.xp;
  assert.ok(xpBefore >= 40);

  const wrong = await call("POST", "/api/me/start-over", { password: "not-it" });
  assert.equal(wrong.status, 403, "403, not 401: the app would sign the member out on a 401");
  assert.equal((await call("GET", "/api/me/about")).body.about.aim, "pain", "a wrong password changes nothing");

  s.tick(60 * 1000);
  const ok = await call("POST", "/api/me/start-over", { password: "test-pass-123" });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.values(ok.body.intro.steps), [false, false, false, false, false, false], "every stop is to do again");
  assert.equal(ok.body.intro.offered, true, "the first descent is offered again, history or not");
  const about = (await call("GET", "/api/me/about")).body;
  assert.ok(!about.about.at && !about.about.aim && !about.about.athlete && !about.about.known, "the get-to-know-you answers are gone");
  assert.equal(about.plan, null); assert.deepEqual(about.tracks, []); assert.deepEqual(about.skips, []);
  // kept
  assert.equal((await call("GET", "/api/me/workouts")).body.length, 1, "workout history kept");
  assert.equal((await call("GET", "/api/me/pain")).body.length, 1, "pain history kept");
  assert.equal((await call("GET", "/api/me/rewards")).body.xp, xpBefore, "XP kept");

  // old history does not tick the stops back on
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "pain" })).status, 409, "the old check-in is not this time round's");
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "session" })).status, 409, "nor the old workout");
  // done again: ticked, but no XP twice for a stop already paid
  s.tick(60 * 1000);
  await call("POST", "/api/me/pain", { area: "Knee", level: 2 });
  const again = await call("POST", "/api/me/xp", { kind: "intro", ref: "pain" });
  assert.equal(again.status, 200); assert.equal(again.body.first, true); assert.equal(again.body.xp, 0);
  assert.equal(again.body.intro.steps.pain, true);
  // a stop never paid before still pays
  const friend = await call("POST", "/api/me/xp", { kind: "intro", ref: "friend" });
  assert.equal(friend.body.xp, 10); assert.equal(friend.body.intro.steps.friend, true);
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "friend" })).body.first, false, "once");
  // the program stop needs a road picked again (the old plan was cleared)
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "program" })).status, 409);
  await call("PUT", "/api/me/about/plan", { program: "plantar-4", start: "2026-11-02" });
  assert.equal((await call("POST", "/api/me/xp", { kind: "intro", ref: "program" })).status, 200);
});

test("start over: an account with no password types RESET; tries are limited", async (t) => {
  const s = await boot(t), { call } = s;
  s.token = (await call("POST", "/api/clients/signup", { name: "Lee Roe", email: "lee@example.com", phone: "941-555-0101", password: "test-pass-123" })).body.token;
  const file = path.join(s.dataDir, "clients.json"), all = JSON.parse(fs.readFileSync(file, "utf8"));
  const me = all.find((c) => c.email === "lee@example.com"); delete me.passwordHash; fs.writeFileSync(file, JSON.stringify(all)); // as a Google or Apple account
  assert.equal((await call("POST", "/api/me/start-over", {})).status, 400);
  assert.equal((await call("POST", "/api/me/start-over", { confirm: "reset" })).status, 200);
  // a password account: ten wrong tries an hour, then refused even with the right one
  s.token = (await call("POST", "/api/clients/signup", { name: "Kim Poe", email: "kim@example.com", phone: "941-555-0102", password: "test-pass-123" })).body.token;
  for (let i = 0; i < 10; i++) assert.equal((await call("POST", "/api/me/start-over", { password: "guess-" + i })).status, 403);
  assert.equal((await call("POST", "/api/me/start-over", { password: "test-pass-123" })).status, 429);
});
