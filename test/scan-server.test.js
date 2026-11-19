// Fixes from the server / staff / content scan (Nov 2026). Each test here failed before its fix: a stalled download
// that took the process down, chart content reaching accounts that may not see it, programs lost on a partial content
// save, double bookings after a lapsed hold, member layouts that broke the app, staff sessions that outlived a
// password, settings put back at a restart, path checks that never matched, and loose content validation.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createApp } = require("../server");
const { hashPassword, signToken } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { defaultContent } = require("../lib/content");
const { idleAbort, meter } = require("../lib/idle");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;
delete process.env.BOARD_PASSCODE;

const OWNER = "coach@example.com", OWNER_PASS = "admin-pass-123", SECRET = "s".repeat(40);
const ROOM = "https://meet.jit.si/mdfit-room";

// dir: start again on the same data (a restart); seed: files written before the server starts
async function start(extra = {}, { dir, seed } = {}) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-"));
  for (const [k, v] of Object.entries(seed || {})) fs.writeFileSync(path.join(dataDir, k + ".json"), JSON.stringify(v));
  const app = createApp({
    adminEmail: OWNER, adminPasswordHash: hashPassword(OWNER_PASS), sessionSecret: SECRET,
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"),
    siteUrl: "https://mdfit.example.com", noVideoSync: true, noBackupSchedule: true, ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* not JSON (a CSV) */ }
    return { status: res.status, body: json, text };
  };
  const login = (email, password) => call("POST", "/api/admin/login", { email, password });
  const ownerToken = async () => (await login(OWNER, OWNER_PASS)).body.token;
  const makeStaff = async (over = {}) => {
    const body = { name: "Sam Office", email: "sam@example.com", role: "admin", password: "staff-pass-1234", ...over };
    const made = await call("POST", "/api/admin/staff", body, await ownerToken());
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { record: made.body.staff, token: (await login(body.email, body.password)).body.token, password: body.password, email: body.email };
  };
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const writeJson = (name, v) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(v));
  const stop = () => server.close();
  return { app, base, call, login, ownerToken, makeStaff, readJson, writeJson, dataDir, stop, close: () => { stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

let n = 0;
const signup = async (s, name = "Pat Doe", email = `scan${++n}@example.com`) => (await s.call("POST", "/api/clients/signup", { name, email, phone: "941-555-0100", password: "pat-pass-123" })).body;
// A booking from the public form (no account), in the first open time; returns what was booked
async function publicBooking(s, over = {}) {
  const av = (await s.call("GET", "/api/availability")).body, day = av.days.find((d) => d.slots.length);
  const area = (await s.call("GET", "/api/site")).body.options.areas[0];
  const body = { typeId: av.type.id, date: day.date, time: day.slots[0], name: "Vera Visitor", email: "vera@example.com", phone: "941-555-0111", areas: [area], painLevel: 8, notes: "post-op, on blood thinners", ...over };
  const r = await s.call("POST", "/api/appointments", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...body, id: r.body.appointment.id, slots: day.slots };
}
async function fakeResend() {
  const emails = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const m = JSON.parse(b); (Array.isArray(m) ? m : [m]).forEach((x) => emails.push(x));
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); });
  server.listen(0); await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, emails, close: () => server.close() };
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
// Log lines written while fn runs (the logger is silent in tests otherwise)
async function logged(fn) {
  const lines = [], sink = logger.sink;
  logger.level = 20; logger.sink = (l) => lines.push(l);
  try { await fn(lines); await new Promise((r) => setTimeout(r, 100)); } finally { logger.level = 99; logger.sink = sink; }
  return lines;
}

// ---------------------------------------------------------------- 1. lib/idle.js

