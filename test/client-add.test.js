// Staff add a client by hand (email required). Saving emails the client their account notice with a temporary
// password, which only ever leads to choosing their own. Also: emailing the sign-in address, and a sign-up invitation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

async function start({ email = true } = {}) {
  const sent = [];
  const mail = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mail.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-add-"));
  const app = createApp({ adminEmail: "owner@example.com", adminPasswordHash: hashPassword("owner-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(),
    siteUrl: "https://www.mymdfit.com", trashTimer: false, ...(email ? { resendKey: "re_test", notifyFrom: "MD Fit <no-reply@example.com>", resendUrl: `http://127.0.0.1:${mail.address().port}`, minGapMs: 0 } : {}) });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const call = async (method, url, body, token) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { "content-type": "application/json", connection: "close", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const owner = (await call("POST", "/api/admin/login", { email: "owner@example.com", password: "owner-pass-123" })).body.token;
  const to = (addr) => sent.filter((m) => [].concat(m.to).includes(addr));
  return { call, owner, sent, to, dataDir, close: () => { server.close(); mail.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const pwIn = (text) => (String(text).match(/Temporary password[^\n]*:\n(\S+)\n/) || [])[1];

test("adding a client: email required, the client is emailed a temporary password, and it only leads to choosing their own", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("POST", "/api/admin/clients", { name: "New Person" })).status, 401);
    let r = await s.call("POST", "/api/admin/clients", { name: "New Person", phone: "941-555-0100" }, s.owner);
    assert.equal(r.status, 400); assert.match(r.body.error, /email address is required/);
    assert.equal((await s.call("POST", "/api/admin/clients", { name: "New Person", email: "not-an-email" }, s.owner)).status, 400);
    assert.equal((await s.call("POST", "/api/admin/clients", { name: "", email: "new.person@example.com" }, s.owner)).status, 400);

    r = await s.call("POST", "/api/admin/clients", { name: "New Person", email: "New.Person@Example.com", phone: "941-555-0100" }, s.owner);
    assert.equal(r.status, 201); assert.equal(r.body.client.email, "new.person@example.com"); assert.equal(r.body.emailed, true);
    assert.equal(JSON.stringify(r.body).includes("Temporary"), false, "the password is never sent back to the workspace");
    const id = r.body.client.id;
    assert.equal((await s.call("POST", "/api/admin/clients", { name: "Again", email: "new.person@example.com" }, s.owner)).status, 409);
    assert.ok((await s.call("GET", "/api/admin/clients", undefined, s.owner)).body.some((c) => c.id === id), "they are on the client list");

    const mail = s.to("new.person@example.com"); assert.equal(mail.length, 1);
    assert.match(mail[0].text, /https:\/\/www\.mymdfit\.com\/login/); assert.match(mail[0].text, /choose your own password/);
    const temp = pwIn(mail[0].text); assert.match(temp, /^[A-Z2-9]{12}$/, "one unbroken word on its own line, so it copies in one go");
    // nothing on disk holds it in the clear
    for (const f of fs.readdirSync(s.dataDir)) { const p = path.join(s.dataDir, f); if (fs.statSync(p).isFile()) assert.equal(fs.readFileSync(p, "latin1").includes(temp), false, f); }

    // a wrong password is just wrong
    assert.equal((await s.call("POST", "/api/clients/login", { email: "new.person@example.com", password: "WRONG-WRONG-WRNG" })).status, 401);
    // the temporary one does not sign them in: it hands back the way to choose a real one
    const first = await s.call("POST", "/api/clients/login", { email: "new.person@example.com", password: temp });
    assert.equal(first.status, 403); assert.equal(first.body.mustChangePassword, true); assert.equal(first.body.token, undefined); assert.ok(first.body.resetToken);
    const set = await s.call("POST", "/api/clients/reset", { token: first.body.resetToken, password: "my-own-password-1" });
    assert.equal(set.status, 200); assert.ok(set.body.token, "choosing a password signs them in");
    assert.equal((await s.call("GET", "/api/me", undefined, set.body.token)).status, 200);
    // from then on: their password works, the temporary one is dead, and the step cannot be replayed
    assert.equal((await s.call("POST", "/api/clients/login", { email: "new.person@example.com", password: "my-own-password-1" })).status, 200);
    assert.equal((await s.call("POST", "/api/clients/login", { email: "new.person@example.com", password: temp })).status, 401);
    assert.equal((await s.call("POST", "/api/clients/reset", { token: first.body.resetToken, password: "another-password-2" })).status, 400);

    // "Email sign-in link" for someone with their own password sends the address and no password
    r = await s.call("POST", `/api/admin/clients/${id}/login-link`, {}, s.owner);
    assert.equal(r.status, 200); assert.equal(r.body.temporaryPassword, false);
    assert.equal(pwIn(s.to("new.person@example.com").pop().text), undefined);
    assert.equal((await s.call("POST", "/api/clients/login", { email: "new.person@example.com", password: "my-own-password-1" })).status, 200, "their password is untouched");

    // for someone who never signed in, it issues a fresh temporary password and the old one stops working
    r = await s.call("POST", "/api/admin/clients", { name: "Second Person", email: "second@example.com" }, s.owner);
    const old = pwIn(s.to("second@example.com")[0].text);
    r = await s.call("POST", `/api/admin/clients/${r.body.client.id}/login-link`, {}, s.owner);
    assert.equal(r.body.temporaryPassword, true);
    const fresh = pwIn(s.to("second@example.com")[1].text); assert.notEqual(fresh, old);
    assert.equal((await s.call("POST", "/api/clients/login", { email: "second@example.com", password: old })).status, 401);
    assert.equal((await s.call("POST", "/api/clients/login", { email: "second@example.com", password: fresh })).status, 403);
    assert.equal((await s.call("POST", "/api/admin/clients/nope/login-link", {}, s.owner)).status, 404);

    // the sign-up invitation makes no account; an address that has one gets the sign-in email instead
    assert.equal((await s.call("POST", "/api/admin/clients/invite", { email: "nope" }, s.owner)).status, 400);
    r = await s.call("POST", "/api/admin/clients/invite", { email: "someone@example.com" }, s.owner);
    assert.equal(r.status, 200); assert.equal(r.body.existing, false); assert.match(s.to("someone@example.com")[0].text, /Create account/);
    assert.equal((await s.call("GET", "/api/admin/clients", undefined, s.owner)).body.some((c) => c.email === "someone@example.com"), false);
    assert.equal((await s.call("POST", "/api/admin/clients/invite", { email: "new.person@example.com" }, s.owner)).body.existing, true);

    // roles: no Clients permission, no adding or inviting
    await s.call("POST", "/api/admin/staff", { name: "Dev", email: "dev@example.com", role: "developer", password: "staff-pass-1234" }, s.owner);
    const dev = (await s.call("POST", "/api/admin/login", { email: "dev@example.com", password: "staff-pass-1234" })).body.token;
    for (const [u, b] of [["/api/admin/clients", { name: "X Y", email: "x@example.com" }], ["/api/admin/clients/invite", { email: "x@example.com" }], [`/api/admin/clients/${id}/login-link`, {}]]) assert.equal((await s.call("POST", u, b, dev)).status, 403, u);
    // the ledger has who added them
    const led = (await s.call("GET", `/api/admin/audit?limit=200`, undefined, s.owner)).body.entries;
    assert.ok(led.some((e) => e.actor === "admin:owner@example.com" && /clients/.test(JSON.stringify(e))), "adding a client is in the audit ledger");
    assert.equal(JSON.stringify(led).includes(temp), false, "and the password is not");
  } finally { s.close(); }
});

test("a temporary password expires, and with no email service none is made", async () => {
  const s = await start();
  try {
    const r = await s.call("POST", "/api/admin/clients", { name: "Late Person", email: "late@example.com" }, s.owner);
    const temp = pwIn(s.to("late@example.com")[0].text);
    const f = path.join(s.dataDir, "clients.json"), list = JSON.parse(fs.readFileSync(f, "utf8"));
    list.find((c) => c.id === r.body.client.id).tempPw.until = "2020-01-01T00:00:00.000Z"; fs.writeFileSync(f, JSON.stringify(list));
    const late = await s.call("POST", "/api/clients/login", { email: "late@example.com", password: temp });
    assert.equal(late.status, 401); assert.match(late.body.error, /expired/); assert.equal(late.body.resetToken, undefined);
  } finally { s.close(); }
  const n = await start({ email: false });
  try {
    const r = await n.call("POST", "/api/admin/clients", { name: "No Mail", email: "nomail@example.com" }, n.owner);
    assert.equal(r.status, 201); assert.equal(r.body.emailed, false); assert.equal(r.body.emailReady, false);
    assert.notEqual((await n.call("POST", "/api/clients/login", { email: "nomail@example.com", password: "anything-at-all" })).status, 200);
    assert.equal((await n.call("POST", `/api/admin/clients/${r.body.client.id}/login-link`, {}, n.owner)).status, 503);
    assert.equal((await n.call("POST", "/api/admin/clients/invite", { email: "x@example.com" }, n.owner)).status, 503);
  } finally { n.close(); }
});
