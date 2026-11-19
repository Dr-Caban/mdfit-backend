"use strict";
// Member accounts, XP and sharing: the defects found in the Nov 19 2026 read-through of lib/clients.js, lib/rewards.js,
// lib/custom-workouts.js and lib/shares.js. Each test fails on the code as it was and passes on the fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { repairsFrom } = require("../lib/rewards");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-"));
  const clock = { at: new Date("2026-11-19T15:00:00Z") }; // 10 AM Thursday in Sarasota
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => clock.at, siteUrl: "https://mdfit.example.com", trashTimer: false, ...extra });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const writeJson = (name, v) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(v));
  const client = (email) => readJson("clients").find((c) => c.email === email);
  const xp = async (token) => (await call("GET", "/api/me/rewards", undefined, token)).body.xp;
  return { app, call, adminToken, dataDir, clock, readJson, writeJson, client, xp, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
let n = 0;
const signup = async (s, name = "Pat Doe", over = {}) => (await s.call("POST", "/api/clients/signup", { name, email: `m${++n}@example.com`, phone: "941-555-0100", password: "pat-pass-123", ...over })).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (iso, plus) => new Date(Date.parse(iso + "T12:00:00Z") + plus * 864e5).toISOString().slice(0, 10);

// A stand-in for the mail service, and confirm(): prove a signed-in account's email with the code it is sent
async function mailbox(t) {
  const sent = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  let asked = 0;
  const codes = () => sent.filter((m) => /is your MD Fit code/.test(m.subject));
  const confirm = async (s, token) => {
    await s.call("POST", "/api/me/email/code", {}, token); asked++;
    for (let i = 0; i < 100 && codes().length < asked; i++) await wait(20);
    return s.call("POST", "/api/me/email/verify", { code: codes().pop().text.match(/\b(\d{6})\b/)[1] }, token);
  };
  return { confirm, cfg: { resendKey: "re_test", resendUrl: `http://127.0.0.1:${srv.address().port}`, notifyFrom: "MD Fit <hello@example.com>", notifyGapMs: 0 } };
}

// ---- 1
test("closing an account never undoes what other members saved while billing was being stopped", async (t) => {
  const s = await start(); t.after(s.close);
  const leaver = await signup(s, "Lea Ver"), keeper = await signup(s, "Kee Per"), other = await signup(s, "Oth Er");
  await s.call("POST", "/api/me/pain", { area: "Hip", level: 6 }, keeper.token); // a pain diary is part of a chart: this account is closed, not erased
  s.app.set("cancelSubscriptions", async () => { await wait(300); return { cancelled: 0 }; }); // stands in for the calls to Stripe

  for (const [who, mode] of [[leaver, "erase"], [keeper, "close"]]) {
    const closing = s.call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pat-pass-123" }, who.token);
    await wait(80);
    assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 4 }, other.token)).status, 201);
    const late = await signup(s, "Late Comer");
    const done = await closing;
    assert.equal(done.status, 200); assert.equal(done.body.mode, mode);
    assert.equal((await s.call("GET", "/api/me", undefined, late.token)).status, 200, `the account made during a "${mode}" is still there`);
    assert.equal((await s.call("GET", "/api/me", undefined, who.token)).status, 401, "the closed account is signed out");
  }
  assert.equal(s.client(other.client.email).painLog.length, 2, "both entries saved meanwhile are kept");
  assert.equal(s.readJson("clients").some((c) => c.id === leaver.client.id), false, "erased");
  const closed = s.readJson("clients").find((c) => c.id === keeper.client.id);
  assert.equal(closed.name, "Closed account"); assert.equal(closed.passwordHash, null); assert.equal(closed.painLog.length, 1, "the chart is kept");
});

