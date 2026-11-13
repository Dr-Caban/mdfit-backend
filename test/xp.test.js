// XP upgrade (owner, Nov 2026): gem levels at every boundary, workout XP (30 / 35 / 40 challenge / 50 program, the day's
// best workout once a day), the workout builder, challenges (+5 sender once a day, +10 recipient), hidden members not
// challengeable, and the "#N overall" ranking.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const R = require("../lib/rewards");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start() {
  const prev = process.env.LEADERBOARD_PACERS; process.env.LEADERBOARD_PACERS = "off";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-xp-"));
  const clock = { at: new Date("2026-11-02T13:00:00Z") };
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => clock.at, siteUrl: "https://mdfit.example.com"
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const setDay = (date, hour = 8) => { clock.at = new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 5) * 36e5); };
  return { call, adminToken, dataDir, setDay, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); if (prev === undefined) delete process.env.LEADERBOARD_PACERS; else process.env.LEADERBOARD_PACERS = prev; } };
}
let n = 0;
const member = async (s, name) => (await s.call("POST", "/api/clients/signup", { name, email: `m${++n}@example.com`, phone: "941-555-0100", password: "pass-word-123" })).body;
// Building workouts and sending challenges take a paid membership (owner): grant one the way Admin does
const paying = async (s, name) => { const m = await member(s, name); await s.call("PUT", `/api/admin/clients/${m.client.id}/membership`, { tier: "member", until: "2027-12-31" }, await s.adminToken()); return m; };
const log = (s, tok, over = {}) => s.call("POST", "/api/me/workouts", { title: "Session", goal: "Full Body", minutes: 20, exercises: 5, ...over }, tok);
const rw = async (s, tok) => (await s.call("GET", "/api/me/rewards", undefined, tok)).body;
const day = (d) => `2026-11-${String(d).padStart(2, "0")}`;
const EX = [{ id: "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", sets: 3, reps: 12 }, { id: "19oVNanPf74w0AaXBZ1LBQoVgAk6VosmU", sets: 2, reps: 8 }];
// Workout XP for a day, without the one-off "First Rep" badge bonus
const workoutXp = (r) => r.todayParts.workouts;

test("gem levels at every boundary", () => {
  const cases = [[0, "Peridot", 1], [50, "Peridot", 1], [51, "Amber", 2], [500, "Amber", 2], [501, "Amethyst", 3], [2500, "Amethyst", 3], [2501, "Emerald", 4],
    [7500, "Emerald", 4], [7501, "Ruby", 5], [15000, "Ruby", 5], [15001, "Sapphire", 6], [30000, "Sapphire", 6], [30001, "Diamond", 7], [60000, "Diamond", 7], [60001, "Platinum", 8], [1e6, "Platinum", 8]];
  for (const [xp, name, level] of cases) {
    assert.equal(R.gemstoneOf(xp).current.name, name, `${xp} XP`);
    assert.equal(R.levelOf(xp), level, `${xp} XP level`);
  }
  assert.deepEqual(R.GEMS.map((g) => g.xp), [0, 51, 501, 2501, 7501, 15001, 30001, 60001]);
  assert.equal(R.gemstoneOf(50).xpToNext, 1); assert.equal(R.gemstoneOf(50).next.name, "Amber");
  assert.equal(R.gemstoneOf(60001).next, null); assert.equal(R.gemstoneOf(60001).progress, 1);
  // through rewards(): 5 activities of 10 on one day = 50 → Peridot; one more XP → Amber
  const acts = (n) => Array.from({ length: n }, (_, i) => ({ date: day(1 + Math.floor(i / 5)), habitId: "a" + (i % 5), points: 10 }));
  assert.equal(R.rewards({ activities: acts(5) }, day(30)).xp, 50);
  assert.equal(R.rewards({ activities: acts(5) }, day(30)).title, "Peridot");
  const r = R.rewards({ activities: [...acts(5), { date: day(9), habitId: "x", points: 1 }] }, day(30));
  assert.equal(r.xp, 51); assert.equal(r.title, "Amber"); assert.equal(r.level, 2); assert.equal(r.nextLevel, 501);
});

