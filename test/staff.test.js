// Staff accounts, roles and permissions: the owner, the permission gate on every admin route, and the rules that
// stop a staff member handing themselves (or anyone else) authority they don't hold.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { PERMISSION_KEYS, ROLES } = require("../lib/staff");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const OWNER = "coach@example.com";
const OWNER_PASS = "admin-pass-123";

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-staff-"));
  const app = createApp({
    adminEmail: OWNER, adminPasswordHash: hashPassword(OWNER_PASS), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"),
    siteUrl: "https://mdfit.example.com", ...extra
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
  const login = (email, password, code) => call("POST", "/api/admin/login", { email, password, ...(code ? { code } : {}) });
  const ownerToken = async () => (await login(OWNER, OWNER_PASS)).body.token;
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  // Make a staff account as the owner and sign in as them.
  const makeStaff = async (over = {}) => {
    const tok = await ownerToken();
    const body = { name: "Sam Office", email: "sam@example.com", role: "admin", password: "staff-pass-1234", ...over };
    const made = await call("POST", "/api/admin/staff", body, tok);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const signedIn = await login(body.email, body.password);
    return { record: made.body.staff, token: signedIn.body.token, password: body.password, email: body.email.toLowerCase() };
  };
  return { call, login, ownerToken, makeStaff, dataDir, readJson, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

const hasHash = (v) => JSON.stringify(v === undefined ? null : v).includes("passwordHash");

// ---------------------------------------------------------------- the owner

test("owner signs in as before, bypasses every permission check, and is never in the staff store", async (t) => {
  const s = await start(); t.after(s.close);
  const login = await s.login(OWNER, OWNER_PASS);
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.ok(login.body.expiresAt);
  assert.deepEqual(Object.keys(login.body).sort(), ["expiresAt", "token"], "login response shape is unchanged");
  const tok = login.body.token;

  const me = await s.call("GET", "/api/admin/me", undefined, tok);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, OWNER);
  assert.equal(me.body.isOwner, true);
  assert.equal(me.body.id, "owner", "the owner has no staff record, so /me reports the reserved id");
  assert.equal(me.body.role, "owner");
  assert.equal(me.body.name, "Owner");
  assert.equal(me.body.mustChangePassword, false);
  assert.deepEqual([...me.body.permissions].sort(), [...PERMISSION_KEYS].sort(), "the owner holds every permission");
  assert.equal(typeof me.body.emailNotifications, "boolean", "existing field kept");
  assert.equal(typeof me.body.mfa, "boolean", "existing field kept");

  // Owner-only, chart and ordinary routes all answer for the owner
  for (const url of ["/api/admin/mfa", "/api/admin/emr", "/api/admin/scribe", "/api/admin/settings", "/api/admin/stats", "/api/admin/staff"]) {
    assert.equal((await s.call("GET", url, undefined, tok)).status, 200, url);
  }

  // Nothing created a staff record for the owner
  assert.equal(fs.existsSync(path.join(s.dataDir, "staff.json")), false);
  await s.makeStaff();
  assert.equal(s.readJson("staff").some((x) => x.email === OWNER), false);
});

test("the owner account can't be created, taken over, or renamed through the API", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const dupe = await s.call("POST", "/api/admin/staff", { name: "Impostor", email: "COACH@example.com", role: "admin", password: "another-pass-123" }, tok);
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /owner/i);

  // "owner" is not an assignable role
  const asOwner = await s.call("POST", "/api/admin/staff", { name: "Impostor", email: "x@example.com", role: "owner", password: "another-pass-123" }, tok);
  assert.equal(asOwner.status, 400);

  const st = await s.makeStaff();
  const steal = await s.call("PUT", `/api/admin/staff/${st.record.id}`, { role: "owner" }, tok);
  assert.equal(steal.status, 400);
  // The owner has no id to aim at, so no /staff/:id route can touch them
  assert.equal((await s.call("PUT", "/api/admin/staff/owner", { name: "x" }, tok)).status, 404);
  assert.equal((await s.call("DELETE", "/api/admin/staff/owner", undefined, tok)).status, 404);
});

// ---------------------------------------------------------------- managing staff

