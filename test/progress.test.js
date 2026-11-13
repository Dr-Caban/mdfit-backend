// Progress report (lib/progress.js): one calculation for the member's "My progress" and the workspace's view of the
// same member. Free accounts see 30 days; full access (membership, active treatment plan, inpatient) sees 365, and the
// workspace always sees 365. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { report } = require("../lib/progress");
const { programProgress, workoutStats } = require("../lib/clients");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-progress-"));
  const clock = { now: new Date("2026-11-12T15:00:00Z") }; // Thursday Nov 12, 10:00 AM at the clinic (New York)
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://site.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const at = (iso) => { clock.now = new Date(iso); };
  const clientsFile = path.join(dataDir, "clients.json");
  const edit = (id, fn) => { const list = JSON.parse(fs.readFileSync(clientsFile, "utf8")); fn(list.find((c) => c.id === id)); fs.writeFileSync(clientsFile, JSON.stringify(list)); };
  return { call, adminToken, signup, at, edit, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("progress: the shape, and the member and the workspace see the same numbers", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), z = await s.signup("Zed Quillon"), T = z.token, id = z.client.id;
  // Workouts on Fri Oct 30, Sun Nov 1 (same Monday-week as Oct 30) and Mon Nov 2 (the next week)
  for (const [day, mins] of [["2026-10-30T15:00:00Z", 20], ["2026-11-01T15:00:00Z", 30], ["2026-11-02T15:00:00Z", 45]]) {
    s.at(day); assert.equal((await s.call("POST", "/api/me/workouts", { title: "Made-up workout", minutes: mins }, T)).status, 201);
  }
  s.at("2026-11-12T15:00:00Z");
  for (const [date, area, level] of [["2026-11-01", "Knee", 7], ["2026-11-05", "Knee", 5], ["2026-11-10", "Knee", 3], ["2026-11-09", "Lower back", 4]])
    assert.equal((await s.call("POST", "/api/me/pain", { date, area, level }, T)).status, 201);
  assert.equal((await s.call("POST", "/api/me/vitals", { date: "2026-11-03", weight: 180.5, sleep: 7.5 }, T)).status < 300, true);
  assert.equal((await s.call("POST", "/api/me/vitals", { date: "2026-11-10", weight: 179 }, T)).status < 300, true);

  const r = await s.call("GET", "/api/me/progress?days=30", undefined, T);
  assert.equal(r.status, 200);
  const p = r.body;
  assert.deepEqual(Object.keys(p).sort(), ["headline", "pain", "programs", "range", "vitals", "weeks"]);
  assert.deepEqual(p.range, { days: 30, from: "2026-10-14", to: "2026-11-12", maxDays: 30, member: false, capped: false });
  assert.deepEqual(Object.keys(p.headline).sort(), ["activeDays30", "painChange", "streak", "workoutsThisMonth"]);
  assert.equal(p.headline.workoutsThisMonth, 2, "Nov 1 and Nov 2");
  assert.equal(typeof p.headline.streak, "number");
  assert.ok(p.headline.activeDays30 >= 6, "workout and check-in days are active");
  // Weeks start on Monday, oldest first, and cover the range: Oct 26 holds Oct 30 + Nov 1, Nov 2 holds Nov 2
  assert.equal(p.weeks[0].week, "2026-10-12"); assert.equal(p.weeks[p.weeks.length - 1].week, "2026-11-09");
  for (const w of p.weeks) assert.equal(new Date(w.week + "T12:00:00Z").getUTCDay(), 1, w.week + " is a Monday");
  const wk = (d) => p.weeks.find((w) => w.week === d);
  assert.deepEqual([wk("2026-10-26").workouts, wk("2026-10-26").minutes], [2, 50], "across the month boundary");
  assert.deepEqual([wk("2026-11-02").workouts, wk("2026-11-02").minutes], [1, 45]);
  // Pain: most-logged area first, points in date order; knee went 7 -> 3, so the change is negative (better)
  assert.deepEqual(p.pain.areas.map((a) => a.area), ["Knee", "Lower back"]);
  assert.deepEqual(p.pain.areas[0].points, [{ date: "2026-11-01", level: 7 }, { date: "2026-11-05", level: 5 }, { date: "2026-11-10", level: 3 }]);
  assert.deepEqual(p.headline.painChange, { area: "Knee", first: 7, last: 3, delta: -4 });
  // Vitals: only what was logged (no resting heart rate here)
  assert.deepEqual(p.vitals, { weight: [{ date: "2026-11-03", value: 180.5 }, { date: "2026-11-10", value: 179 }], sleep: [{ date: "2026-11-03", value: 7.5 }] });
  assert.deepEqual(p.programs, []);
  // The workspace sees the same report for the same range
  const a = await s.call("GET", `/api/admin/clients/${id}/progress?days=30`, undefined, A);
  assert.equal(a.status, 200);
  assert.deepEqual({ ...a.body, range: { ...a.body.range, maxDays: 30 } }, p, "same numbers both sides");
  assert.equal(a.body.range.maxDays, 365);
});

