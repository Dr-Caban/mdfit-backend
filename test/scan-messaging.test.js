// Twelve defects found in a read-through of messaging, pushes, live connections, video visits, Solomon, calendar sync
// and the video mirror, each with the scenario that showed it. Stand-ins everywhere: fake connections, a loopback
// server for the email provider / Bunny / Cloudinary / the model, a movable clock. No real network. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("node:events");
const { createTelehealth } = require("../lib/telehealth");
const { createNudges } = require("../lib/nudges");
const { rewards } = require("../lib/rewards");
const { createRealtime } = require("../lib/realtime");
const { createGuideAI } = require("../lib/guide-ai");
const { createCalSync, parseIcs } = require("../lib/calsync");
const { createNotifier } = require("../lib/notify");
const { createStore } = require("../lib/store");
const { signToken, hashPassword } = require("../lib/auth");
const { createApp, nowParts } = require("../server");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await fn()) return true; await wait(10); } return false; };

// ================= 1 and 9. Video visits: invitations and removals belong to one session =================
// A stand-in connection: what the server sends it is kept in .got; fire() plays a message from that browser
const conn = (clientId, extra = {}) => {
  const ee = new EventEmitter(), got = [];
  return { clientId, clientName: clientId, got, on: (e, f) => ee.on(e, f), emit: (event, data) => got.push({ event, data }), fire: (e, d) => ee.emit(e, d),
    count: (event) => got.filter((x) => x.event === event).length, ...extra };
};
const visits = (live) => {
  const clock = { t: Date.parse("2026-11-19T15:00:00Z") };
  const tele = createTelehealth({ live, now: () => clock.t, describe: (id) => ({ name: id }), invite: async (id) => ({ name: id }) });
  const doc = conn(); tele.staffJoin(doc);
  const member = (id) => { const c = conn(id); tele.patientJoin(c); return c; };
  return { tele, doc, member, clock, room: () => tele.snapshot().room.map((m) => `${m.clientId}:${m.role}`), waiting: () => tele.snapshot().waiting.map((w) => w.clientId) };
};

test("1. video visits: an invitation is used up by coming in and ends with its session; it never lets anyone into a later one", async () => {
  const v = visits(true);
  v.doc.fire("tele_invite", { clientId: "x" }); v.doc.fire("tele_invite", { clientId: "noshow" }); await wait(5);
  const x = v.member("x"); x.fire("tele_knock");
  assert.deepEqual(v.room(), ["x:viewer"], "the invited person is let in on arrival");
  assert.equal(v.tele.isInvited("noshow"), true);
  v.doc.fire("tele_end", {});                                   // the session they were invited to is over

  v.clock.t += 60 * 60e3;                                       // an hour later: someone else's visit
  const p = v.member("p"); p.fire("tele_knock");
  v.doc.fire("tele_admit", { clientId: "p" }); v.doc.fire("tele_role", { clientId: "p", role: "speaker" });
  x.fire("tele_knock"); const late = v.member("noshow"); late.fire("tele_knock");
  assert.deepEqual(v.room(), ["p:speaker"], "nobody walks into another person's visit on an old invitation");
  assert.deepEqual(v.waiting().sort(), ["noshow", "x"], "they wait to be admitted like anyone else");
  assert.equal(x.count("tele_admitted"), 1); assert.equal(late.count("tele_admitted"), 0);
  assert.equal(v.tele.isInvited("noshow"), false, "an invitation nobody took up ended with the session too");

  // within one session too: someone who leaves and comes back knocks again
  const w = visits(true);
  w.doc.fire("tele_invite", { clientId: "x" }); await wait(5);
  const x2 = w.member("x"), y2 = w.member("y"); x2.fire("tele_knock"); y2.fire("tele_knock"); w.doc.fire("tele_admit", { clientId: "y" });
  x2.fire("tele_leave"); x2.fire("tele_knock");
  assert.deepEqual([w.room(), w.waiting()], [["y:viewer"], ["x"]]);
});

test("1. video visits: a room that starts private goes back to private when it empties; an old knock cannot open it as a live room", async () => {
  const v = visits(false);
  v.doc.fire("tele_invite", { clientId: "x" }); await wait(5);
  const x = v.member("x"); x.fire("tele_knock");
  assert.deepEqual([v.room(), v.tele.snapshot().group], [["x:viewer"], true], "an invited person opens it as a live room, for that session");
  v.doc.fire("tele_end", {});
  assert.equal(v.tele.snapshot().group, false, "the next visit is one to one again");

  x.fire("tele_knock");                                         // the invitation is spent
  assert.deepEqual([v.room(), v.waiting(), v.tele.snapshot().group], [[], ["x"], false]);
  const p = v.member("p"); p.fire("tele_knock"); v.doc.fire("tele_admit", { clientId: "p" });
  assert.deepEqual(v.room(), ["p:speaker"], "a private visit: both sides talk, and nobody else is in it");
  v.doc.fire("tele_admit", { clientId: "x" });
  assert.deepEqual(v.room(), ["p:speaker"], "and a second person cannot be added to it");

  // a live room the host switched on by hand also ends with its session
  p.fire("tele_leave"); v.doc.fire("tele_group", { on: true });
  const q = v.member("q"); q.fire("tele_knock"); v.doc.fire("tele_admit", { clientId: "q" }); q.fire("tele_leave");
  assert.equal(v.tele.snapshot().group, false);
});

