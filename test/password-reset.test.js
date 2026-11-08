"use strict";
// Password reset, end to end: the 6-digit code really goes out by email (to a fake Resend), the code from that
// email verifies, the new password works, and the old one doesn't. Both ways in: the member's "Forgot password?"
// and the admin's "Send password reset email" button.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

async function start(t) {
  const sent = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => fake.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-reset-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40), dataDir,
    origins: ["*"], tz: "America/New_York", now: () => new Date(), mfaForceOff: true, notifyGapMs: 0,
    resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>", notifyEmail: "owner@example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const waitFor = async (pred) => { for (let i = 0; i < 300 && !sent.some(pred); i++) await new Promise((r) => setTimeout(r, 20)); return sent.filter(pred); };
  t.after(() => { server.close(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { call, sent, waitFor };
}
const codeIn = (mail) => (mail.subject.match(/^(\d{6}) is your MD Fit code$/) || [])[1];

test("member: Forgot password? -> emailed code -> new password works, old one doesn't", async (t) => {
  const { call, waitFor } = await start(t);
  const su = await call("POST", "/api/clients/signup", { name: "Pat Member", email: "pat@example.com", password: "OldPassw0rd!", phone: "9415550100" });
  assert.ok([200, 201].includes(su.status), JSON.stringify(su.body));

  const f = await call("POST", "/api/clients/forgot", { identifier: "pat@example.com" });
  assert.equal(f.status, 200); assert.equal(f.body.emailed, true);
  const [mail] = await waitFor((m) => m.to && m.to.includes("pat@example.com") && /is your MD Fit code/.test(m.subject));
  assert.ok(mail, "the code email was sent to the member");
  const code = codeIn(mail); assert.match(code, /^\d{6}$/);
  assert.ok(mail.text.includes(code) && /expires in 10 minutes/.test(mail.text));

  const wrong = await call("POST", "/api/clients/verify-code", { identifier: "pat@example.com", code: "000000" });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /Wrong code/);
  const v = await call("POST", "/api/clients/verify-code", { identifier: "pat@example.com", code });
  assert.equal(v.status, 200); assert.ok(v.body.resetToken);
  const reused = await call("POST", "/api/clients/verify-code", { identifier: "pat@example.com", code });
  assert.equal(reused.status, 400, "a code works once");

  const r = await call("POST", "/api/clients/reset", { token: v.body.resetToken, password: "NewPassw0rd!" });
  assert.equal(r.status, 200); assert.ok(r.body.token, "signed in right after the reset");
  const old = await call("POST", "/api/clients/login", { email: "pat@example.com", password: "OldPassw0rd!" });
  assert.equal(old.status, 401);
  const fresh = await call("POST", "/api/clients/login", { email: "pat@example.com", password: "NewPassw0rd!" });
  assert.equal(fresh.status, 200);
  // The session from before the reset is signed out (pwv bump)
  const stale = await call("GET", "/api/me", undefined, su.body.token);
  assert.equal(stale.status, 401);
  // Unknown emails get the same answer and no email
  const unknown = await call("POST", "/api/clients/forgot", { identifier: "nobody@example.com" });
  assert.equal(unknown.status, 200); assert.equal(unknown.body.message, f.body.message);
});

test("admin: Send password reset email button emails the member a working code", async (t) => {
  const { call, waitFor } = await start(t);
  const su = await call("POST", "/api/clients/signup", { name: "Lee Member", email: "lee@example.com", password: "OldPassw0rd!", phone: "9415550101" });
  const admin = await call("POST", "/api/admin/login", { email: "coach@example.com", password: "test-pass-123" });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  const r = await call("POST", `/api/admin/clients/${su.body.client.id}/send-reset-code`, {}, admin.body.token);
  assert.equal(r.status, 200); assert.match(r.body.message, /Code emailed to l•+@example\.com/);
  const [mail] = await waitFor((m) => m.to && m.to.includes("lee@example.com") && /is your MD Fit code/.test(m.subject));
  assert.ok(mail, "the member got the email");
  const v = await call("POST", "/api/clients/verify-code", { identifier: "lee@example.com", code: codeIn(mail) });
  assert.equal(v.status, 200);
  const done = await call("POST", "/api/clients/reset", { token: v.body.resetToken, password: "SetByCode1!" });
  assert.equal(done.status, 200);
  assert.equal((await call("POST", "/api/clients/login", { email: "lee@example.com", password: "SetByCode1!" })).status, 200);
});
