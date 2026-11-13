// An independent, adversarial probe of the staff permission model, written against the contract rather than
// against the implementation: every case here is an attempt to gain authority improperly, and all of them must
// fail. Kept deliberately separate from test/staff.test.js so the two don't share assumptions.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

const OWNER = "coach@example.com", OWNER_PASS = "admin-pass-123";
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-adv-"));
  const app = createApp({ adminEmail: OWNER, adminPasswordHash: hashPassword(OWNER_PASS), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", siteUrl: "https://x.example.com", now: () => new Date("2026-11-02T10:00:00Z") });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m,
    headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const login = (e, p) => call("POST", "/api/admin/login", { email: e, password: p });
  const owner = async () => (await login(OWNER, OWNER_PASS)).body.token;
  return { call, login, owner, close: () => new Promise((r) => server.close(r)) };
}
// an Administrator: every permission EXCEPT charts
async function admin(s) {
  const ot = await s.owner();
  const made = await s.call("POST", "/api/admin/staff",
    { name: "Sam Office", email: "sam@example.com", role: "admin", password: "staff-pass-1234" }, ot);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const tok = (await s.login("sam@example.com", "staff-pass-1234")).body.token;
  return { id: made.body.staff.id, tok, ot };
}

test("an Administrator cannot reach charts, by any road I could find", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await admin(s);
  assert.ok(!a.tok === false, "signed in");

  // 0. the permission really is absent, and PHI routes really are shut
  const me = await s.call("GET", "/api/admin/me", undefined, a.tok);
  assert.equal(me.body.permissions.includes("charts"), false);
  for (const p of ["/api/admin/emr/x", "/api/admin/notes", "/api/admin/scribe/x"]) {
    const r = await s.call("GET", p, undefined, a.tok);
    assert.equal(r.status, 403, `${p} should be shut, got ${r.status}`);
  }

  // 1. grant it to myself directly
  assert.equal((await s.call("PUT", `/api/admin/staff/${a.id}`, { permissions: ["charts"] }, a.tok)).status, 403);
  // 2. give myself a role that carries it
  assert.equal((await s.call("PUT", `/api/admin/staff/${a.id}`, { role: "clinician" }, a.tok)).status, 403);
  // 3. make a NEW account that has it, then sign in as them
  const viaCreate = await s.call("POST", "/api/admin/staff",
    { name: "Mule", email: "mule@example.com", role: "clinician", password: "mule-pass-1234" }, a.tok);
  assert.equal(viaCreate.status, 403, "creating a clinician is granting charts");
  // 4. same, but spelling the permissions out instead of using the preset
  assert.equal((await s.call("POST", "/api/admin/staff",
    { name: "Mule2", email: "mule2@example.com", role: "frontdesk", permissions: ["charts"], password: "mule-pass-1234" }, a.tok)).status, 403);
  // 5. take over an existing clinician's account by resetting their password
  const clin = await s.call("POST", "/api/admin/staff",
    { name: "Dr Who", email: "who@example.com", role: "clinician", password: "clin-pass-1234" }, a.ot);
  assert.equal(clin.status, 201);
  assert.equal((await s.call("POST", `/api/admin/staff/${clin.body.staff.id}/password`, { password: "taken-over-1234" }, a.tok)).status, 403);
  // 6. rename myself is fine, but must not smuggle authority alongside it
  assert.equal((await s.call("PUT", `/api/admin/staff/${a.id}`, { name: "Sam Admin" }, a.tok)).status, 200);
  assert.equal((await s.call("PUT", `/api/admin/staff/${a.id}`, { name: "X", permissions: ["charts"] }, a.tok)).status, 403);
  // after all of that, still no charts
  const after = await s.call("GET", "/api/admin/me", undefined, a.tok);
  assert.equal(after.body.permissions.includes("charts"), false, "charts was never acquired");
  assert.equal((await s.call("GET", "/api/admin/notes", undefined, a.tok)).status, 403);
});

test("the owner cannot be touched, and an unmapped route is owner-only", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await admin(s);
  // the owner has no staff row to attack
  const list = await s.call("GET", "/api/admin/staff", undefined, a.tok);
  assert.equal(list.body.staff.some((x) => x.email === OWNER), false, "owner is not in the staff list");
  // and cannot be re-created as a staff account
  assert.equal((await s.call("POST", "/api/admin/staff",
    { name: "Me", email: OWNER, role: "admin", password: "another-pass-1234" }, a.ot)).status, 400);
  // a route nobody mapped is owner-only, not open
  const invented = "/api/admin/this-route-does-not-exist-yet";
  assert.equal((await s.call("GET", invented, undefined, a.tok)).status, 403, "unmapped must fail closed for staff");
  assert.notEqual((await s.call("GET", invented, undefined, a.ot)).status, 403, "owner is not blocked by the gate");
});

test("losing your account ends it at once, and no hash ever leaves the server", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await admin(s);
  assert.equal((await s.call("GET", "/api/admin/me", undefined, a.tok)).status, 200);
  // the owner switches them off while they are signed in
  assert.equal((await s.call("DELETE", `/api/admin/staff/${a.id}`, undefined, a.ot)).status, 200);
  assert.equal((await s.call("GET", "/api/admin/me", undefined, a.tok)).status, 401, "the live token must die immediately");
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, a.tok)).status, 401);
  // nothing was deleted
  const list = await s.call("GET", "/api/admin/staff", undefined, a.ot);
  const row = list.body.staff.find((x) => x.id === a.id);
  assert.ok(row, "the record is kept");
  assert.equal(row.active, false);
  // no password hash anywhere in any body
  const bodies = JSON.stringify(list.body) + JSON.stringify((await s.call("GET", "/api/admin/me", undefined, a.ot)).body);
  assert.equal(/passwordHash|\$2[aby]\$|scrypt|pbkdf2/i.test(bodies), false, "no hash material in responses");
});
