// Patient-led video visits (owner spec, Nov 2026): the patient picks a time from Dr. Jared's own openings and pays for
// it on the spot. The online evaluation is 60 minutes for $150; the follow-up is 30 minutes for $80 and is offered only
// once they have had an evaluation. The slot is held while Stripe takes the payment, so nobody else can take the same
// video room, and a checkout that is never finished lets the time go. Everything lands on the chart's record, in order.
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

const ROOM = "https://meet.jit.si/mdfit-room";

function fakeStripe() {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  return {
    calls, real,
    client: {
      webhooks: real.webhooks,
      customers: { create: async () => ({ id: "cus_1" }) },
      checkout: { sessions: { create: async (p) => (calls.push(p), { id: "cs_" + calls.length, url: "https://checkout.stripe.com/c/pay/cs_test" }) } }
    }
  };
}

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-visits-"));
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
const signup = async (s, name = "Pat Doe") => (await s.call("POST", "/api/clients/signup", { name, email: `v${++n}@example.com`, phone: "941-555-0100", password: "pat-pass-123" })).body;

async function fillDocs(s, tok, name = "Pat Doe") {
  const save = (doc, body) => s.call("POST", `/api/me/intake/${doc}`, body, tok);
  await save("info", { name, dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" });
  await save("pain", { complaint: "Left hip aches after runs", areas: ["Left hip"], started: "6 weeks to 3 months ago", painNow: 4, goals: "Run a 10k" });
  await save("history", { redFlags: "No" });
  await save("consent", { treatment: true, privacy: true, financial: true, signature: name });
}

const firstOpening = (days) => { const d = days.find((x) => x.slots.length); return { date: d.date, time: d.slots[0] }; };

const paidWebhook = async (s, fake, { clientId, metadata, amount }) => {
  const payload = JSON.stringify({ id: "evt_" + Math.random().toString(16).slice(2), type: "checkout.session.completed", data: { object: { id: metadata.sessionId || "cs_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_1", client_reference_id: clientId, amount_total: amount, currency: "usd", created: 1762077600, metadata } } });
  const header = fake.real.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
  const res = await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return res.status;
};

test("visits: the patient schedules and pays for the online evaluation, and the held time becomes a booking", async (t) => {
  const fake = fakeStripe();
  const s = await start({ stripeClient: fake.client, stripeWebhookSecret: "whsec_test_secret" });
  t.after(s.close);
  const adm = await s.adminToken();
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: ROOM } }, adm);
  const pat = await signup(s);
  await fillDocs(s, pat.token);

  // What is on offer: the evaluation at $150 for 60 minutes; the follow-up waits until they have had one
  const opt = (await s.call("GET", "/api/me/visits/options", undefined, pat.token)).body;
  assert.equal(opt.payOn, true); assert.equal(opt.room, true);
  const ev = opt.services.find((x) => x.id === "eval-remote"), fu = opt.services.find((x) => x.id === "followup-remote");
  assert.equal(ev.rate, 150); assert.equal(ev.minutes, 60); assert.equal(ev.eligible, true);
  assert.equal(fu.rate, 80); assert.equal(fu.minutes, 30); assert.equal(fu.eligible, false);
  assert.match(fu.why, /returning patients/i);
  assert.equal((await s.call("GET", "/api/me/visits/openings?service=followup-remote", undefined, pat.token)).status, 403, "no follow-up before an evaluation");

  // Dr. Jared's openings, and the time the patient picks
  const open = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  assert.ok(open.days.length, "there are openings");
  assert.equal(open.minutes, 60);
  const pick = firstOpening(open.days);

  // Scheduling it opens a Stripe checkout for $150 and holds the time
  const sch = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, pat.token);
  assert.equal(sch.status, 200, JSON.stringify(sch.body));
  assert.equal(sch.body.booked, false); assert.ok(sch.body.url); assert.ok(sch.body.holdId);
  const sess = fake.calls[0];
  assert.equal(sess.mode, "payment");
  assert.equal(sess.line_items[0].price_data.unit_amount, 15000, "$150");
  assert.equal(sess.metadata.kind, "service"); assert.equal(sess.metadata.service, "eval-remote");
  assert.equal(sess.metadata.apptId, sch.body.holdId, "the appointment rides along to Stripe");

  // While it is held, nobody else can take that time and it is not on the calendar yet
  const after = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  const held = after.days.find((d) => d.date === pick.date);
  assert.ok(!held || !held.slots.includes(pick.time), "the held time is gone from the openings");
  const other = await signup(s, "Sam Lee"); await fillDocs(s, other.token, "Sam Lee");
  const clash = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, other.token);
  assert.equal(clash.status, 409, "a second patient cannot take the same video room");
  const cal = (await s.call("GET", "/api/admin/appointments", undefined, adm)).body;
  assert.ok(!cal.some((a) => a.id === sch.body.holdId), "an unpaid hold is not on Dr. Jared's calendar");

  // Stripe says it is paid: the hold becomes a booking with the video link
  assert.equal(await paidWebhook(s, fake, { clientId: pat.client.id, metadata: sess.metadata, amount: 15000 }), 200);
  const mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(mine.visits.length, 1);
  assert.equal(mine.visits[0].date, pick.date); assert.equal(mine.visits[0].time, pick.time);
  assert.equal(mine.visits[0].meetingLink, ROOM);
  assert.equal(mine.visits[0].payment, "paid");
  assert.equal(mine.paidVisits.length, 0, "the payment is spent on this visit, not left waiting");
  const cal2 = (await s.call("GET", "/api/admin/appointments", undefined, adm)).body;
  const booked = cal2.find((a) => a.id === sch.body.holdId);
  assert.ok(booked, "it is on Dr. Jared's calendar once paid");
  assert.equal(booked.status, "booked"); assert.equal(booked.payment, "paid"); assert.equal(booked.source, "patient");

  // The same webhook twice changes nothing
  assert.equal(await paidWebhook(s, fake, { clientId: pat.client.id, metadata: sess.metadata, amount: 15000 }), 200);
  const again = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(again.visits.length, 1); assert.equal(again.paidVisits.length, 0);

  // The record, in order: the documents, the payment and the visit
  const chart = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  const kinds = chart.record.map((e) => e.kind);
  for (const k of ["joined", "documents", "payment", "scheduled"]) assert.ok(kinds.includes(k), `the record has ${k}`);
  const times = chart.record.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse(), "newest first");
});

