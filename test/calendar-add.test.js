// Adding an event to the practice's Google Calendar from the workspace calendar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateKeyPairSync } = require("crypto");
const { createApp } = require("../server");
const { createCalSync } = require("../lib/calsync");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(calsync) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-caladd-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), calsync, calWatchMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const stand = (on, added) => ({ busy: async () => [], events: async () => [], status: () => ({ google: on ? "configured" : "off" }), googleOn: () => on, clear() {}, addBooking: async () => null, removeBooking: async () => {},
  addEvent: async (e) => { if (e.title === "boom") throw new Error("calendar said no"); added.push(e); return "ev_1"; } });

test("calendar: staff add an event to Google Calendar; it is checked, staff only, and the ledger holds no title", async (t) => {
  const added = [];
  const s = await start(stand(true, added)); t.after(s.close);
  const A = await s.adminToken(), u = "/api/admin/calendar/events";
  assert.equal((await s.call("POST", u, { title: "x", date: "2026-11-05", time: "09:00", minutes: 60 })).status, 401);
  assert.equal((await s.call("POST", u, { date: "2026-11-05", time: "09:00", minutes: 60 }, A)).status, 400, "needs a name");
  assert.equal((await s.call("POST", u, { title: "x", date: "tomorrow", time: "09:00", minutes: 60 }, A)).status, 400);
  assert.equal((await s.call("POST", u, { title: "x", date: "2026-11-05", time: "25:00", minutes: 60 }, A)).status, 400);
  assert.equal((await s.call("POST", u, { title: "x", date: "2026-11-05", time: "09:00", minutes: 5000 }, A)).status, 400);
  const r = await s.call("POST", u, { title: "  Follow-up   with Sam  ", date: "2026-11-05", time: "09:00", minutes: 45, note: "bring the report" }, A);
  assert.equal(r.status, 201); assert.equal(r.body.id, "ev_1");
  assert.deepEqual(added, [{ title: "Follow-up with Sam", date: "2026-11-05", time: "09:00", minutes: 45, note: "bring the report" }]);
  assert.equal((await s.call("POST", u, { title: "boom", date: "2026-11-05", time: "09:00", minutes: 45 }, A)).status, 502, "a refusal from the calendar is reported, not thrown");
  const log = JSON.stringify((await s.call("GET", "/api/admin/audit?action=calendar", undefined, A)).body);
  assert.match(log, /calendar\.event_added/); assert.equal(/Sam|report/.test(log), false, "the ledger says an event was added, not what it was");
});

test("calendar: with no Google Calendar connected, adding says so", async (t) => {
  const s = await start(stand(false, [])); t.after(s.close);
  const r = await s.call("POST", "/api/admin/calendar/events", { title: "x", date: "2026-11-05", time: "09:00", minutes: 60 }, await s.adminToken());
  assert.equal(r.status, 503); assert.match(r.body.error, /isn't connected/);
});

test("calendar: the event sent to Google has the name, the times in clinic time, and nothing else about anyone", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("oauth2")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    sent.push({ url: String(url), method: opts.method, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ id: "g_1" }) };
  };
  const cs = createCalSync({ serviceAccount: JSON.stringify({ client_email: "svc@example.com", private_key: privateKey }), calendarId: "doc@example.com, second@example.com", tz: "America/New_York", zonedToUtc: (d, t) => new Date(`${d}T${t}:00-05:00`), fetchImpl });
  assert.equal(await cs.addEvent({ title: "Team meeting", date: "2026-11-05", time: "13:30", minutes: 90, note: "" }), "g_1");
  assert.equal(sent.length, 1); assert.equal(sent[0].method, "POST");
  assert.match(sent[0].url, /\/calendars\/doc%40example\.com\/events$/, "the first calendar");
  assert.equal(sent[0].body.summary, "Team meeting"); assert.equal(sent[0].body.start.dateTime, "2026-11-05T18:30:00.000Z"); assert.equal(sent[0].body.end.dateTime, "2026-11-05T20:00:00.000Z");
  assert.equal("description" in sent[0].body, false); assert.equal("attendees" in sent[0].body, false);
});