test("9. video visits: someone the host removed can knock again once that room has emptied, however it emptied", () => {
  const v = visits(true);
  const a = v.member("a"), b = v.member("b"); a.fire("tele_knock"); b.fire("tele_knock");
  v.doc.fire("tele_admit", { clientId: "a" }); v.doc.fire("tele_admit", { clientId: "b" });
  v.doc.fire("tele_end", { clientId: "a" });                    // removed from this room
  a.fire("tele_knock");
  assert.equal(a.got.filter((e) => e.event === "tele_declined" && e.data.removed).length, 1, "removed: not back into the same room");
  b.fire("tele_leave");                                         // the last viewer leaves on their own: the room is over
  assert.deepEqual(v.room(), []);
  a.fire("tele_knock");                                         // their own visit, later that day
  assert.equal(a.got.filter((e) => e.event === "tele_declined").length, 1, "not turned away a second time");
  assert.deepEqual(v.waiting(), ["a"], "they are in the waiting room for the host to admit");

  // the same when the last person drops off the connection rather than leaving
  const w = visits(true);
  const c = w.member("c"), d = w.member("d"); c.fire("tele_knock"); d.fire("tele_knock");
  w.doc.fire("tele_admit", { clientId: "c" }); w.doc.fire("tele_admit", { clientId: "d" });
  w.doc.fire("tele_end", { clientId: "c" }); d.fire("disconnect"); c.fire("tele_knock");
  assert.deepEqual(w.waiting(), ["c"]);
});

// ================= 2 and 4. Pushes from the nudge sweep =================
// A movable clock (UTC stands in for the clinic's zone), a presence store and a stubbed weather service, as in nudges.test.js
function sweeper({ clientsList, date = "2026-11-10", hour = 12 }) {
  const clock = { date, hour }, pushed = {};
  const data = { devices: clientsList.map((c) => ({ clientId: c.id })), presence: {} };
  const store = { read: (k, d) => (k in data ? data[k] : d), write: (k, v) => { data[k] = v; } };
  const out = [];
  const push = { enabled: true, toClient: (id, note) => { out.push({ id, day: clock.date, hour: clock.hour, ...note }); pushed[id] = clock.date; } };
  let list = clientsList;
  const at = () => new Date(`${clock.date}T${String(clock.hour).padStart(2, "0")}:05:00Z`);
  const n = createNudges({ store, clients: () => list, save: (l) => { list = l; }, push,
    rewardsOf: (c) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], visits: c.visits || [] }, clock.date),
    nowParts: (tz, d) => { const x = (d || at()).toISOString(); return { date: x.slice(0, 10), time: x.slice(11, 16) }; },
    zonedToUtc: (d, t) => new Date(`${d}T${t}:00Z`), prettyTime: (t) => t, tz: "UTC", now: at, logger: { warn() {} }, pushedOn: (id) => pushed[id] || "",
    fetchImpl: async () => ({ ok: true, json: async () => ({ current: { cloud_cover: 90, precipitation: 0, is_day: 1 } }) }) });
  // every hour of the given days, with the day's weather in before the sweep that needs it
  const run = async (days) => { for (const day of days) { clock.date = day; for (let h = 0; h < 24; h++) { clock.hour = h; n.sweep(); await n.prefetchWeather(day); n.sweep(); } } };
  return { n, clock, out, list: () => list, run };
}
const workout = (date) => ({ date, kind: "normal", minutes: 20, exercises: 5, completedAt: date + "T08:10:00Z" });

