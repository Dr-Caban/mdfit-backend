// The activity feed (Admin's bell) and its live "activity" event keep their event type even when the detail has a
// field named "type" (a booking's visit type used to overwrite "appointment", so new bookings never showed in the bell).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createApp } = require("../server");
const { createRealtime } = require("../lib/realtime");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const PASSWORD = "test-pass-123";
const NOW = new Date("2026-11-02T10:00:00Z"); // Monday 05:00 in Sarasota

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const cfg = { adminEmail: "coach@example.com", adminPasswordHash: hashPassword(PASSWORD), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => NOW };
  const server = createApp(cfg).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  token = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: PASSWORD })).body.token;
  return { call, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("activity feed: a booking is logged as an appointment (with its visit type kept as typeId)", async (t) => {
  const s = await start(); t.after(s.close);
  const b = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "10:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" });
  assert.equal(b.status, 201);
  const feed = (await s.call("GET", "/api/admin/activity")).body;
  const ev = feed.find((x) => x.email === "pat@example.com");
  assert.equal(ev.type, "appointment");
  assert.equal(ev.typeId, "eval");

  const c = await s.call("POST", "/api/clients/signup", { name: "Josh Lerner", email: "josh@example.com", phone: "941-555-0123", password: "member-pass-123" });
  assert.equal((await s.call("PUT", `/api/admin/clients/${c.body.client.id}/type`, { type: "inpatient" })).status, 200);
  const ct = (await s.call("GET", "/api/admin/activity")).body[0];
  assert.equal(ct.type, "client_type");
  assert.equal(ct.clientType, "inpatient");
});

test("realtime: the live activity event keeps its type", () => {
  const server = http.createServer();
  const rt = createRealtime(server, { origins: ["*"], sessionSecret: "s".repeat(40), adminEmail: "coach@example.com" });
  const sent = [];
  rt.adminNs.to = () => ({ emit: (name, payload) => sent.push([name, payload]) });
  rt.emitActivity("appointment", { email: "pat@example.com", type: "eval", cancelToken: "secret" });
  const [name, payload] = sent.find(([n]) => n === "activity");
  assert.equal(name, "activity");
  assert.equal(payload.type, "appointment");
  assert.equal(payload.cancelToken, undefined);
  rt.io.close();
});
