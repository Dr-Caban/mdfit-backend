// Cal.com integration: a fake Cal API on a random port, signed webhooks, sync and cancel.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("node:http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { verifySignature, normaliseBooking } = require("../lib/cal");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const KEY = "cal_test_key", SECRET = "whsec_test";
const NOW = new Date("2026-11-02T10:00:00Z"); // Mon 05:00 in Sarasota

function fakeCal() {
  const calls = [];
  const state = { down: false, bookings: [] };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers["cal-api-version"], body: body && JSON.parse(body) });
      const send = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (state.down) return send(500, { status: "error" });
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { status: "error" });
      if (req.url === "/v2/me") return send(200, { status: "success", data: { username: "mdfit", name: "Dr. Jared", timeZone: "America/New_York" } });
      if (req.url.startsWith("/v2/event-types")) return send(200, { status: "success", data: [
        { id: 1, slug: "initial-evaluation", title: "Initial Evaluation", lengthInMinutes: 60, description: "Full assessment", hidden: false },
        { id: 2, slug: "phone-consult", title: "Free Phone Consult", lengthInMinutes: 15, hidden: false },
        { id: 3, slug: "secret", title: "Hidden", lengthInMinutes: 30, hidden: true }
      ] });
      if (req.url.startsWith("/v2/bookings?")) return send(200, { status: "success", data: state.bookings });
      const m = req.url.match(/^\/v2\/bookings\/([^/]+)\/cancel$/);
      if (m && req.method === "POST") return send(200, { status: "success", data: { uid: m[1], status: "cancelled" } });
      send(404, { status: "error" });
    });
  }).listen(0);
  return { server, calls, state, url: () => `http://127.0.0.1:${server.address().port}/v2` };
}

async function start(cal, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-cal-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => NOW,
    calKey: KEY, calUrl: cal ? cal.url() : "http://127.0.0.1:9/v2", calWebhookSecret: SECRET, ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body, headers = {}) => {
    const raw = typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: raw });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const login = async () => { token = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "test-pass-123" })).body.token; };
  const hook = (obj, secret = SECRET) => {
    const raw = JSON.stringify(obj);
    return call("POST", "/api/cal/webhook", raw, { "x-cal-signature-256": crypto.createHmac("sha256", secret).update(raw).digest("hex") });
  };
  return { call, login, hook, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

const calBooking = (over = {}) => ({
  uid: "bk_1", title: "Initial Evaluation between Dr. Jared and Pat", type: "initial-evaluation",
  startTime: "2026-11-03T15:00:00Z", endTime: "2026-11-03T16:00:00Z", status: "ACCEPTED",
  attendees: [{ name: "Pat Doe", email: "Pat@Example.com", timeZone: "America/New_York" }],
  responses: { name: { value: "Pat Doe" }, email: { value: "pat@example.com" }, attendeePhoneNumber: { value: "+19415550100" }, notes: { value: "Left knee" } },
  ...over
});

test("signature check and booking normalisation", () => {
  const raw = Buffer.from('{"a":1}');
  const sig = crypto.createHmac("sha256", "k").update(raw).digest("hex");
  assert.equal(verifySignature(raw, sig, "k"), true);
  assert.equal(verifySignature(raw, sig, "other"), false);
  assert.equal(verifySignature(raw, undefined, "k"), false);
  const n = normaliseBooking(calBooking());
  assert.equal(n.email, "pat@example.com");
  assert.equal(n.phone, "+19415550100");
  assert.equal(n.minutes, 60);
  // API v2 shape
  const api = normaliseBooking({ uid: "x", title: "T", start: "2026-11-03T15:00:00Z", end: "2026-11-03T15:15:00Z", eventType: { slug: "phone-consult" }, attendees: [{ name: "A", email: "a@example.com" }], bookingFieldsResponses: {} });
  assert.equal(api.eventSlug, "phone-consult");
  assert.equal(api.minutes, 15);
});

test("site uses built-in booking until Cal is switched on, then serves Cal event types", async (t) => {
  const cal = fakeCal(); t.after(() => cal.server.close());
  const s = await start(cal); t.after(s.close);
  assert.equal((await s.call("GET", "/api/site")).body.booking.provider, "builtin");
  await s.login();
  assert.equal((await s.call("PUT", "/api/admin/settings", { booking: { provider: "zoom" } })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { booking: { calUsername: "bad name!" } })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { booking: { provider: "cal" } })).status, 200);
  const site = (await s.call("GET", "/api/site")).body;
  assert.equal(site.booking.provider, "cal");
  assert.equal(site.booking.cal.username, "mdfit");
  assert.deepEqual(site.booking.cal.eventTypes.map((e) => e.slug), ["initial-evaluation", "phone-consult"]); // hidden one left out
  assert.equal(site.settings.booking, undefined);
  assert.ok(cal.calls.every((c) => c.auth === `Bearer ${KEY}`));
  assert.equal(cal.calls.find((c) => c.url.startsWith("/v2/event-types")).version, "2024-06-14");
  assert.ok(!JSON.stringify(site).includes(KEY), "API key must never reach the browser");

  // Admin can pick and order which event types show
  await s.call("PUT", "/api/admin/settings", { booking: { calEventSlugs: ["phone-consult", "initial-evaluation"] } });
  // cached for 5 minutes in memory, so read status (fresh) to confirm
  const st = (await s.call("GET", "/api/admin/cal/status")).body;
  assert.equal(st.connected, true);
  assert.equal(st.username, "mdfit");
  assert.deepEqual(st.eventTypes.map((e) => e.slug), ["phone-consult", "initial-evaluation"]);
});