test("workout XP: 30 normal, 35 built yourself, 50 Dr. Jared program; the day's best counts once", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  // normal (generator / today's workout): 30, a second one the same day adds 0
  let w = await log(s, a.token, { key: "full-body-power" });
  assert.equal(w.body.workout.kind, "normal");
  assert.equal(workoutXp(await rw(s, a.token)), 30);
  await log(s, a.token);
  assert.equal(workoutXp(await rw(s, a.token)), 30, "second normal workout: no extra base XP");
  // built yourself: 35. Same day after a normal one: the day's best counts (35), not 30 + 35
  const saved = (await s.call("POST", "/api/me/custom-workouts", { name: "Leg day", exercises: EX }, a.token)).body.saved;
  w = await log(s, a.token, { key: `custom-${saved.id}` });
  assert.equal(w.body.workout.kind, "custom"); assert.equal(w.body.workout.ref, saved.id);
  assert.equal(workoutXp(await rw(s, a.token)), 35);
  // someone else's custom id doesn't count as yours
  const b = await paying(s, "Lee Park");
  const bw = (await s.call("POST", "/api/me/custom-workouts", { name: "B's", exercises: EX }, b.token)).body.saved;
  s.setDay(day(3));
  assert.equal((await log(s, a.token, { key: `custom-${bw.id}` })).body.workout.kind, "normal");
  assert.equal(workoutXp(await rw(s, a.token)), 30);
  // Dr. Jared program (content program, day or week key): 50 total
  s.setDay(day(4));
  w = await log(s, a.token, { key: "prog-shoulder-6-d0" });
  assert.equal(w.body.workout.kind, "program"); assert.equal(w.body.workout.ref, "shoulder-6");
  assert.equal(workoutXp(await rw(s, a.token)), 50);
  await log(s, a.token, { key: `custom-${saved.id}` });
  assert.equal(workoutXp(await rw(s, a.token)), 50, "a custom workout after a program the same day adds nothing");
  s.setDay(day(5));
  assert.equal((await log(s, a.token, { key: "prog-made-up-d0" })).body.workout.kind, "normal", "unknown program");
  // lifetime: day 2 (35) + day 3 (30) + day 4 (50) + day 5 (30), plus badges First Rep, On a Roll, Three-a-Week (25 each)
  const life = await rw(s, a.token);
  assert.deepEqual(life.badges.filter((x) => x.earned).map((x) => x.id), ["first-workout", "streak-3", "week-3"]);
  assert.equal(life.xp, 35 + 30 + 50 + 30 + 3 * 25);
});

test("workout builder: save, edit, delete, validation", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe");
  assert.equal((await s.call("GET", "/api/me/custom-workouts")).status, 401);
  assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: "", exercises: EX }, a.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: "X", exercises: [] }, a.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: "X", exercises: [{ id: "bad id", sets: 3, reps: 10 }] }, a.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: "X", exercises: [{ ...EX[0], sets: 11 }] }, a.token)).status, 400);
  const r = await s.call("POST", "/api/me/custom-workouts", { name: "  Leg day ", exercises: EX }, a.token);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.saved.exercises, [{ id: EX[0].id, sets: 3, reps: 12 }, { id: EX[1].id, sets: 2, reps: 8 }]);
  // owner: movements are always a rep count, never a time
  const timed = await s.call("POST", "/api/me/custom-workouts", { name: "Hold", exercises: [{ ...EX[0], reps: undefined, seconds: 45 }] }, a.token);
  assert.equal(timed.status, 400); assert.match(timed.body.error, /rep count/i);
  assert.equal(r.body.saved.name, "Leg day");
  const id = r.body.saved.id;
  const up = await s.call("PUT", `/api/me/custom-workouts/${id}`, { name: "Leg day 2", exercises: [EX[1], EX[0]] }, a.token);
  assert.equal(up.body.saved.name, "Leg day 2"); assert.equal(up.body.saved.exercises[0].id, EX[1].id, "order kept");
  assert.equal((await s.call("GET", "/api/me/custom-workouts", undefined, a.token)).body.workouts.length, 1);
  assert.equal((await s.call("DELETE", `/api/me/custom-workouts/${id}`, undefined, a.token)).body.workouts.length, 0);
  assert.equal((await s.call("DELETE", `/api/me/custom-workouts/${id}`, undefined, a.token)).status, 400);
});

