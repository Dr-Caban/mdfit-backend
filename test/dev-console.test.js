// /dev: the developer console's one answer. Totals only, for the owner and staff with the Developer role.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-dev-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://x.example.com", trashTimer: false });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const login = async (e, p) => (await call("POST", "/api/admin/login", { email: e, password: p })).body.token;
  return { call, login, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("the developer console: totals for the owner and a developer, closed to everyone else, and no person in it", async (t) => {
  const s = await start(); t.after(s.close);
  const owner = await s.login("coach@example.com", "admin-pass-123");
  await s.call("POST", "/api/clients/signup", { name: "Pat Privateperson", email: "pat.private@example.com", phone: "941-555-0100", password: "pat-pass-123" });
  await s.call("PUT", "/api/admin/economics/costs", { costs: [{ name: "Hosting", kind: "system", monthly: 45 }, { name: "Rent", kind: "expense", monthly: 3000 }] }, owner);

  const mk = async (name, email, role) => { const r = await s.call("POST", "/api/admin/staff", { name, email, role, password: "staff-pass-1234" }, owner); assert.equal(r.status, 201, JSON.stringify(r.body)); return s.login(email, "staff-pass-1234"); };
  const dev = await mk("Dev Person", "dev@example.com", "developer");
  const desk = await mk("Desk Person", "desk@example.com", "frontdesk");

  const mine = await s.call("GET", "/api/admin/dev/overview?days=30", undefined, dev);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.usage.accounts.total, 1);
  assert.equal(mine.body.usage.accounts.joined, 1);
  assert.ok(mine.body.activity.total >= 1, "the sign-up was counted");
  assert.ok(mine.body.activity.byType.every((x) => typeof x.type === "string" && Number.isInteger(x.count)));
  assert.deepEqual(mine.body.spending.lines, [{ name: "Hosting", monthly: 4500 }], "system costs only: the practice's rent is not the developer's business");
  assert.equal(mine.body.spending.monthly, 4500);
  assert.ok(mine.body.system.node && mine.body.system.startedAt);

  // nobody is in it: not a name, not an address, not an id
  const raw = JSON.stringify(mine.body);
  for (const secret of ["Privateperson", "pat.private", "@example.com", "941-555"]) assert.equal(raw.includes(secret), false, `"${secret}" must not appear`);

  assert.equal((await s.call("GET", "/api/admin/dev/overview", undefined, owner)).status, 200, "the owner can see it");
  const mgr = await mk("Manager Person", "mgr@example.com", "manager");
  assert.equal((await s.call("GET", "/api/admin/dev/overview", undefined, mgr)).status, 200, "the manager can see it too");
  const no = await s.call("GET", "/api/admin/dev/overview", undefined, desk);
  assert.equal(no.status, 403); assert.equal(no.body.need, "developer");
  assert.equal((await s.call("GET", "/api/admin/dev/overview")).status, 401);
  // and the developer still cannot open what was never theirs
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, dev)).status, 403);
  assert.equal((await s.call("GET", "/api/admin/economics", undefined, dev)).status, 403);
});

test("the developer console counts only memberships that are still running", async (t) => {
  const s = await start(); t.after(s.close);
  const owner = await s.login("coach@example.com", "admin-pass-123");
  for (const [name, email] of [["Ann Active", "ann.active@example.com"], ["Ed Expired", "ed.expired@example.com"], ["Hal Hand", "hal.hand@example.com"]]) await s.call("POST", "/api/clients/signup", { name, email, phone: "941-555-0100", password: "pat-pass-123" });
  const f = path.join(s.dataDir, "clients.json"), list = JSON.parse(fs.readFileSync(f, "utf8"));
  const set = (email, m) => { list.find((c) => c.email === email).membership = m; };
  set("ann.active@example.com", { tier: "member", until: "2999-01-01", stripeSubscriptionId: "sub_a", status: "active" });
  set("ed.expired@example.com", { tier: "member", until: "2020-01-01", stripeSubscriptionId: "sub_e", status: "active" });
  set("hal.hand@example.com", { tier: "member" }); // given by hand, no end
  fs.writeFileSync(f, JSON.stringify(list));
  const r = await s.call("GET", "/api/admin/dev/overview?days=30", undefined, owner);
  assert.equal(r.body.usage.accounts.members, 2, "the expired one is not counted");
});
