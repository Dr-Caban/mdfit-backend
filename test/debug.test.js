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
