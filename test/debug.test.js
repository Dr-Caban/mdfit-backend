// Regression tests for bugs fixed on fix/debug (consultations, booking races, video links, PHI fields).
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

// Monday 2026-11-02, 05:00 in Sarasota. A stand-in calendar sync: busy() returns whatever the test sets.
function fakeCalsync() {
  const f = { blocks: [], busyCalls: 0, added: [], onBusy: null,
    async busy() { f.busyCalls++; if (f.onBusy) await f.onBusy(); return f.blocks; },
    addBooking(a) { f.added.push(a); }, removeBooking() {}, status: () => ({}), googleOn: () => false, clear() {} };
  return f;
}
async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-d-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("admin video consultation: no past times, and Google Calendar / SimplePractice busy blocks count as overlaps", async (t) => {
  const calsync = fakeCalsync();
  const s = await start({ calsync }); t.after(s.close);
  const admin = await s.adminToken();
  const c = (await s.call("POST", "/api/clients/signup", { name: "Josh Lerner", email: "josh@example.com", phone: "941-555-0123", password: "member-pass-123" })).body.client;
  const consult = (body) => s.call("POST", `/api/admin/clients/${c.id}/consult`, { minutes: 30, meetingLink: "https://zoom.us/j/1", ...body }, admin);
  assert.equal((await consult({ date: "2026-11-01", time: "10:00" })).status, 400, "yesterday");
  assert.equal((await consult({ date: "2026-11-02", time: "04:30" })).status, 400, "earlier today");
  // 2 PM to 3 PM Eastern on Wednesday is busy on Dr. Jared's calendar
  calsync.blocks = [{ start: new Date("2026-11-04T19:00:00Z"), end: new Date("2026-11-04T20:00:00Z") }];
  const clash = await consult({ date: "2026-11-04", time: "14:30" });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /calendar/);
  assert.equal((await consult({ date: "2026-11-04", time: "13:30" })).status, 201, "ends as the busy block starts");
  assert.equal((await consult({ date: "2026-11-02", time: "18:00" })).status, 201, "later today is fine");
});

test("booking race: while the calendar is read, a reward code can't be used twice and new reviews aren't lost", async (t) => {
  const calsync = fakeCalsync();
  const s = await start({ calsync }); t.after(s.close);
  const code = (await s.call("POST", "/api/feedback", { name: "Hana Hill", email: "hana@example.com", rating: 5, text: "My shoulder finally feels normal again.", publish: true })).body.rewardCode;
  const day = (await s.call("GET", "/api/availability?type=plan-review&days=14")).body.days.find((d) => d.slots.length > 2);
  const book = (time, email) => s.call("POST", "/api/appointments", { typeId: "plan-review", date: day.date, time, name: "Hana Hill", email, phone: "941-555-0101", rewardCode: code });
  // Both requests wait on the calendar at the same time; a third person leaves a review meanwhile
  let n = 0;
  calsync.onBusy = async () => { if (++n === 1) await s.call("POST", "/api/feedback", { name: "Lou Low", email: "lou@example.com", rating: 4, text: "Good sessions, thank you.", publish: false }); await new Promise((r) => setTimeout(r, 50)); };
  const r = await Promise.all([book(day.slots[0], "hana@example.com"), book(day.slots[2], "hana2@example.com")]);
  assert.deepEqual(r.map((x) => x.status).sort(), [201, 409]);
  calsync.onBusy = null;
  const admin = await s.adminToken();
  assert.deepEqual((await s.call("GET", "/api/admin/feedback", undefined, admin)).body.map((f) => f.name).sort(), ["Hana Hill", "Lou Low"]);
  // the same slot booked twice at once: one wins
  calsync.onBusy = () => new Promise((r2) => setTimeout(r2, 50));
  const both = await Promise.all(["a", "b"].map((x) => s.call("POST", "/api/appointments", { typeId: "session", date: day.date, time: "15:00", name: "Sam Lee", email: `${x}@example.com`, phone: "941-555-0177" })));
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 409]);
});

test("a program note Dr. Jared writes for a client is encrypted at rest and reads back as written", async (t) => {
  const s = await start(); t.after(s.close);
  const admin = await s.adminToken();
  const su = (await s.call("POST", "/api/clients/signup", { name: "Josh Lerner", email: "josh@example.com", phone: "941-555-0123", password: "member-pass-123" })).body;
  const pid = (await s.call("GET", "/api/me/content", undefined, su.token)).body.programs[0].id;
  assert.equal((await s.call("PUT", `/api/admin/clients/${su.client.id}/programs`, { programs: [{ id: pid, note: "Go easy on the torn meniscus" }] }, admin)).status, 200);
  const raw = fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8");
  assert.ok(!raw.includes("torn meniscus"), "not stored in plain text");
  assert.equal((await s.call("GET", "/api/me", undefined, su.token)).body.client.assignedPrograms[0].note, "Go easy on the torn meniscus");
});
