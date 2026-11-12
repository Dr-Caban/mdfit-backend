// AI scribe backups: when the first service cannot answer, the next one configured is tried, and the answer says
// which one drafted it. If none can, every reason is given.
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
const VISIT = "Right knee three weeks after surgery. Swelling is down. Did soft tissue work on the quad. Heel slides two sets of ten twice a day. Back in one week.";

async function start(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-backup-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
// A stand-in AI service: answers every request the same way and remembers what it was sent
async function service(t, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(b || "{}") }); res.writeHead(reply.status, { "content-type": "application/json" }); res.end(JSON.stringify(reply.status === 200 ? { choices: [{ message: { content: reply.text } }] } : reply.body || {})); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r)); t.after(() => srv.close());
  return { seen, url: `http://127.0.0.1:${srv.address().port}/v1` };
}

test("scribe backups: the next service is tried when the first cannot answer; the answer says who drafted it", async (t) => {
  const first = await service(t, { status: 404, body: { error: { type: "resource_not_found_error", message: "Not found the model first-model or Permission denied" } } });
  const second = await service(t, { status: 200, text: "Drafted by the backup." });
  const s = await start({ scribe: { url: first.url, key: "first-key-not-real", model: "first-model", fallbacks: [{ url: second.url, key: "second-key-not-real", model: "backup-model" }, { url: "http://example.com/v1", key: "k", model: "m" }] } });
  t.after(s.close);
  const A = await s.adminToken();
  const st = (await s.call("GET", "/api/admin/scribe", undefined, A)).body;
  assert.equal(st.model, "first-model"); assert.deepEqual(st.backups.map((b) => b.model), ["backup-model"], "a backup must be complete and reachable over https (or on this machine)");
  const r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT, kind: "soap" }, A);
  assert.equal(r.status, 200); assert.equal(r.body.draft, "Drafted by the backup."); assert.equal(r.body.model, "backup-model"); assert.equal(r.body.backup, true);
  assert.equal(first.seen.length, 1); assert.equal(second.seen.length, 1);
  assert.equal(second.seen[0].auth, "Bearer second-key-not-real", "each service gets its own key, never another's"); assert.equal(first.seen[0].auth, "Bearer first-key-not-real");
  assert.equal(second.seen[0].body.model, "backup-model");
  assert.deepEqual(second.seen[0].body.messages, first.seen[0].body.messages, "the backup is sent the same de-identified text");
  const entry = ((await s.call("GET", "/api/admin/audit?action=scribe", undefined, A)).body.entries || []).find((e) => e.action === "scribe.draft");
  assert.equal(entry.meta.model, "backup-model"); assert.match(entry.meta.backup, /^127\.0\.0\.1/);
});

test("scribe backups: when no service can answer, each reason is given and nothing is saved", async (t) => {
  const first = await service(t, { status: 429, body: { error: { type: "exceeded_current_quota_error", message: "insufficient balance" } } });
  const second = await service(t, { status: 404, body: { error: { message: "This model is unavailable for free." } } });
  const s = await start({ scribe: { url: first.url, key: "k1", model: "first-model", fallbacks: [{ url: second.url, key: "k2", model: "backup-model" }] } });
  t.after(s.close);
  const r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, await s.adminToken());
  assert.equal(r.status, 502);
  assert.match(r.body.error, /no credit or allowance left/); assert.match(r.body.error, /Backup: .*does not offer the model "backup-model"/); assert.match(r.body.error, /Nothing was saved\.$/);
  assert.equal(first.seen.length, 1); assert.equal(second.seen.length, 1);
});