test("2. the streak push is about the streak a member holds now, not the best they ever had; a lapsed member gets the comeback line instead", async () => {
  // three days in a row in August, nothing since
  const lapsed = { id: "c1", name: "Quinn Zebulon", createdAt: "2026-07-01T12:00:00Z", workouts: [workout("2026-08-03"), workout("2026-08-04"), workout("2026-08-05")] };
  const h = sweeper({ clientsList: [lapsed] });
  h.n.sweep();                                                  // the starting point
  await h.run(["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
  assert.deepEqual(h.out.filter((x) => /streak/i.test(x.title + x.body)).map((x) => x.day), [], "no streak is hanging by a thread: it broke in August");
  const back = h.out.filter((x) => x.thread === "sunny");
  assert.equal(back.length, 1, "the comeback line, once, then quiet");
  assert.match(back[0].body, /Still here whenever you're ready/);

  // a live streak still gets the evening push, with its real length: 2 days now, though the best was 5
  const live = { id: "c1", name: "Quinn Zebulon", createdAt: "2026-07-01T12:00:00Z",
    workouts: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-11-09", "2026-11-10"].map(workout) };
  const g = sweeper({ clientsList: [live] });
  g.n.sweep(); await g.run(["2026-11-11"]);
  const streak = g.out.filter((x) => /Keep your/.test(x.title));
  assert.deepEqual(streak.map((x) => [x.hour, x.title]), [[18, "Keep your 2-day streak"]]);
  assert.match(streak[0].body, /2-day streak/);
  assert.equal(g.out.filter((x) => x.thread === "sunny").length, 0, "their one nudge is the streak one");
});

test("4. a badge push never says what the badge was for: pain logged, pain dropping and a clinic visit stay off the lock screen", () => {
  const c = { id: "c1", name: "Pat Doe", createdAt: "2026-10-01T00:00:00Z", painLog: [{ date: "2026-11-01", area: "Lower back", level: 8 }] };
  const h = sweeper({ clientsList: [c], date: "2026-11-11" });
  h.n.sweep();
  h.list()[0].painLog.push({ date: "2026-11-11", area: "Lower back", level: 4 });  // "Feeling Better": pain down 3+ points
  h.n.sweep();
  h.list()[0].visits = [{ date: "2026-11-11" }];                                    // "Team MD Fit": a visit with Dr. Jared
  h.n.sweep();
  const badges = h.out.filter((x) => /^badge:/.test(x.collapseId));
  assert.deepEqual(badges.map((x) => [x.title, x.body]), [["Badge earned", "You earned a badge. Tap to see it."], ["Badge earned", "You earned a badge. Tap to see it."]]);
  for (const x of h.out) assert.doesNotMatch(`${x.title} ${x.body}`, /pain|feeling better|listening|visit|dr\.? jared|back|area|points/i, "nothing from the record on a locked screen");

  // several at once are still only counted
  const many = { id: "c1", name: "Pat Doe", createdAt: "2026-10-01T00:00:00Z", painLog: [{ date: "2026-11-01", area: "Knee", level: 9 }] };
  const m = sweeper({ clientsList: [many], date: "2026-11-11" });
  m.n.sweep();
  m.list()[0].painLog.push({ date: "2026-11-11", area: "Knee", level: 2 }); m.list()[0].visits = [{ date: "2026-11-11" }];
  m.n.sweep();
  assert.deepEqual(m.out.filter((x) => /^badge:/.test(x.collapseId)).map((x) => x.body), ["You earned 2 badges. Tap to see them."]);
});

// ================= 3 and 10. Live connections =================
const SECRET = "s".repeat(40), OWNER = "coach@example.com";
const exp = () => Date.now() + 3600e3;
// A stand-in socket.io socket, signed in through the namespace's own sign-in check
const fakeSocket = (payload) => {
  const s = { id: "s" + Math.random().toString(36).slice(2), handshake: { auth: { token: signToken(payload, SECRET) } }, rooms: [], got: [], closed: false,
    join: (r) => s.rooms.push(r), emit: (e, d) => s.got.push([e, d]), on: () => {}, disconnect: () => { s.closed = true; } };
  return s;
};
const signIn = (ns, payload) => new Promise((r) => { const s = fakeSocket(payload); ns._fns[0](s, (err) => r(err ? { refused: err.message } : s)); });
const connect = (ns, s) => { ns.sockets.set(s.id, s); for (const fn of ns.listeners("connection")) fn(s); return s; };

test("3. a member's live connection is closed when their password changes, their account goes or their sign-in runs out", async (t) => {
  const people = { c1: { id: "c1", name: "Pat", pwv: 0 }, c2: { id: "c2", name: "Lee", pwv: 0 }, c3: { id: "c3", name: "Kim", pwv: 0 }, c4: { id: "c4", name: "Sam", pwv: 0 } };
  const rt = createRealtime(http.createServer(), { origins: ["*"], sessionSecret: SECRET, adminEmail: OWNER, rtRecheckMs: 0 }, { findClient: (id) => people[id] || null });
  t.after(() => rt.io.close());
  const open = async (id, at = exp()) => connect(rt.memberNs, await signIn(rt.memberNs, { sub: id, role: "client", pwv: 0, exp: at }));
  const [pat, lee, kim, sam] = [await open("c1"), await open("c2"), await open("c3"), await open("c4", Date.now() + 60e3)];
  assert.equal(typeof rt.recheck, "function", "connections already open are checked again");
  assert.equal(rt.recheck(), 0); assert.deepEqual([pat, lee, kim, sam].map((s) => s.closed), [false, false, false, false], "nothing changed: everyone stays");

  people.c1.pwv = 1;                                            // Pat changed their password
  delete people.c2;                                             // Lee's account was deleted
  assert.equal(rt.recheck(), 2);
  assert.deepEqual([pat, lee, kim, sam].map((s) => s.closed), [true, true, false, false]);
  assert.equal(pat.got.some(([e]) => e === "signed_out"), true, "told why before the connection goes");
  rt.memberNs.sockets.delete(pat.id); rt.memberNs.sockets.delete(lee.id);
  assert.equal(rt.recheck(Date.now() + 5 * 60e3), 1, "Sam's sign-in has run out");
  assert.deepEqual([kim.closed, sam.closed], [false, true]);

  // and it happens on its own, on a timer
  const rt2 = createRealtime(http.createServer(), { origins: ["*"], sessionSecret: SECRET, adminEmail: OWNER, rtRecheckMs: 15 }, { findClient: (id) => people[id] || null });
  t.after(() => rt2.io.close());
  const kim2 = connect(rt2.memberNs, await signIn(rt2.memberNs, { sub: "c3", role: "client", pwv: 0, exp: exp() }));
  await wait(60); assert.equal(kim2.closed, false);
  people.c3.pwv = 7;
  assert.equal(await until(() => kim2.closed, 1000), true, "closed without anyone asking");
});

test("10. staff can use the live admin connection under the REST guard's rules, and are sent only what their permissions cover", async (t) => {
  const staff = { "front@example.com": { email: "front@example.com", active: true, permissions: ["scheduling", "clients"] },
    "msgs@example.com": { email: "msgs@example.com", active: true, permissions: ["messages"] },
    "gone@example.com": { email: "gone@example.com", active: false, permissions: ["scheduling"] } };
  const rt = createRealtime(http.createServer(), { origins: ["*"], sessionSecret: SECRET, adminEmail: OWNER, rtRecheckMs: 0 }, { findStaff: (e) => staff[e] || null });
  t.after(() => rt.io.close());
  const admin = (payload) => signIn(rt.adminNs, { exp: exp(), ...payload });

  const front = await admin({ sub: "front@example.com", role: "staff" });
  assert.equal(front.refused, undefined, "an active staff account is let in");
  assert.deepEqual(front.permissions, ["clients", "scheduling"]);
  assert.match((await admin({ sub: "gone@example.com", role: "staff" })).refused, /Not admin/, "switched off");
  assert.match((await admin({ sub: "nobody@example.com", role: "staff" })).refused, /Not admin/, "no such account");
  assert.match((await admin({ sub: "front@example.com" })).refused, /Not admin/, "a staff address without the staff role");
  assert.match((await admin({ sub: "front@example.com", role: "client" })).refused, /Not admin/);
  assert.match((await admin({ sub: OWNER, role: "client" })).refused, /Not admin/, "a token with a role is never the owner's");
  const owner = await admin({ sub: OWNER });
  assert.equal(owner.refused, undefined); assert.equal(owner.permissions, null);

  // who is in which room: the owner hears everything, staff only what they hold
  const msgs = await admin({ sub: "msgs@example.com", role: "staff" });
  for (const s of [owner, front, msgs]) connect(rt.adminNs, s);
  assert.deepEqual([owner.rooms, front.rooms, msgs.rooms], [["admin"], ["perm:clients", "perm:scheduling"], ["perm:messages"]]);
  assert.deepEqual([owner, front, msgs].map((s) => s.got.some(([e]) => e === "online_count")), [true, false, false], "who is online is for Insights");
  const sent = []; rt.adminNs.to = (rooms) => ({ emit: (name, payload) => sent.push([name, [].concat(rooms).join("+"), payload.type || ""]) });
  rt.emitToAdmin("new_message", { clientId: "c1", clientName: "Pat Doe" });
  rt.emitToAdmin("calendar_changed", { dates: [] });
  rt.emitToAdmin("something_new", {});
  rt.emitActivity("appointment", { email: "pat@example.com" });
  rt.emitActivity("message", { email: "pat@example.com" });
  rt.emitActivity("patient_note", { email: "pat@example.com" });
  assert.deepEqual(sent, [["new_message", "admin+perm:messages", ""], ["calendar_changed", "admin+perm:scheduling", ""], ["something_new", "admin", ""],
    ["activity", "admin+perm:scheduling", "appointment"], ["toast", "admin+perm:scheduling", "appointment"],
    ["activity", "admin+perm:messages", "message"], ["toast", "admin+perm:messages", "message"], ["activity", "admin", "patient_note"]],
  "messages go to Messages, the diary to Scheduling, chart activity and anything unlisted to the owner alone");

  // the waiting room is Scheduling's: a staff connection without it is not part of video visits at all
  const tele = createTelehealth({ describe: (id) => ({ name: id }) });
  for (const s of [owner, front, msgs]) { s.got.length = 0; tele.staffJoin(s); }
  assert.deepEqual([owner, front, msgs].map((s) => s.got.some(([e]) => e === "tele_waiting")), [true, true, false]);

  // switched off, or given different permissions: the open connection is closed (they come back with the new ones)
  staff["front@example.com"].permissions = ["scheduling"]; staff["msgs@example.com"].active = false;
  assert.equal(rt.recheck(), 2); assert.deepEqual([owner.closed, front.closed, msgs.closed], [false, true, true]);

  // with nothing handed in, staff records are read from the store on disk, as the REST guard reads them
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-rt-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createStore(dataDir).write("staff", [{ id: "a1", email: "desk@example.com", active: true, permissions: ["scheduling"] }, { id: "a2", email: "off@example.com", active: false, permissions: ["scheduling"] }]);
  const rt2 = createRealtime(http.createServer(), { origins: ["*"], sessionSecret: SECRET, adminEmail: OWNER, dataDir, rtRecheckMs: 0 });
  t.after(() => rt2.io.close());
  assert.deepEqual((await signIn(rt2.adminNs, { sub: "desk@example.com", role: "staff", exp: exp() })).permissions, ["scheduling"]);
  assert.match((await signIn(rt2.adminNs, { sub: "off@example.com", role: "staff", exp: exp() })).refused, /Not admin/);
});

// ================= 5. What Solomon's question carries to the model =================
test("5. Solomon: short names, names without their accent, dates in any order and phone numbers from anywhere do not reach the model", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).messages[1].content); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"Here you go.","places":["pain"],"area":"knee"}' } }], usage: { total_tokens: 900 } }) }; };
  const ai = createGuideAI({ cfg: { scribe: { url: "http://localhost:1234/v1", key: "k_made_up", model: "small-one" } }, store: { read: () => ({}) }, logger: { warn() {} }, fetchImpl });
  const ask = async (text, names) => { await ai.understand({ text, names, places: [{ id: "pain", label: "Pain tool" }] }); return sent[sent.length - 1]; };

  let said = await ask("Hi this is Bo Li (DOB 1961-03-05, tel +44 7911 123456), my knee hurts", ["Bo Li"]);
  assert.doesNotMatch(said, /\bBo\b|\bLi\b|1961|7911|123456/, said); assert.match(said, /my knee hurts/);
  said = await ask("I'm José Núñez, born 5 March 1961. Call 555-1234 or 07911 123456 about Jose's hip", ["Jose Nunez"]);
  assert.doesNotMatch(said, /Jos[eé]|N[uú][nñ]ez|March|1961|555|07911|123456/, said); assert.match(said, /my hip/);
  said = await ask("Jose here: born in 1961, or March 1961, or Sept 1961, 05.03.1961, 3/1961, 5th of May", ["José Núñez"]);
  assert.doesNotMatch(said, /Jose|1961|Sept|March|5th of May/, said);
  said = await ask("SSN 123-45-6789, mobile (941) 555 0100 x22, office 9415550100", ["Maria Lopez"]);
  assert.doesNotMatch(said, /6789|555|0100\b|9415550100/, said);

  // ordinary words that happen to be short names, and ordinary numbers, are left alone
  said = await ask("An Do here. Do I need to do 3 sets of 10 12 15 or go on to 180 185 190 lbs? Taking 2 may help my 7/10 pain", ["An Do"]);
  assert.doesNotMatch(said, /An Do/, said);
  assert.match(said, /Do I need to do 3 sets of 10 12 15 or go on to 180 185 190 lbs\? Taking 2 may help my 7\/10 pain/);
});

