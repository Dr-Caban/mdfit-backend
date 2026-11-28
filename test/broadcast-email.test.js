// A broadcast that goes straight to email, with photos (lib/broadcast-email.js, the broadcast routes in lib/messages.js).
// Every person and message here is invented.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { createNotifier } = require("../lib/notify");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const BE = require("../lib/broadcast-email");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 9)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the mail service that keeps everything it was asked to send. answer(n, message) may return a status
// to refuse request n with; delayMs makes every request slow.
async function fakeMail({ answer = () => 200, delayMs = 0 } = {}) {
  const emails = [], hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const p = JSON.parse(body), key = req.headers["idempotency-key"];
      hits.push({ path: req.url, key });
      if (delayMs) await sleep(delayMs);
      const status = answer(hits.length, p);
      if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }); return res.end('{"message":"no"}'); }
      (Array.isArray(p) ? p : [p]).forEach((m) => emails.push({ path: req.url, key, ...m }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"x"}');
    });
  });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, emails, hits, close: () => server.close() };
}

async function start(t, { mail = true, people = 6, mailOpts, extra = {}, dataDir: given } = {}) {
  const f = mail ? await fakeMail(mailOpts) : null;
  const dataDir = given || fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-be-"));
  const app = createApp({ ...extra,
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"],
    tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com",
    ...(mail ? { resendKey: "k", notifyFrom: "MD Fit <hello@example.com>", notifyEmail: "owner@example.com", resendUrl: f.url, notifyGapMs: 0 } : {})
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); if (f) f.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token, headers = {}) => {
    const raw = Buffer.isBuffer(body) || typeof body === "string";
    const res = await fetch(base + url, { method, headers: { ...(raw ? {} : { "content-type": "application/json" }), ...headers, ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const members = [];
  for (let i = 0; i < people; i++) {
    const r = (await call("POST", "/api/clients/signup", { name: `Member${i} Test`, email: `m${i}@example.com`, phone: "941-555-0100", password: "pass-pass-123" })).body;
    members.push({ id: r.client.id, token: r.token, email: `m${i}@example.com` });
  }
  const file = (name) => path.join(dataDir, name + ".json");
  const readJson = (name) => JSON.parse(fs.readFileSync(file(name), "utf8"));
  const edit = (name, fn) => { const list = readJson(name); fn(list); fs.writeFileSync(file(name), JSON.stringify(list)); };
  // the unsubscribe links are signed with a key of the server's own, made the first time one is needed
  await call("GET", "/api/unsubscribe?c=x&t=y", undefined, undefined, { "user-agent": "Mozilla/5.0 test" });
  const tok = (id) => BE.unsubToken(readJson("broadcast-keys").unsub, id);
  const unsub = (id, body) => call("POST", `/api/unsubscribe?c=${id}&t=${tok(id)}`, body || {});
  const photo = (buf, token = adm, type = "image/jpeg") => call("POST", "/api/admin/messages/broadcast/photo", buf, token, { "content-type": type });
  const sent = (subject) => (f ? f.emails.filter((e) => e.subject === subject) : []);
  const idle = async () => { for (let i = 0; i < 400; i++) { const b = (await call("GET", "/api/admin/messages/broadcasts", undefined, adm)).body; if (b.every((x) => !x.sending)) return b; await sleep(25); } throw new Error("still sending"); };
  // the welcome emails from the sign-ups are out of the way before a test counts emails
  if (f) for (let i = 0; i < 400 && f.emails.filter((e) => e.subject === "Welcome to MD Fit").length < people; i++) await sleep(25);
  return { app, call, adm, members, f, dataDir, file, readJson, edit, photo, sent, idle, base, tok, unsub };
}

test("helpers: photo type from the bytes, one-line subject, unsubscribe signature, escaped email, photos held per person", () => {
  assert.equal(BE.sniffImage(JPG), "image/jpeg");
  assert.equal(BE.sniffImage(PNG), "image/png");
  assert.equal(BE.sniffImage(Buffer.from("GIF89a" + "x".repeat(40))), null);
  assert.equal(BE.sniffImage(Buffer.from("<svg onload=alert(1)>" + " ".repeat(20))), null);
  assert.equal(BE.subjectOf("  Holiday\r\nBcc: someone@example.com\thours "), "Holiday Bcc: someone@example.com hours");
  assert.throws(() => BE.subjectOf("   "), /subject/);
  assert.throws(() => BE.subjectOf("x".repeat(BE.MAX_SUBJECT + 1)), /up to/);
  const t = BE.unsubToken("secret-one", "abc123");
  assert.equal(BE.unsubOk("secret-one", "abc123", t), true);
  assert.equal(BE.unsubOk("secret-one", "abc124", t), false, "a link for one account does not work for another");
  assert.equal(BE.unsubOk("secret-two", "abc123", t), false);
  assert.equal(BE.unsubOk("secret-one", "abc123", ""), false);
  const e = BE.buildEmail({ firstName: "Pat", body: "Closed <b>Thursday</b> & Friday.\nBook: https://example.com/book?a=1&b=2.\n\n<script>alert(1)</script>\njavascript:alert(1) and \"quotes\" onmouseover=x", photos: [{ cid: "photo1" }, { cid: "photo2" }],
    clinic: { name: "MD Fit", address: "1 Test Road", phone: "555" }, unsubscribeUrl: "https://mdfit.example.com/unsubscribe?c=1&t=2" });
  assert.ok(!e.html.includes("<script>") && !e.html.includes("<b>Thursday"), "typed text never becomes HTML");
  assert.ok(e.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(e.html.includes('<a href="https://example.com/book?a=1&amp;b=2"'), "a typed link becomes a link, without the full stop after it");
  assert.equal((e.html.match(/<a /g) || []).length, 2, "only http(s) addresses become links (that one, and unsubscribe)");
  assert.ok(e.html.includes("&quot;quotes&quot; onmouseover=x"));
  assert.equal((e.html.match(/src="cid:photo\d"/g) || []).length, 2);
  assert.ok(e.html.includes("Unsubscribe from announcements") && e.text.includes("https://mdfit.example.com/unsubscribe?c=1&t=2"));
  assert.ok(e.text.startsWith("Hi Pat,\n\nClosed <b>Thursday</b>"));
  assert.ok(e.html.includes("MD Fit · 1 Test Road · 555") && /because you are a client of MD Fit or have an account with us/.test(e.html), "who it is from, where they are, and why this person got it");
  // a long line of near-links is handled at once (no runaway matching)
  const t0 = Date.now(); BE.buildEmail({ firstName: "x", body: ("https://a" + ".".repeat(60) + " ").repeat(70), clinic: {} }); assert.ok(Date.now() - t0 < 500);
  // photos waiting to be sent: only the person who added one can use it, and they expire
  let now = 1000;
  const st = BE.createStaging({ now: () => now, minutes: 60, max: 12 });
  const a = st.add(JPG, "a@example.com");
  assert.equal(st.take([a.id], "a@example.com")[0].type, "image/jpeg");
  assert.throws(() => st.take([a.id], "b@example.com"), /no longer waiting/);
  assert.throws(() => st.add(Buffer.from("not an image at all"), "a@example.com"), /JPG or PNG/);
  assert.throws(() => st.add(Buffer.concat([JPG, Buffer.alloc(BE.MAX_PHOTO_BYTES)]), "a@example.com"), /too large/);
  // one person adding many pushes out their own oldest, never someone else's
  const other = st.add(PNG, "b@example.com");
  for (let i = 0; i < 20; i++) st.add(JPG, "a@example.com");
  assert.equal(st.take([other.id], "b@example.com").length, 1, "someone else's photo is still there");
  assert.throws(() => st.take([a.id], "a@example.com"), /no longer waiting/, "their own oldest went first");
  assert.equal(st.size(), 9, "eight for one person, one for the other");
  now += 61 * 60000;
  st.add(PNG, "a@example.com");
  assert.equal(st.size(), 1, "an hour later the old ones are gone");
});

test("email only: one email per person with the photos inside, people who cannot be emailed are left out and counted, nothing lands in the app", async (t) => {
  const s = await start(t), [a, b, c, d, e, g] = s.members;
  // c asked to be reached by phone; d has a written contact restriction; e unsubscribes below; g closed their account
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "phone" }, c.token)).status, 200);
  assert.equal((await s.call("PUT", `/api/admin/clients/${d.id}/privacy`, { contactBy: "", restrictions: "Do not send anything to my work address." }, s.adm)).status, 200);
  s.edit("clients", (list) => {
    const x = list.find((y) => y.id === g.id); x.deletedAt = "2026-10-01T00:00:00.000Z"; x.email = `deleted+${x.id}@mdfit.invalid`;
    list.push({ id: "imp0001", name: "Imported Person", email: "", phone: "", passwordHash: null, createdAt: "2026-11-01T00:00:00.000Z" });
  });
  // the unsubscribe link
  const tok = s.tok(e.id);
  assert.notEqual(tok, BE.unsubToken("s".repeat(40), e.id), "the links are not signed with the sign-in secret");
  assert.equal((await s.call("GET", `/api/unsubscribe?c=${e.id}&t=nope`)).status, 400);
  assert.equal((await s.call("GET", `/api/unsubscribe?c=${a.id}&t=${tok}`)).status, 400, "one person's link does nothing for another");
  assert.deepEqual((await s.call("GET", `/api/unsubscribe?c=${e.id}&t=${tok}`)).body, { unsubscribed: false }, "opening the link changes nothing");
  assert.deepEqual((await s.call("POST", `/api/unsubscribe?c=${e.id}&t=${tok}`, "List-Unsubscribe=One-Click", undefined, { "content-type": "application/x-www-form-urlencoded" })).body, { unsubscribed: true }, "the one-click request a mail app sends");
  assert.deepEqual((await s.call("GET", `/api/unsubscribe?c=${e.id}&t=${tok}`)).body, { unsubscribed: true });
  { // opened in a browser, the address goes to the page on the site (never anywhere else)
    const res = await fetch(`${s.base}/api/unsubscribe?c=${e.id}&t=${tok}`, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual" });
    assert.equal(res.status, 302); assert.equal(res.headers.get("location"), `https://mdfit.example.com/unsubscribe?c=${e.id}&t=${tok}`);
    const odd = await fetch(`${s.base}/api/unsubscribe?c=//evil.example&t=%0d%0aX`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(odd.headers.get("location"), "https://mdfit.example.com/unsubscribe?c=%2F%2Fevil.example&t=%0D%0AX");
  }
  // it is kept apart from the client record, so it holds even for a record that is not on the list (moved to the trash)
  assert.deepEqual(Object.keys(s.readJson("broadcast-optouts")), [e.id]);
  assert.equal(s.readJson("clients").find((x) => x.id === e.id).emailOptOut, undefined);
  assert.deepEqual((await s.unsub("gone00000001")).body, { unsubscribed: true });
  assert.deepEqual((await s.call("GET", `/api/unsubscribe?c=gone00000001&t=${s.tok("gone00000001")}`)).body, { unsubscribed: true });

  { // after a restart (a second server on the same data) the same links still work and the same people are still unsubscribed
    const again = await start(t, { people: 0, dataDir: s.dataDir });
    assert.equal(again.tok(e.id), tok, "the signing key is read back, not made anew");
    assert.deepEqual((await again.call("GET", `/api/unsubscribe?c=${e.id}&t=${tok}`)).body, { unsubscribed: true });
    assert.deepEqual((await again.call("GET", "/api/admin/messages/broadcast/people", undefined, again.adm)).body.unsubscribed, [e.id]);
  }
  // what the composer is told, so the two audiences can be shown apart
  const ppl = (await s.call("GET", "/api/admin/messages/broadcast/people", undefined, s.adm)).body;
  assert.equal(ppl.total, 7); assert.equal(ppl.emailOn, true); assert.equal(ppl.testTo, "coach@example.com"); assert.equal(ppl.sending, false); assert.equal(ppl.limits.minEmail, 2);
  assert.deepEqual(ppl.noEmail.sort(), ["imp0001", g.id].sort());
  assert.deepEqual(ppl.unsubscribed, [e.id]);
  assert.deepEqual(ppl.restricted.sort(), [c.id, d.id].sort());
  assert.deepEqual(ppl.members, []);
  assert.equal((await s.call("GET", "/api/admin/messages/broadcast/people")).status, 401);

  // photos
  assert.equal((await s.photo(JPG, "")).status, 401, "no sign-in, no upload");
  assert.equal((await s.photo(Buffer.from("GIF89a" + "x".repeat(60)), s.adm, "image/gif")).status, 400);
  assert.equal((await s.photo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), s.adm, "image/jpeg")).status, 400, "the bytes decide, not the label");
  assert.equal((await s.photo(Buffer.concat([JPG, Buffer.alloc(BE.MAX_PHOTO_BYTES + 5000)]))).status, 413);
  const p1 = (await s.photo(JPG)).body, p2 = (await s.photo(PNG, s.adm, "image/png")).body;
  assert.ok(p1.id && p2.id && p1.type === "image/jpeg" && p2.type === "image/png");

  const msg = { delivery: "email", to: "all", subject: "Holiday hours", body: "We are closed Thursday & Friday.\n\nSee you <Monday>.", photoIds: [p1.id, p2.id] };
  // a test goes to the sender only and leaves nothing behind
  const tr = await s.call("POST", "/api/admin/messages/broadcast", { ...msg, test: true }, s.adm);
  assert.deepEqual(tr.body, { test: true, sent: true, to: "coach@example.com" });
  const tests = s.sent("[Test] Holiday hours");
  assert.equal(tests.length, 1); assert.deepEqual(tests[0].to, ["coach@example.com"]);
  assert.equal(tests[0].attachments.length, 2); assert.match(tests[0].html, /Test: only you received this/);
  assert.deepEqual(await s.idle(), [], "a test is not a broadcast");

  const r = await s.call("POST", "/api/admin/messages/broadcast", msg, s.adm);
  assert.equal(r.status, 201);
  assert.deepEqual({ ...r.body, broadcastId: "" }, { delivery: "email", sent: 0, emailing: 2, skipped: { noEmail: 2, unsubscribed: 1, restricted: 2 }, broadcastId: "" });
  const [row] = await s.idle();
  const mails = s.sent("Holiday hours");
  assert.deepEqual(mails.map((m) => m.to).sort(), [["m0@example.com"], ["m1@example.com"]], "each email is addressed to one person only");
  assert.ok(mails.every((m) => m.path === "/emails" && !m.cc && !m.bcc));
  for (const [m, who] of [[mails.find((x) => x.to[0] === a.email), a], [mails.find((x) => x.to[0] === b.email), b]]) {
    const link = `https://mdfit.example.com/unsubscribe?c=${who.id}&t=${s.tok(who.id)}`;
    assert.ok(m.html.includes(link.replace(/&/g, "&amp;")) && m.text.includes(link), "their own unsubscribe link");
    assert.equal(m.headers["List-Unsubscribe"], `<https://mdfit.example.com/api/unsubscribe?c=${who.id}&t=${s.tok(who.id)}>`);
    assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.ok(m.html.includes("We are closed Thursday &amp; Friday.") && m.html.includes("See you &lt;Monday&gt;."));
    assert.ok(m.html.includes('src="cid:photo1"') && m.html.includes('src="cid:photo2"'));
    assert.deepEqual(m.attachments.map((x) => [x.filename, x.content_type, x.content_id]), [["photo-1.jpg", "image/jpeg", "photo1"], ["photo-2.png", "image/png", "photo2"]]);
    assert.equal(Buffer.from(m.attachments[0].content, "base64").equals(JPG), true);
    assert.match(m.text, /^Hi Member\d,/);
    assert.equal(m.key, `mdfit-bc-${r.body.broadcastId}-${who.id}`, "each copy has a fixed name at the mail service");
    assert.equal(m.html.includes(who === a ? b.id : a.id), false, "nobody's email names anyone else");
  }
  // nothing went into the app, and no "a message is waiting" notice was sent
  for (const m of [a, c, e]) assert.equal((await s.call("GET", "/api/me/messages", undefined, m.token)).body.messages.length, 0);
  assert.equal(s.sent("New message from Dr. Jared").length, 0);
  // the list in the workspace says how it went out
  assert.equal(row.delivery, "email"); assert.equal(row.subject, "Holiday hours"); assert.equal(row.emailTo, 2); assert.equal(row.emailed, 2);
  assert.equal(row.failed, 0); assert.equal(row.photos, 2); assert.equal(row.recipients, 0); assert.equal(row.stopped, false);
  assert.deepEqual(row.skipped, { noEmail: 2, unsubscribed: 1, restricted: 2 });
  assert.match(row.preview, /^We are closed Thursday/);
  // kept encrypted; the photos are gone once it has been sent
  const raw = fs.readFileSync(s.file("broadcast-emails"), "utf8");
  assert.ok(!raw.includes("closed Thursday") && !raw.includes("Holiday hours"), "subject and message are encrypted at rest");
  assert.deepEqual(s.readJson("broadcast-pending"), {}, "what the send needed (photos, who it was for) is removed when it is done");
  assert.equal((await s.call("POST", "/api/admin/messages/broadcast", msg, s.adm)).status, 400, "the photos were let go once it was sent");
  // the ledger says who sent what to how many, without the words
  const led = (await s.call("GET", "/api/admin/audit?action=broadcast.email", undefined, s.adm)).body.entries;
  assert.equal(led.length, 1); assert.equal(led[0].actor, "admin:coach@example.com");
  assert.deepEqual({ ...led[0].meta, id: "" }, { id: "", delivery: "email", emailTo: 2, inApp: 0, photos: 2, noEmail: 2, unsubscribed: 1, restricted: 2 });
  assert.ok(!JSON.stringify(led).includes("Holiday"));
  assert.equal((await s.call("GET", "/api/admin/audit?action=broadcast.unsubscribed", undefined, s.adm)).body.entries.length, 2);
  // the owner hears how it went
  for (let i = 0; i < 100 && !s.f.emails.some((x) => x.subject.startsWith("Email broadcast sent")); i++) await sleep(25);
  const rep = s.f.emails.find((x) => x.subject.startsWith("Email broadcast sent"));
  assert.equal(rep.subject, "Email broadcast sent to 2 people");
  assert.match(rep.text, /with 2 photos/); assert.match(rep.text, /2 with no email on file, 1 unsubscribed, 2 who asked to be reached another way/);

  // subscribing again from the same page puts them back
  assert.deepEqual((await s.call("POST", "/api/unsubscribe", { c: e.id, t: tok, resubscribe: true })).body, { unsubscribed: false });
  const r2 = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "selected", clientIds: [e.id, a.id, c.id], subject: "Welcome back", body: "Hello again." }, s.adm);
  assert.equal(r2.body.emailing, 2); assert.deepEqual(r2.body.skipped, { noEmail: 0, unsubscribed: 0, restricted: 1 });
  await s.idle();
  const back = s.sent("Welcome back");
  assert.deepEqual(back.map((m) => m.to[0]).sort(), ["m0@example.com", "m4@example.com"]);
  assert.ok(back.every((m) => m.path === "/emails/batch" && m.attachments === undefined), "without photos it goes through the batch request");
  // paying members only
  s.edit("clients", (list) => { for (const m of [a, b, d]) list.find((x) => x.id === m.id).membership = { tier: "expert", since: "2026-09-01", until: null }; });
  assert.deepEqual((await s.call("GET", "/api/admin/messages/broadcast/people", undefined, s.adm)).body.members.sort(), [a.id, b.id, d.id].sort());
  const rm = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "members", subject: "Members only", body: "Early booking." }, s.adm);
  assert.equal(rm.body.emailing, 2); assert.deepEqual(rm.body.skipped, { noEmail: 0, unsubscribed: 0, restricted: 1 });
  await s.idle();
  assert.deepEqual(s.sent("Members only").map((m) => m.to[0]).sort(), [a.email, b.email]);
  // nobody in the choice can be emailed: said plainly, nothing sent
  const none = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "selected", clientIds: [c.id, "imp0001"], subject: "x", body: "y" }, s.adm);
  assert.equal(none.status, 400); assert.match(none.body.error, /Nobody in that choice can be emailed/);
  // an email to one person is a private letter, not a broadcast: refused, for "both" as well, and nothing is written
  for (const delivery of ["email", "both"]) {
    const one = await s.call("POST", "/api/admin/messages/broadcast", { delivery, to: "selected", clientIds: [a.id, c.id, "imp0001"], subject: "Just for you", body: "A note for one person." }, s.adm);
    assert.equal(one.status, 400); assert.match(one.body.error, /Only one person in that choice can be emailed/);
  }
  assert.equal(s.sent("Just for you").length, 0);
  assert.equal((await s.call("GET", "/api/me/messages", undefined, a.token)).body.messages.length, 0);
});

