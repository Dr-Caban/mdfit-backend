// The trash: the owner's Delete sets a client aside for 30 days instead of erasing them, Restore puts them back
// as they were, and when the 30 days run out a client with a chart is kept as a "Closed account".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

const VIDEO = "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv";
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-trash-"));
  const clock = { at: new Date("2026-11-02T15:00:00Z") };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => clock.at, siteUrl: "https://mdfit.example.com", trashTimer: false });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const names = async () => ((await call("GET", "/api/admin/clients", undefined, adm)).body.clients || (await call("GET", "/api/admin/clients", undefined, adm)).body).map((c) => c.name);
  const trash = async () => (await call("GET", "/api/admin/clients/trash/list", undefined, adm)).body;
  return { call, adm, clock, names, trash, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
let n = 0;
const signup = async (s, name) => (await s.call("POST", "/api/clients/signup", { name, email: `t${++n}@example.com`, phone: "941-555-0100", password: "pat-pass-123" })).body;

test("delete goes to the trash, the client is locked out and hidden, and restore brings everything back", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s, "Pat Doe");
  await s.call("POST", `/api/admin/emr/${pat.client.id}/movements`, { videoId: VIDEO, name: "Calf Drops", dose: "3 x 12" }, s.adm);
  assert.equal((await s.call("GET", "/api/me/chart", undefined, pat.token)).body.movements.length, 1);

  const del = await s.call("DELETE", `/api/admin/clients/${pat.client.id}`, undefined, s.adm);
  assert.equal(del.status, 200); assert.equal(del.body.trashed, true); assert.equal(del.body.daysLeft, 30); assert.equal(del.body.keepsChart, true);

  assert.equal((await s.names()).includes("Pat Doe"), false, "gone from the client list");
  assert.equal((await s.call("GET", "/api/me/chart", undefined, pat.token)).status, 401, "their session stops");
  assert.equal((await s.call("POST", "/api/clients/login", { email: pat.client.email, password: "pat-pass-123" })).status, 401, "and they cannot sign in");
  assert.equal((await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, s.adm)).status, 404);

  const tr = await s.trash();
  assert.equal(tr.days, 30); assert.equal(tr.trash.length, 1); assert.equal(tr.trash[0].name, "Pat Doe"); assert.equal(tr.trash[0].trashedBy, "coach@example.com");

  // ten days on it is still there, with twenty left
  s.clock.at = new Date("2026-11-12T15:00:00Z");
  assert.equal((await s.trash()).trash[0].daysLeft, 20);

  const back = await s.call("POST", `/api/admin/clients/${pat.client.id}/restore`, {}, s.adm);
  assert.equal(back.status, 200);
  assert.equal((await s.trash()).trash.length, 0);
  assert.equal((await s.names()).includes("Pat Doe"), true);
  const again = (await s.call("POST", "/api/clients/login", { email: pat.client.email, password: "pat-pass-123" })).body;
  assert.ok(again.token, "they sign in with the same password");
  assert.equal((await s.call("GET", "/api/me/chart", undefined, again.token)).body.movements[0].name, "Calf Drops", "the chart came back with them");
  assert.equal((await s.call("POST", `/api/admin/clients/${pat.client.id}/restore`, {}, s.adm)).status, 404, "nothing left to restore");
});

test("after 30 days: a client with a chart is kept as a closed account, one without is removed", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s, "Pat Chart"), plain = await signup(s, "Sam Plain");
  await s.call("POST", `/api/admin/emr/${pat.client.id}/movements`, { videoId: VIDEO, name: "Calf Drops", dose: "3 x 12" }, s.adm);
  await s.call("DELETE", `/api/admin/clients/${pat.client.id}`, undefined, s.adm);
  await s.call("DELETE", `/api/admin/clients/${plain.client.id}`, undefined, s.adm);
  let tr = (await s.trash()).trash;
  assert.deepEqual(tr.map((x) => [x.name, x.keepsChart]).sort(), [["Pat Chart", true], ["Sam Plain", false]]);

  s.clock.at = new Date("2026-12-01T15:00:00Z");   // day 29
  assert.equal((await s.trash()).trash.length, 2, "not a day early");
  s.clock.at = new Date("2026-12-02T15:00:01Z");   // day 30
  assert.equal((await s.trash()).trash.length, 0, "the trash has emptied");

  const names = await s.names();
  assert.equal(names.includes("Pat Chart"), false); assert.equal(names.includes("Sam Plain"), false);
  assert.equal(names.includes("Closed account"), true, "the chart is kept under a closed account");
  const detail = await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, s.adm);
  assert.equal(detail.status, 200); assert.equal(detail.body.movements[0].name, "Calf Drops");
  assert.equal(detail.body.email.endsWith("@mdfit.invalid"), true, "nothing that identifies or opens the account is left");
  assert.equal((await s.call("GET", `/api/admin/emr/${plain.client.id}`, undefined, s.adm)).status, 404);
  assert.equal((await s.call("POST", `/api/admin/clients/${pat.client.id}/restore`, {}, s.adm)).status, 404, "too late to restore");
});

test("restore refuses when someone has taken the email since; the trash needs an admin", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await signup(s, "First Owner");
  await s.call("DELETE", `/api/admin/clients/${a.client.id}`, undefined, s.adm);
  const b = await s.call("POST", "/api/clients/signup", { name: "Second Owner", email: a.client.email, phone: "941-555-0100", password: "pat-pass-456" });
  assert.ok(b.body.token, "the address is free while the first is in the trash");
  const r = await s.call("POST", `/api/admin/clients/${a.client.id}/restore`, {}, s.adm);
  assert.equal(r.status, 409); assert.match(r.body.error, /signed up/);
  assert.equal((await s.trash()).trash.length, 1, "and it stays in the trash");
  assert.equal((await s.call("GET", "/api/admin/clients/trash/list", undefined, b.body.token)).status, 401);
  assert.equal((await s.call("DELETE", `/api/admin/clients/${b.body.client.id}`, undefined, b.body.token)).status, 401);
});