// ================= 6. The SimplePractice calendar feed =================
const zonedToUtc = (date, time, tz = "America/New_York") => {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (ms) => { const p = nowParts(tz, new Date(ms)); return Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), +p.time.slice(0, 2), +p.time.slice(3)) - ms; };
  let t = guess - off(guess); t = guess - off(t);
  return new Date(t);
};
const feed = (...events) => `BEGIN:VCALENDAR\r\n${events.map((lines) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`;
const NOV = { from: "2026-11-01T04:00:00Z", to: "2026-12-01T04:59:00Z", tz: "America/New_York" };
const starts = (list) => list.filter((e) => !e.allDay).map((e) => e.start.toISOString());

test("6. calendar feed: days off block every day, repeats are written out for the dates looked at, DURATION counts, one odd event does not lose the feed", async () => {
  // a closure from the 24th to the 27th (the end date is the day after the last day)
  assert.deepEqual(parseIcs(feed(["DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261228", "SUMMARY:Out"]), zonedToUtc).map((e) => e.date), ["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27"]);
  assert.deepEqual(parseIcs(feed(["DTSTART;VALUE=DATE:20261224", "DURATION:P2D"]), zonedToUtc).map((e) => e.date), ["2026-12-24", "2026-12-25"]);
  assert.deepEqual(parseIcs(feed(["DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106"]), zonedToUtc), [{ allDay: true, date: "2026-11-05" }], "one day is still one day");

  // every Monday at noon since October: each Monday in the dates looked at, on the clock through the change to winter time
  const weekly = parseIcs(feed(["DTSTART;TZID=America/New_York:20261005T120000", "DTEND;TZID=America/New_York:20261005T130000", "RRULE:FREQ=WEEKLY;BYDAY=MO"]), zonedToUtc, NOV);
  assert.deepEqual(starts(weekly), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map((d) => `${d}T17:00:00.000Z`));
  assert.equal(weekly[0].end.toISOString(), "2026-11-02T18:00:00.000Z");
  assert.deepEqual(starts(parseIcs(feed(["DTSTART;TZID=America/New_York:20261019T120000", "DTEND;TZID=America/New_York:20261019T130000", "RRULE:FREQ=WEEKLY"]), zonedToUtc,
    { from: "2026-10-19T04:00:00Z", to: "2026-11-03T04:59:00Z" })), ["2026-10-19T16:00:00.000Z", "2026-10-26T16:00:00.000Z", "2026-11-02T17:00:00.000Z"], "noon stays noon");
  // every other week on Monday and Wednesday, one of them cancelled; five days in a row; the second Tuesday of the month; until a date
  assert.deepEqual(starts(parseIcs(feed(["DTSTART;TZID=America/New_York:20261005T120000", "DTEND;TZID=America/New_York:20261005T130000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2", "EXDATE;TZID=America/New_York:20261116T120000"]), zonedToUtc, NOV)),
    ["2026-11-02", "2026-11-04", "2026-11-18", "2026-11-30", "2026-12-02"].map((d) => `${d}T17:00:00.000Z`), "(the 16th was cancelled; a day either side of the dates looked at is kept)");
  assert.deepEqual(starts(parseIcs(feed(["DTSTART:20261029T140000Z", "DURATION:PT90M", "RRULE:FREQ=DAILY;COUNT=5"]), zonedToUtc, NOV)).slice(-2), ["2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"], "five in all, and no more");
  assert.deepEqual(parseIcs(feed(["DTSTART;VALUE=DATE:20260113", "RRULE:FREQ=MONTHLY;BYDAY=2TU"]), zonedToUtc, NOV), [{ allDay: true, date: "2026-11-10" }]);
  assert.deepEqual(starts(parseIcs(feed(["DTSTART:20261101T140000Z", "DTEND:20261101T150000Z", "RRULE:FREQ=WEEKLY;UNTIL=20261115T235959Z"]), zonedToUtc, NOV)), ["2026-11-01", "2026-11-08", "2026-11-15"].map((d) => `${d}T14:00:00.000Z`));
  // bounded: a daily repeat with no end, and no dates to look at, does not run away
  const daily = parseIcs(feed(["DTSTART:20200101T140000Z", "DTEND:20200101T150000Z", "RRULE:FREQ=DAILY"]), zonedToUtc);
  assert.ok(daily.length > 300 && daily.length <= 1000, String(daily.length));
  const inNov = parseIcs(feed(["DTSTART:20200101T140000Z", "DTEND:20200101T150000Z", "RRULE:FREQ=DAILY"]), zonedToUtc, NOV).length;
  assert.ok(inNov >= 30 && inNov <= 36, `only the dates looked at, a day or two either side (${inNov})`);

  // DURATION in place of DTEND
  const long = parseIcs(feed(["DTSTART:20261103T120000Z", "DURATION:PT3H"]), zonedToUtc)[0];
  assert.equal((long.end - long.start) / 3600e3, 3);

  // a zone name this server does not know, a quoted one, and a date that does not exist: the feed is still read
  const odd = parseIcs(feed(["DTSTART:20261102T140000Z", "DTEND:20261102T150000Z"],
    ["DTSTART;TZID=Eastern Standard Time:20261103T120000", "DTEND;TZID=Eastern Standard Time:20261103T130000"],
    ["DTSTART;TZID=\"America/New_York\":20261104T120000", "DTEND;TZID=\"America/New_York\":20261104T130000"],
    ["DTSTART:20261399T140000Z"]), zonedToUtc, { tz: "America/New_York" });
  assert.deepEqual(starts(odd), ["2026-11-02T14:00:00.000Z", "2026-11-03T17:00:00.000Z", "2026-11-04T17:00:00.000Z"], "the unknown zone is read as the practice's own, so the time stays blocked");

  // 02:30 on the night the clocks go forward does not exist: it is 03:30, not an hour earlier
  const gap = parseIcs(feed(["DTSTART;TZID=America/New_York:20270314T023000", "DTEND;TZID=America/New_York:20270314T040000"]), zonedToUtc)[0];
  assert.deepEqual([gap.start.toISOString(), gap.end.toISOString()], ["2027-03-14T07:30:00.000Z", "2027-03-14T08:00:00.000Z"]);

  // and through the sync itself: the dates asked for decide which repeats are busy
  const text = feed(["DTSTART;TZID=America/New_York:20261005T120000", "DTEND;TZID=America/New_York:20261005T130000", "RRULE:FREQ=WEEKLY;BYDAY=MO"], ["DTSTART;VALUE=DATE:20261126", "DTEND;VALUE=DATE:20261128"],
    ["DTSTART;TZID=Eastern Standard Time:20261110T090000", "DTEND;TZID=Eastern Standard Time:20261110T100000"]);
  const sync = createCalSync({ icsUrl: "https://sp.example/feed.ics", tz: "America/New_York", zonedToUtc, fetchImpl: async () => ({ ok: true, text: async () => text }), logger: { error() {} } });
  const busy = await sync.busy("2026-11-09", "2026-11-29");
  assert.equal(sync.status().lastError, "");
  assert.deepEqual(starts(busy), ["2026-11-09T17:00:00.000Z", "2026-11-16T17:00:00.000Z", "2026-11-23T17:00:00.000Z", "2026-11-30T17:00:00.000Z", "2026-11-10T14:00:00.000Z"]);
  assert.deepEqual(busy.filter((e) => e.allDay).map((e) => e.date), ["2026-11-26", "2026-11-27"]);
});

