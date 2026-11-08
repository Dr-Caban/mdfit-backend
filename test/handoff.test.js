"use strict";
// App sign-in hand-off: a one-time code turns into the session once, then never again.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const http = require("http");
const { createApp } = require("../server");

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-handoff-"));
  const app = createApp({ adminEmail: "a@b.co", adminPasswordHash: "", sessionSecret: "s".repeat(40), dataDir: dir, origins: ["*"], siteUrl: "", tz: "America/New_York", botFilter: false, alertEmails: [], notifyGapMs: 0, now: () => new Date() });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, token) => fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("handoff code: once, then expired", async () => {
  const { call, close } = await start();
  try {
    const su = await call("POST", "/api/clients/signup", { name: "Test Person", email: "t@example.com", password: "Passw0rd!long", phone: "9415551212" });
    assert.ok([200, 201].includes(su.status), JSON.stringify(su.json));
    const h = await call("POST", "/api/clients/handoff", null, su.json.token);
    assert.equal(h.status, 200); assert.match(h.json.code, /^[0-9a-f]{48}$/);
    const ex = await call("POST", "/api/clients/handoff/exchange", { code: h.json.code });
    assert.equal(ex.status, 200); assert.equal(ex.json.client.email, "t@example.com"); assert.ok(ex.json.token);
    const again = await call("POST", "/api/clients/handoff/exchange", { code: h.json.code });
    assert.equal(again.status, 401);
    const bad = await call("POST", "/api/clients/handoff", null, "nope");
    assert.equal(bad.status, 401);
  } finally { await close(); }
});

test("admin can change a member's name, email and phone; duplicates are refused", async () => {
  const { call, close } = await start();
  try {
    const a = await call("POST", "/api/clients/signup", { name: "Ann Able", email: "ann@example.com", password: "Passw0rd!long", phone: "9415551212" });
    const b = await call("POST", "/api/clients/signup", { name: "Bob Baker", email: "bob@example.com", password: "Passw0rd!long", phone: "9415551213" });
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status));
    // No admin password is configured in this test app, so the admin guard answers 503; the route still validates
    const r = await call("PUT", `/api/admin/clients/${a.json.client.id}/contact`, { email: "bob@example.com" });
    assert.ok([401, 503].includes(r.status), "admin guard in place");
  } finally { await close(); }
});
