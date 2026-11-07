// Email sending under the provider's rate limit: retries on 429, batches group messages, records who was emailed.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNotifier } = require("../lib/notify");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

// A fake Resend that behaves like the real one: more than `perSec` requests in a second -> 429, retry-after 1
async function fakeResend({ perSec = 2, failFirst = 0 } = {}) {
  const hits = [], emails = [];
  let refused = 0, toFail = failFirst;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const now = Date.now();
      hits.push(now);
      const recent = hits.filter((t) => now - t < 1000).length;
      if (recent > perSec || toFail > 0) {
        if (toFail > 0) toFail--;
        refused++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end('{"message":"Too many requests"}');
      }
      const parsed = JSON.parse(body);
      (Array.isArray(parsed) ? parsed : [parsed]).forEach((m) => emails.push({ path: req.url, to: m.to[0], all: m.to, subject: m.subject, text: m.text }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"x"}');
    });
  });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, emails, hits, refused: () => refused, close: () => server.close() };
}

test("notifier: a burst of single emails all get through the rate limit (queued + retried)", async (t) => {
  const f = await fakeResend({ perSec: 2 }); t.after(f.close);
  const n = createNotifier({ apiKey: "k", from: "MD Fit <hi@example.com>", ownerEmail: "owner@example.com", apiUrl: f.url, minGapMs: 100 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => n.client(`p${i}@example.com`, "Hi", "Body")));
  assert.deepEqual(results, Array(8).fill(true), "every email was delivered");
  assert.equal(new Set(f.emails.map((e) => e.to)).size, 8);
});

test("notifier: a 429 is retried after the wait the provider asks for", async (t) => {
  const f = await fakeResend({ perSec: 100, failFirst: 2 }); t.after(f.close);
  const n = createNotifier({ apiKey: "k", from: "x@example.com", ownerEmail: "o@example.com", apiUrl: f.url, minGapMs: 0 });
  assert.equal(await n.owner("New review", "text"), true);
  assert.equal(f.refused(), 2); assert.equal(f.emails.length, 1);
});

test("notifier: many() sends up to 100 emails per batch request", async (t) => {
  const f = await fakeResend({ perSec: 2 }); t.after(f.close);
  const n = createNotifier({ apiKey: "k", from: "x@example.com", ownerEmail: "o@example.com", apiUrl: f.url, minGapMs: 100 });
  const list = Array.from({ length: 150 }, (_, i) => ({ to: `m${i}@example.com`, subject: "New message from Dr. Jared", text: "t" }));
  const ok = await n.many(list);
  assert.equal(ok.size, 150);
  assert.equal(f.emails.length, 150);
  assert.ok(f.emails.every((e) => e.path === "/emails/batch"));
  assert.equal(f.hits.length - f.refused(), 2, "150 emails = 2 accepted requests");
});

test("group message: every notice is emailed despite the rate limit; reminders go only to people who haven't read it", async (t) => {
  const f = await fakeResend({ perSec: 2 }); t.after(f.close);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-n-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"],
    tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", resendKey: "k", notifyFrom: "x@example.com", notifyEmail: "owner@example.com", alertEmails: ["alerts@example.com"], resendUrl: f.url });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const toks = [];
  for (let i = 0; i < 9; i++) toks.push((await call("POST", "/api/clients/signup", { name: `Member ${i}`, email: `m${i}@example.com`, phone: "941-555-0100", password: "pass-pass-123" })).body.token);
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const waitIdle = async () => { for (let i = 0; i < 100; i++) { const b = (await call("GET", "/api/admin/messages/broadcasts", undefined, adm)).body; if (b.every((x) => !x.sending)) return b; await new Promise((r) => setTimeout(r, 100)); } throw new Error("still sending"); };
  await waitIdle(); // signup allows 10 accounts/hour per IP, so 9 members
  // each signup also queues a welcome email; let those drain (600 ms apart) so the broadcast timing below is about the broadcast
  for (let i = 0; i < 300 && f.emails.filter((e) => e.subject === "Welcome to MD Fit").length < 9; i++) await new Promise((r) => setTimeout(r, 100));
  const r = await call("POST", "/api/admin/messages/broadcast", { to: "all", body: "Clinic closed Thanksgiving." }, adm);
  assert.equal(r.status, 201); assert.equal(r.body.sent, 9);
  const [g] = await waitIdle();
  assert.equal(g.recipients, 9); assert.equal(g.emailed, 9, "all 9 notices accepted"); assert.equal(g.read, 0);
  assert.equal(f.emails.filter((e) => e.subject === "New message from Dr. Jared").length, 9);
  // the owner (and the extra alert address) get a report once the notices are out
  for (let i = 0; i < 50 && !f.emails.some((e) => e.subject.startsWith("Group message sent")); i++) await new Promise((r) => setTimeout(r, 100));
  const rep = f.emails.find((e) => e.subject.startsWith("Group message sent"));
  assert.equal(rep.subject, "Group message sent to 9 people");
  assert.deepEqual(rep.all, ["owner@example.com", "alerts@example.com"]);
  assert.match(rep.text, /Email notices: 9 sent\./); assert.match(rep.text, /Clinic closed Thanksgiving\./);
  // every owner alert (here: the 9 new-account alerts) went to both addresses
  assert.ok(f.emails.filter((e) => e.subject.startsWith("New client account")).every((e) => e.all.includes("alerts@example.com")));
  // Admin → Analytics email delivery log
  const log = (await call("GET", "/api/admin/email-log", undefined, adm)).body;
  assert.equal(log.enabled, true); assert.equal(log.alertsTo.length, 2);
  assert.ok(log.days[0].sent >= 9 + 9 + 1, "notices + account alerts + report counted"); assert.equal(log.days[0].failed, 0);
  // 4 people open the app and read it; the reminder goes to the other 5 only
  for (const tok of toks.slice(0, 4)) await call("POST", "/api/me/messages/read", {}, tok);
  const rm = await call("POST", `/api/admin/messages/broadcast/${g.broadcastId}/remind`, {}, adm);
  assert.equal(rm.status, 200); assert.deepEqual(rm.body, { sent: 5, failed: 0, unread: 5 });
  const reminded = f.emails.filter((e) => e.subject.startsWith("Reminder")).map((e) => e.to).sort();
  assert.deepEqual(reminded, Array.from({ length: 5 }, (_, i) => `m${i + 4}@example.com`).sort());
  assert.equal((await call("POST", "/api/admin/messages/broadcast/nope/remind", {}, adm)).status, 404);
  // the per-client thread route still works next to /messages/broadcasts
  const one = (await call("GET", "/api/me", undefined, toks[0])).body.client.id;
  assert.equal((await call("GET", `/api/admin/messages/${one}`, undefined, adm)).status, 200);
});

test("notifier: a rejected address isn't retried and is reported for the admin's delivery log", async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(422, { "content-type": "application/json" }); res.end('{"message":"Invalid to"}'); });
  server.listen(0); await new Promise((r) => server.once("listening", r)); t.after(() => server.close());
  const results = [];
  const n = createNotifier({ apiKey: "k", from: "x@example.com", ownerEmail: "o@example.com", alertEmails: ["a@example.com", "O@example.com"], apiUrl: `http://127.0.0.1:${server.address().port}`, minGapMs: 0, onResult: (r) => results.push(r) });
  assert.deepEqual(n.owners, ["o@example.com", "a@example.com"], "alert addresses added, duplicates dropped");
  assert.equal(await n.client("bad@", "Hi", "x"), false);
  assert.equal(results.length, 1); assert.equal(results[0].ok, false); assert.equal(results[0].error, "HTTP 422");
});