test("progress: free accounts see 30 days; a membership, an active treatment plan or inpatient sees 365; the workspace always 365", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), z = await s.signup("Ivy Ondrake"), T = z.token, id = z.client.id;
  const mine = async (q = "") => (await s.call("GET", "/api/me/progress" + q, undefined, T)).body.range;
  let r = await mine();
  assert.deepEqual([r.days, r.maxDays, r.member, r.capped], [30, 30, false, true], "asked for the default 90, capped at 30");
  r = await mine("?days=14"); assert.deepEqual([r.days, r.capped], [14, false]);
  r = (await s.call("GET", `/api/admin/clients/${id}/progress?days=200`, undefined, A)).body.range;
  assert.deepEqual([r.days, r.maxDays, r.member, r.capped], [200, 365, false, false], "the workspace sees the whole range");
  // Membership
  assert.equal((await s.call("PUT", `/api/admin/clients/${id}/membership`, { tier: "member", until: "2027-01-01" }, A)).status, 200);
  r = await mine("?days=200"); assert.deepEqual([r.days, r.maxDays, r.member, r.capped], [200, 365, true, false]);
  r = await mine("?days=900"); assert.deepEqual([r.days, r.capped], [365, true]);
  assert.equal((await s.call("PUT", `/api/admin/clients/${id}/membership`, { tier: "" }, A)).status, 200);
  assert.equal((await mine("?days=200")).maxDays, 30, "membership removed");
  // Active paid treatment plan
  s.edit(id, (c) => { c.protocols = [{ id: "pr1", status: "active" }]; });
  assert.deepEqual([(await mine("?days=200")).maxDays, (await mine()).member], [365, true]);
  s.edit(id, (c) => { c.protocols = [{ id: "pr1", status: "paid" }]; });
  assert.equal((await mine("?days=200")).maxDays, 30, "a finished plan is not full access");
  // Inpatient, toggled through the workspace's own route: 30 <-> 365
  assert.equal((await s.call("PUT", `/api/admin/clients/${id}/type`, { type: "inpatient" }, A)).status, 200);
  r = await mine("?days=200"); assert.deepEqual([r.days, r.maxDays, r.member], [200, 365, true]);
  assert.equal((await s.call("PUT", `/api/admin/clients/${id}/type`, { type: "outpatient" }, A)).status, 200);
  r = await mine("?days=200"); assert.deepEqual([r.days, r.maxDays, r.member, r.capped], [30, 30, false, true]);
});

test("progress: programs are labeled Recommended (assigned) and Saved (pinned) with done, total and percent", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), z = await s.signup("Lou Marchetti"), T = z.token, id = z.client.id;
  const content = (await s.call("GET", "/api/content")).body.programs;
  const dayProg = content.find((p) => Array.isArray(p.days) && p.days.length && !(Array.isArray(p.perWeek) && p.perWeek.length));
  const other = content.find((p) => p.id !== dayProg.id);
  assert.equal((await s.call("PUT", `/api/admin/clients/${id}/programs`, { programs: [{ id: dayProg.id }] }, A)).status, 200);
  assert.equal((await s.call("PUT", `/api/me/pinned/${other.id}`, undefined, T)).status, 200);
  assert.equal((await s.call("PUT", `/api/me/pinned/${dayProg.id}`, undefined, T)).status, 200, "pinned and assigned: listed once, as Recommended");
  await s.call("POST", "/api/me/workouts", { title: "Day 1", minutes: 30, key: `prog-${dayProg.id}-d0` }, T);
  const p = (await s.call("GET", "/api/me/progress", undefined, T)).body.programs;
  assert.deepEqual(p.map((x) => [x.id, x.label]), [[dayProg.id, "Recommended"], [other.id, "Saved"]]);
  const total = dayProg.weeks * dayProg.days.length;
  assert.deepEqual(p[0], { id: dayProg.id, title: dayProg.title, label: "Recommended", done: 1, total, pct: Math.round(100 / total) });
  assert.equal(p[1].done, 0); assert.equal(p[1].pct, 0);
});

test("progress: pure calculation edge cases (week-by-week protocols, empty data, unknown programs)", () => {
  const base = { today: "2026-11-12", days: 30, maxDays: 30, member: false, programProgress, workoutStats, habits: null };
  const empty = report({ id: "x" }, { ...base, programs: [] });
  assert.equal(empty.headline.painChange, null); assert.equal(empty.headline.streak, 0); assert.deepEqual(empty.vitals, {}); assert.deepEqual(empty.pain.areas, []);
  assert.ok(empty.weeks.every((w) => w.workouts === 0 && w.activeDays === 0));
  const proto = { id: "hip-proto", title: "Hip protocol", weeks: 12, days: [{}] };
  const c = { id: "y", assignedPrograms: [{ id: "hip-proto" }, { id: "gone" }], pinnedPrograms: ["gone-too"],
    workouts: [{ date: "2026-11-02", minutes: 10, key: "prog-hip-proto-w1" }, { date: "2026-11-09", minutes: 10, key: "prog-hip-proto-w2" }, { date: "2026-11-10", minutes: 10, key: "prog-hip-proto-w2" }],
    painLog: [{ date: "2026-11-01", area: "hip", level: 2 }, { date: "2026-11-11", area: "hip", level: 6 }, { date: "2026-09-01", area: "hip", level: 9 }] };
  const r = report(c, { ...base, programs: [proto] });
  assert.deepEqual(r.programs, [{ id: "hip-proto", title: "Hip protocol", label: "Recommended", done: 2, total: 12, pct: 17 }], "weeks started of 12; unknown ids left out");
  assert.deepEqual(r.headline.painChange, { area: "hip", first: 2, last: 6, delta: 4 }, "worse is positive; an entry outside the range is ignored");
  assert.equal(r.headline.streak, 0, "no workout today or yesterday... Nov 10 is two days before Nov 12");
});

test("progress: sign-in required on both routes; an unknown client is 404", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), z = await s.signup("Kai Brennholt");
  assert.equal((await s.call("GET", "/api/me/progress")).status, 401);
  assert.equal((await s.call("GET", `/api/admin/clients/${z.client.id}/progress`)).status, 401);
  assert.equal((await s.call("GET", `/api/admin/clients/${z.client.id}/progress`, undefined, z.token)).status, 401, "a member token is not a workspace sign-in");
  assert.equal((await s.call("GET", "/api/admin/clients/nobody-here/progress", undefined, A)).status, 404);
});
