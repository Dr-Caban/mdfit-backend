// Birthday at sign-up is optional; a member who gave one gets one greeting a year, on the day. Made-up data.
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

test("birthday: optional at sign-up, checked when given, and greeted once on the day from 9 AM", async (t) => {
  const mails = [];
  const mailer = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const j = JSON.parse(b); (Array.isArray(j) ? j : [j]).forEach((m) => mails.push(m)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mailer.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-bday-"));
  const clock = { now: new Date("2026-11-24T15:00:00Z") }; // 10 AM at the clinic
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://mdfit.example.com",
    resendKey: "test-key", notifyFrom: "MD Fit <hello@example.com>", resendUrl: `http://127.0.0.1:${mailer.address().port}`, notifyGapMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); mailer.closeAllConnections(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const signup = async (name, dob) => { const r = await fetch(base + "/api/clients/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1", ...(dob === undefined ? {} : { dob }) }) }); return { status: r.status, body: await r.json() }; };
  const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, "clients.json"), "utf8"));
  const wait = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); };
  const greetings = () => mails.filter((m) => /Happy birthday/.test(m.subject || ""));

  assert.equal((await signup("Nia None")).status, 201, "no birthday is fine");
  assert.equal((await signup("Eli Empty", "")).status, 201, "an empty one is fine");
  for (const bad of ["1990-02-30", "11/25/1990", "2090-01-01", "1850-01-01"]) { const r = await signup("Bad Date", bad); assert.equal(r.status, 400, bad); assert.match(r.body.error, /birthday/i); }
  assert.equal((await signup("Tia Today", "1990-11-25")).status, 201);
  assert.equal((await signup("Otis Other", "1985-06-02")).status, 201);
  const tia = stored().find((c) => c.name === "Tia Today");
  assert.equal(tia.dob, "1990-11-25"); assert.equal(tia.dobBy, "member");
  assert.equal(stored().find((c) => c.name === "Nia None").dob, undefined);

  const run = app.get("birthdays");
  assert.equal(run(), 0, "the day before: nobody");
  clock.now = new Date("2026-11-25T12:00:00Z"); assert.equal(run(), 0, "7 AM on the day: not yet");
  clock.now = new Date("2026-11-25T14:30:00Z"); assert.equal(run(), 1, "9:30 AM on the day");
  await wait(() => greetings().length === 1);
  const m = greetings()[0];
  assert.deepEqual([].concat(m.to), ["tia.today@example.com"]); assert.equal(m.subject, "Happy birthday, Tia!");
  assert.ok(!/1990|36|years/.test(m.text || ""), "no age, no year");
  assert.equal(run(), 0, "once a year");
  clock.now = new Date("2027-11-25T15:00:00Z"); assert.equal(run(), 1, "and again next year");
  await wait(() => greetings().length === 2); // let the second email leave before the stand-in mail server closes
  // A date that came in with imported records (no dobBy) is never greeted
  const l = stored(); const nia = l.find((c) => c.name === "Nia None"); nia.dob = "1970-11-26"; fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify(l));
  clock.now = new Date("2027-11-26T15:00:00Z"); assert.equal(run(), 0);
});

// The same server as above, with the push sender swapped for a list of what would have gone out
async function bootBirthday(t, at) {
  const mails = [];
  const mailer = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const j = JSON.parse(b); (Array.isArray(j) ? j : [j]).forEach((m) => mails.push(m)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mailer.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-bday-"));
  const clock = { now: new Date(at) };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://mdfit.example.com",
    resendKey: "test-key", notifyFrom: "MD Fit <hello@example.com>", resendUrl: `http://127.0.0.1:${mailer.address().port}`, notifyGapMs: 0 });
  const pushes = []; app.get("push").toClient = (id, note) => { pushes.push({ id, note }); };
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); mailer.closeAllConnections(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const signup = async (name, dob) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1", ...(dob === undefined ? {} : { dob }) })).body;
  const file = path.join(dataDir, "clients.json");
  const stored = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const greetings = () => mails.filter((m) => /Happy birthday/.test(m.subject || "")).map((m) => [].concat(m.to)[0]);
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  return { app, call, signup, clock, dataDir, file, stored, pushes, greetings, settle, run: app.get("birthdays") };
}