test("both: the message is in every thread and the full email goes to those who can be emailed; app-only keeps its notice, which now follows the same rule", async (t) => {
  const s = await start(t, { people: 4 }), [a, b, c, d] = s.members;
  assert.deepEqual((await s.unsub(c.id)).body, { unsubscribed: true });
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "text" }, d.token)).status, 200);
  const p = (await s.photo(JPG)).body;
  const r = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "both", to: "all", subject: "New class", body: "Saturday mobility class starts this week.", photoIds: [p.id] }, s.adm);
  assert.equal(r.status, 201);
  assert.deepEqual({ ...r.body, broadcastId: "" }, { delivery: "both", sent: 4, emailing: 2, skipped: { noEmail: 0, unsubscribed: 1, restricted: 1 }, broadcastId: "" });
  const [row] = await s.idle();
  assert.equal(row.delivery, "both"); assert.equal(row.recipients, 4); assert.equal(row.emailTo, 2); assert.equal(row.emailed, 2); assert.equal(row.photos, 1);
  // in the app: everyone, including the people who are not emailed
  for (const m of [a, b, c, d]) {
    const mine = (await s.call("GET", "/api/me/messages", undefined, m.token)).body.messages;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].body, "Saturday mobility class starts this week.\n\n(The email version of this message has a photo.)");
  }
  assert.deepEqual(s.sent("New class").map((m) => m.to[0]).sort(), [a.email, b.email]);
  assert.equal(s.sent("New message from Dr. Jared").length, 0, "the full email takes the place of the notice");
  // the reminder goes to people who have not opened it, and never to someone the email was kept from
  await s.call("POST", "/api/me/messages/read", {}, a.token);
  assert.deepEqual((await s.call("POST", `/api/admin/messages/broadcast/${row.broadcastId}/remind`, {}, s.adm)).body, { sent: 1, failed: 0, unread: 3 });
  assert.deepEqual(s.sent("Reminder: you have a message from Dr. Jared").map((m) => m.to[0]), [b.email]);

  // app only: the email is a notice and never carries the message. It leaves out the same people, and ends with a way out.
  const r2 = await s.call("POST", "/api/admin/messages/broadcast", { to: "all", body: "Parking lot is being repaved Tuesday." }, s.adm);
  assert.equal(r2.status, 201); assert.equal(r2.body.delivery, "app"); assert.equal(r2.body.sent, 4); assert.equal(r2.body.emailing, 2);
  const rows = await s.idle();
  assert.equal(rows[0].delivery, "app"); assert.equal(rows[0].emailed, 2); assert.equal(rows[0].recipients, 4); assert.equal(rows[0].subject, undefined);
  const notices = s.sent("New message from Dr. Jared");
  assert.deepEqual(notices.map((n) => n.to[0]).sort(), [a.email, b.email], "no notice for someone who unsubscribed or asked to be reached another way");
  assert.ok(notices.every((n) => !n.text.includes("repaved") && !n.html && !n.attachments));
  const na = notices.find((n) => n.to[0] === a.email);
  assert.ok(na.text.endsWith(`Stop these emails: https://mdfit.example.com/unsubscribe?c=${a.id}&t=${s.tok(a.id)}`));
  assert.ok(s.f.emails.filter((e) => !e.subject.startsWith("Group message sent")).every((e) => !String(e.text).includes("repaved")));
  for (const m of [c, d]) assert.equal((await s.call("GET", "/api/me/messages", undefined, m.token)).body.messages.length, 2, "they still get it in the app");
});