test("idle watchdog: a download that stalls fails its own transfer and nothing is left unhandled", async (t) => {
  // sends a little and then goes silent with the socket open, as Drive does
  const src = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write(Buffer.alloc(64 * 1024, 1)); });
  src.listen(0); await new Promise((r) => src.once("listening", r));
  t.after(() => { src.closeAllConnections(); src.close(); });
  const dest = path.join(os.tmpdir(), `mdfit-scan-idle-${process.pid}`);
  t.after(() => fs.rmSync(dest, { force: true }));
  const w = idleAbort(150, 10000), t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${src.address().port}/`, { signal: w.signal });
  // the same shape as the copy in lib/videos.js: the fetched body, metered, piped to a file
  await assert.rejects(() => pipeline(meter(Readable.fromWeb(r.body), w), fs.createWriteStream(dest)), /stalled/, "the transfer itself fails");
  w.stop();
  assert.ok(Date.now() - t0 < 5000, "on the idle window, long before the ceiling");
});

// ---------------------------------------------------------------- 2 and 9. lib/export.js

test("export: full records need the charts permission; without it the spreadsheet leaves the chart columns empty", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await signup(s);
  await s.call("PUT", `/api/admin/emr/${pat.client.id}/summary`, { summary: "Runner with hip pain.", tags: ["Runner"] }, A);
  await s.call("POST", `/api/admin/emr/${pat.client.id}/allergies`, { name: "Penicillin" }, A);
  await s.call("POST", "/api/admin/notes", { clientId: pat.client.id, template: "soap", text: "S: standard note text." }, A);
  const office = await s.makeStaff(); // Administrator: holds "security" (exports) and not "charts"
  assert.ok(office.record.permissions.includes("security")); assert.equal(office.record.permissions.includes("charts"), false);

  const rec = await s.call("POST", "/api/admin/export/clients", { kind: "records", all: true }, office.token);
  assert.equal(rec.status, 403, "the export permission alone does not open charts");
  assert.equal(rec.body.need, "charts");
  assert.equal(/Runner with hip pain|Penicillin|standard note text/.test(rec.text), false);
  const one = await s.call("POST", "/api/admin/export/clients", { kind: "records", ids: [pat.client.id] }, office.token);
  assert.equal(one.status, 403, "nor for one chosen client");

  // The spreadsheet still downloads, with contact details and without what comes from the chart
  const csv = await s.call("POST", "/api/admin/export/clients", { kind: "csv", all: true }, office.token);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Pat Doe/);
  assert.equal(/Runner|Penicillin/.test(csv.text), false, "tags and alerts are chart content");

  // Someone who holds charts as well, and the owner, get everything as before
  const clin = await s.makeStaff({ email: "cara@example.com", role: "clinician", permissions: ["charts", "clients", "security"] });
  const full = await s.call("POST", "/api/admin/export/clients", { kind: "records", all: true }, clin.token);
  assert.equal(full.status, 200); assert.equal(full.body.clients[0].chart.careSummary, "Runner with hip pain.");
  const own = await s.call("POST", "/api/admin/export/clients", { kind: "csv", all: true }, A);
  assert.match(own.text, /Runner/); assert.match(own.text, /Penicillin/);
});

test("export: a visit booked under an email belongs to an account only once that address is proven", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken();
  const visit = await publicBooking(s); // the real person, from the public form
  const other = await signup(s, "Mallory", "vera@example.com"); // someone else opens an account under that address
  const rec = async () => (await s.call("POST", "/api/admin/export/clients", { kind: "records", ids: [other.client.id] }, A)).body.clients[0];
  assert.deepEqual((await rec()).appointments, [], "an unproven address claims nobody's visits");
  const csv = (await s.call("POST", "/api/admin/export/clients", { kind: "csv", ids: [other.client.id] }, A)).text;
  assert.equal(csv.includes(visit.date), false, "nor in the spreadsheet's next visit");
  // Once the address is proven the visit is theirs
  const list = s.readJson("clients"); list.find((c) => c.id === other.client.id).emailVerifiedAt = "2026-11-02T10:00:00.000Z"; s.writeJson("clients", list);
  const mine = (await rec()).appointments;
  assert.equal(mine.length, 1); assert.equal(mine[0].date, visit.date); assert.equal(mine[0].painLevel, 8);
});

// ---------------------------------------------------------------- 3. Manager and Developer: counts, never people

test("manager and developer: insights and settings give them the counts and nothing that names a person", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken();
  await publicBooking(s, { name: "Pat Doe", email: "pat@example.com", notes: "herniated disc" });
  const mgr = await s.makeStaff({ name: "Josh Lerner", email: "josh@example.com", role: "manager", permissions: ["partner", "content", "insights", "settings"] });
  const dev = await s.makeStaff({ name: "Dev Person", email: "dev@example.com", role: "developer", permissions: ["content", "insights", "settings"] });
  for (const who of [mgr, dev]) {
    const st = await s.call("GET", "/api/admin/stats", undefined, who.token);
    assert.equal(st.status, 200, "the numbers still answer");
    assert.equal(st.body.appointmentsWeek, 1); assert.equal(st.body.subscribers, 0);
    assert.deepEqual(st.body.nextAppointments, []); assert.deepEqual(st.body.today, []);
    assert.equal(/pat@example\.com|Pat Doe|herniated|941-555/.test(st.text), false, `${who.email}: no patient in /stats`);
    const act = await s.call("GET", "/api/admin/activity", undefined, who.token);
    assert.equal(act.status, 200); assert.ok(act.body.some((e) => e.type === "appointment"), "what happened, and when");
    for (const e of act.body) assert.deepEqual(Object.keys(e).sort(), ["time", "type"]);
    assert.equal(/@example\.com/.test(act.text), false, `${who.email}: no addresses in /activity`);
    assert.deepEqual((await s.call("GET", "/api/admin/online", undefined, who.token)).body.members, []);
    assert.deepEqual((await s.call("GET", "/api/admin/email-log", undefined, who.token)).body.failures, []);
    const push = await s.call("POST", "/api/admin/devices", { token: "a".repeat(64), platform: "ios" }, who.token);
    assert.equal(push.status, 403, `${who.email}: no practice notifications`);
  }
  assert.equal(fs.existsSync(path.join(s.dataDir, "devices.json")) ? s.readJson("devices").length : 0, 0, "no device was registered");
  // An Administrator, who may see patients, is answered as before
  const office = await s.makeStaff({ email: "office@example.com", role: "admin" });
  const st = await s.call("GET", "/api/admin/stats", undefined, office.token);
  assert.equal(st.body.nextAppointments.length, 1); assert.equal(st.body.nextAppointments[0].email, "pat@example.com");
  assert.ok((await s.call("GET", "/api/admin/activity", undefined, office.token)).body.some((e) => e.email === "pat@example.com"));
  assert.equal((await s.call("POST", "/api/admin/devices", { token: "b".repeat(64), platform: "ios" }, office.token)).status, 200);
  assert.equal((await s.call("GET", "/api/admin/stats", undefined, A)).body.nextAppointments.length, 1);
});

// ---------------------------------------------------------------- 4. A content save without programs

test("content: a save that does not include programs never changes which programs exist", async (t) => {
  const d = defaultContent(), all = d.programs.length;
  // Programs saved when only three were built in; the rest have been added to the app since
  const first3 = d.programs.slice(0, 3);
  let s = await start({}, { seed: { content: { programs: first3, contentVersion: 5, knownDefaults: first3.map((p) => p.id) } } });
  let A = await s.ownerToken();
  const count = async () => (await s.call("GET", "/api/content")).body.programs.length;
  assert.equal(await count(), all, "the newer built-in programs show");
  for (const patch of [{ home: { sections: [] } }, { tiers: d.tiers }, { lectures: d.lectures }, { tracks: [] }]) {
    assert.equal((await s.call("PUT", "/api/admin/content", patch, A)).status, 200);
    assert.equal(await count(), all, `still all of them after saving ${Object.keys(patch)[0]}`);
  }
  // Saving the programs themselves is the owner's say on the list, as before: one removed stays removed
  const mine = (await s.call("GET", "/api/admin/content", undefined, A)).body.programs.filter((p) => p.id !== "golf");
  assert.equal((await s.call("PUT", "/api/admin/content", { programs: mine }, A)).status, 200);
  assert.equal(await count(), all - 1);
  s.close();

  // A stale list from before the programs were refreshed is still on disk; the built-in ones are what members see
  s = await start({}, { seed: { content: { programs: [{ ...d.programs[0], id: "old-stale", title: "Old stale program" }], contentVersion: 4 } } });
  t.after(s.close); A = await s.ownerToken();
  const ids = async () => (await s.call("GET", "/api/content")).body.programs.map((p) => p.id);
  assert.equal((await ids()).includes("old-stale"), false);
  assert.equal((await s.call("PUT", "/api/admin/content", { home: { sections: [] } }, A)).status, 200);
  assert.equal((await ids()).includes("old-stale"), false, "saving the Home layout does not bring the stale list back");
  assert.equal((await ids()).length, all);
});

// ---------------------------------------------------------------- 5. Holds, late payments and the consult check

function fakeStripe() {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  return { calls, real, client: { webhooks: real.webhooks, customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async (p) => (calls.push(p), { id: "cs_" + calls.length, url: "https://checkout.stripe.com/c/pay/cs_test" }) } } } };
}
async function fillDocs(s, tok, name = "Pat Doe") {
  const save = (doc, body) => s.call("POST", `/api/me/intake/${doc}`, body, tok);
  await save("info", { name, dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" });
  await save("pain", { complaint: "Left hip aches after runs", areas: ["Left hip"], started: "6 weeks to 3 months ago", painNow: 4, goals: "Run a 10k" });
  await save("history", { redFlags: "No" });
  await save("consent", { treatment: true, privacy: true, financial: true, signature: name });
}
const paidWebhook = async (s, fake, { clientId, metadata, amount }) => {
  const payload = JSON.stringify({ id: "evt_" + Math.random().toString(16).slice(2), type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_1", client_reference_id: clientId, amount_total: amount, currency: "usd", created: 1762077600, metadata } } });
  const header = fake.real.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
  return (await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload })).status;
};

test("visits: the hold outlasts the checkout, and a payment that arrives after the time has gone never books over it", async (t) => {
  const fake = fakeStripe(), mail = await fakeResend();
  const s = await start({ stripeClient: fake.client, stripeWebhookSecret: "whsec_test_secret", resendKey: "k", notifyFrom: "x@example.com", notifyEmail: "owner@example.com", resendUrl: mail.url, notifyGapMs: 0 });
  t.after(() => { s.close(); mail.close(); });
  const adm = await s.ownerToken();
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: ROOM } }, adm);
  const pat = await signup(s); await fillDocs(s, pat.token);
  const open = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  const day = open.days.find((x) => x.slots.length), pick = { date: day.date, time: day.slots[0] };
  const sch = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", ...pick }, pat.token);
  assert.equal(sch.status, 200, JSON.stringify(sch.body)); assert.equal(sch.body.booked, false);
  const checkoutMs = fake.calls[0].expires_at * 1000 - Date.now();
  const held = s.readJson("appointments").find((a) => a.id === sch.body.holdId);
  assert.equal(held.status, "hold");
  assert.ok(Date.parse(held.holdUntil) - Date.now() > checkoutMs, "the time stays held for longer than the checkout can stay open");

  // Stripe's notice is late: the hold has run out, and someone else has booked the time meanwhile
  const list = s.readJson("appointments"); list.find((a) => a.id === held.id).holdUntil = new Date(Date.now() - 60e3).toISOString(); s.writeJson("appointments", list);
  const av = (await s.call("GET", "/api/availability")).body;
  assert.ok(av.days.find((d) => d.date === pick.date).slots.includes(pick.time), "a lapsed hold frees the time");
  const lee = await publicBooking(s, { name: "Lee Roe", email: "lee@example.com", date: pick.date, time: pick.time });
  assert.equal(await paidWebhook(s, fake, { clientId: pat.client.id, metadata: fake.calls[0].metadata, amount: 15000 }), 200);

  const appts = (await s.call("GET", "/api/admin/appointments?all=1", undefined, adm)).body.filter((a) => a.date === pick.date && a.time === pick.time);
  assert.deepEqual(appts.filter((a) => a.status === "booked").map((a) => a.id), [lee.id], "one visit at that time, the one that was there first");
  const set = appts.find((a) => a.id === held.id);
  assert.equal(set.status, "cancelled"); assert.equal(set.payment, "paid"); assert.equal(set.slotLost, true);
  assert.match(set.adminNotes, /time was taken/i); assert.match(set.adminNotes, /nothing was refunded/i);
  // The payment is kept, as a paid visit waiting for a time; nothing went back to the card
  const chart = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(chart.visits.length, 0); assert.equal(chart.paidVisits.length, 1, "the payment is on their record");
  assert.equal(fake.calls.length, 1, "Stripe was asked for one checkout and nothing else");
  const alert = await until(() => mail.emails.find((e) => /Paid, but the time was taken/.test(e.subject)));
  assert.ok(alert, "the owner is told"); assert.ok([].concat(alert.to).includes("owner@example.com"));
  assert.match(alert.text, /Pat Doe/); assert.match(alert.text, /nothing was refunded/i);
  // The same notice again changes nothing
  assert.equal(await paidWebhook(s, fake, { clientId: pat.client.id, metadata: fake.calls[0].metadata, amount: 15000 }), 200);
  assert.equal((await s.call("GET", "/api/me/chart", undefined, pat.token)).body.paidVisits.length, 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mail.emails.filter((e) => /Paid, but the time was taken/.test(e.subject)).length, 1);
});

test("consult: a time a patient is paying for is taken, and impossible dates and times are refused", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await signup(s), lee = await signup(s, "Lee Roe");
  const av = (await s.call("GET", "/api/availability")).body, day = av.days.find((d) => d.slots.length), time = day.slots[day.slots.length - 1];
  const hold = { id: "livehold0001", typeId: "eval-remote", typeName: "Video evaluation", minutes: 60, date: day.date, time, name: "Pat Doe", email: pat.client.email, phone: "", notes: "", areas: [], painLevel: null,
    status: "hold", adminNotes: "", cancelToken: "x".repeat(32), createdAt: new Date().toISOString(), source: "patient", clientId: pat.client.id, meetingLink: ROOM, payment: "due", holdUntil: new Date(Date.now() + 15 * 60e3).toISOString() };
  s.writeJson("appointments", [hold]);
  const consult = (body) => s.call("POST", `/api/admin/clients/${lee.client.id}/consult`, { minutes: 30, ...body }, A);
  const over = await consult({ date: day.date, time });
  assert.equal(over.status, 409, "a live hold blocks the time"); assert.match(over.body.error, /paying/);
  // once the hold has run out the time is free again
  s.writeJson("appointments", [{ ...hold, holdUntil: new Date(Date.now() - 60e3).toISOString() }]);
  assert.equal((await consult({ date: day.date, time })).status, 201);
  // dates and times that do not exist
  for (const bad of [{ date: "2026-11-31", time: "09:00" }, { date: "2026-13-01", time: "09:00" }, { date: day.date, time: "25:99" }, { date: day.date, time: "24:00" }]) {
    const r = await consult({ ...bad, force: true });
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body.error, /date and time/);
  }
  assert.equal(s.readJson("appointments").some((a) => a.date === "2026-11-31" || a.time === "25:99"), false);
  // and a date that is not one is no longer a server error on the calendar reads
  assert.equal((await s.call("GET", "/api/availability?from=2026-13-45")).status, 200);
  assert.equal((await s.call("GET", "/api/admin/busy?from=2026-13-45", undefined, A)).status, 200);
});

// ---------------------------------------------------------------- 6. Member layouts

test("member layout: a card the app no longer has is dropped on reading, never an error", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s);
  // saved by the app when "today" was still a Home card
  const list = s.readJson("clients");
  list[0].layout = { home: { sections: [{ id: "plans", state: "folded" }, { id: "today", state: "open" }, { id: "gem", state: "open" }] } };
  s.writeJson("clients", list);
  const c = await s.call("GET", "/api/me/content", undefined, pat.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const ids = c.body.myLayout.home.sections.map((x) => x.id);
  assert.equal(ids.includes("today"), false); assert.ok(ids.indexOf("plans") < ids.indexOf("gem"), "their own order is kept");
  assert.equal(ids.length, c.body.home.sections.length, "with the rest of today's cards");
  const p = await s.call("PUT", "/api/me/layout", { profile: { sections: [{ id: "care", state: "open" }] } }, pat.token);
  assert.equal(p.status, 200, "saving the other page works too"); assert.ok(p.body.myLayout.home && p.body.myLayout.profile);
  // what a member sends is still checked
  assert.equal((await s.call("PUT", "/api/me/layout", { home: { sections: [{ id: "today", state: "open" }] } }, pat.token)).status, 400);
});

test("member layout: a card the owner hid stays hidden, and the owner showing it again reaches the member", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await signup(s);
  const all = (await s.call("GET", "/api/admin/content", undefined, A)).body.home.sections;
  const ownerSave = (hide) => s.call("PUT", "/api/admin/content", { home: { sections: all.map((x) => ({ id: x.id, state: x.id === "habits" && hide ? "hidden" : x.state })) } }, A);
  await ownerSave(true);
  const habits = (r) => r.body.myLayout.home.sections.find((x) => x.id === "habits");
  // a list that does not mention the hidden card
  const part = await s.call("PUT", "/api/me/layout", { home: { sections: [{ id: "gem", state: "open" }] } }, pat.token);
  assert.deepEqual(habits(part), { id: "habits", state: "hidden", show: false }, "hidden by the owner whether or not the member's list names it");
  assert.equal(habits(await s.call("GET", "/api/me/content", undefined, pat.token)).state, "hidden");
  // a full list asking for it open: still hidden, but that is the owner's doing and is not written into the member's record
  const full = await s.call("PUT", "/api/me/layout", { home: { sections: all.map((x) => ({ id: x.id, state: "open" })) } }, pat.token);
  assert.equal(habits(full).state, "hidden");
  assert.equal(s.readJson("clients")[0].layout.home.sections.find((x) => x.id === "habits").state, "open", "the member's own choice is what is kept");
  await ownerSave(false);
  assert.equal(habits(await s.call("GET", "/api/me/content", undefined, pat.token)).state, "open", "shown again by the owner, it is back for the member");
  // "care" can be folded by a member, never hidden
  const care = await s.call("PUT", "/api/me/layout", { home: { sections: [{ id: "care", state: "hidden" }] } }, pat.token);
  assert.equal(care.body.myLayout.home.sections.find((x) => x.id === "care").state, "folded");
});

// ---------------------------------------------------------------- 7 and 8. lib/staff.js

test("staff: switching an account back on is held to the same rule as granting what it holds", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken();
  const clin = await s.makeStaff({ name: "Cara Clinician", email: "cara@example.com", role: "clinician" });
  const desk = await s.makeStaff({ name: "Dee Desk", email: "dee@example.com", role: "frontdesk" });
  const office = await s.makeStaff(); // Administrator: manages staff, holds no charts
  for (const who of [clin, desk]) assert.equal((await s.call("DELETE", `/api/admin/staff/${who.record.id}`, undefined, A)).status, 200);
  const on = await s.call("PUT", `/api/admin/staff/${clin.record.id}`, { active: true }, office.token);
  assert.equal(on.status, 403, "an Administrator cannot bring back an account that holds charts"); assert.equal(on.body.need, "charts");
  assert.equal(s.readJson("staff").find((x) => x.id === clin.record.id).active, false);
  assert.equal((await s.login(clin.email, clin.password)).status, 401);
  // an account that holds nothing more than they do, they can; and the owner can switch anyone on
  assert.equal((await s.call("PUT", `/api/admin/staff/${desk.record.id}`, { active: true }, office.token)).status, 200);
  assert.equal((await s.call("PUT", `/api/admin/staff/${clin.record.id}`, { active: true }, A)).status, 200);
  assert.equal((await s.login(clin.email, clin.password)).status, 200);
});

test("staff sessions end when the password changes; a token from before this rule works until then", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), st = await s.makeStaff({ role: "frontdesk" });
  const me = (tok) => s.call("GET", "/api/admin/me", undefined, tok);
  // A session opened before tokens carried a password version: no "pwv" in it
  const old = signToken({ sub: st.email, role: "staff", exp: Date.now() + 3600e3 }, SECRET);
  assert.equal((await me(old)).status, 200, "nobody is signed out by the update itself");
  assert.equal((await me(st.token)).status, 200);

  // The owner resets the password: every session under the old one stops at once
  const reset = await s.call("POST", `/api/admin/staff/${st.record.id}/password`, { password: "brand-new-pass-99" }, A);
  assert.equal(reset.status, 200); assert.equal("pwv" in reset.body.staff, false, "the version is not part of what a screen is sent");
  assert.equal((await me(st.token)).status, 401); assert.equal((await me(old)).status, 401);
  const again = (await s.login(st.email, "brand-new-pass-99")).body.token;
  assert.equal((await me(again)).status, 200);

  // Changing their own password: this session carries on with the token in the answer, the others stop
  const other = (await s.login(st.email, "brand-new-pass-99")).body.token;
  const ch = await s.call("POST", "/api/admin/me/password", { current: "brand-new-pass-99", password: "my-own-pass-2026" }, again);
  assert.equal(ch.status, 200); assert.ok(ch.body.token); assert.ok(ch.body.expiresAt);
  assert.equal((await me(ch.body.token)).status, 200);
  assert.equal((await me(again)).status, 401); assert.equal((await me(other)).status, 401);
  assert.equal((await me(A)).status, 200, "the owner's session is its own");
});

// ---------------------------------------------------------------- 10. Settings on a new store

test("settings: the first save on a new store is still there after a restart", async (t) => {
  let s = await start();
  t.after(() => fs.rmSync(s.dataDir, { recursive: true, force: true }));
  let A = await s.ownerToken();
  const d = (await s.call("GET", "/api/admin/settings", undefined, A)).body;
  const hours = d.scheduling.hours.map((h, i) => (i === 1 ? [["13:00", "15:00"]] : h));
  const types = d.appointmentTypes.map((x, i) => (i === 0 ? { ...x, name: "Owner Renamed Visit", minutes: 45 } : x));
  const put = await s.call("PUT", "/api/admin/settings", { scheduling: { hours, minNoticeHours: 48 }, coach: { title: "The owner's own title" }, appointmentTypes: types }, A);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  s.stop();
  s = await start({}, { dir: s.dataDir }); t.after(s.stop); A = await s.ownerToken();
  const after = (await s.call("GET", "/api/admin/settings", undefined, A)).body;
  assert.deepEqual(after.scheduling.hours[1], [["13:00", "15:00"]]); assert.equal(after.scheduling.minNoticeHours, 48);
  assert.equal(after.coach.title, "The owner's own title");
  assert.equal(after.appointmentTypes[0].name, "Owner Renamed Visit"); assert.equal(after.appointmentTypes[0].minutes, 45);
});

// ---------------------------------------------------------------- 11. Paths as the server really sees them

test("logs: heartbeats stay out of the activity log, emails and device tokens out of the request log, names out of activity lines", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await signup(s);
  const device = "ab".repeat(32);
  await s.call("POST", "/api/subscribe", { email: "someone@example.com" });
  const lines = await logged(async () => {
    assert.equal((await s.call("POST", "/api/me/presence", { seconds: 0, view: "home" }, pat.token)).status, 200);
    assert.equal((await s.call("GET", "/api/me/messages/unread-count", undefined, pat.token)).status, 200);
    assert.equal((await s.call("GET", "/api/me/content", undefined, pat.token)).status, 200);
    assert.equal((await s.call("POST", "/api/me/devices", { token: device, platform: "ios" }, pat.token)).status, 200);
    assert.equal((await s.call("DELETE", "/api/me/devices/" + device, undefined, pat.token)).status, 200);
    assert.equal((await s.call("DELETE", "/api/admin/devices/" + device, undefined, A)).status, 200);
    assert.equal((await s.call("DELETE", "/api/admin/subscribers/someone%40example.com", undefined, A)).status, 200);
    assert.equal((await s.call("POST", "/api/me/membership/request", { tier: "member" }, pat.token)).status, 201);
    assert.equal((await s.call("POST", "/api/me/membership/request", { tier: "premium" }, pat.token)).status, 201);
  });
  const requests = lines.filter((l) => l.includes('"msg":"request"')).join("\n");
  assert.match(requests, /"path":"\/subscribers\/\[hidden\]"/); assert.match(requests, /"path":"\/devices\/\[hidden\]"/);
  assert.equal(/someone|example\.com/.test(requests), false, "no address in the request log");
  assert.equal(requests.includes(device), false, "no device token in the request log");
  // the activity line says what happened, with the address masked and no name; the owner's own feed keeps the name
  const act = lines.filter((l) => l.includes('"msg":"activity"') && l.includes("membership_request"));
  assert.equal(act.length, 2); assert.equal(/Pat|Doe/.test(act.join("\n")), false, "no member's name in a log line");
  assert.equal((await s.call("GET", "/api/admin/activity", undefined, A)).body.find((e) => e.type === "membership_request").name, "Pat Doe");
  // what was kept on the volume for that day
  const kept = (await s.call("GET", "/api/admin/logs?date=2026-11-02&limit=5000", undefined, A)).body.entries.filter((e) => e.msg === "request");
  assert.ok(kept.some((e) => e.path === "/content"), "ordinary requests are kept");
  assert.deepEqual(kept.filter((e) => /presence|unread-count/.test(e.path)).map((e) => e.path), [], "the once-a-minute heartbeats are not");
});

test("rate limit: the health check and the signed webhooks are exempt; everything else is still limited", async (t) => {
  const s = await start({ calWebhookSecret: "cal-secret-for-test" }); t.after(s.close);
  const many = async (method, url, body) => { const seen = new Set(); for (let i = 0; i < 130; i++) seen.add((await s.call(method, url, body)).status); return [...seen]; };
  assert.deepEqual(await many("GET", "/api/health"), [200]);
  assert.deepEqual(await many("POST", "/api/cal/webhook", { triggerEvent: "PING" }), [401], "refused for its signature every time, never for the rate");
  assert.equal((await many("POST", "/api/stripe/webhook", {})).includes(429), false);
  // 390 exempt calls later the ordinary allowance (120 in 10 seconds for a visitor) is untouched, and still enforced
  const site = await many("GET", "/api/schedule");
  assert.deepEqual(site.sort(), [200, 429]);
});

// ---------------------------------------------------------------- 12. Content validation

test("content: $20 and $30 prices stick, empty tiers are refused, and bad items, dates and counts are a 400", async (t) => {
  // tiers saved before the owner's prices moved to $19.95 / $29.95 still read at the new prices
  const d = defaultContent(), round = d.tiers.map((x) => (x.id === "member" ? { ...x, price: 20 } : x.id === "accountability" ? { ...x, price: 30 } : x));
  const s = await start({}, { seed: { content: { tiers: round } } }); t.after(s.close);
  const A = await s.ownerToken();
  const put = (patch) => s.call("PUT", "/api/admin/content", patch, A);
  const prices = async () => Object.fromEntries((await s.call("GET", "/api/content")).body.tiers.map((x) => [x.id, x.price]));
  assert.equal((await prices()).member, 19.95); assert.equal((await prices()).accountability, 29.95);
  // the owner sets them to $20 and $30 on purpose: kept
  const saved = await put({ tiers: round });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.tiers.find((x) => x.id === "member").price, 20);
  assert.equal((await prices()).member, 20); assert.equal((await prices()).accountability, 30);
  // an empty list used to bring the built-in tiers and prices back without a word
  const none = await put({ tiers: [] });
  assert.equal(none.status, 400); assert.match(none.body.error, /at least one/);
  assert.equal((await prices()).member, 20);

  // how many suggestions show: a number, not whatever a blank field turns into
  for (const v of [null, "", false, true, [7], "five", -1, 2.5]) {
    const r = await put({ home: { sections: [], suggestions: v } });
    assert.equal(r.status, 400, JSON.stringify(v)); assert.match(r.body.error, /0 to 20/);
  }
  assert.equal((await put({ home: { sections: [], suggestions: 4 } })).body.home.suggestions, 4);
  assert.equal((await put({ home: { sections: [], suggestions: "5" } })).body.home.suggestions, 5);
  assert.equal((await put({ home: { sections: [] } })).body.home.suggestions, 3, "left out, it is the default");

  // an empty item in a list is "missing", not a server error
  const c = (await s.call("GET", "/api/admin/content", undefined, A)).body;
  const track = { id: "a", title: "T", region: "r", pts: ["x"], levels: [{ title: "L", videos: [{ name: "V", id: "" }] }] };
  for (const patch of [{ lectures: [null] }, { tiers: [null] }, { events: [null] }, { recommendations: [null] }, { programs: [{ ...c.programs[0], days: [null] }] },
    { programs: [{ ...c.programs[0], days: [{ ...c.programs[0].days[0], circuit: [null] }] }] }, { live: { recordings: [null] } },
    { tracks: [{ ...track, levels: [null] }] }, { tracks: [{ ...track, levels: [{ title: "L", videos: [null] }] }] },
    { recommendations: [{ ...c.recommendations[0], sections: [{ type: "groups", groups: [null] }] }] }]) {
    const r = await put(patch);
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 80)); assert.match(r.body.error, /missing/);
  }
  // dates and times that exist
  const ev = (date) => put({ events: [{ id: "e1", title: "Talk", date, link: "" }] });
  for (const bad of ["not-a-date", "2026-02-30", "2026-13-01"]) { const r = await ev(bad); assert.equal(r.status, 400, bad); assert.match(r.body.error, /real date/); }
  assert.equal((await ev("2026-12-05")).status, 200);
  assert.equal((await put({ live: { date: "2026-11-31" } })).status, 400);
  assert.equal((await put({ live: { time: "25:99" } })).status, 400);
  assert.equal((await put({ live: { date: "2026-11-30", time: "18:30" } })).status, 200);
  assert.equal((await put({ live: { date: "" } })).status, 200, "no date set is fine");
  // everything the app ships with still saves as it is
  for (const k of ["programs", "lectures", "recommendations", "events", "tracks"]) assert.equal((await put({ [k]: d[k] })).status, 200, k);
});

// ---------------------------------------------------------------- Low: board sessions, search signals

test("board: changing the passcode ends every session opened with the old one", async (t) => {
  let s = await start({ boardPasscode: "424242" });
  t.after(() => fs.rmSync(s.dataDir, { recursive: true, force: true }));
  const tok = (await s.call("POST", "/api/board/enter", { code: "424242" })).body.token;
  assert.equal((await s.call("GET", "/api/board?who=jared", undefined, tok)).status, 200);
  const payload = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString());
  assert.equal(JSON.stringify(payload).includes("424242"), false, "the token does not carry the passcode");
  s.stop();
  // a restart with the same passcode keeps the session
  s = await start({ boardPasscode: "424242" }, { dir: s.dataDir });
  assert.equal((await s.call("GET", "/api/board?who=jared", undefined, tok)).status, 200);
  s.stop();
  // the passcode is changed (it leaked): the old session is over, a new one opens with the new passcode
  s = await start({ boardPasscode: "777777" }, { dir: s.dataDir }); t.after(s.stop);
  assert.equal((await s.call("GET", "/api/board?who=jared", undefined, tok)).status, 401);
  assert.equal((await s.call("POST", "/api/board/enter", { code: "424242" })).status, 401);
  const fresh = (await s.call("POST", "/api/board/enter", { code: "777777" })).body.token;
  assert.equal((await s.call("GET", "/api/board?who=jared", undefined, fresh)).status, 200);
});

test("search signals: no visitor's words in the public answer, and one visitor is one vote", async (t) => {
  const s = await start(); t.after(s.close);
  const log = (body) => s.call("POST", "/api/search/log", body);
  const q = "my private hip thing";
  await log({ type: "query", q, resultCount: 5 });
  await log({ type: "click", q, id: "cond:honest", position: 0 });
  // the same address pushes another result forty times
  for (let i = 0; i < 40; i++) await log({ type: "click", q, id: "cond:pushed", position: 0 });
  const sig = await s.call("GET", "/api/search/signals");
  assert.equal(sig.status, 200);
  assert.equal(/private|hip thing/.test(sig.text), false, "what was typed is not handed out");
  const qh = crypto.createHash("sha256").update(q).digest("hex").slice(0, 10);
  assert.equal(sig.body.keys, "sha256-10");
  assert.deepEqual(Object.keys(sig.body.boost).sort(), [`${qh}|cond:honest`, `${qh}|cond:pushed`], "keyed by the query's fingerprint and the result");
  assert.equal(sig.body.boost[`${qh}|cond:pushed`], sig.body.boost[`${qh}|cond:honest`], "forty clicks from one address count as one");
  // the owner's analytics still has every event
  const A = await s.ownerToken();
  const row = (await s.call("GET", "/api/admin/search-analytics?days=1", undefined, A)).body.top.find((x) => x.q === q);
  assert.equal(row.topDoc, "cond:pushed"); assert.equal(row.topDocClicks, 40);
});
