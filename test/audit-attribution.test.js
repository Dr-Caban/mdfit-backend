// The descriptive ledger entries for patient records (emr.view, emr.summary ...) name the person who acted,
// owner or staff, instead of a generic "admin" that has to be paired with the request-level entry to learn who.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { adminActor } = require("../lib/audit");
logger.level = 99;

const OWNER = "coach@example.com", OWNER_PASS = "admin-pass-123";
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-attr-"));
  const app = createApp({ adminEmail: OWNER, adminPasswordHash: hashPassword(OWNER_PASS), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", siteUrl: "https://x.example.com", now: () => new Date("2026-11-02T15:00:00Z") });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m,
    headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const login = async (e, p) => (await call("POST", "/api/admin/login", { email: e, password: p })).body.token;
  return { call, login, close: () => new Promise((r) => server.close(r)) };
}

test("adminActor names the person, and falls back only when there is nobody to name", () => {
  assert.equal(adminActor({ admin: "sam@example.com" }), "admin:sam@example.com");
  assert.equal(adminActor({}), "admin");
  assert.equal(adminActor(undefined), "admin");
});

test("opening and changing a chart is recorded against whoever did it", async (t) => {
  const s = await start(); t.after(s.close);
  const owner = await s.login(OWNER, OWNER_PASS);
  const pat = (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body.client;
  assert.ok(pat && pat.id, "a patient to open");

  // a clinician with chart access
  const made = await s.call("POST", "/api/admin/staff", { name: "Dr Who", email: "who@example.com", role: "clinician", password: "clin-pass-1234" }, owner);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const clin = await s.login("who@example.com", "clin-pass-1234");

  assert.equal((await s.call("GET", `/api/admin/emr/${pat.id}`, undefined, clin)).status, 200);   // the clinician looks
  assert.equal((await s.call("GET", `/api/admin/emr/${pat.id}`, undefined, owner)).status, 200);  // then the owner does

  const led = await s.call("GET", `/api/admin/audit?subject=${pat.id}&limit=100`, undefined, owner);
  assert.equal(led.status, 200, JSON.stringify(led.body).slice(0, 200));
  const views = (led.body.entries || []).filter((e) => e.action === "emr.view");
  assert.ok(views.length >= 2, "both looks are on the ledger");
  const actors = views.map((e) => e.actor);
  assert.ok(actors.includes("admin:who@example.com"), `the clinician's look carries their name (${actors.join(", ")})`);
  assert.ok(actors.includes(`admin:${OWNER}`), "and the owner's carries theirs");
  assert.equal(actors.includes("admin"), false, "nothing is left as a nameless admin");
});
