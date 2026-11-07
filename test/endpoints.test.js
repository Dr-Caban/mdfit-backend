// Regression tests from the endpoint sweep: every save the UI makes must be readable again through the GET the UI uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { defaultContent } = require("../lib/content");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start({ seed = {}, ...extra } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-e-"));
  for (const [name, data] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const writeJson = (name, data) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  return { call, adminToken, base, dataDir, readJson, writeJson, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

test("a built-in program added after the admin last saved content can be pinned and assigned", async (t) => {
  const d = defaultContent();
  // Content saved by the admin when only the first built-in program existed
  const s = await start({ seed: { content: { contentVersion: 5, programs: [d.programs[0]], knownDefaults: [d.programs[0].id] } } }); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const shown = (await s.call("GET", "/api/me/content", undefined, T)).body.programs.map((p) => p.id);
  assert.equal(shown.length, d.programs.length, "the app shows the new built-ins");
  const pid = shown[1];
  const pin = await s.call("PUT", `/api/me/pinned/${pid}`, undefined, T);
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.deepEqual((await s.call("GET", "/api/me", undefined, T)).body.client.pinnedPrograms, [pid]);
  const as = await s.call("PUT", `/api/admin/clients/${client.id}/programs`, { programs: [{ id: pid, note: "Start here" }] }, A);
  assert.equal(as.status, 200, JSON.stringify(as.body));
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.assignedPrograms[0].note, "Start here");
  // A program the admin removed stays unavailable
  const gone = d.programs[0].id;
  await s.call("PUT", "/api/admin/content", { programs: (await s.call("GET", "/api/admin/content", undefined, A)).body.programs.filter((p) => p.id !== gone) }, A);
  assert.equal((await s.call("PUT", `/api/me/pinned/${gone}`, undefined, T)).status, 400);
});

test("admin membership save keeps the Stripe subscription on the membership", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const cls = s.readJson("clients");
  cls[0].membership = { tier: "member", since: "2026-10-01", until: "2026-12-01", stripeSubscriptionId: "sub_123", status: "active", cancelAtPeriodEnd: false };
  s.writeJson("clients", cls);
  const r = await s.call("PUT", `/api/admin/clients/${client.id}/membership`, { tier: "member", until: "2027-01-01" }, A);
  assert.equal(r.status, 200);
  const m = (await s.call("GET", "/api/me/payments", undefined, T)).body.membership;
  assert.equal(m.until, "2027-01-01");
  assert.equal(m.since, "2026-10-01");
  assert.equal(m.stripeSubscriptionId, "sub_123");
  // Turning it off still clears it
  await s.call("PUT", `/api/admin/clients/${client.id}/membership`, { tier: null }, A);
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.membership, null);
});

test("profile name change updates first and last name (Google sign-up accounts store them separately)", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: T } = (await signup(s)).body;
  const cls = s.readJson("clients");
  Object.assign(cls[0], { firstName: "Pat", lastName: "Doe", googleSub: "g-1" });
  s.writeJson("clients", cls);
  await s.call("PUT", "/api/me", { name: "Patricia Smith", phone: "941-555-0100" }, T);
  const c = (await s.call("GET", "/api/me", undefined, T)).body.client;
  assert.equal(c.name, "Patricia Smith");
  assert.equal(c.firstName, "Patricia");
  assert.equal(c.lastName, "Smith");
  // Saving the profile with the same name keeps them
  await s.call("PUT", "/api/me", { name: "Patricia Smith", phone: "941-555-0101" }, T);
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.phone, "941-555-0101");
});

test("feedback report status and admin notes read back; members never see the notes", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const { token: T } = (await signup(s)).body;
  assert.equal((await s.call("POST", "/api/me/feedback-reports", { kind: "bug", title: "Chart blank", body: "The pain chart is empty", page: "/account" }, T)).status, 201);
  const id = (await s.call("GET", "/api/admin/feedback-reports", undefined, A)).body.reports[0].id;
  assert.equal((await s.call("PATCH", `/api/admin/feedback-reports/${id}`, { status: "working", adminNotes: "Repro on iOS" }, A)).status, 200);
  const r = (await s.call("GET", "/api/admin/feedback-reports", undefined, A)).body.reports[0];
  assert.equal(r.status, "working");
  assert.equal(r.adminNotes, "Repro on iOS");
  const mine = (await s.call("GET", "/api/me/feedback-reports", undefined, T)).body[0];
  assert.equal(mine.status, "working");
  assert.equal(mine.adminNotes, undefined);
});