// ================= 7. Email retries =================
// A stand-in for the email provider: answer(n, req) says what the nth request gets
async function provider(answer) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ path: req.url, key: req.headers["idempotency-key"] || "", body: JSON.parse(b) });
    const status = answer(seen.length, req.url);
    res.writeHead(status, { "content-type": "application/json", ...(status >= 500 ? { "retry-after": "0.001" } : {}) }); res.end("{}");
  }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test("7. email: a retry carries the same key as the first try, so a message the provider already took is not delivered twice", async (t) => {
  const p = await provider((n) => (n <= 2 ? 503 : 200)); t.after(p.close);
  const results = [];
  const n = createNotifier({ apiKey: "k_made_up", from: "MD Fit <hello@example.com>", ownerEmail: "owner@example.com", apiUrl: p.url, minGapMs: 0, onResult: (r) => results.push(r) });
  assert.equal(await n.client("pat@example.com", "Dr. Jared replied to your message", "x"), true);
  assert.equal(p.seen.length, 3, "two tries the provider answered badly, then one it took");
  assert.match(p.seen[0].key, /^[\w-]{16,}$/, "every request names its message");
  assert.deepEqual(p.seen.map((x) => x.key), [p.seen[0].key, p.seen[0].key, p.seen[0].key], "the same key each time");
  assert.equal(await n.client("lee@example.com", "Dr. Jared replied to your message", "x"), true);
  assert.notEqual(p.seen[3].key, p.seen[0].key, "a different message has its own");
});