test("birthday: no email to a member who asked not to be emailed, no push with reminders off", async (t) => {
  const s = await bootBirthday(t, "2026-11-24T15:00:00Z");
  const rhea = await s.signup("Rhea Restrict", "1990-11-25"), pia = await s.signup("Pia Phone", "1991-11-25");
  const nell = await s.signup("Nell Nonudge", "1992-11-25"), ola = await s.signup("Ola Open", "1993-11-25");
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "email", restrictions: "Please do not email me about anything but visits." }, rhea.token)).status, 200);
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "phone", restrictions: "" }, pia.token)).status, 200);
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "email", restrictions: "" }, ola.token)).status, 200, "email chosen is fine");
  assert.equal((await s.call("PUT", "/api/me/prefs", { nudges: "off" }, nell.token)).status, 200);
  s.clock.now = new Date("2026-11-25T15:00:00Z");
  assert.equal(s.run(), 4, "everyone is greeted, each the way they allow");
  await s.settle(500);
  assert.deepEqual(s.greetings().sort(), ["nell.nonudge@example.com", "ola.open@example.com"], "no email for a restriction or for phone only");
  assert.deepEqual(s.pushes.map((p) => p.id).sort(), [rhea.client.id, pia.client.id, ola.client.id].sort(), "no push with reminders off");
  assert.ok(s.stored().every((c) => c.birthdayGreeted === "2026"), "the year is kept for all four, so none is greeted twice");
  assert.equal(s.run(), 0);
});

test("birthday: the year is saved before anything is sent, so a failing save never resends", async (t) => {
  const s = await bootBirthday(t, "2026-11-25T15:00:00Z");
  await s.signup("Fay Failsave", "1990-11-25");
  const blocker = s.file + "." + process.pid + ".tmp";
  fs.mkdirSync(blocker); // the next write of the client list fails, as a full disk would
  for (let i = 0; i < 3; i++) assert.throws(() => s.run(), "the timer in server.js logs it");
  await s.settle();
  assert.equal(s.greetings().length, 0, "nothing is emailed while the save fails");
  assert.equal(s.pushes.length, 0, "nothing is pushed while the save fails");
  fs.rmdirSync(blocker);
  assert.equal(s.run(), 1); assert.equal(s.run(), 0);
  await s.settle(500);
  assert.equal(s.greetings().length, 1, "one greeting once the save works"); assert.equal(s.pushes.length, 1);
});

test("birthday: a damaged record is passed over and everyone else is still greeted", async (t) => {
  const s = await bootBirthday(t, "2026-11-25T15:00:00Z");
  await s.signup("Gus Good", "1990-11-25"); await s.signup("Dee Damaged", "1991-11-25"); await s.signup("Ned Named", "1992-11-25");
  const list = s.stored();
  list.find((c) => c.name === "Dee Damaged").dob = 19911125;         // a birthday that is not text
  list.find((c) => c.name === "Ned Named").name = { first: "Ned" };   // a name that is not text: greeted as "there"
  list.unshift(null);                                                 // an empty slot in the list
  fs.writeFileSync(s.file, JSON.stringify(list));
  assert.equal(s.run(), 2);
  await s.settle(500);
  assert.deepEqual(s.greetings().sort(), ["gus.good@example.com", "ned.named@example.com"]);
  assert.equal(s.stored().find((c) => c && c.email === "dee.damaged@example.com").birthdayGreeted, undefined);
});

test("birthday: the member sees it, changes it and removes it in their own record", async (t) => {
  const s = await bootBirthday(t, "2026-11-24T15:00:00Z");
  const bea = await s.signup("Bea Birthday", "1988-04-17"), nod = await s.signup("Nod Nodob");
  const me = async (tok) => (await s.call("GET", "/api/me", undefined, tok)).body.client;
  const rec = () => s.stored().find((c) => c.id === bea.client.id);
  assert.equal(bea.client.dob, "1988-04-17", "the sign-up answer carries it");
  assert.equal((await me(bea.token)).dob, "1988-04-17");
  assert.equal((await me(nod.token)).dob, "", "none kept reads as empty text");
  // change it
  const ch = await s.call("PUT", "/api/me", { dob: "1988-11-25" }, bea.token);
  assert.equal(ch.status, 200); assert.equal(ch.body.client.dob, "1988-11-25");
  assert.equal(rec().dob, "1988-11-25"); assert.equal(rec().dobBy, "member");
  // anything that is not a usable date is refused, with the sign-up's own message, and changes nothing
  for (const bad of ["1988-02-30", "11/25/1988", "2099-01-01", "1850-01-01", 19880417, null, true, ["1988-04-17"], { toString: "x" }]) {
    const r = await s.call("PUT", "/api/me", { dob: bad }, bea.token);
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body.error, /birthday/i);
  }
  assert.equal(rec().dob, "1988-11-25");
  // left out of the body: nothing about it changes
  assert.equal((await s.call("PUT", "/api/me", { name: "Bea Birthday", phone: "941-555-0100" }, bea.token)).status, 200);
  assert.equal(rec().dob, "1988-11-25"); assert.equal(rec().dobBy, "member");
  // a date given later in the app counts as theirs: a member with none before can add one
  assert.equal((await s.call("PUT", "/api/me", { dob: "1990-11-25" }, nod.token)).body.client.dob, "1990-11-25");
  assert.equal(s.stored().find((c) => c.id === nod.client.id).dobBy, "member");
  // greeted on the day; moving the date to another day of the same year does not bring a second greeting
  s.clock.now = new Date("2026-11-25T15:00:00Z");
  assert.equal(s.run(), 2);
  assert.equal((await s.call("PUT", "/api/me", { dob: "1988-11-26" }, bea.token)).status, 200);
  assert.equal(rec().birthdayGreeted, "2026", "a new date keeps this year's greeting");
  s.clock.now = new Date("2026-11-26T15:00:00Z");
  assert.equal(s.run(), 0, "no second greeting in a year already greeted");
  // remove it: the date and whose it was go; the record of this year's greeting stays
  const rm = await s.call("PUT", "/api/me", { dob: "" }, bea.token);
  assert.equal(rm.status, 200); assert.equal(rm.body.client.dob, "");
  assert.ok(!("dob" in rec()) && !("dobBy" in rec()), JSON.stringify(rec()));
  assert.equal(rec().birthdayGreeted, "2026");
  assert.equal((await me(bea.token)).dob, "");
  // so removing it and giving it again on the day does not bring a second greeting
  assert.equal((await s.call("PUT", "/api/me", { dob: "1988-11-26" }, bea.token)).status, 200);
  assert.equal(s.run(), 0, "removed and given again: still greeted once this year");
  assert.equal((await s.call("PUT", "/api/me", { dob: "" }, bea.token)).status, 200);
  s.clock.now = new Date("2027-11-26T15:00:00Z");
  assert.equal(s.run(), 0, "no birthday, no greeting");
  await s.settle(500);
});