test("a phone typed while booking is saved to a member account that had none", async (t) => {
  const s = await start(); t.after(s.close);
  const { token: T } = (await signup(s, { phone: "" })).body;
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.phone, "");
  const r = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time: "09:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0177" }, T);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.phone, "941-555-0177");
  // An existing phone is never overwritten, and an anonymous booking with the same email changes nothing
  await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time: "11:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0999" }, T);
  await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time: "13:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0888" });
  assert.equal((await s.call("GET", "/api/me", undefined, T)).body.client.phone, "941-555-0177");
});

test("a too-short new password doesn't use up the emailed code", async (t) => {
  const http = require("node:http");
  const sent = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => fake.once("listening", r));
  t.after(() => fake.close());
  const s = await start({ resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>" }); t.after(s.close);
  const { token: T } = (await signup(s)).body;
  assert.equal((await s.call("POST", "/api/me/password/code", {}, T)).status, 200);
  let mail; for (let i = 0; i < 50 && !(mail = sent.find((m) => /is your MD Fit code/.test(m.subject))); i++) await new Promise((r) => setTimeout(r, 20));
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  const short = await s.call("PUT", "/api/me/password", { code, password: "short" }, T);
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 8/);
  const ok = await s.call("PUT", "/api/me/password", { code, password: "long-enough-1" }, T);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat@example.com", password: "long-enough-1" })).status, 200);
});

test("stripe: an installment paid while the plan's schedule is being set up stays paid", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  let release; const gate = new Promise((r) => (release = r));
  let customerGate = null;
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async () => { if (customerGate) await customerGate; return { id: "cus_1" }; } },
    checkout: { sessions: { create: async (p) => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_test", metadata: p.metadata }) } },
    subscriptionSchedules: { create: async () => { await gate; return { id: "sched_1", phases: [{ start_date: 1790000000, items: [{ price: "price_1", quantity: 1 }] }] }; }, update: async (id) => ({ id }) }
  };
  const whsec = "whsec_test_secret";
  const s = await start({ stripeClient: fake, stripeWebhookSecret: whsec }); t.after(s.close);
  const send = (ev) => {
    const payload = JSON.stringify(ev);
    return fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": real.webhooks.generateTestHeaderString({ payload, secret: whsec }) }, body: payload }).then((r) => r.json());
  };
  const { token: T } = (await signup(s)).body;
  // While the Stripe customer is being created, the member logs pain: the customer id save must not undo it
  let openCustomer; customerGate = new Promise((r) => (openCustomer = r));
  const checkout = s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "silver" }, T);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 3, note: "" }, T)).status, 201);
  openCustomer(); customerGate = null;
  const co = await checkout;
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal((await s.call("GET", "/api/me/pain", undefined, T)).body.length, 1, "pain entry kept");
  const pid = (await s.call("GET", "/api/me/payments", undefined, T)).body.protocols[0].id;
  const md = { kind: "protocol", protocolId: pid, payments: "3" };
  const done = send({ id: "evt_c", type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_p", metadata: md } } });
  await new Promise((r) => setTimeout(r, 50));
  await send({ id: "evt_i", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", parent: { subscription_details: { subscription: "sub_p" } } } } });
  release();
  await done;
  const p = (await s.call("GET", "/api/me/payments", undefined, T)).body.protocols[0];
  assert.equal(p.paid, 1, "the first installment stays counted");
});

test("cancelling a Cal.com visit doesn't erase a booking made while Cal answers", async (t) => {
  const http = require("node:http");
  let release; let gate;
  const cal = http.createServer((req, res) => { req.resume(); req.on("end", async () => { await gate; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "success", data: {} })); }); }).listen(0);
  await new Promise((r) => cal.once("listening", r));
  t.after(() => cal.close());
  const calAppt = (id, time) => ({ id, source: "cal", calUid: "uid-" + id, typeId: "cal", typeName: "Evaluation", minutes: 60, date: "2026-11-05", time, name: "Pat Doe",
    email: "pat@example.com", phone: "941-555-0100", notes: "", areas: [], painLevel: null, status: "booked", adminNotes: "", cancelToken: "t".repeat(32), createdAt: "2026-11-01T00:00:00Z" });
  const s = await start({ calKey: "cal_key", calUrl: `http://127.0.0.1:${cal.address().port}/v2`, seed: { appointments: [calAppt("aaaaaaaaaaaa", "09:00"), calAppt("bbbbbbbbbbbb", "13:00")] } }); t.after(s.close);
  const A = await s.adminToken();
  const { token: T } = (await signup(s)).body;
  const book = (time) => s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-04", time, name: "Lee Roe", email: "lee@example.com", phone: "941-555-0100" });

  for (const [cancel, time] of [[() => s.call("PATCH", "/api/admin/appointments/aaaaaaaaaaaa", { status: "cancelled" }, A), "09:00"],
    [() => s.call("POST", "/api/me/appointments/bbbbbbbbbbbb/cancel", {}, T), "11:00"]]) {
    gate = new Promise((r) => (release = r));
    const pending = cancel();
    await new Promise((r) => setTimeout(r, 50));
    const b = await book(time);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    release();
    assert.equal((await pending).status, 200);
    const all = (await s.call("GET", "/api/admin/appointments?all=1", undefined, A)).body;
    assert.ok(all.some((a) => a.id === b.body.appointment.id), "the booking made meanwhile is still there");
  }
  const all = (await s.call("GET", "/api/admin/appointments?all=1", undefined, A)).body;
  assert.deepEqual(all.filter((a) => a.source === "cal").map((a) => a.status), ["cancelled", "cancelled"]);
});