test("emptying the trash leaves alone a client who was restored while an earlier one was being dealt with", async (t) => {
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const a = await signup(s, "Ann Able"), b = await signup(s, "Bob Baker");
  for (const c of [a, b]) assert.equal((await s.call("DELETE", `/api/admin/clients/${c.client.id}`, undefined, adm)).status, 200);
  s.clock.at = new Date(s.clock.at.getTime() + 31 * 864e5);
  const stopped = [];
  s.app.set("cancelSubscriptions", async (c) => { stopped.push(c.id); await wait(300); return { cancelled: 0 }; });
  const emptying = s.call("GET", "/api/admin/clients/trash/list", undefined, adm);
  await wait(80);
  assert.equal((await s.call("POST", `/api/admin/clients/${b.client.id}/restore`, {}, adm)).status, 200);
  await emptying;
  assert.deepEqual(stopped, [a.client.id], "billing is stopped for the one still in the trash only");
  assert.equal(s.readJson("clients").find((c) => c.id === b.client.id).name, "Bob Baker");
});

// ---- 2
test("a referral never lowers the tier of, or puts an end date on, a membership that has none", async (t) => {
  const mail = await mailbox(t);
  const s = await start(mail.cfg); t.after(s.close);
  const adm = await s.adminToken();
  const pat = await signup(s);
  assert.equal((await s.call("PUT", `/api/admin/clients/${pat.client.id}/membership`, { tier: "premium-plus", until: "" }, adm)).status, 200);
  const open = s.client(pat.client.email).membership;
  assert.equal(open.until, "", "no end date");
  const sam = await signup(s, "Sam Roe", { referralCode: pat.client.referralCode });
  assert.equal((await mail.confirm(s, sam.token)).status, 200);
  assert.deepEqual(s.client(pat.client.email).membership, open, "left exactly as it was");
  assert.equal(s.client(pat.client.email).referrals, 1, "the referral itself still counts");
  assert.equal((await s.call("GET", "/api/me", undefined, pat.token)).body.client.membership.tier, "premium-plus");
});

// ---- 3
test("the referrer's free month waits for the new account's email to be proven, and is granted once", async (t) => {
  const mail = await mailbox(t);
  const s = await start(mail.cfg); t.after(s.close);
  const pat = await signup(s), code = pat.client.referralCode;
  const fakes = [];
  for (let i = 0; i < 3; i++) fakes.push(await signup(s, "Fake Person", { email: `fake${i}@nowhere.invalid`, referralCode: code }));
  assert.equal(s.client(pat.client.email).membership, undefined, "made-up addresses earn nothing");
  assert.equal(s.client(pat.client.email).referrals, 3, "the sign-ups are still counted");

  assert.equal((await mail.confirm(s, fakes[0].token)).status, 200);
  const m = s.client(pat.client.email).membership;
  assert.equal(m.tier, "member"); assert.equal(m.via, "referral-reward");
  assert.equal(m.until, new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), "one month");
  assert.equal(s.client("fake0@nowhere.invalid").referralRewardDue, undefined);

  // proving it again, or signing in again, adds nothing
  assert.equal((await s.call("POST", "/api/me/email/verify", { code: "000000" }, fakes[0].token)).status, 200);
  assert.equal(s.client(pat.client.email).membership.until, m.until);

  // a code typed in after signing up follows the same rule
  const late = await signup(s, "Late Claim");
  assert.equal((await s.call("POST", "/api/me/referral/claim", { code }, late.token)).status, 200);
  assert.equal(s.client(pat.client.email).membership.until, m.until, "not before the claimer's email is proven");
  assert.equal((await mail.confirm(s, late.token)).status, 200);
  assert.equal(s.client(pat.client.email).membership.until, day(m.until, 30), "a second month for a second proven account");
});

