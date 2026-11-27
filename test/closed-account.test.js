// A closed account ("Close my account" with a chart kept: the record stays for the practice, everything that identifies
// or opens the account goes). What other members and the public can still see of it: its share links and its row on
// the leaderboard. Both must answer as for an account that was erased. Made-up people only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-closed-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  let n = 0;
  const member = async (name) => (await call("POST", "/api/clients/signup", { name, email: `closed${++n}@example.com`, password: "pass-word-123" })).body;
  const close = (m) => call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pass-word-123" }, m.token);
  const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, "clients.json"), "utf8"));
  return { call, admin, member, close, stored };
}
const PROGRAM = { name: "Knee rebuild", workout: { title: "Knee rebuild", goal: "Strength", goalId: "strength", location: "home", level: "2", levelLabel: "Steady",
  rounds: 3, restEx: 30, restRound: 60, minutes: 25, warmup: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: "1 x 10" }], circuit: [{ id: "19oVNanPf74w0AaXBZ1LBQoVgAk6VosmU", sets: "3 x 12" }], cooldown: [] } };

test("a closed account's share link answers exactly as an erased account's does", async (t) => {
  const s = await start(t);
  const reader = await s.member("Rae Reader");
  // A saved generator program: needs no membership (a membership is a paid record, and would keep the account as closed)
  const linkOf = async (m) => {
    const p = (await s.call("POST", "/api/me/programs", PROGRAM, m.token)).body.programs[0];
    const made = await s.call("POST", "/api/me/shares", { kind: "program", id: p.id }, m.token);
    assert.equal(made.status, 201); return made.body.share.key;
  };
  const answers = async (key) => {
    const pub = await s.call("GET", `/api/shares/${key}`), save = await s.call("POST", `/api/me/shares/${key}/save`, {}, reader.token);
    return { pub: [pub.status, pub.body], save: [save.status, save.body] };
  };
  // Erin never had a chart: closing erases her. Cleo has one (a check-in): closing keeps her record as "Closed account".
  const erin = await s.member("Erin Erased"), cleo = await s.member("Cleo Closed");
  const erinKey = await linkOf(erin), cleoKey = await linkOf(cleo);
  assert.equal((await s.call("GET", `/api/shares/${cleoKey}`)).body.share.by, "Cleo C.", "open while the account is");
  await s.call("POST", "/api/me/pain", { area: "Knee", level: 3 }, cleo.token);
  assert.equal((await s.close(erin)).body.mode, "erase");
  assert.equal((await s.close(cleo)).body.mode, "close");
  assert.ok(s.stored().find((c) => c.id === cleo.client.id).deletedAt, "her record is still in the list, closed");

  const erased = await answers(erinKey), closed = await answers(cleoKey);
  assert.deepEqual(erased, { pub: [404, { error: "This link no longer works." }], save: [404, { error: "This link no longer works." }] });
  assert.deepEqual(closed, erased, "the same answer, and no name");
  assert.equal((await s.call("GET", "/api/me/shared-with-me", undefined, reader.token)).body.items.length, 0, "nothing was saved from either");
});

test("a closed account leaves the leaderboard at once, and no longer counts in anyone's overall rank", async (t) => {
  const s = await start(t);
  const cleo = await s.member("Cleo Carr"), zed = await s.member("Zelda Quinn");
  for (const m of [cleo, cleo, zed]) assert.equal((await s.call("POST", "/api/me/workouts", { title: "Session", minutes: 20, exercises: 3 }, m.token)).status, 201);
  await s.call("POST", "/api/me/pain", { area: "Knee", level: 3 }, cleo.token); // a chart: closing keeps the record
  const board = async () => (await s.call("GET", "/api/me/leaderboard?league=all&period=all", undefined, zed.token)).body;
  const before = await board();
  assert.deepEqual(before.top.map((x) => x.name), ["Cleo C.", "Zelda Q."]);
  assert.equal(before.total, 2);
  assert.equal((await s.close(cleo)).body.mode, "close");
  const after = await board(); // asked straight away: the minute's cache does not hold her row
  assert.deepEqual(after.top.map((x) => x.name), ["Zelda Q."], "no row for her, under her name or as Closed account");
  assert.equal(after.total, 1); assert.deepEqual(after.me, { rank: 1, score: after.me.score });
  const rank = (await s.call("GET", `/api/admin/clients/${zed.client.id}`, undefined, s.admin)).body.rewards.overall;
  assert.deepEqual([rank.rank, rank.total], [1, 1], "overall rank counts open accounts only");
});