test("birthday: staff views do not carry it, and a date of birth from the clinic's records is not the app's to change", async (t) => {
  const s = await bootBirthday(t, "2026-11-24T15:00:00Z");
  const bea = await s.signup("Bea Birthday", "1988-04-17"), imp = await s.signup("Ima Ported");
  // the member sees their own; the workspace's client views (built for staff) do not show it
  const login = await s.call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" });
  assert.equal(login.status, 200); const A = login.body.token;
  for (const u of [`/api/admin/clients/${bea.client.id}`, `/api/admin/clients/${bea.client.id}/overview`, "/api/admin/clients"]) {
    const v = await s.call("GET", u, undefined, A);
    assert.equal(v.status, 200, u); assert.equal(JSON.stringify(v.body).includes("1988-04-17"), false, `${u} carries no date of birth`);
  }
  // a date that came with imported records has no dobBy: the member sees it, marked as the clinic's
  const l = s.stored(); const r = l.find((c) => c.id === imp.client.id); r.dob = "1970-03-04"; fs.writeFileSync(s.file, JSON.stringify(l));
  const mine = (await s.call("GET", "/api/me", undefined, imp.token)).body.client;
  assert.equal(mine.dob, "1970-03-04"); assert.equal(mine.dobLocked, true);
  assert.equal((await s.call("GET", "/api/me", undefined, bea.token)).body.client.dobLocked, false);
  // the same date sent back (a profile save) is fine and changes nothing; a new date or removing it is refused
  const same = await s.call("PUT", "/api/me", { name: "Ima Ported", dob: "1970-03-04" }, imp.token);
  assert.equal(same.status, 200);
  for (const v of ["1971-03-04", ""]) {
    const no = await s.call("PUT", "/api/me", { dob: v }, imp.token);
    assert.equal(no.status, 409, JSON.stringify(v)); assert.match(no.body.error, /on file with the clinic/); assert.equal(no.body.dobLocked, true);
  }
  const kept = s.stored().find((c) => c.id === imp.client.id);
  assert.equal(kept.dob, "1970-03-04"); assert.equal(kept.dobBy, undefined, "still the clinic's, never turned into the member's");
  // a clinic date a birthday could not use (before 1900) is still shown and can be sent back unchanged
  const l2 = s.stored(); l2.find((c) => c.id === imp.client.id).dob = "1890-01-01"; fs.writeFileSync(s.file, JSON.stringify(l2));
  assert.equal((await s.call("GET", "/api/me", undefined, imp.token)).body.client.dob, "1890-01-01");
  assert.equal((await s.call("PUT", "/api/me", { dob: "1890-01-01" }, imp.token)).status, 200);
  assert.equal((await s.call("PUT", "/api/me", { dob: "1990-01-01" }, imp.token)).status, 409);
  l2.find((c) => c.id === imp.client.id).dob = "1970-03-04"; fs.writeFileSync(s.file, JSON.stringify(l2));
  // and it is never greeted
  s.clock.now = new Date("2027-03-04T15:00:00Z");
  assert.equal(s.run(), 0);
  await s.settle(500);
});

test("birthday: a push that fails does not cost the member the email", async (t) => {
  const s = await bootBirthday(t, "2026-11-24T15:00:00Z");
  await s.signup("Pia Push", "1990-11-25");
  s.app.get("push").toClient = () => { throw new Error("made-up push failure"); };
  s.clock.now = new Date("2026-11-25T15:00:00Z");
  assert.equal(s.run(), 1);
  await s.settle(500);
  assert.deepEqual(s.greetings(), ["pia.push@example.com"], "the email still went");
  assert.equal(s.run(), 0, "and only once");
});
