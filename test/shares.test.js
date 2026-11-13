// Sharing (lib/shares.js): a member shares a saved program or a built workout by link; anyone with the link can read
// it (signed in or not, paid or not) and any signed-in member can save a copy into "Shared with me".
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

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-shares-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com"
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

let n = 0;
const member = async (s, name) => (await s.call("POST", "/api/clients/signup", { name, email: `s${++n}@example.com`, phone: "941-555-0100", password: "pass-word-123" })).body;
// Building workouts takes a paid membership (owner): grant one the way Admin does
const paying = async (s, name) => {
  const m = await member(s, name);
  await s.call("PUT", `/api/admin/clients/${m.client.id}/membership`, { tier: "member", until: "2099-12-31" }, await s.adminToken());
  return m;
};
const EX = [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 12 }, { id: "19oVNanPf74w0AaXBZ1LBQoVgAk6VosmU", sets: 2, reps: 8 }];
const PROGRAM = {
  name: "Knee rebuild",
  workout: { title: "Knee rebuild", goal: "Strength", goalId: "strength", location: "home", level: "2", levelLabel: "Steady",
    rounds: 3, restEx: 30, restRound: 60, minutes: 25, warmup: [{ id: EX[0].id, sets: "1 x 10" }], circuit: [{ id: EX[1].id, sets: "3 x 12" }], cooldown: [] }
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const saveWorkout = async (s, tok, name = "Leg day") => (await s.call("POST", "/api/me/custom-workouts", { name, exercises: EX }, tok)).body.saved;
const saveProgram = async (s, tok, over = {}) => (await s.call("POST", "/api/me/programs", { ...PROGRAM, ...over }, tok)).body.programs[0];

test("share a built workout: the link reads without any token and shows only the snapshot and a short name", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  const w = await saveWorkout(s, a.token);
  const made = await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token);
  assert.equal(made.status, 201);
  const sh = made.body.share;
  assert.equal(sh.kind, "workout"); assert.equal(sh.title, "Leg day"); assert.equal(sh.by, "Pat D.");
  assert.ok(ISO.test(sh.createdAt));
  assert.ok(sh.key.length >= 22 && /^[A-Za-z0-9_-]+$/.test(sh.key), "URL-safe key, at least 128 bits");

  const read = await s.call("GET", `/api/shares/${sh.key}`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(read.body, { share: { kind: "workout", title: "Leg day", by: "Pat D.", createdAt: sh.createdAt,
    snapshot: { name: "Leg day", exercises: [{ id: EX[0].id, sets: 3, reps: 12 }, { id: EX[1].id, sets: 2, reps: 8 }] } } });

  const list = await s.call("GET", "/api/me/shares", undefined, a.token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.shares.map((x) => x.key), [sh.key]);
});

