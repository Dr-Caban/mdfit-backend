// Medical record (owner, Nov 2026): members with complete documents wait to be converted; converting makes an active
// patient; chart notes and prescribed movements reach the patient (encrypted at rest, never in email); a paid video
// visit (Stripe service) waits in the record and is used up when Dr. Jared schedules the consult.
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

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-emr-"));
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
  return { call, adminToken, dataDir, base, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
let n = 0;
const signup = async (s, name = "Pat Doe") => (await s.call("POST", "/api/clients/signup", { name, email: `p${++n}@example.com`, phone: "941-555-0100", password: "pat-pass-123" })).body;
async function fillDocs(s, tok) {
  const save = (doc, body) => s.call("POST", `/api/me/intake/${doc}`, body, tok);
  assert.equal((await save("info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" })).status, 201);
  assert.equal((await save("pain", { complaint: "Left hip aches after runs", areas: ["Left hip"], started: "6 weeks to 3 months ago", painNow: 4, goals: "Run a 10k" })).status, 201);
  assert.equal((await save("history", { redFlags: "No" })).status, 201);
  assert.equal((await save("consent", { treatment: true, privacy: true, financial: true, signature: "Pat Doe" })).body.done, true);
}
const VIDEO = "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv";

test("record: waiting list from completed documents, conversion, chart notes and movements reach the patient", async (t) => {
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const pat = await signup(s), other = await signup(s, "Sam Lee");
  assert.equal((await s.call("GET", "/api/admin/emr")).status, 401, "owner only");
  let r = (await s.call("GET", "/api/admin/emr", undefined, adm)).body;
  assert.deepEqual(r, { patients: [], waiting: [] }, "nobody until documents are complete");
  await fillDocs(s, pat.token);
  r = (await s.call("GET", "/api/admin/emr", undefined, adm)).body;
  assert.equal(r.waiting.length, 1); assert.equal(r.waiting[0].id, pat.client.id); assert.equal(r.waiting[0].documents.complete, true); assert.equal(r.patients.length, 0);
  assert.ok(!r.waiting.some((x) => x.id === other.client.id), "a member without documents isn't in the record");
  // member side before conversion: nothing from Dr. Jared yet, but the video visits are offered
  let mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(mine.patient, false); assert.deepEqual(mine.notes, []); assert.deepEqual(mine.movements, []);
  assert.deepEqual(mine.services.map((x) => x.id), ["eval-remote", "followup-remote"]);
  // convert
  const cv = await s.call("PUT", `/api/admin/emr/${pat.client.id}/patient`, { active: true }, adm);
  assert.equal(cv.status, 200); assert.equal(cv.body.patient, true);
  r = (await s.call("GET", "/api/admin/emr", undefined, adm)).body;
  assert.equal(r.patients.length, 1); assert.equal(r.waiting.length, 0); assert.equal(r.patients[0].patient, true);
  // chart: a note and a movement
  assert.equal((await s.call("POST", `/api/admin/emr/${pat.client.id}/notes`, { text: "" }, adm)).status, 400);
  const note = await s.call("POST", `/api/admin/emr/${pat.client.id}/notes`, { text: "Great first session. Keep the hip hinge slow; 2 rounds today." }, adm);
  assert.equal(note.status, 201); assert.ok(note.body.id);
  assert.equal((await s.call("POST", `/api/admin/emr/${pat.client.id}/movements`, { videoId: "bad id!", name: "X" }, adm)).status, 400, "a movement must link to a library video");
  const mv = await s.call("POST", `/api/admin/emr/${pat.client.id}/movements`, { videoId: VIDEO, name: "Eccentric Calf Drops", dose: "3 x 12", cue: "Slow on the way down" }, adm);
  assert.equal(mv.status, 201);
  const detail = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  assert.equal(detail.notes.length, 1); assert.equal(detail.movements.length, 1); assert.equal(detail.movements[0].videoId, VIDEO); assert.equal(detail.patient, true);
  // the patient sees both
  mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(mine.patient, true); assert.equal(mine.notes[0].text, "Great first session. Keep the hip hinge slow; 2 rounds today.");
  assert.deepEqual(mine.movements.map((m) => [m.name, m.dose, m.videoId]), [["Eccentric Calf Drops", "3 x 12", VIDEO]]);
  // another member sees nothing of it
  const theirs = (await s.call("GET", "/api/me/chart", undefined, other.token)).body;
  assert.deepEqual(theirs.notes, []); assert.deepEqual(theirs.movements, []);
  // encrypted at rest
  assert.ok(!fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8").includes("hip hinge"), "chart text is never stored in the clear");
  // soft removal: gone from both views, never erased
  assert.equal((await s.call("DELETE", `/api/admin/emr/${pat.client.id}/notes/${note.body.id}`, undefined, adm)).status, 200);
  assert.equal((await s.call("DELETE", `/api/admin/emr/${pat.client.id}/notes/${note.body.id}`, undefined, adm)).status, 404);
  mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.deepEqual(mine.notes, []); assert.equal(mine.movements.length, 1);
  // audit trail has the views and changes
  const audit = (await s.call("GET", "/api/admin/audit", undefined, adm)).body;
  const acts = (audit.entries || audit.events || audit).map((e) => e.action);
  for (const a of ["emr.view", "emr.convert", "emr.note", "emr.movement", "emr.note_removed"]) assert.ok(acts.includes(a), `audit has ${a}`);
  // unconvert goes back to waiting (documents are still complete)
  await s.call("PUT", `/api/admin/emr/${pat.client.id}/patient`, { active: false }, adm);
  r = (await s.call("GET", "/api/admin/emr", undefined, adm)).body;
  assert.equal(r.patients.length, 0); assert.equal(r.waiting.length, 1);
});

test("record: a paid video visit (Stripe service) waits in the record and is used up when the consult is scheduled", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async (p) => (calls.push(p), { id: "cs_" + calls.length, url: "https://checkout.stripe.com/c/pay/cs_test" }) } }
  };
  const whsec = "whsec_test_secret";
  const s = await start({ stripeClient: fake, stripeWebhookSecret: whsec }); t.after(s.close);
  const adm = await s.adminToken();
  const pat = await signup(s);
  await fillDocs(s, pat.token);
  await s.call("PUT", `/api/admin/emr/${pat.client.id}/patient`, { active: true }, adm);
  const mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(mine.payOn, true);
  const svc = mine.services.find((x) => x.id === "eval-remote");
  const co = await s.call("POST", "/api/me/checkout/service", { service: "eval-remote" }, pat.token);
  assert.equal(co.status, 200); assert.ok(co.body.url);
  const sess = calls[0];
  assert.equal(sess.mode, "payment"); assert.equal(sess.metadata.kind, "service"); assert.equal(sess.metadata.service, "eval-remote");
  assert.equal(sess.line_items[0].price_data.unit_amount, Math.round(svc.rate * 100));
  // Stripe tells us it was paid
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_1", client_reference_id: pat.client.id, amount_total: svc.rate * 100, currency: "usd", created: 1762077600, metadata: sess.metadata } } });
  const header = real.webhooks.generateTestHeaderString({ payload, secret: whsec });
  const wh = await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  assert.equal(wh.status, 200);
  let d = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  assert.equal(d.paidVisits.length, 1); assert.equal(d.paidVisits[0].service, "eval-remote"); assert.equal(d.paidVisits[0].amount, svc.rate * 100);
  const list = (await s.call("GET", "/api/admin/emr", undefined, adm)).body;
  assert.equal(list.patients[0].paidVisits, 1);
  const seen = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(seen.paidVisits.length, 1); assert.equal(seen.paidVisits[0].sessionId, undefined, "Stripe ids stay server-side");
  // the same webhook twice changes nothing
  await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  d = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  assert.equal(d.paidVisits.length, 1, "idempotent");
  // Dr. Jared schedules the video visit: the paid visit is used and the appointment is marked paid
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: "https://meet.jit.si/mdfit-room" } }, adm);
  const ap = await s.call("POST", `/api/admin/clients/${pat.client.id}/consult`, { date: "2026-11-10", time: "10:00", minutes: 60, title: "Online evaluation" }, adm);
  assert.equal(ap.status, 201, JSON.stringify(ap.body)); assert.equal(ap.body.payment, "paid"); assert.equal(ap.body.paidService, "eval-remote");
  d = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  assert.equal(d.paidVisits.length, 0); assert.equal(d.visits.length, 1); assert.equal(d.visits[0].payment, "paid");
  const after = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(after.paidVisits.length, 0); assert.equal(after.visits.length, 1); assert.ok(after.visits[0].meetingLink);
});

