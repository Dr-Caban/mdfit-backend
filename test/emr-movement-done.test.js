// A member ticks off a prescribed movement for the day (asked for by the member app: the gem mine on Home shows
// "N movements from Dr. Jared to do today" and had nothing to light them up with).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

const VIDEO = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-done-"));
  const clock = { at: new Date("2026-11-02T15:00:00Z") };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => clock.at, siteUrl: "https://mdfit.example.com" });
  const pings = []; const cc = app.get("calendarChanged"); app.set("calendarChanged", (id, why) => { pings.push([id, why]); if (cc) cc(id, why); });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adm, clock, pings, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
let n = 0;
const signup = async (s) => (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: `d${++n}@example.com`, phone: "941-555-0100", password: "pat-pass-123" })).body;
const prescribe = async (s, id, name) => (await s.call("POST", `/api/admin/emr/${id}/movements`, { videoId: VIDEO, name, dose: "3 x 12" }, s.adm)).body;

test("done for the day: once, shown to the member, taken back, and gone tomorrow", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s), tok = pat.token;
  const a = await prescribe(s, pat.client.id, "Calf Drops"), b = await prescribe(s, pat.client.id, "Toe Walk");
  assert.ok(a.id && b.id, "two movements prescribed");

  let chart = (await s.call("GET", "/api/me/chart", undefined, tok)).body;
  assert.deepEqual(chart.movements.map((m) => m.doneToday), [false, false]);
  assert.equal("done7" in chart.movements[0], false, "the member gets today's answer, not the clinic's tallies");

  s.pings.length = 0;
  let r = await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, tok);
  assert.equal(r.status, 201); assert.equal(r.body.doneToday, true); assert.equal(r.body.date, "2026-11-02");
  assert.deepEqual(r.body.movements.map((m) => m.doneToday), [true, false]);
  assert.deepEqual(s.pings, [[pat.client.id, "chart"]], "the member's open app is told to redraw");

  // saying it again changes nothing and writes nothing
  s.pings.length = 0;
  r = await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, tok);
  assert.equal(r.status, 200); assert.equal(s.pings.length, 0);

  chart = (await s.call("GET", "/api/me/chart", undefined, tok)).body;
  assert.deepEqual(chart.movements.map((m) => m.doneToday), [true, false]);

  // a mis-tap can be taken back the same day
  r = await s.call("DELETE", `/api/me/chart/movements/${a.id}/done`, undefined, tok);
  assert.equal(r.status, 200); assert.equal(r.body.doneToday, false);
  await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, tok);

  // tomorrow it is to do again
  s.clock.at = new Date("2026-11-03T15:00:00Z");
  chart = (await s.call("GET", "/api/me/chart", undefined, tok)).body;
  assert.deepEqual(chart.movements.map((m) => m.doneToday), [false, false]);
});

test("Dr. Jared sees it on the chart; nobody can tick someone else's or one that was removed", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s), other = await signup(s);
  const a = await prescribe(s, pat.client.id, "Calf Drops");
  await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, pat.token);
  s.clock.at = new Date("2026-11-03T15:00:00Z");
  await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, pat.token);

  const detail = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, s.adm)).body;
  assert.equal(detail.movements[0].done7, 2); assert.equal(detail.movements[0].lastDone, "2026-11-03"); assert.equal(detail.movements[0].doneToday, true);

  assert.equal((await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, other.token)).status, 404, "not in the other member's plan");
  assert.equal((await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {})).status, 401);
  await s.call("DELETE", `/api/admin/emr/${pat.client.id}/movements/${a.id}`, undefined, s.adm);
  assert.equal((await s.call("POST", `/api/me/chart/movements/${a.id}/done`, {}, pat.token)).status, 404, "a removed movement can't be ticked");

  // kept inside the encrypted chart: the stored file shows neither the movement nor the dates in the clear
  const raw = fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8");
  assert.equal(raw.includes("Calf Drops"), false); assert.equal(raw.includes('"done"'), false);
});
