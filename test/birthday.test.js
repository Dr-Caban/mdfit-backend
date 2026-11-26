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