test("challenges: sender +5 once a day, recipient 30 + 10 = 40, once per challenge; no health info", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park"), c = await member(s, "Kim Ray");
  // Lee is a free account with no XP (not on the leaderboard) and can still be challenged (owner: anyone)
  for (const m of [a, c]) await s.call("POST", "/api/me/habits/checkin", { habitId: "prayer" }, m.token);
  const mine = (await s.call("POST", "/api/me/custom-workouts", { name: "Pat's burner", exercises: EX }, a.token)).body.saved;
  const pool = (await s.call("GET", "/api/me/challenges/members", undefined, a.token)).body.members;
  assert.deepEqual(pool.map((m) => m.name), ["Kim R.", "Lee P."], "pool excludes yourself; first name + last initial only");
  assert.ok(pool.every((m) => Object.keys(m).sort().join() === "gem,id,name"));
  assert.equal(pool.find((m) => m.name === "Lee P.").gem, null, "unranked: no gem"); assert.ok(pool.find((m) => m.name === "Kim R.").gem, "ranked: gem shown");
  // a free member can't build or send, but is listed, receives and (below) does challenges for XP
  const refused = await s.call("POST", "/api/me/custom-workouts", { name: "Lee's", exercises: EX }, b.token);
  assert.equal(refused.status, 402); assert.equal(refused.body.membersOnly, true);
  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: c.client.id }, b.token)).status, 402);
  assert.deepEqual((await s.call("GET", "/api/me/challenges/members", undefined, b.token)).body.members.map((m) => m.name), ["Kim R.", "Pat D."], "free members see the pool too");
  const lee = pool.find((m) => m.name === "Lee P."), kim = pool.find((m) => m.name === "Kim R.");

  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: "nope", toId: lee.id }, a.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: a.client.id }, a.token)).status, 404, "not yourself");
  let r = await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: lee.id }, a.token);
  assert.equal(r.status, 201); assert.equal(r.body.xpEarned, 5);
  const chId = r.body.challenge.id;
  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: lee.id }, a.token)).status, 409, "already waiting");
  r = await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: kim.id }, a.token);
  assert.equal(r.status, 201); assert.equal(r.body.xpEarned, 0, "+5 once a day");
  let ar = await rw(s, a.token);
  assert.equal(ar.todayParts.workouts, 5); assert.equal(ar.xp, 5 + 5); // prayer check-in 5 + challenge sent 5
  // the auto item shows as done for the sender
  assert.equal((await s.call("GET", "/api/me/habits/today", undefined, a.token)).body.habits.find((h) => h.id === "challenge-send").done, true);

  // recipient sees it: sender's short name and the workout (exercise ids, sets/reps) only
  const inbox = (await s.call("GET", "/api/me/challenges", undefined, b.token)).body;
  assert.equal(inbox.open.length, 1);
  assert.deepEqual(Object.keys(inbox.open[0]).sort(), ["doneOn", "from", "id", "incoming", "sentOn", "status", "to", "workout"]);
  assert.equal(inbox.open[0].from, "Pat D."); assert.equal(inbox.open[0].workout.name, "Pat's burner");
  assert.deepEqual(Object.keys(inbox.open[0].workout).sort(), ["exercises", "name"]);
  const raw = fs.readFileSync(path.join(s.dataDir, "challenges.json"), "utf8");
  assert.ok(!/pain|email|phone|@example/i.test(raw), "nothing about health or contact details in challenges");
  // someone else can't claim Lee's challenge
  assert.equal((await log(s, c.token, { key: `challenge-${chId}` })).body.workout.kind, "normal");

  // Lee does it: 30 + 10 = 40
  const w = await log(s, b.token, { key: `challenge-${chId}` });
  assert.equal(w.body.workout.kind, "challenge");
  let br = await rw(s, b.token);
  assert.equal(br.todayParts.workouts, 40);
  assert.equal((await s.call("GET", "/api/me/habits/today", undefined, b.token)).body.habits.find((h) => h.id === "challenge-do").done, true);
  const after = (await s.call("GET", "/api/me/challenges", undefined, b.token)).body;
  assert.equal(after.open.length, 0); assert.equal(after.done[0].status, "done");
  assert.equal((await s.call("GET", "/api/me/challenges", undefined, a.token)).body.sent.find((x) => x.id === chId).status, "done", "sender sees it done");
  // doing the same challenge again the next day: a normal 30, no second bonus
  s.setDay(day(3));
  await log(s, b.token, { key: `challenge-${chId}` });
  br = await rw(s, b.token);
  assert.equal(br.todayParts.workouts, 30);
  // the sender can send again the next day for another +5
  const again = await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: lee.id }, a.token);
  assert.equal(again.status, 201); assert.equal(again.body.xpEarned, 5);
  ar = await rw(s, a.token); assert.equal(ar.todayParts.workouts, 5);
});