// ---- 4
test("pain and vitals earn XP only for today or yesterday; older days are saved and earn nothing", async (t) => {
  const s = await start(); t.after(s.close);
  const today = "2026-11-19";
  const pat = await signup(s);
  const readings = Array.from({ length: 400 }, (_, i) => ({ date: day("2020-01-01", i), weight: 150, sleep: 8 }));
  const batch = await s.call("POST", "/api/me/vitals/batch", { readings }, pat.token);
  assert.equal(batch.status, 201); assert.equal(batch.body.saved, 400, "the import is saved");
  for (let i = 0; i < 30; i++) assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 10 - (i % 10), date: day("2021-01-01", Math.floor(i / 3)) }, pat.token)).status, 201);
  assert.equal(await s.xp(pat.token), 0, "400 past days of readings and 30 back-dated pain entries earn nothing");
  assert.equal((await s.call("GET", "/api/me/pain", undefined, pat.token)).body.length, 30, "and are all in the diary");

  await s.call("POST", "/api/me/pain", { area: "Knee", level: 5 }, pat.token);
  assert.equal(await s.xp(pat.token), 5, "today's check-in");
  await s.call("POST", "/api/me/vitals", { date: day(today, -1), weight: 150, sleep: 8 }, pat.token);
  assert.equal(await s.xp(pat.token), 15, "yesterday's readings, entered this morning");
  await s.call("POST", "/api/me/vitals", { date: day(today, -2), weight: 150, sleep: 8 }, pat.token);
  assert.equal(await s.xp(pat.token), 15, "two days back is too late");

  // a day logged on time keeps what it earned, and readings added to it later don't raise that
  const sam = await signup(s, "Sam Roe");
  await s.call("POST", "/api/me/vitals", { weight: 150 }, sam.token);
  assert.equal(await s.xp(sam.token), 5);
  s.clock.at = new Date(s.clock.at.getTime() + 3 * 864e5);
  await s.call("POST", "/api/me/vitals", { date: today, sleep: 8, hrv: 60 }, sam.token);
  assert.equal(await s.xp(sam.token), 5);
});

test("XP a member already had from older pain entries and readings stays after the today-or-yesterday rule", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  // as saved before the rule: no "late" mark on anything
  const list = s.readJson("clients"), c = list.find((x) => x.id === pat.client.id);
  c.painLog = [{ id: "a1", date: "2026-09-01", area: "Knee", level: 6, note: "", createdAt: "2026-09-20T12:00:00.000Z" }, { id: "a2", date: "2026-09-02", area: "Hip", level: 6, note: "", createdAt: "2026-09-20T12:01:00.000Z" }];
  c.vitals = [{ date: "2026-09-01", weight: 150, sleep: 8, source: "Apple Health" }, { date: "2026-09-02", hrv: 60, source: "Apple Health" }];
  s.writeJson("clients", list);
  assert.equal(await s.xp(pat.token), 5 + 5 + 10 + 5, "exactly what those entries were worth before");
  // adding to one of those old days now changes nothing
  await s.call("POST", "/api/me/vitals", { date: "2026-09-02", weight: 150 }, pat.token);
  assert.equal(await s.xp(pat.token), 25);
});

// ---- 5
test("share links: revoked rows don't fill the store for everyone, old ones are dropped, and a member can't loop", async (t) => {
  const s = await start(); t.after(s.close);
  const workout = { title: "T", rounds: 1, restEx: 0, restRound: 0, minutes: 10 };
  const program = async (token) => (await s.call("POST", "/api/me/programs", { name: "P", workout }, token)).body.programs[0].id;
  const share = (token, id) => s.call("POST", "/api/me/shares", { kind: "program", id }, token);

  // one member turning a link on and off: 50 new links a day, then no more until tomorrow
  const loop = await signup(s, "Loo Per"), lp = await program(loop.token);
  for (let i = 0; i < 50; i++) { const r = await share(loop.token, lp); assert.equal(r.status, 201); await s.call("DELETE", "/api/me/shares/" + r.body.share.key, undefined, loop.token); }
  const refused = await share(loop.token, lp);
  assert.equal(refused.status, 400); assert.match(refused.body.error, /50 share links a day/);

  // a store holding 20,000 revoked rows is not "full" for another member, and rows revoked over 30 days ago go
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const rows = Array.from({ length: 20000 }, (_, i) => ({ key: "k".repeat(18) + String(i).padStart(6, "0"), kind: "program", ownerId: "someone-else", itemId: "x", title: "T", by: "S. E.",
    snapshot: { name: "T", workout }, createdAt: ago(40), revokedAt: ago(i < 12000 ? 31 : 5) }));
  s.writeJson("shares", rows);
  const pat = await signup(s), made = await share(pat.token, await program(pat.token));
  assert.equal(made.status, 201, "another member can still share");
  const kept = s.readJson("shares");
  assert.equal(kept.length, 8001, "the 12,000 revoked more than 30 days ago are gone; recent ones and the new link stay");
  assert.equal((await s.call("GET", "/api/shares/" + made.body.share.key)).status, 200);
});