test("7. email: a group message whose batch may have gone out is not sent again one by one; a batch refused outright still is", async (t) => {
  const people = ["a@example.com", "b@example.com", "c@example.com"].map((to) => ({ to, subject: "New message from Dr. Jared", text: "x" }));
  // the provider errors on the batch every time: it may have taken it, and nobody can know
  const down = await provider(() => 503); t.after(down.close);
  const results = [];
  const n = createNotifier({ apiKey: "k_made_up", from: "MD Fit <hello@example.com>", ownerEmail: "owner@example.com", apiUrl: down.url, minGapMs: 0, onResult: (r) => results.push(r) });
  const ok = await n.many(people);
  assert.deepEqual(down.seen.map((x) => x.path).filter((x) => x !== "/emails/batch"), [], "no one-by-one copies of a batch that may have been delivered");
  assert.equal(new Set(down.seen.map((x) => x.key)).size, 1, "every try of the batch is the same batch");
  assert.equal(ok.size, 0, "reported as not sent, so the sender can remind them later");
  assert.deepEqual(results.map((r) => [r.ok, r.count]), [[false, 3]], "and the failure is on the email log");

  // refused outright (one bad address): nobody got it, so each is sent on its own
  const picky = await provider((k, url) => (url === "/emails/batch" ? 422 : 200)); t.after(picky.close);
  const n2 = createNotifier({ apiKey: "k_made_up", from: "MD Fit <hello@example.com>", ownerEmail: "owner@example.com", apiUrl: picky.url, minGapMs: 0 });
  assert.deepEqual([...(await n2.many(people))].sort(), ["a@example.com", "b@example.com", "c@example.com"]);
  assert.deepEqual(picky.seen.map((x) => x.path), ["/emails/batch", "/emails", "/emails", "/emails"]);
});