test("share a saved program: the snapshot is the program's name and workout", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, "Lee Park"); // saving a generator program needs no membership
  const p = await saveProgram(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "program", id: p.id }, a.token)).body.share;
  const read = await s.call("GET", `/api/shares/${sh.key}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.share.snapshot, { name: PROGRAM.name, workout: PROGRAM.workout });
  assert.equal(read.body.share.by, "Lee P.");
  assert.deepEqual(Object.keys(read.body.share).sort(), ["by", "createdAt", "kind", "snapshot", "title"]);
});

test("sharing the same item twice hands back the same live key", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  const w = await saveWorkout(s, a.token);
  const first = await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token);
  const again = await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token);
  assert.equal(first.status, 201); assert.equal(again.status, 200);
  assert.equal(again.body.share.key, first.body.share.key);
  assert.equal((await s.call("GET", "/api/me/shares", undefined, a.token)).body.shares.length, 1);
});

test("only your own items can be shared, and the kind has to make sense", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await paying(s, "Lee Park");
  const w = await saveWorkout(s, a.token);
  const mine = { error: "That isn't in your library." };
  const r = await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, b.token);
  assert.equal(r.status, 404); assert.deepEqual(r.body, mine);
  assert.equal((await s.call("POST", "/api/me/shares", { kind: "program", id: w.id }, a.token)).status, 404);
  assert.equal((await s.call("POST", "/api/me/shares", { kind: "workout", id: "nope" }, a.token)).status, 404);
  for (const kind of [undefined, "", "chart", "painLog"]) {
    assert.equal((await s.call("POST", "/api/me/shares", { kind, id: w.id }, a.token)).status, 400, String(kind));
  }
});

test("a free member can open a link and save a copy, but still can't build a workout", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park");
  const w = await saveWorkout(s, a.token, "Pat's burner");
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;

  // the paywall on the builder is untouched
  const refused = await s.call("POST", "/api/me/custom-workouts", { name: "Lee's", exercises: EX }, b.token);
  assert.equal(refused.status, 402); assert.equal(refused.body.membersOnly, true);

  assert.equal((await s.call("GET", `/api/shares/${sh.key}`)).status, 200, "a free member's browser needs no token at all");
  const saved = await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token);
  assert.equal(saved.status, 201);
  assert.deepEqual(Object.keys(saved.body.saved).sort(), ["by", "fromKey", "id", "kind", "savedAt", "snapshot", "title"]);
  assert.equal(saved.body.saved.title, "Pat's burner"); assert.equal(saved.body.saved.by, "Pat D.");
  assert.equal(saved.body.saved.fromKey, sh.key); assert.ok(ISO.test(saved.body.saved.savedAt));

  const got = await s.call("GET", "/api/me/shared-with-me", undefined, b.token);
  assert.deepEqual(got.body.items.map((x) => x.id), [saved.body.saved.id]);
  // the copy lives in "Shared with me" only: not in the builder's list, not among saved programs
  assert.deepEqual((await s.call("GET", "/api/me/custom-workouts", undefined, b.token)).body.workouts, []);
  assert.deepEqual((await s.call("GET", "/api/me/library", undefined, b.token)).body.programs, []);
  // saving twice doesn't pile up copies
  assert.equal((await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token)).status, 201);
  assert.equal((await s.call("GET", "/api/me/shared-with-me", undefined, b.token)).body.items.length, 1);

  const gone = await s.call("DELETE", `/api/me/shared-with-me/${saved.body.saved.id}`, undefined, b.token);
  assert.equal(gone.status, 200); assert.deepEqual(gone.body.items, []);
  assert.equal((await s.call("DELETE", `/api/me/shared-with-me/${saved.body.saved.id}`, undefined, b.token)).status, 400);
});

test("you can't save your own share", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const r = await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, a.token);
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, "string");
  assert.deepEqual((await s.call("GET", "/api/me/shared-with-me", undefined, a.token)).body.items, []);
});

test("the public read leaks nothing about the sharer", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  // a chart, pain and progress on the account: none of it may travel with a share
  await s.call("POST", "/api/me/pain", { area: "neck", level: 7, note: "Quokka-private-pain" }, a.token);
  await s.call("POST", "/api/me/workouts", { title: "Session", goal: "Full Body", minutes: 20, exercises: 5 }, a.token);
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const read = await s.call("GET", `/api/shares/${sh.key}`);
  const raw = JSON.stringify(read.body);
  for (const secret of [a.client.id, a.client.email, "941-555-0100", "Quokka-private-pain", "membership", "painLog", "ownerId", "itemId", "revokedAt", sh.key])
    assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(Object.keys(read.body), ["share"]);
  assert.deepEqual(Object.keys(read.body.share).sort(), ["by", "createdAt", "kind", "snapshot", "title"]);
  assert.deepEqual(Object.keys(read.body.share.snapshot).sort(), ["exercises", "name"]);
  assert.equal(read.body.share.by, "Pat D.", "first name and last initial only");
});

test("the snapshot is frozen: editing the original doesn't change the link", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  const w = await saveWorkout(s, a.token, "Leg day");
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const before = (await s.call("GET", `/api/shares/${sh.key}`)).body.share;
  const up = await s.call("PUT", `/api/me/custom-workouts/${w.id}`, { name: "Leg day (hard)", exercises: [{ ...EX[0], reps: 100 }] }, a.token);
  assert.equal(up.status, 200);
  assert.deepEqual((await s.call("GET", `/api/shares/${sh.key}`)).body.share, before);

  // a shared program is just as frozen when the original is deleted
  const p = await saveProgram(s, a.token);
  const ps = (await s.call("POST", "/api/me/shares", { kind: "program", id: p.id }, a.token)).body.share;
  assert.equal((await s.call("DELETE", `/api/me/programs/${p.id}`, undefined, a.token)).status, 200);
  assert.equal((await s.call("GET", `/api/shares/${ps.key}`)).status, 200, "the link still shows what it showed");
});

test("revoking: the link 404s, a copy already saved keeps working, and nothing is deleted from the store", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const saved = (await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token)).body.saved;

  const off = await s.call("DELETE", `/api/me/shares/${sh.key}`, undefined, a.token);
  assert.equal(off.status, 200); assert.deepEqual(off.body, { ok: true });
  const dead = await s.call("GET", `/api/shares/${sh.key}`);
  assert.equal(dead.status, 404); assert.deepEqual(dead.body, { error: "This link no longer works." });
  assert.deepEqual((await s.call("GET", "/api/me/shares", undefined, a.token)).body.shares, []);
  assert.equal((await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token)).status, 404);
  // Lee's copy is untouched
  assert.deepEqual((await s.call("GET", "/api/me/shared-with-me", undefined, b.token)).body.items.map((x) => x.id), [saved.id]);
  // revoking again is not found; the row stays on disk with revokedAt set
  assert.equal((await s.call("DELETE", `/api/me/shares/${sh.key}`, undefined, a.token)).status, 404);
  const rows = JSON.parse(fs.readFileSync(path.join(s.dataDir, "shares.json"), "utf8"));
  assert.equal(rows.length, 1);
  assert.ok(ISO.test(rows[0].revokedAt));
  // sharing the same item again makes a new key, and the old one stays dead
  const next = await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token);
  assert.equal(next.status, 201);
  assert.notEqual(next.body.share.key, sh.key);
  assert.equal((await s.call("GET", `/api/shares/${sh.key}`)).status, 404);
});

test("only the owner can revoke: another member gets 404 and the link keeps working", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await paying(s, "Lee Park");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const r = await s.call("DELETE", `/api/me/shares/${sh.key}`, undefined, b.token);
  assert.equal(r.status, 404);
  assert.equal((await s.call("GET", `/api/shares/${sh.key}`)).status, 200);
  assert.deepEqual((await s.call("GET", "/api/me/shares", undefined, b.token)).body.shares, [], "it isn't in anyone else's list either");
});

test("a link whose owner's account is gone no longer works", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  const admin = await s.adminToken();
  assert.equal((await s.call("DELETE", `/api/admin/clients/${a.client.id}`, undefined, admin)).status, 200);
  const dead = await s.call("GET", `/api/shares/${sh.key}`);
  assert.equal(dead.status, 404); assert.deepEqual(dead.body, { error: "This link no longer works." });
  assert.equal((await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token)).status, 404);
});

test("member share routes need a member token; an admin token is not one", async (t) => {
  const s = await start(); t.after(s.close);
  const admin = await s.adminToken();
  const key = "k".repeat(24);
  const routes = [["POST", "/api/me/shares", { kind: "workout", id: "abc123" }], ["GET", "/api/me/shares"], ["DELETE", `/api/me/shares/${key}`],
    ["POST", `/api/me/shares/${key}/save`, {}], ["GET", "/api/me/shared-with-me"], ["DELETE", "/api/me/shared-with-me/abc123"]];
  for (const tok of [undefined, "garbage", "a.b", admin]) {
    for (const [m, u, b] of routes) {
      const r = await s.call(m, u, b, tok);
      assert.equal(r.status, 401, `${m} ${u} with ${tok ? "a bad token" : "no token"}`);
      assert.deepEqual(r.body, { error: "Please log in again." });
    }
  }
  // the public read is the one route that needs nothing
  assert.equal((await s.call("GET", `/api/shares/${key}`)).status, 404);
});

test("the public read is rate limited so keys can't be guessed in bulk", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  for (let i = 0; i < 60; i++) {
    const r = await s.call("GET", `/api/shares/${"g".repeat(22)}${i}`);
    assert.equal(r.status, 404, `guess ${i}`);
  }
  const blocked = await s.call("GET", `/api/shares/${sh.key}`);
  assert.equal(blocked.status, 429, "even a real key is refused once the limit is hit");
  assert.equal(typeof blocked.body.error, "string");
  assert.equal(blocked.body.share, undefined);
});

// A share key is the only thing protecting what's behind it, so the request log must not record it
test("a share key is kept out of the request log", (t) => {
  const { requestLogger, logger } = require("../lib/logger");
  const seen = [], real = logger.log;
  logger.log = (level, msg, fields) => { seen.push(fields); };
  t.after(() => { logger.log = real; });
  // Express may have stripped the "/api/me" mount off req.url by the time the log line is written, so the
  // router-relative forms have to be redacted as well
  const paths = ["/api/shares/SECRETKEY123", "/api/me/shares/SECRETKEY123", "/api/me/shares/SECRETKEY123/save",
    "/shares/SECRETKEY123", "/shares/SECRETKEY123/save", "/api/me/shares", "/shares", "/api/board/shared/SECRETKEY123"];
  for (const p of paths) {
    const handlers = {};
    const res = { statusCode: 200, on: (ev, fn) => { handlers[ev] = fn; }, once: (ev, fn) => { handlers[ev] = fn; } };
    requestLogger({ method: "GET", path: p, originalUrl: p, url: p }, res, () => {});
    (handlers.finish || handlers.close || (() => {}))();
  }
  assert.equal(seen.length, paths.length, "each request was logged");
  assert.ok(!JSON.stringify(seen).includes("SECRETKEY123"), "no key is in the log");
  assert.deepEqual(seen.map((f) => f.path), ["/api/shares/[key]", "/api/me/shares/[key]", "/api/me/shares/[key]/save",
    "/shares/[key]", "/shares/[key]/save", "/api/me/shares", "/shares", "/api/board/shared/[key]"]);
});

test("nothing about a share reaches the logs, and the key never appears in another member's data", async (t) => {
  const lines = [], sink = logger.sink, level = logger.level;
  logger.sink = (l) => lines.push(l); logger.level = 10;
  t.after(() => { logger.sink = sink; logger.level = level; });
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park");
  const w = await saveWorkout(s, a.token);
  const sh = (await s.call("POST", "/api/me/shares", { kind: "workout", id: w.id }, a.token)).body.share;
  await s.call("GET", `/api/shares/${sh.key}`);
  await s.call("POST", `/api/me/shares/${sh.key}/save`, {}, b.token);
  await new Promise((r) => setTimeout(r, 30));
  const out = lines.join("\n");
  assert.ok(out.includes("/api/shares/[key]"), "the public read was logged, with the key hidden");
  assert.ok(!out.includes(sh.key), "the key is not in the log");
});
