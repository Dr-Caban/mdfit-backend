// AI scribe: drafts the patient-facing note from the clinician's rough notes, through any OpenAI-compatible service.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { redact, settingsFrom } = require("../lib/scribe");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scribe-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

// A stand-in for the model service: records what it was sent and answers like an OpenAI-compatible API
async function fakeModel(t, { status = 200, reply = "We worked on your right knee today.\n\nWhat to do before next time:\n- Heel slides, 2 sets of 10, twice a day" } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { role: "assistant", content: reply } }] } : { error: "nope" }));
    });
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  return { seen, cfg: { scribe: { url: `http://127.0.0.1:${srv.address().port}/v1/`, key: "test-key-not-real", model: "test-model" } } };
}

const VISIT = "Pat Doe came in for the right knee, 3 weeks after surgery. Pat's swelling is down. Did soft tissue work on the quad and heel slides. Home: heel slides 2x10 twice a day. Call 941-555-0100 or pat@example.com with questions.";

test("scribe is off until a model is connected", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  assert.equal((await s.call("GET", "/api/admin/scribe")).status, 401, "staff only");
  const off = (await s.call("GET", "/api/admin/scribe", undefined, A)).body;
  assert.deepEqual([off.enabled, off.model, off.host], [false, "", ""]);
  assert.ok(off.kinds.includes("soap") && off.kinds.includes("treatment-plan"));
  const r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, A);
  assert.equal(r.status, 503); assert.match(r.body.error, /not connected/);
});

test("scribe drafts a note; the patient's name, email and phone never leave the server; nothing is stored", async (t) => {
  const model = await fakeModel(t);
  const s = await start(model.cfg); t.after(s.close);
  const A = await s.adminToken();
  const pat = (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
  const st = (await s.call("GET", "/api/admin/scribe", undefined, A)).body;
  assert.equal(st.enabled, true); assert.equal(st.model, "test-model"); assert.equal(JSON.stringify(st).includes("test-key"), false, "the key is never sent to the browser");

  assert.equal((await s.call("POST", "/api/admin/scribe/draft", { clientId: pat.client.id, text: "too short" }, A)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/scribe/draft", { clientId: "nope", text: VISIT }, A)).status, 404);
  assert.equal(model.seen.length, 0, "nothing was sent for a refused request");

  const r = await s.call("POST", "/api/admin/scribe/draft", { clientId: pat.client.id, text: VISIT }, A);
  assert.equal(r.status, 200); assert.match(r.body.draft, /right knee/); assert.equal(r.body.model, "test-model"); assert.ok(r.body.removed >= 3);

  // what the model service received
  assert.equal(model.seen.length, 1);
  const sent = model.seen[0];
  assert.equal(sent.url, "/v1/chat/completions"); assert.equal(sent.auth, "Bearer test-key-not-real"); assert.equal(sent.body.model, "test-model");
  const wire = JSON.stringify(sent.body);
  for (const leak of ["Pat", "Doe", "pat@example.com", "941-555-0100", pat.client.id]) assert.equal(wire.includes(leak), false, `"${leak}" must not be sent`);
  assert.match(sent.body.messages[1].content, /the patient came in for the right knee/);
  assert.match(sent.body.messages[1].content, /the patient's swelling is down/);
  assert.match(sent.body.messages[0].content, /Use only what is in the text/);

  // a clinical template uses the clinician-facing instructions; an unknown kind is refused before anything is sent
  const soap = await s.call("POST", "/api/admin/scribe/draft", { clientId: pat.client.id, text: VISIT, kind: "soap" }, A);
  assert.equal(soap.status, 200); assert.equal(soap.body.kind, "soap");
  assert.match(model.seen[1].body.messages[0].content, /Subjective, Objective, Assessment, Plan/);
  assert.match(model.seen[1].body.messages[0].content, /Not recorded/);
  assert.equal((await s.call("POST", "/api/admin/scribe/draft", { text: VISIT, kind: "poem" }, A)).status, 400);
  assert.equal(model.seen.length, 2);

  // nothing about the visit is kept: not in the chart, not in any stored file, and the ledger holds no text
  assert.deepEqual((await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, A)).body.notes, []);
  const stored = fs.readdirSync(s.dataDir).map((f) => fs.readFileSync(path.join(s.dataDir, f), "utf8")).join("\n");
  assert.equal(/swelling|heel slides|soft tissue/i.test(stored), false, "neither the visit text nor the draft is stored");
  const log = (await s.call("GET", "/api/admin/audit?action=scribe", undefined, A)).body;
  const entry = (log.entries || log).find((e) => e.action === "scribe.draft");
  assert.ok(entry, "the ledger records that a draft was made");
  assert.equal(entry.subject, pat.client.id); assert.equal(entry.meta.model, "test-model"); assert.equal(entry.meta.chars, VISIT.length);
});

test("scribe: a failing model service is reported and nothing is saved", async (t) => {
  const model = await fakeModel(t, { status: 500 });
  const s = await start(model.cfg); t.after(s.close);
  const A = await s.adminToken();
  const r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, A);
  assert.equal(r.status, 502); assert.match(r.body.error, /Nothing was saved/);
});

// A stand-in AI service that answers each request with the next reply in a list
async function scripted(t, replies) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    req.resume(); req.on("end", () => {
      const r = replies[Math.min(seen.length, replies.length - 1)]; seen.push(1);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers || {}) });
      res.end(JSON.stringify(r.status === 200 ? { choices: [{ message: { content: "Drafted after a wait." } }] } : r.body || {}));
    });
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  return { seen, cfg: { scribe: { url: `http://127.0.0.1:${srv.address().port}/v1`, key: "test-key-not-real", model: "test-model" } } };
}