// ================= 8. The video mirror =================
const asset = (key) => ({ key, source: "drive", drive_id: key, type: "video", public_id: `mdfit/videos/x/${key}`, display_name: key, tags: ["mdfit"], context: { name: key }, folder: "mdfit/videos/x" });
// A stand-in for the site (the media list), Drive, Bunny and Cloudinary. state.manifest: the status the media list
// answers with; state.encode: what Bunny says about a video; state.hold(n): keep Bunny's nth status answer back
async function mediaHosts(assets) {
  const seen = { manifest: 0, create: [], status: 0, destroy: [] }, state = { manifest: 200, encode: { status: 4, encodeProgress: 100, availableResolutions: "360p,720p" }, holdAt: 0, held: null, release: null };
  let g = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; for await (const c of req) body += c.length < 4096 ? c : "";
    if (u.pathname === "/data/media-manifest.json") { seen.manifest++; await wait(40); return json(state.manifest, { assets }); }
    if (u.pathname === "/public") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(96, 3)); }
    if (u.pathname === "/bunny/library/lib42/collections") return json(200, req.method === "GET" ? { items: [{ guid: "coll", name: "In app" }] } : { guid: "coll" });
    if (u.pathname === "/bunny/library/lib42/videos") { const guid = `guid-${++g}`; seen.create.push(JSON.parse(body).title); return json(200, { guid }); }
    const m = u.pathname.match(/^\/bunny\/library\/lib42\/videos\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (++seen.status === state.holdAt) { await new Promise((go) => { state.release = go; state.held(); }); }
      return json(200, { guid: m[1], ...state.encode });
    }
    if (m) { await wait(120); return json(200, {}); }           // the upload itself takes a moment
    if (/^\/v1_1\/testcloud\/video\/upload$/.test(u.pathname)) return json(200, { public_id: new URLSearchParams(body).get("public_id"), version: 7, bytes: 96, format: "mp4" });
    if (/^\/v1_1\/testcloud\/video\/destroy$/.test(u.pathname)) { seen.destroy.push(new URLSearchParams(body).get("public_id")); return json(200, { result: "ok" }); }
    res.writeHead(404); res.end();
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, state, close: () => { srv.closeAllConnections(); srv.close(); } };
}
async function mediaApp(t, f, extra = {}) {
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: "testcloud", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret", BUNNY_STREAM_API_KEY: "bunny-key", BUNNY_STREAM_LIBRARY_ID: "lib42", BUNNY_STREAM_HOSTNAME: "vz-test.b-cdn.net" });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-v-"));
  const app = createApp({ adminEmail: OWNER, adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: SECRET, dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: f.base, cloudinaryApiUrl: f.base, bunnyApiUrl: f.base + "/bunny", drivePublicUrl: f.base + "/public?id=", noVideoSync: true, ...extra });
  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_HOSTNAME"]) delete process.env[k];
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); f.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const adm = (await call("POST", "/api/admin/login", { email: OWNER, password: "admin-pass-123" })).body.token;
  const status = async () => (await call("GET", "/api/admin/videos/status", undefined, adm)).body;
  const records = () => JSON.parse(fs.readFileSync(path.join(dataDir, "videos-testcloud.json"), "utf8"));
  return { call, adm, status, records };
}

test("8. video mirror: two sync requests at the same moment are one run; nothing is uploaded twice or marked as a crash", async (t) => {
  const f = await mediaHosts([asset("clip-one"), asset("clip-two")]);
  const s = await mediaApp(t, f, { bunnyDualWrite: "off" });
  const [a, b] = await Promise.all([s.call("POST", "/api/admin/videos/migrate", {}, s.adm), s.call("POST", "/api/admin/videos/migrate", {}, s.adm)]);
  assert.deepEqual([a.body.started, b.body.started, a.body.running, b.body.running].map(Boolean).sort(), [false, false, true, true], "one starts, the other is told a run is on");
  assert.equal(await until(async () => { const st = await s.status(); return st.job && st.job.finishedAt; }), true);
  await wait(200);
  assert.deepEqual(f.seen.create.slice().sort(), ["clip-one", "clip-two"], "each video went to Bunny once");
  const st = await s.status();
  assert.deepEqual([st.failed, s.records().crashed || {}, st.job.ok, st.job.total], [{}, {}, 2, 2]);
});

test("8. video mirror: when the media list cannot be read, the automatic sync keeps one retry going, not one more for every attempt", async (t) => {
  const f = await mediaHosts([asset("clip-one")]); f.state.manifest = 500;
  // the six-hourly timer's own function, taken as the app sets it up; and every five-minute retry it arms afterwards
  const realInterval = global.setInterval, realTimeout = global.setTimeout;
  let autoSync = null, armed = 0;
  global.setInterval = (fn, ms, ...rest) => { if (ms === 6 * 3600 * 1000) autoSync = fn; return realInterval(fn, ms, ...rest); };
  t.after(() => { global.setInterval = realInterval; global.setTimeout = realTimeout; });
  await mediaApp(t, f, { noVideoSync: false, videoSyncHold: true });
  global.setInterval = realInterval;
  assert.equal(typeof autoSync, "function");
  global.setTimeout = (fn, ms, ...rest) => { if (ms === 5 * 60e3) armed++; return realTimeout(fn, ms, ...rest); };
  for (let i = 1; i <= 3; i++) { autoSync(); assert.equal(await until(() => f.seen.manifest === i), true, `attempt ${i} read the list`); await wait(60); }
  global.setTimeout = realTimeout;
  assert.equal(armed, 1, "three failed attempts, one retry waiting");
  // two attempts at once read the list once
  f.state.manifest = 200; const before = f.seen.manifest;
  autoSync(); autoSync(); await wait(300);
  assert.equal(f.seen.manifest - before, 1);
});

test("8. video mirror: the check for finished encodes does not write an old copy of the records over a purge that ran meanwhile", async (t) => {
  const f = await mediaHosts([asset("clip-one")]);
  f.state.encode = { status: 2, encodeProgress: 35, availableResolutions: "" };  // still encoding when the sync ends
  const s = await mediaApp(t, f, { noVideoSync: false, videoSyncHold: true, bunnyPollMs: 25 });
  const held = new Promise((r) => { f.state.held = r; }); f.state.holdAt = 2;      // the sync's own check is the first; the timer's is the second
  await s.call("POST", "/api/admin/videos/migrate", {}, s.adm);
  await held;                                                                    // the timer has read the records and is waiting on Bunny
  assert.equal(s.records().done["clip-one"].pid, "mdfit/videos/x/clip-one", "on Cloudinary and on Bunny at this point");
  const purge = await s.call("POST", "/api/admin/videos/purge-cloudinary", {}, s.adm);
  assert.deepEqual([purge.body.removed, f.seen.destroy], [1, ["mdfit/videos/x/clip-one"]]);
  f.state.encode = { status: 4, encodeProgress: 100, availableResolutions: "360p,720p" };
  f.state.release();                                                             // Bunny answers: encoded
  assert.equal(await until(() => s.records().done["clip-one"].ready === true), true, "the encode is noticed");
  const pub = (await s.call("GET", "/api/videos")).body;
  assert.deepEqual(pub.map, {}, "the Cloudinary copy that was just deleted is not offered again");
  assert.deepEqual(Object.keys(pub.bunny.map), ["clip-one"]);
  assert.equal(s.records().done["clip-one"].pid, undefined);
});

