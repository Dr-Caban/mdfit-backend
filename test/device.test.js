// What a member is using (the app or a browser, the kind of device, whether it can use a camera) is on record from
// the first beat the app sends, and staff see it in plain words before inviting anyone to a video session.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { describeDevice } = require("../lib/presence");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

test("device: recorded from the first beat, shown to staff in plain words, and nothing that tells two phones apart is kept", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-device-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), calWatchMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const A = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const mk = async (n) => (await call("POST", "/api/clients/signup", { name: n, email: n.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const ios = await mk("Ivy Iphone"), web = await mk("Wes Web"), droid = await mk("Dee Droid"), none = await mk("Nan None");

  assert.equal((await call("GET", "/api/admin/telehealth/devices")).status, 401);
  assert.equal((await call("GET", "/api/admin/telehealth/devices", undefined, ios.token)).status, 401);
  // the first beat carries no time, only what the app is running on
  assert.equal((await call("POST", "/api/me/presence", { seconds: 0, view: "home", platform: "ios", device: { app: true, os: "ios", browser: "safari", media: true } }, ios.token)).status, 200);
  await call("POST", "/api/me/presence", { seconds: 0, view: "home", platform: "web", device: { app: false, os: "android", browser: "chrome", media: true, model: "Pixel 9", id: "abc-123" } }, web.token);
  await call("POST", "/api/me/presence", { seconds: 0, view: "home", platform: "android", device: { app: true, os: "android", browser: "chrome", media: true } }, droid.token);
  await call("POST", "/api/me/presence", { seconds: 30, view: "home", platform: "web" }, none.token);

  const d = (await call("GET", "/api/admin/telehealth/devices", undefined, A)).body;
  assert.equal(d[ios.client.id].label, "iPhone app"); assert.equal(d[ios.client.id].speak, false); assert.match(d[ios.client.id].note, /continue in Safari/);
  assert.equal(d[web.client.id].label, "Android · Chrome"); assert.equal(d[web.client.id].speak, true);
  assert.equal(d[droid.client.id].label, "Android app"); assert.equal(d[droid.client.id].speak, null, "not claimed either way until it is checked");
  assert.equal(none.client.id in d, false, "nothing is invented for someone whose app has not said");
  assert.equal(/Pixel|abc-123/.test(fs.readdirSync(dataDir).map((f) => fs.readFileSync(path.join(dataDir, f), "utf8")).join("")), false, "a model or an identifier that was sent is not kept");
  // words outside the fixed lists are not stored as given
  await call("POST", "/api/me/presence", { seconds: 0, device: { app: "yes", os: "<script>", browser: "netscape", media: 1 } }, none.token);
  assert.equal((await call("GET", "/api/admin/telehealth/devices", undefined, A)).body[none.client.id].label, "iPhone app");
  assert.deepEqual([describeDevice({ app: false, os: "ios", browser: "safari", media: true }).label, describeDevice({ app: false, os: "mac", browser: "firefox", media: false }).speak, describeDevice(null)], ["iPhone or iPad · Safari", false, null]);
});
