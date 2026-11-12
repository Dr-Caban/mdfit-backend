// The guide in the member app: answers counted per clinic day on the server, the free limit and its setting,
// reminders and their one push, looks, and the owner's numbers. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

// A stand-in for the language model: records what it was sent, answers what the test tells it to
async function model(reply) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ url: req.url, body: JSON.parse(b) }); const r = reply(seen.length); res.writeHead(r.status || 200, { "content-type": "application/json" }); res.end(JSON.stringify(r.status && r.status !== 200 ? { error: { message: "no" } } : { choices: [{ message: { content: r.content } }] })); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { seen, host: `127.0.0.1:${srv.address().port}`, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-guide-"));
  const clock = { now: new Date("2026-11-12T15:00:00Z") }; // 10:00 AM on Nov 12 at the clinic (New York)
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://site.example.com", ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const at = (iso) => { clock.now = new Date(iso); };
  const answer = (token, body = { kind: "pain" }) => call("POST", "/api/me/guide/answer", body, token);
  // every byte the server has written, to look for something that must not be there
  const everything = () => { const out = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } }; walk(dataDir); return out.join("\n"); };
  const file = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  return { app, call, adminToken, signup, at, answer, everything, file, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("guide: a free account gets 25 answers a day by default, then is told the limit; the owner can change the number", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free");

  let g = (await s.call("GET", "/api/me/guide", undefined, fay.token)).body;
  assert.deepEqual({ plan: g.plan, limit: g.limit, used: g.used, left: g.left }, { plan: "free", limit: 25, used: 0, left: 25 }, "the default is 25");
  assert.deepEqual(g.reminders, []); assert.deepEqual(g.prefs, { theme: "white", layout: "comfortable" });
  assert.equal((await s.call("GET", "/api/admin/guide/stats", undefined, A)).body.settings.freePerDay, 25);

  for (let i = 1; i <= 25; i++) { const r = await s.answer(fay.token); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, used: i, limit: 25, left: 25 - i }); }
  const over = await s.answer(fay.token);
  assert.equal(over.status, 200, "the limit is an answer, not an error"); assert.deepEqual(over.body, { ok: false, limited: true, used: 25, limit: 25, left: 0 });
  assert.deepEqual((await s.answer(fay.token)).body, { ok: false, limited: true, used: 25, limit: 25, left: 0 });
  g = (await s.call("GET", "/api/me/guide", undefined, fay.token)).body; assert.equal(g.used, 25); assert.equal(g.left, 0);

  // the owner's setting: a whole number from 1 to 500, kept in the store, applied at once
  for (const bad of [0, 501, 2.5, "5", null, -3]) assert.equal((await s.call("PUT", "/api/admin/guide/settings", { freePerDay: bad }, A)).status, 400, String(bad));
  assert.equal((await s.call("PUT", "/api/admin/guide/settings", {}, A)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 500 }, A)).body.settings.freePerDay, 500);
  assert.deepEqual((await s.answer(fay.token)).body, { ok: true, used: 26, limit: 500, left: 474 }, "a higher limit opens the day back up");
  assert.equal((await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 3 }, A)).body.settings.freePerDay, 3);
  assert.equal(s.file("guide").settings.freePerDay, 3);
  const gus = await s.signup("Gus Guest");
  for (let i = 1; i <= 3; i++) assert.equal((await s.answer(gus.token)).body.left, 3 - i);
  assert.equal((await s.answer(gus.token)).body.limited, true);
  assert.equal((await s.answer(fay.token)).body.limited, true, "a lower limit applies to someone already past it");
  assert.equal((await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 1 }, A)).status, 200);
});