// ---- 6
test("trimming the action log never lowers XP and never un-credits a first-descent stop", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  // 91 days at the daily caps (33 actions a day) after the first two stops of the tutorial: 3,000 entries
  const perDay = [...Array.from({ length: 10 }, (_, i) => ["video", "v" + i]), ...[0, 1, 2].flatMap((i) => [["lecture", "l" + i], ["message", ""], ["reaction", ""], ["program", "p" + i], ["generate", ""]]),
    ...Array.from({ length: 5 }, (_, i) => ["favorite", "f" + i]), ["share", ""], ["profile", ""], ["open", ""]];
  assert.equal(perDay.length, 33);
  const log = [{ date: "2026-08-01", kind: "intro", ref: "solomon" }, { date: "2026-08-01", kind: "intro", ref: "friend" }];
  for (let d = 0; log.length < 3000; d++) for (const [kind, ref] of perDay) if (log.length < 3000) log.push({ date: day("2026-08-01", d), kind, ref });
  const list = s.readJson("clients"); list.find((x) => x.id === pat.client.id).xpLog = log; s.writeJson("clients", list);

  const before = await s.xp(pat.token);
  assert.ok(before > 9000, "about 108 XP a day for 91 days");
  // a busy day today: 30 videos and 9 lectures are written down (10 and 3 of them earn), which pushes the oldest day out
  let said = 0;
  for (let i = 0; i < 30; i++) said += (await s.call("POST", "/api/me/xp", { kind: "video", ref: "today-" + i }, pat.token)).body.xp;
  for (let i = 0; i < 9; i++) said += (await s.call("POST", "/api/me/xp", { kind: "lecture", ref: "today-" + i }, pat.token)).body.xp;
  assert.equal(said, 10 * 2 + 3 * 10);
  assert.equal(await s.xp(pat.token), before + 50, "nothing earned earlier is lost");
  const c = s.client(pat.client.email);
  assert.equal(c.xpLog.some((x) => x.date === "2026-08-01" && x.kind !== "intro"), false, "the oldest day was trimmed from the log");
  assert.equal(c.xpBanked, 108, "and what that day had earned is kept on the account");
  assert.ok(c.xpLog.length <= 3000 + 105, "the log stays bounded (whole days are dropped, so it can run a day over)");
  const intro = (await s.call("GET", "/api/me/intro", undefined, pat.token)).body;
  assert.equal(intro.steps.solomon, true); assert.equal(intro.steps.friend, true);
  const again = (await s.call("POST", "/api/me/xp", { kind: "intro", ref: "solomon" }, pat.token)).body;
  assert.equal(again.first, false); assert.equal(again.xp, 0, "a stop pays once ever");
  assert.equal(await s.xp(pat.token), before + 50);
});