test("what is refused: no subject, too long, too many photos, someone else's photo, a made-up delivery, a test that could become a real send, email not set up, no permission", async (t) => {
  const s = await start(t, { people: 2 });
  const send = (b, tok = s.adm) => s.call("POST", "/api/admin/messages/broadcast", { to: "all", ...b }, tok);
  assert.match((await send({ delivery: "email", body: "x" })).body.error, /subject/);
  assert.match((await send({ delivery: "email", subject: "s" })).body.error, /Type a message/);
  assert.match((await send({ delivery: "carrier-pigeon", subject: "s", body: "x" })).body.error, /how it goes out/);
  assert.equal((await send({ delivery: "email", subject: "s", body: "x".repeat(BE.MAX_EMAIL_BODY + 1) })).status, 400);
  assert.equal((await send({ delivery: "both", subject: "s", body: "x".repeat(2001) })).status, 400, "what also goes in the app keeps the app's limit");
  // a request that says "test" in any way is never a real send
  for (const bad of [{ body: "x", test: true }, { delivery: "app", body: "x", test: true }, { delivery: "email", subject: "s", body: "x", test: "true" }, { delivery: "email", subject: "s", body: "x", test: 1 }, { body: "x", test: "yes" }]) {
    const r = await send(bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body.error, /test/i);
  }
  assert.deepEqual(await s.idle(), [], "nothing was sent by any of those");
  for (const m of s.members) assert.equal((await s.call("GET", "/api/me/messages", undefined, m.token)).body.messages.length, 0);
  assert.equal(s.f.emails.filter((e) => !/Welcome|New client/.test(e.subject)).length, 0);
  assert.equal((await send({ delivery: "email", subject: "s", body: "x".repeat(BE.MAX_EMAIL_BODY) })).status, 201);
  await s.idle();
  // Send pressed twice with the same name (the answer to the first press was lost): one broadcast, the same answer
  const first = await send({ delivery: "email", subject: "Pressed twice", body: "x", key: "press-0001-abcd" });
  const second = await send({ delivery: "email", subject: "Pressed twice", body: "x", key: "press-0001-abcd" });
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ...first.body, repeat: true });
  await s.idle();
  assert.equal(s.sent("Pressed twice").length, 2, "two people, one email each");
  const app1 = await send({ body: "App pressed twice", key: "press-0002-abcd" }), app2 = await send({ body: "App pressed twice", key: "press-0002-abcd" });
  assert.equal(app2.body.repeat, true); assert.equal(app2.body.broadcastId, app1.body.broadcastId);
  await s.idle();
  assert.equal((await s.call("GET", "/api/me/messages", undefined, s.members[0].token)).body.messages.length, 1);
  // the test has an address of its own: it emails the sender only, whatever else the request says
  const tt = await s.call("POST", "/api/admin/messages/broadcast/test", { to: "all", subject: "Own address", body: "x", clientIds: [s.members[0].id] }, s.adm);
  assert.deepEqual(tt.body, { test: true, sent: true, to: "coach@example.com" });
  assert.deepEqual(s.sent("[Test] Own address").map((e) => e.to), [["coach@example.com"]]); assert.equal(s.sent("Own address").length, 0);
  assert.equal((await s.call("POST", "/api/admin/messages/broadcast/test", { subject: "x", body: "y" })).status, 401);
  const before = (await s.call("GET", "/api/me/messages", undefined, s.members[1].token)).body.messages.length;
  for (const r of [await s.call("POST", "/api/admin/messages/broadcast/test", { delivery: "both", to: "all", subject: "Both test", body: "x" }, s.adm), await send({ delivery: "both", subject: "Both test", body: "x", test: true })]) assert.deepEqual(r.body, { test: true, sent: true, to: "coach@example.com" });
  assert.equal((await s.call("GET", "/api/me/messages", undefined, s.members[1].token)).body.messages.length, before, "a test in Both mode puts nothing in anyone's thread");
  assert.deepEqual(s.sent("[Test] Both test").map((e) => e.to[0]), ["coach@example.com", "coach@example.com"]); assert.equal(s.sent("Both test").length, 0);
  // a subject is always one line
  assert.equal((await send({ delivery: "email", subject: "Line one\r\nBcc: other@example.com", body: "x" })).status, 201);
  await s.idle();
  assert.ok(s.f.emails.every((e) => !/[\r\n]/.test(e.subject)) && s.sent("Line one Bcc: other@example.com").length === 2);
  assert.ok(s.f.emails.every((e) => !e.bcc));
  // photos
  const ids = []; for (let i = 0; i < 5; i++) ids.push((await s.photo(JPG)).body.id);
  assert.match((await send({ delivery: "email", subject: "s", body: "x", photoIds: ids })).body.error, /up to 4 photos/);
  assert.match((await send({ delivery: "email", subject: "s", body: "x", photoIds: ["nope"] })).body.error, /no longer waiting/);
  // staff: someone with Messages can broadcast, but not with a photo another person added; a developer cannot at all
  const mk = async (role, email) => { assert.equal((await s.call("POST", "/api/admin/staff", { name: role, email, role, password: "staff-pass-1234" }, s.adm)).status, 201); return (await s.call("POST", "/api/admin/login", { email, password: "staff-pass-1234" })).body.token; };
  const desk = await mk("frontdesk", "desk@example.com"), dev = await mk("developer", "dev@example.com");
  assert.match((await send({ delivery: "email", subject: "s", body: "x", photoIds: [ids[0]] }, desk)).body.error, /no longer waiting/);
  const mine = (await s.photo(PNG, desk, "image/png")).body;
  assert.equal((await send({ delivery: "email", subject: "From the desk", body: "x", photoIds: [mine.id], test: true }, desk)).body.to, "desk@example.com");
  assert.deepEqual(s.sent("[Test] From the desk").map((e) => e.to), [["desk@example.com"]]);
  assert.equal((await s.call("DELETE", `/api/admin/messages/broadcast/photo/${ids[1]}`, undefined, desk)).status, 200);
  assert.equal((await send({ delivery: "email", subject: "Still mine", body: "x", photoIds: [ids[1]], test: true })).status, 200, "nobody else can remove a photo you added");
  assert.equal((await send({ delivery: "email", subject: "s", body: "x" }, dev)).status, 403);
  assert.equal((await s.photo(JPG, dev)).status, 403);
  assert.equal((await s.call("GET", "/api/admin/messages/broadcast/people", undefined, dev)).status, 403);
  // every announcement email shows the practice\u2019s street address: without one saved, none goes out (not even a test)
  const biz = (await s.call("GET", "/api/admin/settings", undefined, s.adm)).body.business;
  assert.equal((await s.call("PUT", "/api/admin/settings", { business: { ...biz, address: "" } }, s.adm)).status, 200);
  for (const extra of [{}, { test: true }]) { const r = await send({ delivery: "email", subject: "No address", body: "x", ...extra }); assert.equal(r.status, 400); assert.match(r.body.error, /street address/); }
  assert.equal(s.sent("No address").length + s.sent("[Test] No address").length, 0);
  assert.equal((await s.call("PUT", "/api/admin/settings", { business: biz }, s.adm)).status, 200);
  // a server with no mail service says so instead of pretending
  const off = await start(t, { mail: false, people: 1 });
  assert.equal((await off.call("GET", "/api/admin/messages/broadcast/people", undefined, off.adm)).body.emailOn, false);
  const no = await off.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "all", subject: "s", body: "x" }, off.adm);
  assert.equal(no.status, 400); assert.match(no.body.error, /Email is not set up/);
  assert.equal((await off.call("POST", "/api/admin/messages/broadcast", { to: "all", body: "app still works" }, off.adm)).status, 201);
});

