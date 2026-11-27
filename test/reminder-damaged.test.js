// One damaged entry in the client list must not stop everyone's reminders.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

test("reminders: an empty slot or a damaged reminder in the client list is passed over and the rest still go", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-rem-"));
  const clock = { now: new Date("2026-11-12T15:00:00Z") };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"],
    tz: "America/New_York", now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://site.example.com", noVideoSync: true, noAffiliateJobs: true });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const a = (await call("POST", "/api/clients/signup", { name: "Ann Alpha", email: "ann.alpha@example.com", password: "made-up-pass-1" })).body;
  assert.equal((await call("POST", "/api/me/devices", { token: "1".repeat(64) }, a.token)).status, 200);
  assert.equal((await call("POST", "/api/me/reminders", { title: "Stretch", date: "2026-11-12", time: "10:30" }, a.token)).status, 201);
  const f = path.join(dataDir, "clients.json"), list = JSON.parse(fs.readFileSync(f, "utf8"));
  list.unshift(null);                                   // an empty slot
  list.find((c) => c && c.id === a.client.id).reminders.push(null); // and a damaged reminder beside the real one
  fs.writeFileSync(f, JSON.stringify(list));
  clock.now = new Date("2026-11-12T15:30:10Z");
  const out = [];
  assert.deepEqual(app.get("guideApi").sweep({ enabled: true, toClient: (id, n) => out.push([id, n.body]) }), { sent: 1 });
  assert.deepEqual(out, [[a.client.id, "Stretch"]]);
});