test("Cal down: last good event types are still served", async (t) => {
  const cal = fakeCal(); t.after(() => cal.server.close());
  const s = await start(cal); t.after(s.close);
  await s.login();
  await s.call("PUT", "/api/admin/settings", { booking: { provider: "cal" } });
  assert.equal((await s.call("GET", "/api/admin/cal/status")).body.connected, true); // fills the disk cache
  cal.state.down = true;
  const st = (await s.call("GET", "/api/admin/cal/status")).body;
  assert.equal(st.connected, false);
  assert.match(st.message, /Cal\.com error 500/);
  // the public booking page keeps working from the last good copy
  const site = (await s.call("GET", "/api/site")).body;
  assert.equal(site.booking.provider, "cal");
  assert.equal(site.booking.cal.eventTypes.length, 2);
  // a server with no reachable Cal and no username set falls back to the built-in scheduler
  const s2 = await start(null); t.after(s2.close);
  await s2.login();
  await s2.call("PUT", "/api/admin/settings", { booking: { provider: "cal" } });
  assert.equal((await s2.call("GET", "/api/site")).body.booking.provider, "builtin");
});

test("webhooks: signed create, reschedule and cancel become appointments; forged ones are rejected", async (t) => {
  const s = await start(null); t.after(s.close);
  assert.equal((await s.call("POST", "/api/cal/webhook", { triggerEvent: "BOOKING_CREATED", payload: calBooking() })).status, 401);
  assert.equal((await s.hook({ triggerEvent: "BOOKING_CREATED", payload: calBooking() }, "wrong")).status, 401);
  assert.equal((await s.hook({ triggerEvent: "PING", payload: {} })).status, 200);
  assert.equal((await s.hook({ triggerEvent: "BOOKING_CREATED", payload: calBooking() })).status, 200);
  assert.equal((await s.hook({ triggerEvent: "BOOKING_CREATED", payload: calBooking() })).status, 200); // retried delivery

  await s.login();
  let list = (await s.call("GET", "/api/admin/appointments")).body;
  assert.equal(list.length, 1, "duplicate deliveries must not double-book");
  assert.equal(list[0].source, "cal");
  assert.equal(list[0].date, "2026-11-03");
  assert.equal(list[0].time, "10:00"); // 15:00Z = 10:00 EST
  assert.equal(list[0].phone, "+19415550100");
  // Cal bookings block the built-in calendar too
  const slots = (await s.call("GET", "/api/availability?type=eval&from=2026-11-03&days=1")).body.days[0].slots;
  assert.ok(!slots.includes("10:00") && !slots.includes("09:30") && slots.includes("11:00"));

  await s.hook({ triggerEvent: "BOOKING_RESCHEDULED", payload: calBooking({ uid: "bk_2", rescheduleUid: "bk_1", startTime: "2026-11-04T19:00:00Z", endTime: "2026-11-04T20:00:00Z" }) });
  list = (await s.call("GET", "/api/admin/appointments?all=1")).body;
  assert.deepEqual(list.map((a) => [a.calUid, a.status]).sort(), [["bk_1", "cancelled"], ["bk_2", "booked"]]);
  assert.equal(list.find((a) => a.calUid === "bk_2").time, "14:00");

  await s.hook({ triggerEvent: "BOOKING_CANCELLED", payload: calBooking({ uid: "bk_2", startTime: "2026-11-04T19:00:00Z", endTime: "2026-11-04T20:00:00Z" }) });
  assert.equal((await s.call("GET", "/api/admin/appointments")).body.length, 0);
  assert.equal((await s.hook({ triggerEvent: "MEETING_ENDED", payload: {} })).body.ignored, "MEETING_ENDED");
});

test("webhook refuses everything when no secret is configured", async (t) => {
  const s = await start(null, { calWebhookSecret: "" }); t.after(s.close);
  assert.equal((await s.hook({ triggerEvent: "BOOKING_CREATED", payload: calBooking() })).status, 503);
});

test("admin sync pulls upcoming Cal bookings; cancelling in admin cancels in Cal", async (t) => {
  const cal = fakeCal(); t.after(() => cal.server.close());
  cal.state.bookings = [
    { uid: "api_1", title: "Free Phone Consult", start: "2026-11-05T14:00:00Z", end: "2026-11-05T14:15:00Z", status: "accepted", eventType: { slug: "phone-consult" }, attendees: [{ name: "Sam Lee", email: "sam@example.com" }], bookingFieldsResponses: { notes: "Neck" } }
  ];
  const s = await start(cal); t.after(s.close);
  await s.login();
  const r = await s.call("POST", "/api/admin/cal/sync");
  assert.equal(r.body.synced, 1);
  assert.equal(cal.calls.find((c) => c.url.startsWith("/v2/bookings?")).version, "2024-08-13");
  await s.call("POST", "/api/admin/cal/sync"); // idempotent
  const list = (await s.call("GET", "/api/admin/appointments")).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].typeName, "Free Phone Consult");
  assert.equal(list[0].minutes, 15);
  assert.equal(list[0].notes, "Neck");

  const upd = await s.call("PATCH", `/api/admin/appointments/${list[0].id}`, { status: "cancelled" });
  assert.equal(upd.body.status, "cancelled");
  const cancel = cal.calls.find((c) => c.url === "/v2/bookings/api_1/cancel");
  assert.ok(cancel);
  assert.equal(cancel.body.cancellationReason, "Cancelled by MD Fit");

  cal.state.down = true;
  assert.equal((await s.call("POST", "/api/admin/cal/sync")).status, 502);
});

test("bad API key gives a clear message", async (t) => {
  const cal = fakeCal(); t.after(() => cal.server.close());
  const s = await start(cal, { calKey: "cal_live_wrong" }); t.after(s.close);
  await s.login();
  const st = (await s.call("GET", "/api/admin/cal/status")).body;
  assert.equal(st.connected, false);
  assert.match(st.message, /rejected the API key/);
});