test("hidden members can't be challenged or listed", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park");
  const mine = (await s.call("POST", "/api/me/custom-workouts", { name: "Burner", exercises: EX }, a.token)).body.saved;
  assert.equal((await s.call("GET", "/api/me/challenges/members", undefined, a.token)).body.members.length, 1);
  await s.call("PUT", "/api/me/leaderboard/visibility", { hidden: true }, b.token);
  assert.deepEqual((await s.call("GET", "/api/me/challenges/members", undefined, a.token)).body.members, []);
  const r = await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: b.client.id }, a.token);
  assert.equal(r.status, 404); assert.match(r.body.error, /isn't available/);
  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: "000000000000" }, a.token)).status, 404, "unknown looks the same as hidden");
  assert.equal((await rw(s, a.token)).todayParts.workouts, 0, "no +5 for a refused send");
});

test("overall ranking: #N by lifetime XP on rewards, an all-leagues all-time board, and in admin", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, "Pat Doe"), b = await member(s, "Lee Park"), c = await member(s, "Kim Ray");
  await log(s, a.token); // 55
  await s.call("POST", "/api/me/habits/checkin", { habitId: "yoga" }, b.token); // 10
  await log(s, c.token, { key: "prog-shoulder-6-d0" }); // 75
  let r = await rw(s, a.token);
  assert.deepEqual(r.overall, { rank: 2, total: 3, hidden: false });
  assert.equal(r.rank.current.name, "Amber"); assert.equal(r.rank.xpToNext, 501 - 55);
  const board = (await s.call("GET", "/api/me/leaderboard?period=all&league=all", undefined, a.token)).body;
  assert.equal(board.league, "all");
  assert.deepEqual(board.top.map((x) => [x.rank, x.name, x.score, x.gem.name]), [[1, "Kim R.", 75, "Amber"], [2, "Pat D.", 55, "Amber"], [3, "Lee P.", 10, "Peridot"]]);
  assert.equal(board.me.rank, r.overall.rank, "Home's #N matches the full board");
  assert.equal(board.olympicGem, "Emerald");
  // a hidden member still sees their own rank privately and isn't counted for others
  await s.call("PUT", "/api/me/leaderboard/visibility", { hidden: true }, c.token);
  assert.deepEqual((await rw(s, c.token)).overall, { rank: 1, total: 3, hidden: true });
  const at = await s.adminToken();
  const d = (await s.call("GET", `/api/admin/clients/${a.client.id}`, undefined, at)).body;
  assert.equal(d.rewards.xp, 55); assert.equal(d.rewards.gem.name, "Amber"); assert.equal(d.rewards.overall.rank >= 1, true);
});