test("create, list, update, reset and deactivate; nothing is ever deleted", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();

  const made = await s.call("POST", "/api/admin/staff", { name: "Sam Office", email: "Sam@Example.com", role: "admin", password: "staff-pass-1234" }, tok);
  assert.equal(made.status, 201);
  const sam = made.body.staff;
  assert.equal(sam.email, "sam@example.com", "email is stored lower case");
  assert.equal(sam.role, "admin");
  assert.equal(sam.active, true);
  assert.equal(sam.mustChangePassword, true);
  assert.equal(sam.createdBy, OWNER);
  assert.deepEqual(sam.permissions, ROLES.admin.permissions, "the role preset filled the permission set");
  assert.equal(sam.permissions.includes("charts"), false, "Administrator never gets charts by default");

  const list = await s.call("GET", "/api/admin/staff", undefined, tok);
  assert.equal(list.status, 200);
  assert.equal(list.body.staff.length, 1);
  assert.deepEqual(Object.keys(list.body.roles).sort(), ["admin", "clinician", "frontdesk"]);
  assert.equal(list.body.roles.admin.label, "Administrator");
  assert.deepEqual(list.body.permissions.map((p) => p.key), PERMISSION_KEYS);
  for (const p of list.body.permissions) assert.ok(p.label && p.description, p.key);

  // Update: name, role (which refills permissions) and a hand-picked permission set
  const renamed = await s.call("PUT", `/api/admin/staff/${sam.id}`, { name: "Sam O.", role: "frontdesk" }, tok);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.staff.name, "Sam O.");
  assert.deepEqual(renamed.body.staff.permissions, ROLES.frontdesk.permissions);
  const picked = await s.call("PUT", `/api/admin/staff/${sam.id}`, { permissions: ["clients", "clients", "billing"] }, tok);
  assert.deepEqual(picked.body.staff.permissions, ["clients", "billing"], "duplicates are dropped, the list is kept as given");
  assert.equal((await s.call("PUT", `/api/admin/staff/${sam.id}`, { permissions: ["nope"] }, tok)).status, 400);
  assert.equal((await s.call("PUT", `/api/admin/staff/${sam.id}`, { role: "boss" }, tok)).status, 400);

  // Password reset by the owner
  const reset = await s.call("POST", `/api/admin/staff/${sam.id}/password`, { password: "brand-new-pass-99" }, tok);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.staff.mustChangePassword, true);
  assert.equal((await s.login("sam@example.com", "staff-pass-1234")).status, 401, "the old password stops working");
  assert.equal((await s.login("sam@example.com", "brand-new-pass-99")).status, 200);

  // Deactivate: a soft switch-off, never a delete
  const off = await s.call("DELETE", `/api/admin/staff/${sam.id}`, undefined, tok);
  assert.equal(off.status, 200);
  assert.equal(off.body.staff.active, false);
  assert.ok(off.body.staff.deactivatedAt);
  assert.equal(s.readJson("staff").length, 1, "the record is still there");
  assert.equal((await s.login("sam@example.com", "brand-new-pass-99")).status, 401, "a switched-off account can't sign in");
  // ...and can be switched back on
  const on = await s.call("PUT", `/api/admin/staff/${sam.id}`, { active: true }, tok);
  assert.equal(on.body.staff.active, true);
  assert.equal(on.body.staff.deactivatedAt, "");
  assert.equal((await s.login("sam@example.com", "brand-new-pass-99")).status, 200);

  assert.equal((await s.call("POST", "/api/admin/staff/nope/password", { password: "another-pass-123" }, tok)).status, 404);
});

test("email is unique case-insensitively", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  await s.makeStaff({ email: "sam@example.com" });
  const again = await s.call("POST", "/api/admin/staff", { name: "Other Sam", email: "SAM@EXAMPLE.COM", role: "frontdesk", password: "staff-pass-1234" }, tok);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already/i);
  assert.equal((await s.call("POST", "/api/admin/staff", { name: "No Mail", email: "not-an-email", role: "admin", password: "staff-pass-1234" }, tok)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/staff", { name: "", email: "b@example.com", role: "admin", password: "staff-pass-1234" }, tok)).status, 400);
});