test("guide: the count belongs to the clinic's day and to the account, not the device; a member is unlimited", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free"), mel = await s.signup("Mel Member");
  await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 2 }, A);
  await s.answer(fay.token); await s.answer(fay.token);
  assert.equal((await s.answer(fay.token)).body.limited, true);
  // signing in again (a new phone, a reinstall) is the same account and the same count
  const again = (await s.call("POST", "/api/clients/login", { email: "fay.free@example.com", password: "made-up-pass-1" })).body;
  assert.notEqual(again.token, undefined); assert.equal((await s.answer(again.token)).body.limited, true);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, again.token)).body.left, 0);
  // 10 PM the same evening at the clinic is already the next day in UTC: still today's count
  s.at("2026-11-13T03:00:00Z"); assert.equal((await s.answer(fay.token)).body.limited, true);
  // half past midnight at the clinic: a new day
  s.at("2026-11-13T05:30:00Z");
  assert.deepEqual((await s.call("GET", "/api/me/guide", undefined, fay.token)).body.left, 2);
  assert.deepEqual((await s.answer(fay.token)).body, { ok: true, used: 1, limit: 2, left: 1 });

  // a paid membership (the same rule the rest of the app uses) has no limit
  assert.equal((await s.call("PUT", `/api/admin/clients/${mel.client.id}/membership`, { tier: "member" }, A)).status, 200);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, mel.token)).body.plan, "member");
  assert.equal((await s.call("GET", "/api/me/guide", undefined, mel.token)).body.left, null);
  for (let i = 1; i <= 6; i++) assert.deepEqual((await s.answer(mel.token)).body, { ok: true, used: i, limit: 2, left: null });
  // and when it ends, the limit is back
  await s.call("PUT", `/api/admin/clients/${mel.client.id}/membership`, { tier: "member", until: "2026-11-12" }, A);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, mel.token)).body.plan, "free");
  assert.equal((await s.answer(mel.token)).body.limited, true);

  // one account cannot hammer the store
  let last; for (let i = 0; i < 95; i++) last = await s.call("POST", "/api/me/guide/event", { type: "open" }, fay.token);
  assert.equal(last.status, 429);
});