test("accountability membership: $1 off per active day, 20 days takes $29.95 down to the $10 floor", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, "Pat Doe");
  await s.call("PUT", `/api/admin/clients/${a.client.id}/membership`, { tier: "accountability", until: "2027-12-31" }, await s.adminToken());
  s.setDay(day(1));
  let r = (await s.call("GET", "/api/me/accountability", undefined, a.token)).body;
  assert.equal(r.enabled, true); assert.equal(r.price, 29.95); assert.equal(r.floor, 10); assert.equal(r.credit, 0); assert.equal(r.owed, 29.95);
  for (let d = 1; d <= 3; d++) { s.setDay(day(d)); await log(s, a.token); }
  r = (await s.call("GET", "/api/me/accountability", undefined, a.token)).body;
  assert.equal(r.activeDays, 3); assert.equal(r.credit, 3); assert.equal(r.owed, 26.95); assert.equal(r.atFloor, false);
  for (let d = 4; d <= 25; d++) { s.setDay(day(d)); await log(s, a.token); }
  r = (await s.call("GET", "/api/me/accountability", undefined, a.token)).body;
  assert.equal(r.activeDays, 25); assert.equal(r.credit, 19.95, "credit stops at 20 days and at the floor"); assert.equal(r.owed, 10, "never below the floor"); assert.equal(r.atFloor, true); assert.equal(r.free, false);
  // the flat membership has no credit
  await s.call("PUT", `/api/admin/clients/${a.client.id}/membership`, { tier: "member", until: "2027-12-31" }, await s.adminToken());
  assert.equal((await s.call("GET", "/api/me/accountability", undefined, a.token)).body.enabled, false);
  // the default lineup the app shows
  const tiers = (await s.call("GET", "/api/content")).body.tiers;
  assert.deepEqual(tiers.map((x) => [x.id, x.price, x.meetings || 0]), [["member", 19.95, 0], ["accountability", 29.95, 0], ["expert", 50, 0], ["premium", 200, 2], ["premium-plus", 349, 4]]);
});

test("admin sees each client's activity: the 30-day count in the list and a day-by-day series on the profile", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, "Pat Doe"), adm = await s.adminToken();
  s.setDay(day(1)); await log(s, a.token);
  s.setDay(day(2)); await log(s, a.token); await s.call("POST", "/api/me/habits/checkin", { habitId: "prayer" }, a.token);
  s.setDay(day(4)); await s.call("POST", "/api/me/pain", { area: "Knee", level: 4 }, a.token);
  s.setDay(day(6)); await s.call("POST", "/api/me/habits/checkin", { habitId: "yoga" }, a.token);
  s.setDay(day(10));
  const row = (await s.call("GET", "/api/admin/clients", undefined, adm)).body.find((x) => x.id === a.client.id);
  assert.equal(row.active30, 4, "4 distinct active days: workout, workout + check-in, pain log, check-in");
  const r = (await s.call("GET", `/api/admin/clients/${a.client.id}/activity?days=10`, undefined, adm)).body;
  assert.equal(r.days.length, 10); assert.equal(r.days[0].date, day(1)); assert.equal(r.days[9].date, day(10));
  assert.deepEqual(r.days.map((d) => d.active), [true, true, false, true, false, true, false, false, false, false]);
  assert.equal(r.days[0].workouts, 1); assert.equal(r.days[0].xp, 30); assert.equal(r.days[1].xp, 35, "workout 30 + prayer 5"); assert.equal(r.days[3].pain, 1); assert.equal(r.days[3].xp, 0);
  assert.equal(r.summary.active30, 4); assert.equal(r.summary.lastActive, day(6)); assert.equal(r.summary.firstActive, day(1)); assert.equal(r.summary.workouts30, 2);
  assert.equal((await s.call("GET", "/api/admin/clients/nope/activity", undefined, adm)).status, 404);
  assert.equal((await s.call("GET", `/api/admin/clients/${a.client.id}/activity`, undefined, a.token)).status, 401, "members can't read it");
});

