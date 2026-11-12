"use strict";
// The weekly client export: one self-contained, encrypted file emailed to the owner only. These tests hold the lines
// that matter for a file full of health records travelling by email: nothing readable in it or in the email, a long
// passphrase or no send at all, the owner's own address and nobody else's, and one send a week.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { zip, seal, unseal, page, weekKey, MIN_PASSPHRASE } = require("../lib/backup");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;
const GOOD = "correct horse battery staple 42"; // a test passphrase, not a real one

// Read a zip back the way an unzip tool does: through the central directory at the end
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "has an end-of-central-directory record");
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16); const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), start = off + 30 + lnl + lxl;
    const raw = method === 8 ? zlib.inflateRawSync(buf.subarray(start, start + csize)) : buf.subarray(start, start + csize);
    assert.equal(raw.length, usize, name + " size"); assert.equal(zlib.crc32(raw) >>> 0, crc, name + " crc");
    out[name] = raw; p += 46 + nl + xl + cl;
  }
  return out;
}
const boxOf = (html) => JSON.parse(html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/)[1]).box;

async function fakeResend() {
  const emails = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const m = JSON.parse(b); (Array.isArray(m) ? m : [m]).forEach((x) => emails.push(x));
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); });
  server.listen(0); await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, emails, close: () => server.close() };
}
async function boot(t, f, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-bk-"));
  const clock = { now: new Date("2026-11-02T15:00:00Z") }; // Monday 10 am in New York
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"],
    tz: "America/New_York", now: () => clock.now, siteUrl: "https://mdfit.example.com", resendKey: "k", notifyFrom: "x@example.com", notifyEmail: "owner@example.com",
    alertEmails: ["alerts@example.com"], resendUrl: f.url, noBackupSchedule: true, noVideoSync: true, backupPassphrase: GOOD, backupIterations: 2000, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 test", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { app, call, adm, clock, dataDir };
}
const signup = (call, i) => call("POST", "/api/clients/signup", { name: `Zelda Quillfeather ${i}`, email: `zelda${i}@example.com`, phone: "941-555-0100", password: "pass-pass-123" });

test("zip: what is written reads back as the same files", () => {
  const files = [{ name: "README.txt", data: "hello\r\n" }, { name: "clients.csv", data: "name,email\r\nÅsa,a@example.com\r\n" }, { name: "big.json", data: JSON.stringify({ x: "y".repeat(50000) }) }];
  const back = unzip(zip(files, new Date(2026, 10, 2, 6, 0, 0)));
  assert.deepEqual(Object.keys(back), ["README.txt", "clients.csv", "big.json"]);
  for (const f of files) assert.equal(back[f.name].toString("utf8"), f.data);
});