test("guide: what a member typed is never taken or kept; only a category from the fixed list is counted", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free"), MARK = "ZZMARKER";
  assert.equal((await s.answer(fay.token, { kind: "pain", text: MARK + " my knee has hurt since March", q: MARK, message: { body: MARK } })).body.ok, true);
  assert.equal((await s.answer(fay.token, { kind: MARK + " knee pain" })).body.ok, true);
  assert.equal((await s.answer(fay.token, { kind: { text: MARK } })).body.ok, true);
  assert.equal((await s.call("POST", "/api/me/guide/answer", undefined, fay.token)).body.ok, true);
  assert.equal((await s.call("POST", "/api/me/guide/event", { type: "open", text: MARK }, fay.token)).status, 200);
  assert.equal((await s.call("POST", "/api/me/guide/event", { type: MARK }, fay.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/guide/event", {}, fay.token)).status, 400);
  await s.call("GET", "/api/admin/guide/stats", undefined, A);
  const all = s.everything();
  assert.ok(all.includes('"answers"'), "the files are readable here, so the search below means something");
  assert.equal(all.includes(MARK), false, "nothing typed reached the disk: not the store, not the audit ledger");
  assert.deepEqual(s.file("guide").days["2026-11-12"].kinds, { pain: 1, other: 3 });
  const m = s.file("guide").members[fay.client.id];
  assert.deepEqual(Object.keys(m).sort(), ["day", "lastOpen", "used"], "per member: a date and a count");
  // the guide's own counters are not ledger events; a saved reminder is
  await s.call("POST", "/api/me/reminders", { title: "Knee program", date: "2026-11-13", time: "07:00" }, fay.token);
  const log = JSON.stringify((await s.call("GET", "/api/admin/audit", undefined, A)).body);
  assert.equal(/guide\/answer|guide\/event/.test(log), false); assert.match(log, /client\.\/reminders/);
});

test("guide: reminders are checked, capped, listed soonest first, pushed once when the time comes, and can be deleted", async (t) => {
  const s = await start(); t.after(s.close);
  const fay = await s.signup("Fay Free"), ned = await s.signup("Ned Nophone"), u = "/api/me/reminders";
  const add = (b, tok = fay.token) => s.call("POST", u, b, tok);
  for (const [bad, why] of [[{ date: "2026-11-13", time: "07:00" }, /name/], [{ title: "   ", date: "2026-11-13", time: "07:00" }, /name/], [{ title: "x".repeat(81), date: "2026-11-13", time: "07:00" }, /80/],
    [{ title: "Walk", date: "2026-13-40", time: "07:00" }, /day/], [{ title: "Walk", date: "tomorrow", time: "07:00" }, /day/], [{ title: "Walk", date: "2026-11-13", time: "7am" }, /time/], [{ title: "Walk", date: "2026-11-13", time: "25:00" }, /time/],
    [{ title: "Walk", date: "2026-11-11", time: "07:00" }, /already passed/], [{ title: "Walk", date: "2026-11-12", time: "09:00" }, /already passed/], [{ title: "Walk", date: "2027-11-20", time: "07:00" }, /a year/]]) {
    const r = await add(bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body.error, why);
  }
  const later = await add({ title: "  Knee\tprogram \n", date: "2026-11-13", time: "07:00" });
  assert.equal(later.status, 201); assert.equal(later.body.reminder.title, "Knee program"); assert.equal(later.body.reminder.sentAt, null);
  assert.deepEqual(Object.keys(later.body.reminder).sort(), ["createdAt", "date", "id", "sentAt", "time", "title"]);
  const soon = (await add({ title: "Stretch", date: "2026-11-12", time: "10:30" })).body; // half an hour from now
  assert.deepEqual(soon.reminders.map((r) => r.title), ["Stretch", "Knee program"], "soonest first");
  assert.deepEqual((await s.call("GET", u, undefined, fay.token)).body.reminders.map((r) => r.title), ["Stretch", "Knee program"]);
  assert.deepEqual((await s.call("GET", "/api/me/guide", undefined, fay.token)).body.reminders.map((r) => r.title), ["Stretch", "Knee program"]);
  assert.deepEqual((await s.call("GET", u, undefined, ned.token)).body.reminders, [], "one member's reminders are not another's");
  assert.equal(fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8").includes("Knee program"), false, "the title is encrypted in the file");

  // the push: nothing while push is off; then once, at the minute, only to someone with a phone, and never again
  assert.deepEqual(s.app.get("guideRemind")(), { sent: 0 });
  await add({ title: "Ned's walk", date: "2026-11-12", time: "10:30" }, ned.token);
  assert.equal((await s.call("POST", "/api/me/devices", { token: "ab".repeat(32) }, fay.token)).status, 200);
  const out = [], push = { enabled: true, toClient: (id, note) => out.push({ id, ...note }) }, guide = s.app.get("guideApi");
  s.at("2026-11-12T15:29:00Z"); assert.deepEqual(guide.sweep(push), { sent: 0 }); assert.equal(out.length, 0, "not before its time");
  s.at("2026-11-12T15:30:20Z"); assert.deepEqual(guide.sweep(push), { sent: 1 });
  assert.deepEqual(out, [{ id: fay.client.id, title: "Reminder", body: "Stretch", route: "progress", thread: "reminders", collapseId: soon.reminder.id }]);
  s.at("2026-11-12T15:31:20Z"); assert.deepEqual(guide.sweep(push), { sent: 0 }); assert.equal(out.length, 1, "never twice");
  let list = (await s.call("GET", u, undefined, fay.token)).body.reminders;
  assert.equal(list.find((r) => r.title === "Stretch").sentAt, "2026-11-12T15:30:20.000Z"); assert.equal(list.find((r) => r.title === "Knee program").sentAt, null);
  assert.equal((await s.call("GET", u, undefined, ned.token)).body.reminders[0].sentAt, null, "no phone: it stays on the calendar, unsent");
  assert.deepEqual(guide.sweep({ enabled: false, toClient: () => { throw new Error("must not be called"); } }), { sent: 0 });
  // the server was down over the time: more than an hour late is not sent late
  s.at("2026-11-13T14:30:00Z"); assert.deepEqual(guide.sweep(push), { sent: 0 }); assert.equal(out.length, 1);

  // delete; someone else's or a made-up id is not found
  assert.equal((await s.call("DELETE", `${u}/${later.body.reminder.id}`, undefined, ned.token)).status, 404);
  assert.equal((await s.call("DELETE", `${u}/nope`, undefined, fay.token)).status, 404);
  assert.deepEqual((await s.call("DELETE", `${u}/${later.body.reminder.id}`, undefined, fay.token)).body.reminders.map((r) => r.title), ["Stretch"]);
  // at most 20 upcoming; a past one does not count against it and drops off after 30 days
  for (let i = 0; i < 20; i++) assert.equal((await add({ title: "R" + i, date: "2026-11-20", time: "08:" + String(i).padStart(2, "0") })).status, 201, "R" + i);
  const full = await add({ title: "One too many", date: "2026-11-21", time: "08:00" });
  assert.equal(full.status, 400); assert.match(full.body.error, /up to 20 reminders/);
  assert.equal((await s.call("GET", u, undefined, fay.token)).body.reminders.length, 21, "20 upcoming and yesterday's");
  s.at("2026-12-13T15:00:00Z"); assert.deepEqual((await s.call("GET", u, undefined, fay.token)).body.reminders.map((r) => r.date), Array(20).fill("2026-11-20"));
  s.at("2026-12-21T15:00:00Z"); assert.deepEqual((await s.call("GET", u, undefined, fay.token)).body.reminders, []);
});

test("guide: looks are checked and kept on the account", async (t) => {
  const s = await start(); t.after(s.close);
  const fay = await s.signup("Fay Free"), u = "/api/me/prefs";
  for (const bad of [{ theme: "purple" }, { layout: "huge" }, { theme: "black", layout: 3 }, { theme: null }]) assert.equal((await s.call("PUT", u, bad, fay.token)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await s.call("PUT", u, {}, fay.token)).body, { prefs: { theme: "white", layout: "comfortable" } });
  assert.deepEqual((await s.call("PUT", u, { theme: "black" }, fay.token)).body, { prefs: { theme: "black", layout: "comfortable" } });
  assert.deepEqual((await s.call("PUT", u, { layout: "compact" }, fay.token)).body, { prefs: { theme: "black", layout: "compact" } });
  const again = (await s.call("POST", "/api/clients/login", { email: "fay.free@example.com", password: "made-up-pass-1" })).body;
  assert.deepEqual((await s.call("GET", "/api/me/guide", undefined, again.token)).body.prefs, { theme: "black", layout: "compact" }, "the same on another device");
  assert.deepEqual((await s.call("PUT", u, { theme: "white", layout: "comfortable" }, fay.token)).body.prefs, { theme: "white", layout: "comfortable" });
});

test("guide: the owner's numbers add up, day by day, and count who upgraded after hitting the limit", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), u = "/api/admin/guide/stats";
  const ann = await s.signup("Ann Upgrader"), bob = await s.signup("Bob Stays"), cy = await s.signup("Cy Member"), dee = await s.signup("Dee Looks");
  await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 2 }, A);
  const ev = (tok, type) => s.call("POST", "/api/me/guide/event", { type }, tok);
  const empty = (await s.call("GET", u, undefined, A)).body;
  assert.deepEqual(empty.totals, { opens: 0, people: 0, answers: 0, limitHits: 0, limitPeople: 0, upgradeTaps: 0, upgraded: 0 }); assert.equal(empty.rate, null, "no rate from nobody");

  // Nov 12: Cy is already a member. Ann and Bob open, use their two answers, and hit the limit (Ann twice).
  await s.call("PUT", `/api/admin/clients/${cy.client.id}/membership`, { tier: "member" }, A);
  await ev(ann.token, "open"); await ev(ann.token, "open"); await ev(bob.token, "open"); await ev(cy.token, "open");
  for (const p of [ann, bob]) { await s.answer(p.token, { kind: "pain" }); await s.answer(p.token, { kind: "book" }); assert.equal((await s.answer(p.token)).body.limited, true); }
  assert.equal((await s.answer(ann.token)).body.limited, true);
  for (let i = 0; i < 4; i++) await s.answer(cy.token, { kind: "programs" });
  await ev(ann.token, "upgrade"); await ev(bob.token, "tomorrow");
  // Nov 13: Ann upgrades; Bob comes back, hits the limit again; Dee only opens it.
  s.at("2026-11-13T15:00:00Z");
  await s.call("PUT", `/api/admin/clients/${ann.client.id}/membership`, { tier: "member" }, A);
  await ev(bob.token, "open"); await ev(dee.token, "open");
  await s.answer(bob.token); await s.answer(bob.token); assert.equal((await s.answer(bob.token)).body.limited, true);
  await s.answer(ann.token); await s.answer(ann.token); assert.equal((await s.answer(ann.token)).body.ok, true, "Ann is unlimited now");

  const r = (await s.call("GET", u + "?days=7", undefined, A)).body;
  assert.equal(r.days, 7); assert.deepEqual(r.settings, { freePerDay: 2, ai: false, aiReady: false, aiHost: "", aiModel: "", aiWhy: "No AI service is connected on the server yet." });
  assert.deepEqual(r.totals, { opens: 6, people: 4, answers: 13, limitHits: 3, limitPeople: 2, upgradeTaps: 1, upgraded: 1 });
  assert.equal(r.rate, 0.5);
  assert.equal(r.byDay.length, 7); assert.deepEqual(r.byDay.map((d) => d.date), ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
  assert.deepEqual(r.byDay[4], { date: "2026-11-11", opens: 0, answers: 0, limitHits: 0, upgradeTaps: 0 });
  assert.deepEqual(r.byDay[5], { date: "2026-11-12", opens: 4, answers: 8, limitHits: 2, upgradeTaps: 1 });
  assert.deepEqual(r.byDay[6], { date: "2026-11-13", opens: 2, answers: 5, limitHits: 1, upgradeTaps: 0 });
  const d30 = (await s.call("GET", u, undefined, A)).body; assert.equal(d30.days, 30); assert.equal(d30.byDay.length, 30); assert.deepEqual(d30.totals, r.totals);
  assert.equal((await s.call("GET", u + "?days=90", undefined, A)).body.byDay.length, 90);
  assert.equal((await s.call("GET", u + "?days=12", undefined, A)).body.days, 30, "an unknown window is the default");
  // Cy was a member before he ever met the limit, and never met it: not an upgrade from the limit
  assert.equal(s.file("guide").members[cy.client.id].firstHit, undefined);
  // a week on, the window has moved past it all
  s.at("2026-11-25T15:00:00Z");
  const late = (await s.call("GET", u + "?days=7", undefined, A)).body; assert.equal(late.totals.limitPeople, 0); assert.equal(late.rate, null);
  assert.equal((await s.call("GET", u + "?days=30", undefined, A)).body.totals.upgraded, 1);

  // a deleted account takes its counters with it
  assert.equal((await s.call("DELETE", `/api/admin/clients/${bob.client.id}`, undefined, A)).status, 200);
  assert.equal(JSON.stringify(s.file("guide")).includes(bob.client.id), false);
  const after = (await s.call("GET", u + "?days=30", undefined, A)).body;
  assert.equal(after.totals.limitPeople, 1); assert.equal(after.totals.upgraded, 1); assert.equal(after.rate, 1);
});