test("passwords are at least 12 characters, on create, on reset and on a self-change", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const short = await s.call("POST", "/api/admin/staff", { name: "Sam", email: "sam@example.com", role: "admin", password: "short-one" }, tok);
  assert.equal(short.status, 400);
  assert.match(short.body.error, /12 characters/);
  assert.equal(fs.existsSync(path.join(s.dataDir, "staff.json")), false, "nothing was written");

  const st = await s.makeStaff();
  assert.equal((await s.call("POST", `/api/admin/staff/${st.record.id}/password`, { password: "tooshort" }, tok)).status, 400);
  const self = await s.call("POST", "/api/admin/me/password", { current: st.password, password: "tiny" }, st.token);
  assert.equal(self.status, 400);
  assert.match(self.body.error, /12 characters/);
});

test("passwordHash never appears in any response body", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const made = await s.call("POST", "/api/admin/staff", { name: "Sam", email: "sam@example.com", role: "clinician", password: "staff-pass-1234" }, tok);
  const sid = made.body.staff.id;
  const bodies = [
    made.body,
    (await s.call("GET", "/api/admin/staff", undefined, tok)).body,
    (await s.call("PUT", `/api/admin/staff/${sid}`, { name: "Sam B" }, tok)).body,
    (await s.call("POST", `/api/admin/staff/${sid}/password`, { password: "brand-new-pass-99" }, tok)).body,
    (await s.call("DELETE", `/api/admin/staff/${sid}`, undefined, tok)).body,
    (await s.call("GET", "/api/admin/me", undefined, tok)).body
  ];
  for (const b of bodies) assert.equal(hasHash(b), false, JSON.stringify(b).slice(0, 200));
  // ...but it really is on disk
  assert.ok(s.readJson("staff")[0].passwordHash.startsWith("scrypt$"));
});

// ---------------------------------------------------------------- the permission gate

test("the route gate: charts is PHI and off for an Administrator, on for a clinician and the owner", async (t) => {
  const s = await start(); t.after(s.close);
  const ownerTok = await s.ownerToken();
  const boss = await s.makeStaff({ email: "boss@example.com", role: "admin" });
  const doc = await s.makeStaff({ email: "doc@example.com", role: "clinician" });

  for (const url of ["/api/admin/emr", "/api/admin/notes?clientId=x", "/api/admin/scribe"]) {
    const denied = await s.call("GET", url, undefined, boss.token);
    assert.equal(denied.status, 403, url);
    assert.equal(denied.body.need, "charts", url);
    assert.match(denied.body.error, /Charts & clinical notes/);
    assert.notEqual((await s.call("GET", url, undefined, doc.token)).status, 403, url + " (clinician)");
    assert.notEqual((await s.call("GET", url, undefined, ownerTok)).status, 403, url + " (owner)");
  }
  // Express matches routes case-insensitively, so the gate must too
  const shouted = await s.call("GET", "/api/admin/EMR", undefined, boss.token);
  assert.equal(shouted.status, 403);
  assert.equal(shouted.body.need, "charts");

  // The clinician has no billing, no settings and no staff
  const money = await s.call("GET", "/api/admin/payments", undefined, doc.token);
  assert.equal(money.status, 403);
  assert.equal(money.body.need, "billing");
  assert.equal((await s.call("GET", "/api/admin/settings", undefined, doc.token)).body.need, "settings");
  assert.equal((await s.call("GET", "/api/admin/staff", undefined, doc.token)).body.need, "staff");
  // ...but does have clients, scheduling, messages and content
  for (const url of ["/api/admin/clients", "/api/admin/appointments", "/api/admin/messages", "/api/admin/videos"]) {
    assert.notEqual((await s.call("GET", url, undefined, doc.token)).status, 403, url);
  }
});

test("an unmapped admin route is owner-only", async (t) => {
  const s = await start(); t.after(s.close);
  const ownerTok = await s.ownerToken();
  const boss = await s.makeStaff({ role: "admin" });
  const denied = await s.call("GET", "/api/admin/mfa", undefined, boss.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.need, "owner");
  assert.match(denied.body.error, /owner/i);
  assert.equal((await s.call("POST", "/api/admin/mfa/disable", { password: OWNER_PASS }, boss.token)).status, 403);
  assert.equal((await s.call("GET", "/api/admin/mfa", undefined, ownerTok)).status, 200);
  // A route nobody has ever defined is owner-only too, not a 404 leak
  const unknown = await s.call("GET", "/api/admin/brand-new-thing", undefined, boss.token);
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.need, "owner");
  // Odd spellings of a chart path fail closed, whichever way the gate reads them
  for (const url of ["/api/admin/%65mr", "/api/admin/emr/", "/api/admin//emr"]) {
    const r = await s.call("GET", url, undefined, boss.token);
    assert.equal(r.status, 403, url);
    assert.ok(["charts", "owner"].includes(r.body.need), url);
  }
});