test("a send cut short by a restart is picked up: the rest get it, nobody gets it twice, and one send goes out at a time", async (t) => {
  const s = await start(t, { people: 5, mailOpts: { delayMs: 120 } }), [a, b, c, d, e] = s.members;
  const p = (await s.photo(JPG)).body;
  const r = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "all", subject: "Open house", body: "Join us Saturday.", photoIds: [p.id] }, s.adm);
  assert.equal(r.status, 201); assert.equal(r.body.emailing, 5);
  // while it is going out: the composer is told, a second email broadcast waits, and what it needs is on disk
  assert.equal((await s.call("GET", "/api/admin/messages/broadcast/people", undefined, s.adm)).body.sending, true);
  const again = await s.call("POST", "/api/admin/messages/broadcast", { delivery: "email", to: "all", subject: "Second", body: "x" }, s.adm);
  assert.equal(again.status, 409); assert.match(again.body.error, /still going out/);
  const job = s.readJson("broadcast-pending")[r.body.broadcastId];
  assert.equal(job.to.length, 5); assert.equal(Buffer.from(job.photos[0].b64, "base64").equals(JPG), true);
  // each person is written down as their copy is accepted, not at the end
  let mid = null;
  for (let i = 0; i < 100 && !mid; i++) { const x = s.readJson("broadcast-emails").find((y) => y.id === r.body.broadcastId); if (x.sentTo.length >= 1 && x.sentTo.length < 5 && !x.doneAt) mid = x.sentTo.length; else await sleep(20); }
  assert.ok(mid >= 1 && mid < 5, "progress is on disk while the send is still going");
  const [row] = await s.idle();
  assert.equal(row.emailed, 5); assert.equal(row.stopped, false);
  assert.equal(s.sent("Open house").length, 5); assert.equal(s.sent("Second").length, 0);
  // now put things back to how a restart after two people would have left them, with one of the rest having unsubscribed since
  const two = [a.id, b.id];
  s.edit("broadcast-emails", (list) => { const x = list.find((y) => y.id === r.body.broadcastId); x.sentTo = two; x.doneAt = null; x.failed = 0; });
  fs.writeFileSync(s.file("broadcast-pending"), JSON.stringify({ [r.body.broadcastId]: job }));
  assert.equal((await s.call("GET", "/api/admin/messages/broadcasts", undefined, s.adm)).body[0].stopped, true, "until it is picked up, the workspace shows it as stopped");
  await s.unsub(e.id);
  s.f.emails.length = 0;
  assert.equal(s.app.get("resumeBroadcasts")(), 1);
  const [done] = await s.idle();
  const more = s.sent("Open house");
  assert.deepEqual(more.map((m) => m.to[0]).sort(), [c.email, d.email], "only the people who had not got it, and not the one who unsubscribed");
  assert.ok(more.every((m) => m.attachments.length === 1 && Buffer.from(m.attachments[0].content, "base64").equals(JPG)), "with the photo");
  assert.deepEqual(more.map((m) => m.key).sort(), [c.id, d.id].map((x) => `mdfit-bc-${r.body.broadcastId}-${x}`).sort(), "under the same name as the first time, so the mail service would not deliver a copy it already took");
  assert.equal(done.emailed, 4); assert.equal(done.failed, 1); assert.equal(done.stopped, false);
  assert.deepEqual(s.readJson("broadcast-pending"), {});
  assert.equal(s.app.get("resumeBroadcasts")(), 0, "nothing left to pick up");
  // a send too old to pick up safely is left as stopped, and its photos are let go
  s.edit("broadcast-emails", (list) => { const x = list.find((y) => y.id === r.body.broadcastId); x.doneAt = null; x.at = new Date(Date.now() - 13 * 3600e3).toISOString(); });
  fs.writeFileSync(s.file("broadcast-pending"), JSON.stringify({ [r.body.broadcastId]: job }));
  assert.equal(s.app.get("resumeBroadcasts")(), 0);
  assert.deepEqual(s.readJson("broadcast-pending"), {});
  assert.equal((await s.call("GET", "/api/admin/messages/broadcasts", undefined, s.adm)).body[0].stopped, true);
});

