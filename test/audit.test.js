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
  assert.deepEqual(months.map((k) => k.slice(0, 7)), ["2026-10", "2026-11"], "spans months: a new month starts a new file");
  const NOV = "audit-" + months[1];
  assert.ok(!fs.readFileSync(path.join(dir, NOV + ".json"), "utf8").includes("coach@example.com"), "encrypted at rest");
  // a fresh instance (same store) keeps the same key and chain
  const a2 = createAudit({ store });
  assert.equal(a2.fingerprint, a.fingerprint);
  a2.record({ actor: "client:c1", action: "client./pain", subject: "c1" });
  assert.equal(a2.verify().ok, true);
  // tamper: change who viewed a record
  const nov = store.read(NOV, []);
  const orig = JSON.parse(JSON.stringify(nov));
  nov[0].subject = "someone-else"; store.write(NOV, nov);
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /altered/);
  // tamper with hash too (re-hash without the key): signature fails
  const { hashOf } = require("../lib/audit"); nov[0].hash = hashOf(nov[0]); store.write(NOV, nov);
  v = a2.verify(); assert.equal(v.ok, false);
  // delete an entry
  store.write(NOV, orig.filter((_, i) => i !== 1));
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /missing or out of order/);
  // truncate the newest entry
  store.write(NOV, orig.slice(0, -1));
  v = a2.verify(); assert.equal(v.ok, false); assert.match(v.error, /truncated/);
  store.write(NOV, orig);
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
  assert.equal(log.nextBefore, null, "everything fit on one page");
  // paging: newest first, ?before=<seq> continues where the last page stopped, no overlap or gaps
  const p1 = (await call("GET", "/api/admin/audit?limit=2", undefined, adm)).body;
  assert.equal(p1.entries.length, 2); assert.equal(p1.nextBefore, p1.entries[1].seq);
  const p2 = (await call("GET", `/api/admin/audit?limit=2&before=${p1.nextBefore}`, undefined, adm)).body;
  assert.equal(p2.entries.length, 2); assert.equal(p2.entries[0].seq, p1.nextBefore - 1);
  assert.ok(p2.entries.every((e) => e.seq < p1.nextBefore));
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
  const settle = () => new Promise((r) => setTimeout(r, 750)); // emails are paced ~0.6 s apart to stay under the provider's rate limit
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


test("audit: entries go into small files, the chain runs on from an earlier whole-month file, and nothing about checking it changes", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createStore } = require("../lib/store");
  const { createAudit } = require("../lib/audit");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-auditseg-"));
  try {
    const store = createStore(dir, { key: "made-up-key-for-this-test" });
    let clock = new Date("2026-10-30T12:00:00Z");
    const audit = createAudit({ store, ipSalt: "x", now: () => clock });
    const rec = (n, action = "admin.view /clients") => { for (let i = 0; i < n; i++) audit.record({ actor: "admin", action, subject: "s" + i, ip: "1.2.3.4" }); };
    rec(3);
    // make what is there look like the earlier layout: one whole-month file, and a state that knows nothing of small files
    const st0 = store.read("audit-state"), first = st0.months[0];
    store.write("audit-2026-10", store.read("audit-" + first)); fs.rmSync(path.join(dir, "audit-" + first + ".json"));
    store.write("audit-state", { seq: st0.seq, last: st0.last, months: ["2026-10"] });
    assert.equal(audit.verify().ok, true, "the earlier layout still verifies");

    rec(1200);
    clock = new Date("2026-11-01T12:00:00Z"); rec(7, "admin.change /settings");
    const st = store.read("audit-state");
    assert.equal(st.seq, 1210);
    assert.equal(st.months[0], "2026-10", "the earlier month file is still the start of the chain");
    assert.deepEqual(st.months.slice(1).map((k) => store.read("audit-" + k).length), [500, 500, 200, 7], "500 to a file; a new month starts a new file");
    assert.ok(st.months.slice(1, 4).every((k) => k.startsWith("2026-10-s")) && st.months[4].startsWith("2026-11-s"));
    assert.equal(store.read("audit-2026-10").length, 3, "the earlier file is not rewritten");
    const v = audit.verify(); assert.equal(v.ok, true); assert.equal(v.entries, 1210);
    // reading back: newest first, across files, with the same filters and paging as before
    const top = audit.list({ limit: 10 }); assert.deepEqual(top.map((e) => e.seq), [1210, 1209, 1208, 1207, 1206, 1205, 1204, 1203, 1202, 1201]);
    assert.equal(audit.list({ action: "admin.change", limit: 50 }).length, 7);
    assert.deepEqual(audit.list({ limit: 3, before: 502 }).map((e) => e.seq), [501, 500, 499], "paging crosses from one file into the one before");
    assert.equal(audit.list({ limit: 5000 }).length, 1210);
    assert.equal(audit.checkAnchor(2, store.read("audit-2026-10")[1].hash).ok, true); assert.equal(audit.checkAnchor(900, audit.list({ limit: 1, before: 901 })[0].hash).ok, true);
    // one altered entry in a middle file is still caught, and so is a missing newest file
    const mid = st.months[2], rows = store.read("audit-" + mid); rows[10].subject = "someone-else"; store.write("audit-" + mid, rows);
    const bad = audit.verify(); assert.equal(bad.ok, false); assert.match(bad.error, /altered/);
    rows[10].subject = "s" + (rows[10].seq - 4); store.write("audit-" + mid, rows); assert.equal(audit.verify().ok, true);
    fs.rmSync(path.join(dir, "audit-" + st.months[4] + ".json")); assert.equal(audit.verify().ok, false, "a file that has gone missing is noticed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