test("every /staff route needs the staff permission", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const desk = await s.makeStaff({ email: "desk@example.com", role: "frontdesk" });
  const victim = await s.makeStaff({ email: "victim@example.com", role: "frontdesk" });
  const calls = [
    ["GET", "/api/admin/staff", undefined],
    ["POST", "/api/admin/staff", { name: "New", email: "new@example.com", role: "frontdesk", password: "staff-pass-1234" }],
    ["PUT", `/api/admin/staff/${victim.record.id}`, { name: "Hacked" }],
    ["POST", `/api/admin/staff/${victim.record.id}/password`, { password: "brand-new-pass-99" }],
    ["DELETE", `/api/admin/staff/${victim.record.id}`, undefined]
  ];
  for (const [m, url, body] of calls) {
    const r = await s.call(m, url, body, desk.token);
    assert.equal(r.status, 403, `${m} ${url}`);
    assert.equal(r.body.need, "staff");
  }
  // The owner's view of the victim is untouched
  const after = (await s.call("GET", "/api/admin/staff", undefined, tok)).body.staff.find((x) => x.id === victim.record.id);
  assert.equal(after.name, "Sam Office");
  assert.equal(after.active, true);
});

// ---------------------------------------------------------------- no escalation

test("a staff member can't grant a permission they don't hold themselves", async (t) => {
  const s = await start(); t.after(s.close);
  const boss = await s.makeStaff({ email: "boss@example.com", role: "admin" }); // every permission except charts
  const me = await s.call("GET", "/api/admin/me", undefined, boss.token);
  assert.equal(me.body.permissions.includes("charts"), false);
  assert.equal(me.body.permissions.includes("staff"), true);

  // ...not at create, by hand
  const byHand = await s.call("POST", "/api/admin/staff", { name: "Mole", email: "mole@example.com", role: "frontdesk", permissions: ["clients", "charts"], password: "staff-pass-1234" }, boss.token);
  assert.equal(byHand.status, 403);
  assert.equal(byHand.body.need, "charts");
  // ...and not at create through a role preset that includes it
  const byRole = await s.call("POST", "/api/admin/staff", { name: "Mole", email: "mole@example.com", role: "clinician", password: "staff-pass-1234" }, boss.token);
  assert.equal(byRole.status, 403);
  assert.equal(byRole.body.need, "charts");
  assert.equal((await s.call("GET", "/api/admin/staff", undefined, boss.token)).body.staff.length, 1, "neither account was created");

  // What they do hold, they may grant
  const ok = await s.call("POST", "/api/admin/staff", { name: "Desk", email: "desk@example.com", role: "frontdesk", password: "staff-pass-1234" }, boss.token);
  assert.equal(ok.status, 201);
  const deskId = ok.body.staff.id;

  // ...not at update, by hand or by preset
  const grant = await s.call("PUT", `/api/admin/staff/${deskId}`, { permissions: ["clients", "charts"] }, boss.token);
  assert.equal(grant.status, 403);
  assert.equal(grant.body.need, "charts");
  const promote = await s.call("PUT", `/api/admin/staff/${deskId}`, { role: "clinician" }, boss.token);
  assert.equal(promote.status, 403);
  assert.deepEqual((await s.call("GET", "/api/admin/staff", undefined, boss.token)).body.staff.find((x) => x.id === deskId).permissions, ROLES.frontdesk.permissions);

  // Taking a permission away is always allowed
  const narrow = await s.call("PUT", `/api/admin/staff/${deskId}`, { permissions: ["clients"] }, boss.token);
  assert.equal(narrow.status, 200);
  assert.deepEqual(narrow.body.staff.permissions, ["clients"]);

  // ...and they can't take a more privileged account over by resetting its password
  const ownerTok = await s.ownerToken();
  const doc = await s.call("POST", "/api/admin/staff", { name: "Doc", email: "doc@example.com", role: "clinician", password: "staff-pass-1234" }, ownerTok);
  const takeover = await s.call("POST", `/api/admin/staff/${doc.body.staff.id}/password`, { password: "brand-new-pass-99" }, boss.token);
  assert.equal(takeover.status, 403);
  assert.equal(takeover.body.need, "charts");
  assert.equal((await s.login("doc@example.com", "staff-pass-1234")).status, 200, "the clinician's password is untouched");
  // Someone no more privileged than them, they may reset
  assert.equal((await s.call("POST", `/api/admin/staff/${deskId}/password`, { password: "brand-new-pass-99" }, boss.token)).status, 200);
});