// ================= 11 and 12. Through the app: Solomon's daily allowance, time in app =================
async function memberApp(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-a-"));
  const clock = { now: new Date("2026-11-12T15:00:00Z") };      // 10:00 AM on Nov 12 at the clinic (New York)
  const app = createApp({ adminEmail: OWNER, adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: SECRET, dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://site.example.com", noVideoSync: true, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: OWNER, password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  return { call, adminToken, signup, at: (iso) => { clock.now = new Date(iso); }, file: (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8")) };
}

test("11. Solomon: questions sent at the same moment cannot all slip under the daily limit, and a reply that could not be used still counts", async (t) => {
  // a stand-in model: 4,000 tokens an answer, a moment to think; mode decides what it says
  const seen = []; let mode = "ok";
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push(1);
    setTimeout(() => {
      if (mode === "refuse") { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: mode === "ok" ? '{"say":"Here you go.","places":["pain"],"area":"knee"}' : "Sure thing!" } }], usage: { total_tokens: 4000 } }));
    }, 150); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const s = await memberApp(t, { scribe: { url: `http://127.0.0.1:${srv.address().port}/v1`, key: "k_made_up", model: "small-one" } });
  const A = await s.adminToken();
  assert.equal((await s.call("PUT", "/api/admin/guide/settings", { ai: true, freeTokensPerDay: 5000 }, A)).status, 200);
  const used = async (who) => (await s.call("GET", "/api/me/guide", undefined, who.token)).body.used;

  const fay = await s.signup("Fay Free");
  const all = await Promise.all(Array.from({ length: 12 }, () => s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, fay.token)));
  const answered = all.filter((r) => r.body.ok === true).length, limited = all.filter((r) => r.body.limited === true).length;
  assert.equal(answered + limited, 12);
  assert.ok(answered >= 1 && answered <= 2, `${answered} answered on a 5,000-token day (one answer is 4,000)`);
  assert.equal(seen.length, answered, "the model was only asked for the ones that were let through");
  assert.equal(await used(fay), answered * 4000, "what was held for each is settled to what it really cost");

  // one at a time is as before: allowed while under the limit, stopped at it
  const gus = await s.signup("Gus Free");
  assert.equal((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, gus.token)).body.used, 4000);
  assert.equal((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, gus.token)).body.used, 8000);
  assert.equal((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, gus.token)).body.limited, true);

  // the model answered but not in a form that can be used: the app falls back to the device, and the call is counted
  const hal = await s.signup("Hal Free"); mode = "nonsense";
  assert.deepEqual((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, hal.token)).body, { ok: false, ai: false });
  assert.equal(await used(hal), 4000, "counted at what was held (the last answer's cost)");
  assert.deepEqual((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, hal.token)).body, { ok: false, ai: false });
  assert.equal((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, hal.token)).body.limited, true, "so it cannot be asked without end");
  // the service refused: nothing was produced, nothing is counted, and nothing stays held
  const ivy = await s.signup("Ivy Free"); mode = "refuse";
  assert.deepEqual((await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, ivy.token)).body, { ok: false, ai: false });
  assert.equal(await used(ivy), 0);
});

test("12. time in app: a day the app was open at midnight counts as opened, and only real screens are counted as screens", async (t) => {
  const s = await memberApp(t);
  const pat = await s.signup("Pat Doe");
  const beat = (body) => s.call("POST", "/api/me/presence", body, pat.token);
  s.at("2026-11-13T04:56:00Z");                                 // 11:56 PM on the 12th at the clinic
  assert.equal((await beat({ seconds: 0, view: "home", platform: "web" })).body.sessions, 1);
  for (const iso of ["2026-11-13T04:57:00Z", "2026-11-13T04:58:00Z", "2026-11-13T04:59:00Z"]) { s.at(iso); await beat({ seconds: 60, view: "home", platform: "web" }); }
  s.at("2026-11-13T05:00:30Z");                                 // half a minute into the 13th, still in the app
  assert.equal((await beat({ seconds: 60, view: "programs", platform: "web" })).body.sessions, 1, "the 13th was opened");
  s.at("2026-11-13T05:01:30Z");
  assert.equal((await beat({ seconds: 60, view: "programs", platform: "web" })).body.sessions, 1, "and it is still one sitting");
  const days = s.file("presence")[pat.client.id].days;
  assert.deepEqual([days["2026-11-12"].sessions, days["2026-11-13"].sessions], [1, 1]);

  // a word that fits the old pattern but is no screen
  for (let i = 0; i < 2; i++) { s.at(`2026-11-13T05:0${2 + i}:30Z`); assert.equal((await beat({ seconds: 60, view: "constructor", platform: "web" })).status, 200); }
  await beat({ seconds: 30, view: "visit", platform: "web" }); await beat({ seconds: 30, view: ["home"], platform: "web" });
  assert.deepEqual(s.file("presence")[pat.client.id].days["2026-11-13"].views, { programs: 120, app: 150, visit: 30 });
});