test("seal: only the passphrase opens it, and a browser's WebCrypto can", async () => {
  const plain = crypto.randomBytes(5000), box = seal(plain, GOOD, 2000);
  assert.ok(unseal(box, GOOD).equals(plain));
  assert.throws(() => unseal(box, GOOD + "x"));
  assert.notEqual(seal(plain, GOOD, 2000).data, box.data, "a fresh salt and iv every time");
  // the exact steps the emailed page runs
  const S = crypto.webcrypto.subtle, b = (s) => Buffer.from(s, "base64");
  const base = await S.importKey("raw", new TextEncoder().encode(GOOD), "PBKDF2", false, ["deriveKey"]);
  const key = await S.deriveKey({ name: "PBKDF2", salt: b(box.salt), iterations: box.iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  assert.ok(Buffer.from(await S.decrypt({ name: "AES-GCM", iv: b(box.iv) }, key, b(box.data))).equals(plain));
});

test("page: one file, nothing fetched from anywhere, nothing readable in it", () => {
  const secret = "Zelda Quillfeather sees Dr. Jared for her left shoulder";
  const html = page({ box: seal(zip([{ name: "client-records.json", data: secret }]), GOOD, 2000), date: "2026-11-02", count: 3, zipName: "mdfit-clients-2026-11-02.zip" });
  assert.ok(!html.includes("Zelda") && !html.includes("shoulder"), "no record text in the file");
  assert.ok(!html.includes(GOOD), "the passphrase is not in the file");
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/@import|[^A-Za-z]url\(/.test(html), "no outside resource of any kind");
  assert.match(html, /3 client records/);
  assert.ok(unzip(unseal(boxOf(html), GOOD))["client-records.json"].toString().includes(secret), "and the passphrase gets it all back");
});

test("weekKey: every day of a week maps to its Monday", () => {
  for (const d of ["2026-11-02", "2026-11-04", "2026-11-08"]) assert.equal(weekKey(d), "2026-11-02");
  assert.equal(weekKey("2026-11-09"), "2026-11-09");
  assert.equal(weekKey("2027-01-01"), "2026-12-28");
});

test("weekly export: sent to the owner alone, encrypted, with every client inside", async (t) => {
  const f = await fakeResend(); t.after(f.close);
  const { call, adm, dataDir } = await boot(t, f);
  for (let i = 0; i < 3; i++) assert.equal((await signup(call, i)).status, 201);
  const st0 = (await call("GET", "/api/admin/export/weekly", undefined, adm)).body;
  assert.equal(st0.ready, true); assert.equal(st0.last, null);

  const r = await call("POST", "/api/admin/export/weekly/send", {}, adm);
  assert.equal(r.status, 200); assert.equal(r.body.count, 3);
  const mail = f.emails.find((e) => /weekly client export/.test(e.subject));
  assert.ok(mail, "an email went out");
  assert.deepEqual(mail.to, ["owner@example.com"], "to the owner only - not the alert addresses");
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /^mdfit-client-export-2026-11-02\.html$/);
  // nothing in the email itself says who the clients are, or how to open the file
  const outer = JSON.stringify({ ...mail, attachments: undefined });
  assert.ok(!/Zelda|zelda\d@/.test(outer) && !outer.includes(GOOD));
  const html = Buffer.from(mail.attachments[0].content, "base64").toString("utf8");
  assert.ok(!/Zelda|zelda\d@/.test(html) && !html.includes(GOOD), "the attachment is not readable either");

  const files = unzip(unseal(boxOf(html), GOOD));
  assert.deepEqual(Object.keys(files).sort(), ["README.txt", "client-records.json", "clients.csv"]);
  const rec = JSON.parse(files["client-records.json"].toString("utf8"));
  assert.equal(rec.count, 3); assert.deepEqual(rec.clients.map((c) => c.email).sort(), ["zelda0@example.com", "zelda1@example.com", "zelda2@example.com"]);
  assert.equal(files["clients.csv"].toString("utf8").trim().split(/\r?\n/).length, 4, "a header and three rows");
  // nothing that works as a key comes along
  assert.ok(!/passwordHash|"pwv"|resetToken|"token"/.test(files["client-records.json"].toString("utf8")));

  const st = (await call("GET", "/api/admin/export/weekly", undefined, adm)).body;
  assert.equal(st.last.ok, true); assert.equal(st.last.count, 3); assert.ok(st.lastSentAt);
  // the passphrase and the plain export never land on disk
  const disk = fs.readdirSync(dataDir).map((n) => { try { return fs.readFileSync(path.join(dataDir, n), "utf8"); } catch { return ""; } }).join("\n");
  assert.ok(!disk.includes(GOOD));
});

test("weekly export: a short or missing passphrase means nothing is sent", async (t) => {
  for (const [pass, why] of [["1234", /too short/], ["", /No passphrase/], ["x".repeat(MIN_PASSPHRASE - 1), /too short/]]) {
    const f = await fakeResend(); t.after(f.close);
    const { call, adm, app } = await boot(t, f, { backupPassphrase: pass });
    await signup(call, 0);
    const st = (await call("GET", "/api/admin/export/weekly", undefined, adm)).body;
    assert.equal(st.ready, false); assert.match(st.blocked, why);
    const r = await call("POST", "/api/admin/export/weekly/send", {}, adm);
    assert.equal(r.status, 409); assert.match(r.body.error, why);
    app.get("backupApi").tick(); await new Promise((x) => setTimeout(x, 150));
    assert.equal(f.emails.filter((e) => e.attachments).length, 0, `nothing emailed with passphrase ${JSON.stringify(pass)}`);
  }
});

test("weekly export: a short code is sent only when the owner has switched that on", async (t) => {
  const f = await fakeResend(); t.after(f.close);
  const { call, adm } = await boot(t, f, { backupPassphrase: "1234", backupAllowShort: true });
  await signup(call, 0);
  const st = (await call("GET", "/api/admin/export/weekly", undefined, adm)).body;
  assert.equal(st.ready, true); assert.equal(st.shortCode, true, "and the status says it is running on a short code");
  assert.equal((await call("POST", "/api/admin/export/weekly/send", {}, adm)).status, 200);
  const mail = f.emails.find((e) => e.attachments);
  assert.deepEqual(mail.to, ["owner@example.com"]);
  const html = Buffer.from(mail.attachments[0].content, "base64").toString("utf8");
  assert.ok(!/Zelda/.test(html) && unzip(unseal(boxOf(html), "1234"))["clients.csv"], "still encrypted, and the code opens it");
});

test("weekly export: once a week, from Monday 6 am, and caught up if the service was down", async (t) => {
  const f = await fakeResend(); t.after(f.close);
  const { call, app, clock } = await boot(t, f);
  await signup(call, 0);
  const api = app.get("backupApi"), sent = () => f.emails.filter((e) => e.attachments).length;
  const at = async (iso) => { clock.now = new Date(iso); api.tick(); for (let i = 0; i < 40 && api.due(); i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 60)); };
  await at("2026-11-02T09:30:00Z"); assert.equal(sent(), 0, "Monday 4:30 am New York: too early");
  await at("2026-11-02T11:05:00Z"); assert.equal(sent(), 1, "Monday 6:05 am: sent");
  await at("2026-11-02T18:00:00Z"); await at("2026-11-05T15:00:00Z"); await at("2026-11-08T23:00:00Z");
  assert.equal(sent(), 1, "not again that week");
  await at("2026-11-11T15:00:00Z"); assert.equal(sent(), 2, "service was down on Monday the 9th: sent on the first check after");
  await at("2026-11-13T15:00:00Z"); assert.equal(sent(), 2);
});

test("weekly export: admin only", async (t) => {
  const f = await fakeResend(); t.after(f.close);
  const { call } = await boot(t, f);
  const member = (await signup(call, 0)).body.token;
  for (const tok of [undefined, member]) {
    assert.equal((await call("GET", "/api/admin/export/weekly", undefined, tok)).status, 401);
    assert.equal((await call("POST", "/api/admin/export/weekly/send", {}, tok)).status, 401);
  }
  assert.equal(f.emails.filter((e) => e.attachments).length, 0);
});