// ---- 7
test("signing in from a shared address is not held to the sign-up limit; sign-up and forgot-password still are", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  for (let i = 0; i < 15; i++) {
    const code = (await s.call("POST", "/api/clients/handoff", {}, pat.token)).body.code;
    assert.equal((await s.call("POST", "/api/clients/handoff/exchange", { code })).status, 200, `app sign-in ${i + 1}`);
  }
  for (let i = 0; i < 9; i++) assert.equal((await s.call("POST", "/api/clients/forgot", { email: "nobody@example.com" })).status, 200);
  assert.equal((await s.call("POST", "/api/clients/forgot", { email: "nobody@example.com" })).status, 429, "ten sign-ups and forgotten passwords an hour, as before");
  assert.equal((await s.call("POST", "/api/clients/signup", { name: "One More", email: "more@example.com", password: "pat-pass-123" })).status, 429);
  const code = (await s.call("POST", "/api/clients/handoff", {}, pat.token)).body.code;
  assert.equal((await s.call("POST", "/api/clients/handoff/exchange", { code })).status, 200, "and signing in still works then");
});

// ---- 8
test("streak repair tokens: one for every third day of a streak, wherever the streak falls in the history", () => {
  const on = (...dd) => dd.map((d) => ({ date: "2026-11-" + String(d).padStart(2, "0") }));
  assert.equal(repairsFrom(on(10, 11, 12)).earned, 1);
  assert.equal(repairsFrom(on(1, 10, 11, 12)).earned, 1, "an earlier workout day doesn't cost the streak its token");
  assert.equal(repairsFrom(on(1, 3, 10, 11, 12)).earned, 1);
  assert.equal(repairsFrom(on(1, 10, 11, 12, 13, 14, 15)).earned, 2, "six in a row is two");
  assert.equal(repairsFrom(on(10, 11, 12, 13, 14)).earned, 1, "five in a row is still one");
  assert.equal(repairsFrom(on(1, 2, 3, 10, 11, 12)).earned, 2, "two separate streaks");
  assert.equal(repairsFrom(on(1, 2, 10, 11)).earned, 0);
  assert.equal(repairsFrom(on(10, 11, 12), ["2026-11-13"]).available, 0);
});

// ---- 9
test("a made-up track or protocol key is an ordinary workout; real ones and the owner's own tracks are programs", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  const kind = async (key) => (await s.call("POST", "/api/me/workouts", { title: "x", minutes: 10, key }, pat.token)).body.workout.kind;
  assert.equal(await kind("track-does-not-exist"), "normal");
  assert.equal(await kind("painproto-does-not-exist"), "normal");
  assert.equal(await s.xp(pat.token), 30 + 25, "30 for the day's workout (and the first-workout badge), not the program's 50");
  assert.equal(await kind("track-new-knee"), "normal", "not a track yet");
  assert.equal(await kind("track-knee"), "program");
  assert.equal(await kind("painproto-vastus-lateralis"), "program");
  const track = { id: "new-knee", title: "Patellar tendon → front of knee", region: "Knee", img: ["https://drive.google.com/file/d/1ABCdefGHIjklMNOpqrSTUvwx/view"], pts: ["vmo"], note: "",
    levels: [{ title: "Level 1", videos: [{ name: "Wall sit", id: "" }] }] };
  assert.equal((await s.call("PUT", "/api/admin/content", { tracks: [track] }, await s.adminToken())).status, 200);
  assert.equal(await kind("track-new-knee"), "program", "a track the owner added in the workspace");
});

// ---- 10
test("POST /api/me/xp answers with what the ledger credits, and the same item again doesn't use up the day's log", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  const post = async (body) => (await s.call("POST", "/api/me/xp", body, pat.token)).body.xp;
  const start0 = await s.xp(pat.token);
  let said = 0;
  for (let i = 0; i < 30; i++) said += await post({ kind: "video", ref: "same-video" });
  assert.equal(said, 2, "the same video thirty times is one video");
  assert.equal(await s.xp(pat.token), start0 + 2);
  assert.equal(s.client(pat.client.email).xpLog.filter((x) => x.kind === "video").length, 1, "written down once");
  said = 0;
  for (let i = 0; i < 11; i++) said += await post({ kind: "video", ref: "other-" + i });
  assert.equal(said, 18, "nine more videos reach the day's ten; the next two earn nothing");
  assert.equal(await s.xp(pat.token), start0 + 20);
  // an action with no item to tell apart counts each time, up to its cap
  const g = []; for (let i = 0; i < 4; i++) g.push(await post({ kind: "generate" }));
  assert.deepEqual(g, [2, 2, 2, 0]);
  assert.equal(await s.xp(pat.token), start0 + 26);
});

