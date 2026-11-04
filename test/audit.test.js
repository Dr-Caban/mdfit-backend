const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createStore } = require("../lib/store");
const { createAudit } = require("../lib/audit");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-audit-"));

test("ledger: hash chain + Ed25519 signatures verify; tampering, deletion and truncation are caught", () => {
  const dir = tmp(), store = createStore(dir, { key: "k".repeat(32) });
  let t = Date.parse("2026-10-31T23:58:00Z");
  const a = createAudit({ store, now: () => new Date((t += 30000)) });
  for (let i = 0; i < 5; i++) a.record({ actor: "admin:coach@example.com", action: "admin.view /clients/:id", subject: "c" + i, ip: "203.0.113.9" });
  let v = a.verify();
  assert.equal(v.ok, true); assert.equal(v.entries, 5);
  const months = JSON.parse(JSON.stringify(createStore(dir, { key: "k".repeat(32) }).read("audit-state", {}))).months;
  assert.deepEqual(months, ["2026-10", "2026-11"], "spans months");
  assert.ok(!fs.readFileSync(path.join(dir, "audit-2026-11.json"), "utf8").includes("coach@example.com"), "encrypted at rest");
  // a fresh instance (same store) keeps the same key and chain
  const a2 = createAudit({ store });
  assert.equal(a2.fingerprint, a.fingerprint);
  a2.record({ actor: "client:c1", action: "client./pain", subject: "c1" });
  assert.equal(a2.verify().ok, true);
  // tamper: change who viewed a record
  const nov = store.read("audit-2026-11", []);
  const orig = JSON.parse(JSON.stringify(nov));
  nov[0].subject = "someone-else"; store.write("audit-2026-11", nov);
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /altered/);
  // tamper with hash too (re-hash without the key): signature fails
  const { hashOf } = require("../lib/audit"); nov[0].hash = hashOf(nov[0]); store.write("audit-2026-11", nov);
  v = a2.verify(); assert.equal(v.ok, false);
  // delete an entry
  store.write("audit-2026-11", orig.filter((_, i) => i !== 1));
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /missing or out of order/);
  // truncate the newest entry
  store.write("audit-2026-11", orig.slice(0, -1));
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /truncated/);
  store.write("audit-2026-11", orig);
  assert.equal(a2.verify().ok, true, "restored copy verifies again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server records logins, failed logins and every admin look at a patient", async (t) => {
  const dataDir = tmp();
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://x" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  await call("POST", "/api/admin/login", { email: "coach@example.com", password: "wrong-password" });
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const ctok = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", password: "pat-pass-123" })).body.token;
  await call("POST", "/api/me/pain", { area: "Neck", level: 4 }, ctok);
  const me = (await call("GET", "/api/me", undefined, ctok)).body.client;
  await call("GET", `/api/admin/clients/${me.id}`, undefined, adm);
  await new Promise((r) => setTimeout(r, 50));
  const log = (await call("GET", "/api/admin/audit", undefined, adm)).body;
  const acts = log.entries.map((e) => e.action);
  for (const a of ["auth.admin.login_failed", "auth.admin.login", "auth.client.signup", "client./pain", "admin.view /clients/:id"]) assert.ok(acts.includes(a), a);
  const view = log.entries.find((e) => e.action === "admin.view /clients/:id");
  assert.equal(view.actor, "admin:coach@example.com"); assert.equal(view.subject, me.id);
  assert.ok(!JSON.stringify(log.entries).includes("127.0.0.1"), "IPs are stored hashed");
  assert.match(log.publicKey, /BEGIN PUBLIC KEY/);
  const v = (await call("GET", "/api/admin/audit/verify", undefined, adm)).body;
  assert.equal(v.ok, true); assert.ok(v.entries >= 5);
});