test("admin overview: one call with everything about a client", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await paying(s, "Pat Doe"), b = await member(s, "Lee Park"), adm = await s.adminToken();
  s.setDay(day(2)); await log(s, a.token); await s.call("POST", "/api/me/habits/checkin", { habitId: "prayer" }, a.token);
  const mine = (await s.call("POST", "/api/me/custom-workouts", { name: "Pat's burner", exercises: EX }, a.token)).body.saved;
  await s.call("POST", "/api/me/challenges", { workoutId: mine.id, toId: b.client.id }, a.token);
  s.setDay(day(3)); await log(s, a.token, { key: `custom-${mine.id}` }); await s.call("POST", "/api/me/pain", { area: "Knee", level: 5 }, a.token);
  s.setDay(day(5)); await s.call("POST", "/api/me/pain", { area: "Knee", level: 3 }, a.token); await s.call("PUT", "/api/me/favorites/1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", {}, a.token);
  const ov = await s.call("GET", `/api/admin/clients/${a.client.id}/overview`, undefined, adm); assert.equal(ov.status, 200, JSON.stringify(ov.body)); const o = ov.body;
  assert.equal(o.client.name, "Pat Doe"); assert.equal(o.membership.tier, "member");
  assert.equal(o.workouts.total, 2); assert.deepEqual(o.workouts.byKind, { program: 0, custom: 1, challenge: 0, normal: 1 }); assert.equal(o.workouts.recent[0].kind, "custom");
  assert.ok(o.rewards.xp >= 30 + 5 + 5 + 35, "normal 30 + prayer 5 + challenge sent 5 + custom 35, plus badge bonuses"); assert.equal(o.rewards.gem.name, "Amber"); assert.ok(o.rewards.badges.length >= 1);
  assert.equal(o.challenges.sent, 1); assert.equal(o.challenges.recent[0].with, "Lee P.");
  assert.equal(o.pain.entries, 2); assert.equal(o.pain.trend, "improving"); assert.equal(o.favorites, 1);
  assert.equal(o.habits.top30[0].name.toLowerCase().includes("prayer"), true); assert.equal(o.habits.goalLevel, "amateur");
  assert.equal(o.activity.days.length, 90); assert.equal(o.activity.summary.active30, 3);
  assert.equal(o.programs.builtWorkouts.length, 1); assert.equal(o.documents.total > 0, true); assert.equal(o.appointments.completed, 0);
  assert.equal((await s.call("GET", `/api/admin/clients/${a.client.id}/overview`, undefined, a.token)).status, 401);
  assert.equal((await s.call("GET", "/api/admin/clients/nope/overview", undefined, adm)).status, 404);
});

test("time in app: heartbeats add up per day, sessions split on a 30-minute gap, admin sees minutes", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, "Pat Doe"), adm = await s.adminToken();
  s.setDay(day(3), 9);
  const beat = (body) => s.call("POST", "/api/me/presence", body, a.token);
  assert.equal((await s.call("POST", "/api/me/presence", { seconds: 10 })).status, 401);
  let r = await beat({ seconds: 0, view: "home", platform: "web" });           // app opened: a session, no time yet
  assert.equal(r.body.sessions, 1); assert.equal(r.body.seconds, 0);
  r = await beat({ seconds: 60, view: "home", platform: "web" }); r = await beat({ seconds: 45, view: "videos", platform: "web" });
  assert.equal(r.body.sessions, 1, "beats a minute apart are one session"); assert.equal(r.body.seconds, 105);
  r = await beat({ seconds: 9999, view: "<bad>", platform: "tv" });              // a stuck tab can't inflate; odd values are tamed
  assert.equal(r.body.seconds, 105 + 120);
  s.setDay(day(3), 12);                                                         // three hours later: a new session the same day
  r = await beat({ seconds: 30, view: "pain", platform: "ios" });
  assert.equal(r.body.sessions, 2); assert.equal(r.body.seconds, 255);
  s.setDay(day(5), 8); await beat({ seconds: 0, view: "home", platform: "web" }); await beat({ seconds: 120, view: "home", platform: "web" });
  s.setDay(day(6), 8);
  const row = (await s.call("GET", "/api/admin/clients", undefined, adm)).body.find((x) => x.id === a.client.id);
  assert.equal(row.minutes30, 6, "255 s + 120 s = 6 minutes, rounded per day (4 + 2)");
  const o = (await s.call("GET", `/api/admin/clients/${a.client.id}/overview`, undefined, adm)).body;
  assert.equal(o.time.last30.minutes, 6); assert.equal(o.time.last30.sessions, 3); assert.equal(o.time.last30.daysOpened, 2); assert.equal(o.time.last30.avgMinutesPerDay, 3);
  assert.deepEqual(o.time.last30.views[0], { view: "home", minutes: 3 }); assert.deepEqual(o.time.last30.platforms.map((p) => p.platform).sort(), ["ios", "web"]);
  assert.equal(o.time.last30.lastView, "home"); assert.ok(o.time.last30.lastSeenAt);
  const act = (await s.call("GET", `/api/admin/clients/${a.client.id}/activity?days=7`, undefined, adm)).body;
  const d3 = act.days.find((d) => d.date === day(3)), d5 = act.days.find((d) => d.date === day(5));
  assert.equal(d3.minutes, 4); assert.equal(d3.opened, true); assert.equal(d5.minutes, 2); assert.equal(act.summary.minutes30, 6); assert.equal(act.summary.opened30, 2);
});