test("scribe: a momentary 'too many requests' is tried once more; a refusal says why in plain words", async (t) => {
  // rate limited, then fine: staff get the draft
  const busy = await scripted(t, [{ status: 429, body: { error: { type: "rate_limit_reached_error", message: "Too many requests" } } }, { status: 200 }]);
  let s = await start(busy.cfg); t.after(s.close);
  let r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, await s.adminToken());
  assert.equal(r.status, 200); assert.equal(r.body.draft, "Drafted after a wait."); assert.equal(busy.seen.length, 2);

  // no credit: not retried, and the reason is spelled out without leaking anything shaped like a key or an address
  const broke = await scripted(t, [{ status: 429, body: { error: { type: "exceeded_current_quota_error", message: "Account org-abc123def456 owner@example.com is suspended due to insufficient balance" } } }]);
  s = await start(broke.cfg); t.after(s.close);
  r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, await s.adminToken());
  assert.equal(r.status, 502); assert.equal(broke.seen.length, 1);
  assert.match(r.body.error, /no credit or allowance left/); assert.match(r.body.error, /insufficient balance/); assert.match(r.body.error, /Nothing was saved/);
  assert.doesNotMatch(r.body.error, /abc123|owner@example/);

  // still rate limited after the second try
  const slow = await scripted(t, [{ status: 429, body: { error: { message: "RPM limit reached" } } }]);
  s = await start(slow.cfg); t.after(s.close);
  r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, await s.adminToken());
  assert.equal(slow.seen.length, 2); assert.match(r.body.error, /over its rate limit/);

  // a key the service does not accept: say so, and never repeat what the service wrote back
  const bad = await scripted(t, [{ status: 401, body: { error: { message: "Incorrect API key provided: sk-live-0123456789" } } }]);
  s = await start(bad.cfg); t.after(s.close);
  r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, await s.adminToken());
  assert.match(r.body.error, /did not accept the key/); assert.doesNotMatch(r.body.error, /sk-live|0123456789/);
});

test("scribe: the model is chosen from what the key is offered, and the choice is kept", async (t) => {
  // a stand-in service that knows two models and refuses any other name the way the real ones do
  const asked = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      asked.push(req.url); res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "kimi-new" }, { id: "kimi-old" }, { id: "bad id <script>" }] }));
      const model = JSON.parse(b).model;
      if (!["kimi-new", "kimi-old"].includes(model)) { res.statusCode = 404; return res.end(JSON.stringify({ error: { type: "resource_not_found_error", message: `Not found the model ${model} or Permission denied` } })); }
      res.end(JSON.stringify({ choices: [{ message: { content: "Drafted by " + model } }] }));
    });
  }).listen(0);
  await new Promise((r) => srv.once("listening", r)); t.after(() => srv.close());
  const cfg = { scribe: { url: `http://127.0.0.1:${srv.address().port}/v1`, key: "test-key-not-real", model: "kimi-gone" } };
  const s = await start(cfg); t.after(s.close);
  const A = await s.adminToken();
  let r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, A);
  assert.equal(r.status, 502); assert.match(r.body.error, /does not offer the model "kimi-gone"/); assert.match(r.body.error, /Change model/);
  r = await s.call("GET", "/api/admin/scribe/models", undefined, A);
  assert.deepEqual(r.body.models, ["kimi-new", "kimi-old"], "only well-formed names are passed on"); assert.equal(r.body.current, "kimi-gone");
  assert.equal(JSON.stringify(r.body).includes("test-key-not-real"), false);
  assert.equal((await s.call("PUT", "/api/admin/scribe/model", { model: "made-up" }, A)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/scribe/model", { model: "kimi-new" })).status, 401);
  r = await s.call("PUT", "/api/admin/scribe/model", { model: "kimi-new" }, A);
  assert.equal(r.status, 200); assert.equal(r.body.model, "kimi-new");
  r = await s.call("POST", "/api/admin/scribe/draft", { text: VISIT }, A);
  assert.equal(r.status, 200); assert.equal(r.body.draft, "Drafted by kimi-new");
  const acts = ((await s.call("GET", "/api/admin/audit?action=scribe", undefined, A)).body.entries || []).map((e) => e.action);
  assert.ok(acts.includes("scribe.model"));
  // the choice outlives a restart: a second server on the same data uses it
  const s2 = await start({ ...cfg, dataDir: s.dataDir }); t.after(s2.close);
  assert.equal((await s2.call("GET", "/api/admin/scribe", undefined, await s2.adminToken())).body.model, "kimi-new");
});

test("scribe: only https services (or a model on this machine) can be connected; names are swapped whole", () => {
  assert.equal(settingsFrom({ scribe: { url: "http://api.example.com/v1", key: "k", model: "m" } }).enabled, false, "plain http to another host is refused");
  assert.equal(settingsFrom({ scribe: { url: "https://api.example.com/v1", key: "k", model: "m" } }).enabled, true);
  assert.equal(settingsFrom({ scribe: { url: "http://localhost:11434/v1", key: "k", model: "m" } }).enabled, true);
  assert.equal(settingsFrom({ scribe: { url: "https://api.example.com/v1", key: "", model: "m" } }).enabled, false);
  const r = redact("Pat did well. Patella tracking is fine and the patient's partner Patricia drove.", ["Pat Doe"]);
  assert.equal(r.text, "the patient did well. Patella tracking is fine and the patient's partner Patricia drove.");
});