test("a staff member can't change their own role, permissions or access, or switch themselves off", async (t) => {
  const s = await start(); t.after(s.close);
  const boss = await s.makeStaff({ email: "boss@example.com", role: "admin" });
  const mine = `/api/admin/staff/${boss.record.id}`;
  for (const body of [{ role: "clinician" }, { permissions: [...ROLES.admin.permissions, "charts"] }, { permissions: ["clients"] }, { active: false }]) {
    const r = await s.call("PUT", mine, body, boss.token);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.need, "owner");
  }
  const off = await s.call("DELETE", mine, undefined, boss.token);
  assert.equal(off.status, 403);
  assert.equal(off.body.need, "owner");

  // Their own record is untouched, and they may still rename themselves
  const rename = await s.call("PUT", mine, { name: "Boss B." }, boss.token);
  assert.equal(rename.status, 200);
  assert.equal(rename.body.staff.name, "Boss B.");
  assert.deepEqual(rename.body.staff.permissions, ROLES.admin.permissions);
  assert.equal(rename.body.staff.active, true);

  // The owner can do all of it
  const tok = await s.ownerToken();
  assert.equal((await s.call("PUT", mine, { role: "clinician" }, tok)).status, 200);
  assert.equal((await s.call("DELETE", mine, undefined, tok)).status, 200);
});

// ---------------------------------------------------------------- live revocation

test("switching someone off, or narrowing them, takes effect on the token they already hold", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const boss = await s.makeStaff({ email: "boss@example.com", role: "admin" });
  assert.equal((await s.call("GET", "/api/admin/settings", undefined, boss.token)).status, 200);

  // Narrow them: the same token loses the settings screens at once
  await s.call("PUT", `/api/admin/staff/${boss.record.id}`, { permissions: ["clients"] }, tok);
  const narrowed = await s.call("GET", "/api/admin/settings", undefined, boss.token);
  assert.equal(narrowed.status, 403);
  assert.equal(narrowed.body.need, "settings");
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, boss.token)).status, 200);
  const me = await s.call("GET", "/api/admin/me", undefined, boss.token);
  assert.deepEqual(me.body.permissions, ["clients"], "/me reflects the record, not the token");

  // Switch them off: the same token stops working everywhere, immediately
  await s.call("DELETE", `/api/admin/staff/${boss.record.id}`, undefined, tok);
  for (const url of ["/api/admin/clients", "/api/admin/me", "/api/admin/stats"]) {
    const r = await s.call("GET", url, undefined, boss.token);
    assert.equal(r.status, 401, url);
    assert.match(r.body.error, /log in again/i);
  }
  // And a record wiped from the store behind the token's back is the same answer
  await s.call("PUT", `/api/admin/staff/${boss.record.id}`, { active: true }, tok);
  assert.equal((await s.call("GET", "/api/admin/me", undefined, boss.token)).status, 200);
  fs.writeFileSync(path.join(s.dataDir, "staff.json"), "[]");
  assert.equal((await s.call("GET", "/api/admin/me", undefined, boss.token)).status, 401);
});

// ---------------------------------------------------------------- signing in

test("a member token is never an admin token, and a staff token is not a member token", async (t) => {
  const s = await start(); t.after(s.close);
  const boss = await s.makeStaff({ email: "boss@example.com", role: "admin" });
  const signup = await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" });
  assert.equal(signup.status, 201);
  const memberToken = signup.body.token;
  for (const url of ["/api/admin/me", "/api/admin/clients", "/api/admin/staff", "/api/admin/emr"]) {
    assert.equal((await s.call("GET", url, undefined, memberToken)).status, 401, url);
  }
  // A staff account is not a member account
  assert.equal((await s.call("GET", "/api/me", undefined, boss.token)).status, 401);
  // No token, and a forged one, are still 401
  assert.equal((await s.call("GET", "/api/admin/me")).status, 401);
  assert.equal((await s.call("GET", "/api/admin/me", undefined, "not.a.token")).status, 401);
});