test("the mail service misbehaving: a refused run stops early, and a 'still working on it' answer is waited out, not sent again", async (t) => {
  const item = (i, extra = {}) => ({ to: `p${i}@example.com`, subject: "S", text: "T", html: "<p>T</p>", ...extra });
  const att = [{ filename: "photo-1.jpg", content: JPG.toString("base64"), content_type: "image/jpeg", content_id: "photo1" }];
  { // every request refused: it gives up after five in a row instead of working through everyone
    const f = await fakeMail({ answer: () => 422 }); t.after(f.close);
    const n = createNotifier({ apiKey: "k", from: "MD Fit <hi@example.com>", ownerEmail: "owner@example.com", apiUrl: f.url, minGapMs: 0 });
    const ok = await n.campaign(Array.from({ length: 12 }, (_, i) => item(i, { attachments: att })));
    assert.equal(ok.size, 0); assert.equal(f.hits.length, 5);
  }
  { // one bad address in the middle does not stop the rest
    const f = await fakeMail({ answer: (n, p) => (p.to && p.to[0] === "p2@example.com" ? 422 : 200) }); t.after(f.close);
    const n = createNotifier({ apiKey: "k", from: "MD Fit <hi@example.com>", ownerEmail: "owner@example.com", apiUrl: f.url, minGapMs: 0 });
    const seen = [];
    const ok = await n.campaign(Array.from({ length: 6 }, (_, i) => item(i, { attachments: att, key: `k-${i}` })), { onSent: (x) => seen.push(x) });
    assert.equal(ok.size, 5); assert.ok(!ok.has("p2@example.com")); assert.equal(seen.length, 5);
    assert.deepEqual(f.emails.map((e) => e.key), ["k-0", "k-1", "k-3", "k-4", "k-5"]);
  }
  { // without photos it is one batch: if the provider refuses the batch over one bad address, each is then sent alone and the rest still get it
    const f = await fakeMail({ answer: (n, p) => ((Array.isArray(p) ? p.some((m) => m.to[0] === "p3@example.com") : p.to[0] === "p3@example.com") ? 422 : 200) }); t.after(f.close);
    const n = createNotifier({ apiKey: "k", from: "MD Fit <hi@example.com>", ownerEmail: "owner@example.com", apiUrl: f.url, minGapMs: 0 });
    const ok = await n.campaign(Array.from({ length: 8 }, (_, i) => item(i)), { group: "mdfit-bc-xyz" });
    assert.equal(ok.size, 7); assert.ok(!ok.has("p3@example.com"));
    assert.equal(f.hits[0].path, "/emails/batch"); assert.equal(f.hits.filter((h) => h.path === "/emails").length, 8);
    assert.deepEqual(f.emails.map((e) => e.to[0]).sort(), [0, 1, 2, 4, 5, 6, 7].map((i) => `p${i}@example.com`));
  }
  { // 409: the provider is still on an earlier try of the same message. Ask again under the same name; never send anew
    const f = await fakeMail({ answer: (n) => (n === 1 ? 409 : 200) }); t.after(f.close);
    const n = createNotifier({ apiKey: "k", from: "MD Fit <hi@example.com>", ownerEmail: "owner@example.com", apiUrl: f.url, minGapMs: 0 });
    const ok = await n.campaign([item(0), item(1)], { group: "mdfit-bc-abc" });
    assert.equal(ok.size, 2); assert.equal(f.hits.length, 2);
    assert.equal(f.hits[0].key, f.hits[1].key); assert.match(f.hits[0].key, /^mdfit-bc-abc-[0-9a-f]{24}$/);
    assert.ok(f.emails.every((e) => e.path === "/emails/batch"));
  }
});

test("the one-click request with the server's own bot filter on: a browser-like sender gets through, a script-like one is refused (a known limit)", async (t) => {
  const s = await start(t, { people: 1, extra: { botFilter: true } }), [a] = s.members;
  const oneClick = (ua) => fetch(`${s.base}/api/unsubscribe?c=${a.id}&t=${s.tok(a.id)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": ua }, body: "List-Unsubscribe=One-Click" });
  // lib/security.js (a locked part) applies its bot rule to this path like any other. The link in the email, opened in
  // the person's own browser, always works; a mail provider whose servers send a script-like user agent is refused.
  assert.equal((await oneClick("okhttp/4.9.3")).status, 403);
  assert.equal(fs.existsSync(s.file("broadcast-optouts")), false, "nothing was recorded");
  const ok = await oneClick("Mozilla/5.0 (compatible; MailProvider one-click)");
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { unsubscribed: true });
  assert.deepEqual(Object.keys(s.readJson("broadcast-optouts")), [a.id]);
});