test("visits: a time the patient never pays for is let go, and a paid visit on file needs no second payment", async (t) => {
  const fake = fakeStripe();
  const s = await start({ stripeClient: fake.client, stripeWebhookSecret: "whsec_test_secret" });
  t.after(s.close);
  const adm = await s.adminToken();
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: ROOM } }, adm);
  const pat = await signup(s);
  await fillDocs(s, pat.token);
  const open = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  const pick = firstOpening(open.days);
  const sch = (await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, pat.token)).body;

  // Closing the checkout hands the time back
  assert.equal((await s.call("POST", `/api/me/visits/${sch.holdId}/release`, {}, pat.token)).status, 200);
  const back = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  assert.ok(back.days.find((d) => d.date === pick.date).slots.includes(pick.time), "the time is open again");
  const chart0 = (await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, adm)).body;
  assert.ok(chart0.record.some((e) => e.kind === "lapsed"), "the record shows a checkout that was never finished");

  // Paid ahead of time (the pricing page, or Dr. Jared taking payment): scheduling uses that up
  const co = (await s.call("POST", "/api/me/checkout/service", { service: "eval-remote" }, pat.token)).body;
  const meta = fake.calls[fake.calls.length - 1].metadata;
  assert.equal(meta.apptId, undefined, "paying without a time keeps the visit waiting");
  assert.ok(co.url);
  await paidWebhook(s, fake, { clientId: pat.client.id, metadata: { ...meta, sessionId: "cs_paidahead" }, amount: 15000 });
  const waiting = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(waiting.paidVisits.length, 1);
  const before = fake.calls.length;
  const sch2 = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, pat.token);
  assert.equal(sch2.status, 200, JSON.stringify(sch2.body));
  assert.equal(sch2.body.booked, true, "no second payment");
  assert.equal(fake.calls.length, before, "Stripe was not asked for anything");
  assert.equal(sch2.body.appointment.meetingLink, ROOM);
  const mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.equal(mine.paidVisits.length, 0, "the visit they paid for is the one they scheduled");
  assert.equal(mine.visits.length, 1);
});