test("stripe: events handled at the same time are both remembered (a retry isn't applied twice)", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  let release; const gate = new Promise((r) => (release = r));
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_test" }) } },
    subscriptionSchedules: { create: async () => { await gate; return { id: "sched_1", phases: [{ start_date: 1790000000, items: [{ price: "price_1", quantity: 1 }] }] }; }, update: async (id) => ({ id }) }
  };
  const whsec = "whsec_test_secret";
  const s = await start({ stripeClient: fake, stripeWebhookSecret: whsec }); t.after(s.close);
  const send = (ev) => {
    const payload = JSON.stringify(ev);
    return fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": real.webhooks.generateTestHeaderString({ payload, secret: whsec }) }, body: payload }).then((r) => r.json());
  };
  const { token: T } = (await signup(s)).body;
  assert.equal((await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "silver" }, T)).status, 200);
  const pid = (await s.call("GET", "/api/me/payments", undefined, T)).body.protocols[0].id;
  const slow = send({ id: "evt_c", type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_p", metadata: { kind: "protocol", protocolId: pid, payments: "3" } } } });
  await new Promise((r) => setTimeout(r, 50));
  const paid = { id: "evt_i", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", parent: { subscription_details: { subscription: "sub_p" } } } } };
  await send(paid);
  release(); await slow;
  assert.equal((await send(paid)).duplicate, true, "Stripe's retry of the invoice is recognised");
  assert.equal((await s.call("GET", "/api/me/payments", undefined, T)).body.protocols[0].paid, 1);
});

test("scheduling a video consultation with the link left blank uses the practice's video room", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const consult = (link) => s.call("POST", `/api/admin/clients/${client.id}/consult`, { date: "2026-11-05", time: "13:00", minutes: 30, meetingLink: link, message: "" }, A);
  assert.equal((await consult("")).status, 400, "no room saved yet: asks for a link");
  await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: "https://zoom.us/j/777" } }, A);
  const r = await consult("");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mine = (await s.call("GET", "/api/me/appointments", undefined, T)).body.upcoming.find((a) => a.id === r.body.id);
  assert.equal(mine.meetingLink, "https://zoom.us/j/777");
});