// ---- 11
test("a visit booked in the evening earns its XP on the clinic's day, not on tomorrow's UTC date", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  // booked Sunday Nov 22 at 8 PM in Sarasota: already Monday Nov 23 in UTC
  s.writeJson("appointments", [{ id: "appt00000001", clientId: pat.client.id, email: pat.client.email, name: "Pat Doe", typeId: "eval", typeName: "Evaluation", date: "2026-12-01", time: "10:00", status: "booked", createdAt: "2026-11-23T01:00:00.000Z" }]);
  s.clock.at = new Date("2026-11-23T02:00:00Z"); // Sunday 9 PM
  let r = (await s.call("GET", "/api/me/rewards", undefined, pat.token)).body;
  assert.equal(r.todayXp, 15); assert.equal(r.week.find((d) => d.date === "2026-11-22").xp, 15);
  s.clock.at = new Date("2026-11-23T15:00:00Z"); // Monday morning: a new day and a new week
  r = (await s.call("GET", "/api/me/rewards", undefined, pat.token)).body;
  assert.equal(r.xp, 15);
  assert.equal(r.todayXp, 0, "not earned a second time on Monday");
  assert.equal(r.week.reduce((sum, d) => sum + d.xp, 0), 0, "and not carried into the new week's leaderboard");
});

// ---- 12
test("dates that don't exist and programs that don't exist are refused; a bad row in a batch is a 400, not a 500", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  const pain = (date) => s.call("POST", "/api/me/pain", { area: "Knee", level: 5, date }, pat.token);
  for (const bad of ["2025-13-45", "2026-02-30", "0001-99-99"]) assert.equal((await pain(bad)).status, 400, "pain " + bad);
  assert.equal((await pain("2026-11-18")).status, 201);
  const vital = (date) => s.call("POST", "/api/me/vitals", { date, weight: 150 }, pat.token);
  for (const bad of ["0001-99-99", "2026-02-30", "2025-13-45"]) assert.equal((await vital(bad)).status, 400, "vitals " + bad);
  assert.equal((await vital("2026-11-18")).status, 201);
  for (const readings of [[null], ["2026-11-18"], [{ date: "2026-11-18", weight: 150 }, { date: "2026-02-30", weight: 150 }]])
    assert.equal((await s.call("POST", "/api/me/vitals/batch", { readings }, pat.token)).status, 400, JSON.stringify(readings));
  assert.equal((await s.call("GET", "/api/me/vitals", undefined, pat.token)).body.length, 1, "nothing from a refused batch is saved");
  const plan = (body) => s.call("PUT", "/api/me/about/plan", body, pat.token);
  assert.equal((await plan({ program: "knee-6", start: "2026-11-31" })).status, 400, "November has 30 days");
  assert.equal((await plan({ program: "nope-not-real", start: "2026-11-23" })).status, 400, "not one of the programs");
  assert.deepEqual((await plan({ program: "knee-6", start: "2026-11-23" })).body.plan, { program: "knee-6", start: "2026-11-23" });
});

// ---- Extra
test("a saved program keeps the generator's own set lines (up to 60 characters)", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  const save = (sets) => s.call("POST", "/api/me/programs", { name: "P", workout: { title: "T", rounds: 1, restEx: 0, restRound: 0, minutes: 10, circuit: [{ id: "abcdef123456", sets }] } }, pat.token);
  const line = "3 × 10 slow reps (pause at the top)";
  const r = await save(line);
  assert.equal(r.status, 201); assert.equal(r.body.programs[0].workout.circuit[0].sets, line);
  assert.equal((await save("x".repeat(60))).status, 201);
  assert.equal((await save("x".repeat(61))).status, 400);
});
