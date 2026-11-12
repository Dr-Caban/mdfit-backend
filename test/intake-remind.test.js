// "Notify to sign": staff ask a client to finish their new patient documents. The message says documents are waiting
// and where; it never says what is in them.
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

test("notify to sign: an email and app notice to finish documents; not twice in a row; not once complete", async (t) => {
  const mail = [];
  const post = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const j = JSON.parse(b); mail.push(...(Array.isArray(j) ? j : [j])); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","data":[]}'); }); }).listen(0);
  await new Promise((r) => post.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-remind-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", resendKey: "re_made_up", notifyFrom: "MD Fit <office@example.com>", resendUrl: `http://127.0.0.1:${post.address().port}`, notifyGapMs: 1 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); post.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const pat = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
  const done = (await call("POST", "/api/clients/signup", { name: "Dee Done", email: "dee@example.com", phone: "941-555-0101", password: "pat-pass-123" })).body;
  const A = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const u = (id) => `/api/admin/clients/${id}/intake/remind`;

  assert.equal((await call("POST", u(pat.client.id), {})).status, 401);
  assert.equal((await call("POST", u(pat.client.id), {}, pat.token)).status, 401, "staff only");
  assert.equal((await call("POST", u("nobody"), {}, A)).status, 404);

  // one document filled, three to go
  await call("POST", "/api/me/intake/info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" }, pat.token);
  const r = await call("POST", u(pat.client.id), {}, A);
  assert.equal(r.status, 200); assert.equal(r.body.emailed, true); assert.equal(r.body.done, 1); assert.equal(r.body.total, 4);
  assert.equal((await call("POST", u(pat.client.id), {}, A)).status, 429, "not twice within a few minutes");

  // someone whose documents are complete is not reminded
  const save = (doc, body) => call("POST", `/api/me/intake/${doc}`, body, done.token);
  await save("info", { name: "Dee Done", dob: "1980-02-03", phone: "941-555-0101", email: "dee@example.com", emergencyName: "Sam", emergencyPhone: "941-555-0199" });
  await save("pain", { complaint: "Knee", areas: ["Right knee"], started: "2 to 6 weeks ago", painNow: 3, goals: "Walk" });
  await save("history", { redFlags: "No" });
  await save("consent", { treatment: true, privacy: true, financial: true, signature: "Dee Done" });
  assert.equal((await call("POST", u(done.client.id), {}, A)).status, 409);

  await new Promise((x) => setTimeout(x, 700));
  const sent = mail.filter((m) => /finish your MD Fit new patient documents/.test(m.subject || ""));
  assert.equal(sent.length, 1, "one email, to the one person asked");
  assert.match(JSON.stringify(sent[0].to), /pat@example\.com/);
  assert.match(sent[0].text, /1 of 4 done/); assert.match(sent[0].text, /https:\/\/mdfit\.example\.com\/intake\?me=1/);
  assert.equal(/1980|Sam Doe|emergency/i.test(sent[0].text), false, "nothing from the documents themselves");
  const log = (await call("GET", "/api/admin/audit?action=intake", undefined, A)).body;
  assert.ok((log.entries || log).some((e) => e.action === "intake.remind" && e.subject === pat.client.id && e.meta.emailed === true));
});
