// Regression tests from the endpoint sweep: every save the UI makes must be readable again through the GET the UI uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { defaultContent } = require("../lib/content");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start({ seed = {}, ...extra } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-e-"));
  for (const [name, data] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const writeJson = (name, data) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  return { call, adminToken, dataDir, readJson, writeJson, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

test("a built-in program added after the admin last saved content can be pinned and assigned", async (t) => {
  const d = defaultContent();
  // Content saved by the admin when only the first built-in program existed
  const s = await start({ seed: { content: { contentVersion: 5, programs: [d.programs[0]], knownDefaults: [d.programs[0].id] } } }); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const shown = (await s.call("GET", "/api/me/content", undefined, T)).body.programs.map((p) => p.id);
  assert.equal(shown.length, d.programs.length, "the app shows the new built-ins");
  const pid = shown[1];
  const pin = await s.call("PUT", `/api/me/pinned/${pid}`, undefined, T);
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.deepEqual((await s.call("GET", "/api/me", undefined, T)).body.client.pinnedPrograms, [pid]);
  const as = await s.call("PUT", `/api/admin/clients/${client.id}/programs`, { programs: [{ id: pid, note: "Start here" }] }, A);
  assert.equal(as.status, 200, JSON.stringify(as.body));
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.assignedPrograms[0].note, "Start here");
  // A program the admin removed stays unavailable
  const gone = d.programs[0].id;
  await s.call("PUT", "/api/admin/content", { programs: (await s.call("GET", "/api/admin/content", undefined, A)).body.programs.filter((p) => p.id !== gone) }, A);
  assert.equal((await s.call("PUT", `/api/me/pinned/${gone}`, undefined, T)).status, 400);
});

test("admin membership save keeps the Stripe subscription on the membership", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const cls = s.readJson("clients");
  cls[0].membership = { tier: "member", since: "2026-10-01", until: "2026-12-01", stripeSubscriptionId: "sub_123", status: "active", cancelAtPeriodEnd: false };
  s.writeJson("clients", cls);
  const r = await s.call("PUT", `/api/admin/clients/${client.id}/membership`, { tier: "member", until: "2027-01-01" }, A);
  assert.equal(r.status, 200);
  const m = (await s.call("GET", "/api/me/payments", undefined, T)).body.membership;
  assert.equal(m.until, "2027-01-01");
  assert.equal(m.since, "2026-10-01");
  assert.equal(m.stripeSubscriptionId, "sub_123");
  // Turning it off still clears it
  await s.call("PUT", `/api/admin/clients/${client.id}/membership`, { tier: null }, A);
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.membership, null);
});

test("profile name change updates first and last name (Google sign-up accounts store them separately)", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: T } = (await signup(s)).body;
  const cls = s.readJson("clients");
  Object.assign(cls[0], { firstName: "Pat", lastName: "Doe", googleSub: "g-1" });
  s.writeJson("clients", cls);
  await s.call("PUT", "/api/me", { name: "Patricia Smith", phone: "941-555-0100" }, T);
  const c = (await s.call("GET", "/api/me", undefined, T)).body.client;
  assert.equal(c.name, "Patricia Smith");
  assert.equal(c.firstName, "Patricia");
  assert.equal(c.lastName, "Smith");
  // Saving the profile with the same name keeps them
  await s.call("PUT", "/api/me", { name: "Patricia Smith", phone: "941-555-0101" }, T);
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.phone, "941-555-0101");
});
