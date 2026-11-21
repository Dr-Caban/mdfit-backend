// A rep count for each set (owner, Nov 2026): the builder may give every set its own reps (e.g. 12, 10, 8, 6). It
// must name every set; equal counts fold back to a plain "reps"; the counts travel with challenges and share links.
// Also: every exercise in Dr. Jared's fixed program circuits uses its exact library name.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { customInput } = require("../lib/custom-workouts");
const { defaultContent } = require("../lib/content");
logger.level = 99;

test("customInput: per-set reps are kept, checked and folded when all equal", () => {
  const a = customInput({ name: "Pyramid", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 4, reps: 12, repsBySet: [12, 10, 8, 6] }] });
  assert.deepEqual(a.exercises[0], { id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 4, reps: 12, repsBySet: [12, 10, 8, 6] });
  const b = customInput({ name: "Flat", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 10, repsBySet: [10, 10, 10] }] });
  assert.deepEqual(b.exercises[0], { id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 10 });
  const c = customInput({ name: "Plain", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 10 }] });
  assert.deepEqual(c.exercises[0], { id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 10 });
  assert.throws(() => customInput({ name: "x", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, repsBySet: [12, 10] }] }), /each of its 3 sets/);
  assert.throws(() => customInput({ name: "x", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 2, repsBySet: [12, 0] }] }), /set 2 reps must be 1 to 100/);
  assert.throws(() => customInput({ name: "x", exercises: [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 2, repsBySet: "12,10" }] }), /each of its 2 sets/);
});

test("per-set reps are saved, sent as a challenge and shared by link", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-rbs-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const a = (await call("POST", "/api/clients/signup", { name: "Ann Lee", email: "a@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    const b = (await call("POST", "/api/clients/signup", { name: "Bo Kim", email: "b@example.com", phone: "941-555-0101", password: "pass-word-123" })).body;
    await call("PUT", `/api/admin/clients/${a.client.id}/membership`, { tier: "member", until: "2099-12-31" }, admin);
    const ex = [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 4, reps: 12, repsBySet: [12, 10, 8, 6] }];
    const saved = await call("POST", "/api/me/custom-workouts", { name: "Pyramid", exercises: ex }, a.token);
    assert.equal(saved.status, 201); assert.deepEqual(saved.body.saved.exercises[0].repsBySet, [12, 10, 8, 6]);
    const wid = saved.body.saved.id;
    const ch = await call("POST", "/api/me/challenges", { workoutId: wid, toId: b.client.id }, a.token);
    assert.equal(ch.status, 201);
    const inbox = (await call("GET", "/api/me/challenges", undefined, b.token)).body.open;
    assert.deepEqual(inbox[0].workout.exercises[0].repsBySet, [12, 10, 8, 6]);
    const sh = await call("POST", "/api/me/shares", { kind: "workout", id: wid }, a.token);
    const pub = await call("GET", "/api/shares/" + sh.body.share.key);
    assert.deepEqual(pub.body.share.snapshot.exercises[0].repsBySet, [12, 10, 8, 6]);
    const bad = await call("PUT", "/api/me/custom-workouts/" + wid, { name: "Pyramid", exercises: [{ ...ex[0], repsBySet: [12, 10] }] }, a.token);
    assert.equal(bad.status, 400);
  } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("Dr. Jared's fixed program circuits use exact library names", () => {
  // The library is the app's exercise list (mdfit-frontend app/exercises.js). These are the only circuit entries with
  // no video yet: lifestyle items and movements not filmed. Anything else must match a library name exactly.
  const NO_VIDEO = new Set(["Zone 2 Cardio (Walk, Bike, Row)", "Acupressure Mat", "Walk Outdoors", "Sauna or Hot Bath",
    "Eccentric Dumbbell Shrug Drop", "Side Plank (Modified)", "Knee Drive (Radiating Pain Only)", "Posterior Pelvic Tilts",
    "Heel Slides", "Bent Knee Fall-Outs", "Supine Marches", "Wall Squats (Quarter Depth)", "Pelvic Floor Activation",
    "Ankle Rocking Mobility", "Golf Stance Weight Shift", "Lateral Step Down", "Shoulder Set", "Side Plank", "Lateral Shuffle",
    "Split Step + Shadow Volley"]);
  const LIB = new Set(["Strict Press", "Bench Press", "Lat Pulldown", "TRX Squat", "Pole Squat", "Burpee", "Pistol Squat", "Cossack Squat", "Bear Crawl"]);
  const psg = defaultContent().programs.find((p) => p.id === "hypertrophy-12");
  for (const d of psg.days) for (const x of d.circuit || []) assert.ok(!/\(DB\)|Pull-Down|TRX Body|Sit-Ups/.test(x.ex), `PSG still says ${x.ex}`);
  assert.deepEqual(psg.days[0].circuit.map((x) => x.ex), ["Strict Press", "Bench Press", "Lat Pulldown"]);
  assert.ok(psg.days[1].circuit.every((x) => LIB.has(x.ex)), JSON.stringify(psg.days[1].circuit.map((x) => x.ex)));
  const lib = (() => { try { const w = {}; require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "../../mdfit-frontend/app/exercises.js"), "utf8"), { window: w }); return new Set(w.MDFIT_EXERCISES.map((e) => e.name)); } catch { return null; } })();
  if (!lib) return; // the app repo isn't beside this one (CI): the PSG checks above still ran
  const off = [];
  for (const p of defaultContent().programs) for (const d of p.days || []) for (const x of d.circuit || []) if (!lib.has(x.ex) && !NO_VIDEO.has(x.ex)) off.push(`${p.id}: ${x.ex}`);
  assert.deepEqual(off, []);
});
