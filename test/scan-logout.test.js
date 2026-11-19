// Signing out of the workspace ends that sign-in on the server: a copy of the token kept elsewhere stops working.
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server"); const { hashPassword } = require("../lib/auth");

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-logout-"));
  const cfg = { adminEmail: "o@example.com", adminPasswordHash: hashPassword("x-pass-12345"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", siteUrl: "http://localhost", noVideoSync: true, noAffiliateJobs: true, calWatchMs: 0 };
  const start = async () => { const srv = createApp(cfg).listen(0); await new Promise((r) => srv.once("listening", r)); return srv; };
  return { cfg, start, dataDir };
}
const call = (srv, method, p, token, body) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });

test("staff sign-out: the token is refused afterwards, also after a restart; other sign-ins keep working", async () => {
  const { start, dataDir } = await boot(); let srv = await start();
  try {
    const login = async () => (await (await call(srv, "POST", "/api/admin/login", null, { email: "o@example.com", password: "x-pass-12345" })).json()).token;
    const a = await login(), b = await login();
    assert.ok(a && b);
    assert.strictEqual((await call(srv, "GET", "/api/admin/me", a)).status, 200);
    assert.strictEqual((await call(srv, "POST", "/api/admin/me/logout", a)).status, 200);
    assert.strictEqual((await call(srv, "GET", "/api/admin/me", a)).status, 401, "the signed-out token is refused");
    assert.strictEqual((await call(srv, "POST", "/api/admin/me/logout", a)).status, 401, "and cannot be used to sign out again");
    if (a !== b) assert.strictEqual((await call(srv, "GET", "/api/admin/me", b)).status, 200, "another sign-in of the same account is untouched");
    assert.strictEqual((await call(srv, "POST", "/api/admin/me/logout")).status, 401, "no token, no sign-out");
    // only a fingerprint is stored, never the token
    const kept = fs.readFileSync(path.join(dataDir, "signedOut.json"), "utf8");
    assert.ok(!kept.includes(a));
    await new Promise((r) => srv.close(r)); srv = await start();
    assert.strictEqual((await call(srv, "GET", "/api/admin/me", a)).status, 401, "still refused after a restart");
  } finally { await new Promise((r) => srv.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