test("guide: members' routes need a member, the owner's routes need the owner", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free");
  for (const [m, u, b] of [["GET", "/api/me/guide"], ["POST", "/api/me/guide/answer", { kind: "pain" }], ["POST", "/api/me/guide/ask", { text: "where are programs" }], ["POST", "/api/me/guide/event", { type: "open" }], ["GET", "/api/me/reminders"],
    ["POST", "/api/me/reminders", { title: "Walk", date: "2026-11-13", time: "07:00" }], ["DELETE", "/api/me/reminders/x"], ["PUT", "/api/me/prefs", { theme: "black" }]]) {
    assert.equal((await s.call(m, u, b)).status, 401, `${m} ${u} signed out`);
    assert.equal((await s.call(m, u, b, A)).status, 401, `${m} ${u} as the owner`);
  }
  for (const [m, u, b] of [["GET", "/api/admin/guide/stats"], ["PUT", "/api/admin/guide/settings", { freePerDay: 9 }]]) {
    assert.equal((await s.call(m, u, b)).status, 401, `${m} ${u} signed out`);
    assert.equal((await s.call(m, u, b, fay.token)).status, 401, `${m} ${u} as a member`);
  }
  assert.equal((await s.call("GET", "/api/admin/guide/stats", undefined, A)).body.settings.freePerDay, 25, "none of that changed the setting");
  assert.equal(fs.existsSync(path.join(s.dataDir, "guide.json")), false, "or wrote anything");
});