test("visits: the 30-minute $80 follow-up opens up once the evaluation is behind them", async (t) => {
  const fake = fakeStripe();
  const s = await start({ stripeClient: fake.client, stripeWebhookSecret: "whsec_test_secret" });
  t.after(s.close);
  const adm = await s.adminToken();
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: ROOM } }, adm);
  const pat = await signup(s);
  await fillDocs(s, pat.token);
  // Dr. Jared saw them: the evaluation is done
  const ap = await s.call("POST", `/api/admin/clients/${pat.client.id}/consult`, { date: "2026-11-10", time: "10:00", minutes: 60, title: "Online evaluation", force: true }, adm);
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  await s.call("PATCH", `/api/admin/appointments/${ap.body.id}`, { status: "completed" }, adm);

  const opt = (await s.call("GET", "/api/me/visits/options", undefined, pat.token)).body;
  const fu = opt.services.find((x) => x.id === "followup-remote");
  assert.equal(fu.eligible, true, "a returning patient can book a follow-up");
  assert.equal(fu.rate, 80); assert.equal(fu.minutes, 30);
  const open = (await s.call("GET", "/api/me/visits/openings?service=followup-remote", undefined, pat.token)).body;
  assert.equal(open.minutes, 30);
  const pick = firstOpening(open.days);
  const sch = await s.call("POST", "/api/me/visits/schedule", { service: "followup-remote", date: pick.date, time: pick.time }, pat.token);
  assert.equal(sch.status, 200, JSON.stringify(sch.body));
  const sess = fake.calls[fake.calls.length - 1];
  assert.equal(sess.line_items[0].price_data.unit_amount, 8000, "$80");
  await paidWebhook(s, fake, { clientId: pat.client.id, metadata: sess.metadata, amount: 8000 });
  const mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  const bookedFu = mine.visits.find((v) => v.date === pick.date && v.time === pick.time);
  assert.ok(bookedFu, "the follow-up is booked");
  assert.equal(bookedFu.minutes, 30);
});

test("visits: with no video room and no online payment, the patient is told to call instead", async (t) => {
  const s = await start(); // no Stripe client configured
  t.after(s.close);
  const pat = await signup(s);
  await fillDocs(s, pat.token);
  const opt = (await s.call("GET", "/api/me/visits/options", undefined, pat.token)).body;
  assert.equal(opt.payOn, false); assert.equal(opt.room, false);
  const open = (await s.call("GET", "/api/me/visits/openings?service=eval-remote", undefined, pat.token)).body;
  const pick = firstOpening(open.days);
  const no = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, pat.token);
  assert.equal(no.status, 409);
  assert.match(no.body.error, /941-313-0562/, "the phone number, not an error code");
  const adm = await s.adminToken();
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: ROOM } }, adm);
  const off = await s.call("POST", "/api/me/visits/schedule", { service: "eval-remote", date: pick.date, time: pick.time }, pat.token);
  assert.equal(off.status, 503);
  assert.match(off.body.error, /941-313-0562/);
  assert.equal((await s.call("GET", "/api/admin/appointments", undefined, adm)).body.length, 0, "nothing was held");
});

test("visits: the homework pool is what Dr. Jared prescribes most, with no patient named", async (t) => {
  const s = await start();
  t.after(s.close);
  const adm = await s.adminToken();
  const VIDEO = "1hNEZKFQvc2G0B8nQDJPbrx8JhWnBScuv", VIDEO2 = "1ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const a = await signup(s, "Ann One"), b = await signup(s, "Bob Two");
  for (const c of [a, b]) {
    await fillDocs(s, c.token, c.client.name);
    await s.call("PUT", `/api/admin/emr/${c.client.id}/patient`, { active: true }, adm);
    await s.call("POST", `/api/admin/emr/${c.client.id}/movements`, { videoId: VIDEO, name: "Eccentric Calf Drops", dose: "3 x 12", cue: "Slow down" }, adm);
  }
  await s.call("POST", `/api/admin/emr/${b.client.id}/movements`, { videoId: VIDEO2, name: "Hip Hinge", dose: "2 x 10" }, adm);
  const pool = (await s.call("GET", "/api/admin/emr/pool", undefined, adm)).body.pool;
  assert.equal(pool[0].videoId, VIDEO); assert.equal(pool[0].uses, 2); assert.equal(pool[0].name, "Eccentric Calf Drops"); assert.equal(pool[0].dose, "3 x 12");
  assert.equal(pool[1].videoId, VIDEO2); assert.equal(pool[1].uses, 1);
  assert.ok(!JSON.stringify(pool).includes("Ann One") && !JSON.stringify(pool).includes("Bob Two"), "no patient is named in the pool");
  assert.equal((await s.call("GET", "/api/admin/emr/pool")).status, 401, "owner only");
});
