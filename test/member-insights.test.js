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