test("guide AI answers: off until the owner switches them on, and only ever with a service that signs an agreement", async (t) => {
  const m = await model(() => ({ content: '{"say":"Here you go.","places":["programs"],"area":""}' })); t.after(m.close);
  // nothing connected: the switch is refused, and says why
  const bare = await start(); t.after(bare.close);
  const A0 = await bare.adminToken(), z0 = await bare.signup("Zed Quillon");
  let r = await bare.call("PUT", "/api/admin/guide/settings", { ai: true }, A0);
  assert.equal(r.status, 400); assert.match(r.body.error, /No AI service is connected/);
  assert.equal((await bare.call("PUT", "/api/admin/guide/settings", { ai: "yes" }, A0)).status, 400);
  assert.equal((await bare.call("PUT", "/api/admin/guide/settings", { ai: false }, A0)).status, 200, "off is always allowed");
  assert.deepEqual((await bare.call("POST", "/api/me/guide/ask", { text: "where are programs" }, z0.token)).body, { ok: false, ai: false });
  // a service that does not sign one: refused whatever the switch says
  const router = await start({ scribe: { url: "https://openrouter.ai/api/v1", key: "k_made_up", model: "any" } }); t.after(router.close);
  const A1 = await router.adminToken();
  r = await router.call("PUT", "/api/admin/guide/settings", { ai: true, freePerDay: 9 }, A1);
  assert.equal(r.status, 400); assert.match(r.body.error, /does not sign a business associate agreement/);
  const st = (await router.call("GET", "/api/admin/guide/stats", undefined, A1)).body.settings;
  assert.deepEqual([st.freePerDay, st.ai, st.aiReady, st.aiHost], [25, false, false, "openrouter.ai"], "a refused change changes nothing");
  // connected and allowed, but the owner has not switched it on: the model is never called
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "small-one" } }); t.after(s.close);
  const A = await s.adminToken(), zed = await s.signup("Zed Quillon");
  assert.equal((await s.call("GET", "/api/me/guide", undefined, zed.token)).body.ai, false);
  assert.deepEqual((await s.call("POST", "/api/me/guide/ask", { text: "where are programs" }, zed.token)).body, { ok: false, ai: false });
  assert.equal(m.seen.length, 0); assert.equal((await s.call("GET", "/api/me/guide", undefined, zed.token)).body.used, 0);
  r = await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);
  assert.deepEqual(r.body, { settings: { freePerDay: 25, ai: true, aiReady: true, aiHost: m.host, aiModel: "small-one", aiWhy: "" } });
  assert.equal((await s.call("GET", "/api/me/guide", undefined, zed.token)).body.ai, true);
  await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);   // no change: not a second ledger entry
  await s.call("PUT", "/api/admin/guide/settings", { ai: false }, A);
  const log = (await s.call("GET", "/api/admin/audit?action=guide.ai", undefined, A)).body, rows = (log.entries || log.events || log.rows || log).filter((e) => e.action === "guide.ai");
  assert.equal(rows.length, 2, "on, then off");
  assert.deepEqual(rows.map((e) => e.meta).sort((a, b) => Number(a.on) - Number(b.on)), [{ on: false, host: m.host, model: "small-one" }, { on: true, host: m.host, model: "small-one" }]);
});