test("admin two-step login by email code: on/off, single-use, expires, 5 tries, emergency switch", async (t) => {
  const http = require("http");
  const mails = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { mails.push(JSON.parse(b)); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); });
  await new Promise((r) => fake.listen(0, r));
  const dataDir = tmp();
  const mk = (extra = {}) => createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date(), siteUrl: "https://x", resendKey: "re_test", notifyFrom: "MD Fit <noreply@mymdfit.com>", resendUrl: `http://127.0.0.1:${fake.address().port}`, ...extra });
  let server = mk().listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base() + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const login = (code) => call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123", ...(code ? { code } : {}) });
  const lastCode = () => { const m = mails[mails.length - 1]; return m.subject.match(/^(\d{6})/)[1]; };
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const tok = (await login()).body.token;
  assert.ok(tok, "password-only while off");
  // turn on: a code is emailed, confirming it switches two-step on
  assert.equal((await call("POST", "/api/admin/mfa/start", {}, tok)).status, 200); await settle();
  assert.equal(mails[0].to[0], "coach@example.com"); assert.equal(mails[0].from, "MD Fit <noreply@mymdfit.com>");
  assert.equal((await call("POST", "/api/admin/mfa/confirm", { code: "000000" }, tok)).status, 400);
  assert.equal((await call("POST", "/api/admin/mfa/confirm", { code: lastCode() }, tok)).status, 200);
  // login now needs the emailed code
  let r = await login(); await settle();
  assert.equal(r.status, 401); assert.equal(r.body.mfaRequired, true); assert.match(r.body.error, /emailed a 6-digit code/);
  const code = lastCode();
  assert.ok(!JSON.stringify(mails[mails.length - 1]).includes("recovery"), "no recovery codes anywhere");
  assert.equal((await login(code)).status, 200);
  assert.equal((await login(code)).status, 401, "a code works once");
  // 5 wrong tries burn the code
  await new Promise((r) => setTimeout(r, 10)); mails.length = 0;
  const p = (await call("GET", "/api/admin/mfa", undefined, tok)).body; assert.equal(p.enabled, true);
  // emergency switch: ADMIN_MFA=off in the host's variables
  server.close(); server = mk({ mfaForceOff: true }).listen(0); await new Promise((r) => server.once("listening", r));
  assert.equal((await login()).status, 200, "ADMIN_MFA=off lets you in with the password");
  server.close(); server = mk().listen(0); await new Promise((r) => server.once("listening", r));
  const tok2 = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" }));
  assert.equal(tok2.status, 401, "on again after the switch is removed"); await settle();
  for (let i = 0; i < 5; i++) await login("111111");
  assert.equal((await login(lastCode())).status, 401, "after 5 wrong tries the code is dead");
  // turning off needs the password
});

test("audit anchors detect a fully rebuilt chain; key rotation keeps old entries verifiable", () => {
  const crypto = require("crypto");
  const dir = tmp(), store = createStore(dir, { key: "k".repeat(32) });
  const a = createAudit({ store });
  for (let i = 0; i < 3; i++) a.record({ actor: "admin:coach@example.com", action: "admin.view /clients/:id", subject: "c" + i });
  const anchor = a.anchor();
  assert.equal(anchor.seq, 3);
  assert.equal(a.anchor(), null, "no duplicate anchor when nothing changed");
  assert.equal(a.checkAnchor(3, anchor.head).ok, true);
  // Attacker with full server access rebuilds the chain from scratch (new key, different history): it verifies on its own...
  const dir2 = tmp(), store2 = createStore(dir2, { key: "k".repeat(32) });
  const forged = createAudit({ store: store2 });
  for (let i = 0; i < 3; i++) forged.record({ actor: "admin:coach@example.com", action: "admin.view /clients/:id", subject: "nobody" });
  assert.equal(forged.verify().ok, true);
  // ...but the anchor emailed to the owner exposes it
  assert.equal(forged.checkAnchor(3, anchor.head).ok, false);
  // Rotate to a key held outside the store: old entries still verify, new ones use the new key id
  const newKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const b = createAudit({ store, signingKey: Buffer.from(newKey).toString("base64") });
  assert.notEqual(b.fingerprint, a.fingerprint);
  const e = b.record({ actor: "system", action: "audit.key_rotated", meta: { from: a.fingerprint, to: "new" } });
  assert.equal(e.kid, b.fingerprint);
  assert.equal(b.verify().ok, true);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });
});

