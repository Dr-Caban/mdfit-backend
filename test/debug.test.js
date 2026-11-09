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

test("Admin calendar busy blocks: Google and SimplePractice times, MD Fit's own Google copies left out, admin only", async (t) => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createApp } = require("../server");
  const { hashPassword } = require("../lib/auth");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-busy-"));
  // 10:00-11:00 and 14:00-15:00 clinic time on Nov 10 (EST = UTC-5), plus an all-day event on Nov 11
  const busy = [
    { start: new Date("2026-11-10T15:00:00Z"), end: new Date("2026-11-10T16:00:00Z"), source: "google" },
    { start: new Date("2026-11-10T19:00:00Z"), end: new Date("2026-11-10T20:00:00Z"), source: "simplepractice" },
    { allDay: true, date: "2026-11-11", source: "google" }
  ];
  const calsync = { busy: async () => busy, status: () => ({ google: "on" }), googleOn: () => false, clear() {}, addBooking: async () => null, removeBooking: async () => {} };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-07T15:00:00Z"), calsync, calWatchMs: 0 });
  fs.writeFileSync(path.join(dataDir, "appointments.json"), JSON.stringify([{ id: "a1", typeId: "eval", typeName: "Evaluation", date: "2026-11-10", time: "10:00", minutes: 60, status: "booked", name: "Pat", email: "p@example.com", phone: "1" }]));
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/api/admin/busy?from=2026-11-09&days=7")).status, 401);
  const tok = (await (await fetch(base + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "coach@example.com", password: "test-pass-123" }) })).json()).token;
  const r = await (await fetch(base + "/api/admin/busy?from=2026-11-09&days=7", { headers: { authorization: "Bearer " + tok } })).json();
  assert.deepEqual(r.busy.filter((b) => !b.allDay).map((b) => [b.date, b.start, b.end, b.source]), [["2026-11-10", 840, 900, "simplepractice"]], "the Google copy of MD Fit's 10:00 visit isn't drawn twice");
  assert.ok(r.busy.some((b) => b.allDay && b.date === "2026-11-11"));
  assert.ok(!JSON.stringify(r).includes("Pat"), "times only");
});