test("staff sign-in: per-email rate limiting, and /me/password", async (t) => {
  const s = await start(); t.after(s.close);
  const st = await s.makeStaff({ email: "sam@example.com", role: "frontdesk" });
  const me = await s.call("GET", "/api/admin/me", undefined, st.token);
  assert.equal(me.body.isOwner, false);
  assert.equal(me.body.id, st.record.id, "/me carries the staff id the /staff list uses");
  assert.notEqual(me.body.id, "owner");
  assert.equal(me.body.role, "frontdesk");
  assert.equal(me.body.mustChangePassword, true, "a new account must change its password");
  assert.equal(s.readJson("staff")[0].lastLoginAt, "2026-11-02T10:00:00.000Z");

  // Wrong current password
  const wrong = await s.call("POST", "/api/admin/me/password", { current: "not-the-password", password: "brand-new-pass-99" }, st.token);
  assert.equal(wrong.status, 403);

  const ok = await s.call("POST", "/api/admin/me/password", { current: st.password, password: "brand-new-pass-99" }, st.token);
  assert.equal(ok.status, 200);
  assert.equal((await s.call("GET", "/api/admin/me", undefined, st.token)).body.mustChangePassword, false);
  assert.equal((await s.login("sam@example.com", "brand-new-pass-99")).status, 200);

  // The owner's password isn't kept here
  const ownerTok = await s.ownerToken();
  const owner = await s.call("POST", "/api/admin/me/password", { current: OWNER_PASS, password: "brand-new-pass-99" }, ownerTok);
  assert.equal(owner.status, 400);
  assert.match(owner.body.error, /ADMIN_PASSWORD_HASH/);
  assert.equal((await s.login(OWNER, OWNER_PASS)).status, 200, "the owner's password still works");

  // Ten wrong tries for one email, then that email is blocked even with the right password
  for (let i = 0; i < 10; i++) assert.equal((await s.login("sam@example.com", "wrong-pass-here")).status, 401);
  const blocked = await s.login("sam@example.com", "brand-new-pass-99");
  assert.equal(blocked.status, 429);
});

// ---------------------------------------------------------------- the ledger

test("every staff change and every sign-in is in the audit ledger, and the chain still verifies", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.ownerToken();
  const made = await s.call("POST", "/api/admin/staff", { name: "Sam", email: "sam@example.com", role: "admin", password: "staff-pass-1234" }, tok);
  const sid = made.body.staff.id;
  await s.call("PUT", `/api/admin/staff/${sid}`, { role: "frontdesk" }, tok);
  await s.call("POST", `/api/admin/staff/${sid}/password`, { password: "brand-new-pass-99" }, tok);
  const staffLogin = await s.login("sam@example.com", "brand-new-pass-99");
  await s.call("POST", "/api/admin/me/password", { current: "brand-new-pass-99", password: "third-password-99" }, staffLogin.body.token);
  await s.call("DELETE", `/api/admin/staff/${sid}`, undefined, tok);

  const log = await s.call("GET", "/api/admin/audit?limit=1000", undefined, tok);
  assert.equal(log.status, 200);
  const entries = log.body.entries;
  const find = (action, actor) => entries.find((e) => e.action === action && (!actor || e.actor === actor));
  for (const action of ["staff.create", "staff.update", "staff.password_reset", "staff.deactivate"]) {
    const e = find(action, `admin:${OWNER}`);
    assert.ok(e, `${action} attributed to the owner`);
    assert.equal(e.subject, sid, action);
  }
  assert.ok(find("staff.password_change", "admin:sam@example.com"), "the staff member's own change is attributed to them");
  assert.ok(find("auth.admin.login", "admin"), "the owner's sign-in");
  assert.ok(find("auth.admin.login", "admin:sam@example.com"), "the staff sign-in names the person");

  const v = await s.call("GET", "/api/admin/audit/verify", undefined, tok);
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, true, v.body.error);
  assert.equal(hasHash(entries), false, "no password hash ever reaches the ledger");
});