test("guide AI answers: the sentence goes without the member's name, one answer is counted, and nothing typed or said is kept", async (t) => {
  const MARK = "ZZMARKER", SAID = "YYSAIDMARK";
  const m = await model((n) => (n === 3 ? { status: 500 } : n === 4 ? { content: "Sure thing!" } : { content: `{"say":"I understand, that can be frustrating. ${SAID}","places":["pain","book","nowhere"],"area":"Knee"}` })); t.after(m.close);
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "small-one" } }); t.after(s.close);
  const A = await s.adminToken(), zed = await s.signup("Zed Quillon"), ask = (text, tok = zed.token) => s.call("POST", "/api/me/guide/ask", { text }, tok);
  await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);

  for (const bad of [undefined, "", "   ", "x".repeat(301), 7, ["knee"], { a: 1 }]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad));
  assert.equal(m.seen.length, 0);
  const ok = await ask(`Hi I'm Zed Quillon, zed.quillon@example.com. ${MARK} my knee hurts`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, say: `I understand, that can be frustrating. ${SAID}`, places: ["pain", "book"], area: "knee", used: 1, limit: 25, left: 24 });
  assert.equal(m.seen.length, 1); const sent = JSON.stringify(m.seen[0].body);
  assert.equal(/Zed|Quillon|zed\.quillon/.test(sent), false, "the member's name and email did not leave"); assert.match(sent, /my knee hurts/);
  assert.equal(sent.includes(zed.client.id), false, "nor anything else about them");
  assert.equal(m.seen[0].body.messages.length, 2);

  // an emergency is answered in the app: not sent, not counted
  assert.deepEqual((await ask(`${MARK} I have chest pain and can't breathe`)).body, { ok: true, urgent: true });
  assert.equal(m.seen.length, 1); assert.equal((await s.call("GET", "/api/me/guide", undefined, zed.token)).body.used, 1);

  // a member is counted too, with no limit
  const mel = await s.signup("Mel Member"); await s.call("PUT", `/api/admin/clients/${mel.client.id}/membership`, { tier: "member" }, A);
  assert.deepEqual([(await ask(`${MARK} sore knee`, mel.token)).body.used, m.seen.length], [1, 2]);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, mel.token)).body.left, null);

  // the service fails, or answers nonsense: the app falls back to the device, and nothing is counted
  assert.deepEqual((await ask(`${MARK} where are the programs`)).body, { ok: false, ai: false });
  assert.deepEqual((await ask(`${MARK} where are the programs`)).body, { ok: false, ai: false });
  assert.equal(m.seen.length, 4); assert.equal((await s.call("GET", "/api/me/guide", undefined, zed.token)).body.used, 1);

  // at the limit the model is not called, and the hit is recorded like any other
  await s.call("PUT", "/api/admin/guide/settings", { freePerDay: 1 }, A);
  assert.deepEqual((await ask(`${MARK} one more about my knee`)).body, { ok: false, limited: true, used: 1, limit: 1, left: 0 });
  assert.equal(m.seen.length, 4);
  const stats = (await s.call("GET", "/api/admin/guide/stats?days=7", undefined, A)).body;
  assert.deepEqual([stats.totals.answers, stats.totals.limitHits, stats.totals.limitPeople], [2, 1, 1]);
  assert.deepEqual(s.file("guide").days["2026-11-12"].kinds, { pain: 2 }); assert.equal(s.file("guide").days["2026-11-12"].ai, 2);

  // nothing typed and nothing the model said is anywhere the server writes: not the store, not the audit ledger
  const all = s.everything();
  assert.ok(all.includes('"answers"')); assert.equal(all.includes(MARK), false, "what was typed"); assert.equal(all.includes(SAID), false, "what came back");
  assert.equal(/guide\/ask/.test(JSON.stringify((await s.call("GET", "/api/admin/audit", undefined, A)).body)), false);

  // the owner switches it off: the next sentence is not sent
  await s.call("PUT", "/api/admin/guide/settings", { ai: false, freePerDay: 25 }, A);
  assert.deepEqual((await ask("where are the programs", mel.token)).body, { ok: false, ai: false }); assert.equal(m.seen.length, 4);
  // and one account cannot fire dozens a minute at it: Zed has sent twelve in this minute (the refused ones count too)
  const thirteenth = await ask("where are the programs");
  assert.equal(thirteenth.status, 429); assert.equal(m.seen.length, 4);
});