test("record: a chart that cannot be opened is never saved over", async (t) => {
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const pat = (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
  await s.call("PUT", `/api/admin/emr/${pat.client.id}/patient`, { active: true }, adm);
  assert.equal((await s.call("POST", `/api/admin/emr/${pat.client.id}/notes`, { text: "First note" }, adm)).status, 201);
  // the stored chart is replaced by one sealed with a key this server does not have (as after a key change)
  const { cipher } = require("../lib/messages");
  const f = path.join(s.dataDir, "clients.json"), list = JSON.parse(fs.readFileSync(f, "utf8"));
  const foreign = cipher(["some-other-key-entirely"]).enc(JSON.stringify({ notes: [{ id: "n1", text: "Years of history", at: "2025-01-01T00:00:00.000Z" }], movements: [], events: [] }));
  list.find((c) => c.id === pat.client.id).chart = foreign;
  fs.writeFileSync(f, JSON.stringify(list));
  // it reads as empty rather than breaking the lists...
  assert.equal((await s.call("GET", "/api/admin/emr", undefined, adm)).status, 200);
  assert.deepEqual((await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body.notes, []);
  // ...but nothing may be written over it
  const w = await s.call("POST", `/api/admin/emr/${pat.client.id}/notes`, { text: "A new note" }, adm);
  assert.equal(w.status, 400); assert.match(w.body.error, /nothing was saved/);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).find((c) => c.id === pat.client.id).chart, foreign, "the stored chart is untouched");
});
