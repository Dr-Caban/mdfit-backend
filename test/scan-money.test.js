"use strict";
// Money paths found by the Nov 2026 scan of the payment files, each as the case that went wrong:
// instalment plans (their end, their count, being told twice), a clients list saved from before a Stripe call,
// an invoice paid twice, a refund pressed twice or made in Stripe's own dashboard, the manager's payout against a
// refund in flight, commission on Net Revenue when there is no hold, the accountability credit's window, and the
// day a payment falls on in the member's calendar. Made-up data and stand-ins for Stripe and the email service.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Stripe = require("stripe");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const WHSEC = "whsec_test_secret";
const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

async function start(t, stripeClient, extra = {}, { mail = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-scan-"));
  const sent = [];
  let post = null;
  if (mail) {
    post = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const j = JSON.parse(b); sent.push(...(Array.isArray(j) ? j : [j])); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","data":[]}'); }); }).listen(0);
    await new Promise((r) => post.once("listening", r));
  }
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: "https://site.example.com", noVideoSync: true, noAffiliateJobs: true, calWatchMs: 0, stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: WHSEC, now: () => new Date(),
    ...(mail ? { resendKey: "re_made_up", notifyFrom: "MD Fit <office@example.com>", resendUrl: `http://127.0.0.1:${post.address().port}`, notifyGapMs: 1 } : {}), ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); if (post) post.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const login = async (email = "coach@example.com") => (await call("POST", "/api/admin/login", { email, password: "admin-pass-123" })).body.token;
  const signup = async (name, over = {}) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", phone: "941-555-0100", password: "made-up-pass-1", ...over })).body;
  const readJson = (n, d = []) => { const f = path.join(dataDir, n + ".json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d; };
  const writeJson = (n, v) => fs.writeFileSync(path.join(dataDir, n + ".json"), JSON.stringify(v));
  let n = 0;
  // A signed webhook. Every delivery gets its own event id unless one is given (Stripe's retry of the same event).
  const hook = async (type, object, id) => {
    const payload = JSON.stringify({ id: id || "evt_" + ++n, type, created: 1793200000, data: { object } });
    const res = await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": real.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) }, body: payload });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const mails = async () => { await tick(500); return sent.map((m) => ({ to: [].concat(m.to).join(","), subject: m.subject, text: m.text || "" })); };
  const client = (email) => readJson("clients").find((c) => c.email === email);
  const edit = (email, fn) => { const l = readJson("clients"); fn(l.find((c) => c.email === email)); writeJson("clients", l); };
  // What happens when the shared list of Stripe event ids has turned over (it keeps the last 1,000)
  const forgetEvents = () => writeJson("stripeEvents", Array.from({ length: 1000 }, (_, i) => "evt_later_" + i));
  return { call, login, signup, readJson, writeJson, hook, mails, client, edit, forgetEvents, base };
}

// Checkout as this server uses it: sessions it opens, the charge behind each, expiry, refunds. A refund sent again
// with the same idempotency key is answered with the refund already made, as Stripe does.
function checkoutFake() {
  const made = [], sessions = new Map(), charges = new Map(), expired = [], refunds = [], byKey = new Map(), st = { refundGate: null, createGate: null };
  const stripe = {
    webhooks: real.webhooks,
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: {
      create: async (o) => {
        if (st.createGate) await st.createGate;
        const id = "cs_" + (made.length + 1), amount = o.line_items ? o.line_items[0].price_data.unit_amount : 0; made.push(o);
        charges.set("ch_" + id, { id: "ch_" + id, object: "charge", status: "succeeded", amount, amount_refunded: 0, customer: o.customer || null, payment_intent: "pi_" + id, metadata: o.metadata });
        sessions.set(id, { id, object: "checkout.session", mode: o.mode, status: "open", payment_status: "unpaid", url: "https://pay.example.com/" + id, success_url: o.success_url, metadata: o.metadata, customer: o.customer, client_reference_id: o.client_reference_id, amount_total: amount, currency: "usd", payment_intent: "pi_" + id });
        return { id, url: "https://pay.example.com/" + id, metadata: o.metadata };
      },
      retrieve: async (id, opts) => { const s = sessions.get(id); if (!s) throw new Error("No such session"); return opts && (opts.expand || []).includes("payment_intent.latest_charge") ? { ...s, payment_intent: { id: s.payment_intent, latest_charge: { ...charges.get("ch_" + id) } } } : { ...s }; },
      expire: async (id) => { const s = sessions.get(id); if (!s || s.status !== "open") throw new Error("Only open sessions can be expired"); expired.push(id); s.status = "expired"; return s; } } },
    charges: { retrieve: async (id) => { const c = charges.get(id); if (!c) throw new Error("No such charge"); return { ...c }; }, list: async () => ({ data: [] }) },
    refunds: { create: async (o, opts) => {
      if (st.refundGate) await st.refundGate;
      if (byKey.has(opts.idempotencyKey)) return byKey.get(opts.idempotencyKey);
      const re = { id: "re_" + (refunds.length + 1), amount: o.amount }; refunds.push({ ...o, id: re.id }); charges.get(o.charge).amount_refunded += o.amount; byKey.set(opts.idempotencyKey, re); return re;
    } },
    invoices: { list: async () => ({ data: [] }) }, paymentMethods: { list: async () => ({ data: [] }) }
  };
  // The session as Stripe sends it once paid
  const paidSession = (id) => { const s = sessions.get(id); Object.assign(s, { status: "complete", payment_status: "paid" }); return { ...s }; };
  const refundedCharge = (id, total) => { const c = charges.get("ch_" + id); c.amount_refunded = total; return { ...c, refunded: total >= c.amount }; };
  // Two people (or two taps) asking for the payment page at the same moment: both reach Stripe before either page exists
  const together = async (...asks) => { let open; st.createGate = new Promise((r) => (open = r)); const all = asks.map((ask) => ask()); await tick(100); st.createGate = null; open(); return Promise.all(all); };
  return { stripe, made, sessions, charges, expired, refunds, st, paidSession, refundedCharge, together };
}

// Instalment plans: checkout for a plan, and the schedule that ends its subscription after the last payment
function planFake() {
  const k = { creates: 0, failCreate: 0, failUpdate: 0, bySub: {}, updates: [], cancelled: [], sessions: 0 };
  const stripe = {
    webhooks: real.webhooks,
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async (p) => ({ id: "cs_p" + ++k.sessions, url: "https://checkout.example.com/x", metadata: p.metadata }), retrieve: async (id) => { const s = k.retrieve && k.retrieve(id); if (!s) throw new Error("No such session"); return s; } } },
    subscriptionSchedules: {
      create: async ({ from_subscription: sub }) => {
        k.creates++;
        if (k.failCreate > 0) { k.failCreate--; throw new Error("Stripe is unavailable"); }
        if (k.bySub[sub]) throw new Error("This subscription already has a schedule");
        return (k.bySub[sub] = { id: "sched_" + sub, end_behavior: "release", phases: [{ start_date: 1790000000, items: [{ price: "price_1", quantity: 1 }] }] });
      },
      update: async (id, p) => { if (k.failUpdate > 0) { k.failUpdate--; throw new Error("Stripe is unavailable"); } const s = Object.values(k.bySub).find((x) => x.id === id); s.end_behavior = p.end_behavior; k.updates.push([id, p]); return s; },
      retrieve: async (id) => Object.values(k.bySub).find((x) => x.id === id)
    },
    subscriptions: { retrieve: async (id) => ({ id, schedule: k.bySub[id] ? k.bySub[id].id : null }), cancel: async (id) => { k.cancelled.push(id); return { id, status: "canceled" }; } }
  };
  return { stripe, k };
}
// A member who has started checkout for a 3-payment plan. Returns what Stripe would send about it.
async function plan(s, token, sub) {
  const co = await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "silver" }, token);
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const p = (await s.call("GET", "/api/me/payments", undefined, token)).body.protocols.slice(-1)[0];
  assert.equal(p.payments, 3);
  const md = { kind: "protocol", protocolId: p.id, payments: String(p.payments) };
  return { id: p.id, md, sub,
    session: (over = {}) => ({ id: co.body.id, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", customer: "cus_1", subscription: sub, metadata: md, ...over }),
    invoice: (n, withMeta = true) => ({ id: `in_${sub}_${n}`, object: "invoice", customer: "cus_1", parent: { subscription_details: { subscription: sub, ...(withMeta ? { metadata: md } : {}) } } }),
    now: async () => (await s.call("GET", "/api/me/payments", undefined, token)).body.protocols.find((x) => x.id === p.id) };
}

test("1. an instalment plan whose end could not be set is tried again until it is, and never bills on with no end", async (t) => {
  const { stripe, k } = planFake();
  const s = await start(t, stripe);
  const pat = await s.signup("Pat Doe");

  await t.test("Stripe's retry of the checkout event sets the end", async () => {
  // Stripe is down for the schedule when the checkout completes. Stripe retries the event: the end is set then.
  const a = await plan(s, pat.token, "sub_a");
  k.failCreate = 1;
  assert.equal((await s.hook("checkout.session.completed", a.session(), "evt_a")).status, 500, "Stripe is told to send it again");
  assert.equal((await a.now()).scheduleId, undefined);
  assert.equal((await s.hook("checkout.session.completed", a.session(), "evt_a")).status, 200);
  assert.equal(k.creates, 2, "the retry tries the schedule again");
  assert.equal(k.bySub.sub_a.end_behavior, "cancel", "the plan ends after its last payment");
  assert.equal((await a.now()).scheduleId, "sched_sub_a");
  assert.deepEqual(k.updates[0][1].phases[0].duration, { interval: "month", interval_count: 3 });
  // told again after that, nothing more is asked of Stripe
  assert.equal((await s.hook("checkout.session.completed", a.session(), "evt_a2")).status, 200);
  assert.equal(k.creates, 2);
  });

  await t.test("or the next instalment's invoice does", async () => {
  // No retry ever comes: the next instalment's invoice sets the end instead
  const b = await plan(s, pat.token, "sub_b");
  k.failCreate = 1; k.creates = 0;
  assert.equal((await s.hook("checkout.session.completed", b.session({ invoice: b.invoice(1).id }))).status, 500);
  assert.equal((await s.hook("invoice.paid", b.invoice(2))).status, 200);
  assert.equal(k.bySub.sub_b.end_behavior, "cancel");
  assert.equal((await b.now()).scheduleId, "sched_sub_b"); assert.equal((await b.now()).paid, 2);
  });

  await t.test("a schedule left half made is picked up", async () => {
  // The schedule was made but could not be given its end (both forms refused). Stripe allows a subscription one
  // schedule, so the next try picks that one up rather than failing for ever.
  const c = await plan(s, pat.token, "sub_c");
  k.failCreate = 0; k.failUpdate = 2;
  assert.equal((await s.hook("checkout.session.completed", c.session(), "evt_c")).status, 500);
  assert.equal(k.bySub.sub_c.end_behavior, "release", "half made");
  assert.equal((await s.hook("checkout.session.completed", c.session(), "evt_c")).status, 200);
  assert.equal(k.bySub.sub_c.end_behavior, "cancel"); assert.equal((await c.now()).scheduleId, "sched_sub_c");
  });

  await t.test("and with no schedule at all the subscription is stopped after the last payment", async () => {
  // The key cannot make schedules at all: once the last instalment is in, the subscription is stopped outright
  const d = await plan(s, pat.token, "sub_d");
  k.failCreate = 99;
  await s.hook("checkout.session.completed", d.session({ invoice: d.invoice(1).id }));
  assert.equal((await s.hook("invoice.paid", d.invoice(2))).status, 200); assert.deepEqual(k.cancelled, []);
  assert.equal((await s.hook("invoice.paid", d.invoice(3))).status, 200);
  assert.deepEqual(k.cancelled, ["sub_d"], "nothing is left to bill a fourth time");
  assert.equal((await d.now()).status, "paid");
  });
});

test("3. instalments are counted once each whichever of invoice.paid and checkout.session.completed comes first", async (t) => {
  const { stripe } = planFake();
  const s = await start(t, stripe);
  const pat = await s.signup("Pat Doe");
  const state = async (x) => { const p = await x.now(); return [p.paid, p.status]; };
  const ended = (x) => s.hook("customer.subscription.deleted", { id: x.sub, object: "subscription", customer: "cus_1", status: "canceled", metadata: x.md });

  await t.test("the invoice first (Stripe's usual order for a new subscription)", async () => {
  const a = await plan(s, pat.token, "sub_a");
  assert.equal((await s.hook("invoice.paid", a.invoice(1))).status, 200);
  assert.deepEqual(await state(a), [1, "active"], "the subscription's metadata on the invoice says which plan it is");
  assert.equal((await s.hook("checkout.session.completed", a.session({ invoice: a.invoice(1).id }))).status, 200);
  assert.deepEqual(await state(a), [1, "active"], "the checkout names the same first invoice: not counted again");
  await s.hook("invoice.paid", a.invoice(2));
  await s.hook("invoice.paid", a.invoice(2)); // the same invoice under a new event id
  assert.deepEqual(await state(a), [2, "active"]);
  await s.hook("invoice.paid", a.invoice(3));
  assert.deepEqual(await state(a), [3, "paid"]);
  await ended(a);
  assert.deepEqual(await state(a), [3, "paid"], "a finished plan ends as paid, not as ended one short");
  });

  await t.test("the checkout first (this order was already right: kept right)", async () => {
  const b = await plan(s, pat.token, "sub_b");
  await s.hook("checkout.session.completed", b.session({ invoice: b.invoice(1).id }));
  await s.hook("invoice.paid", b.invoice(1));
  assert.deepEqual(await state(b), [1, "active"], "the checkout and its first invoice are one instalment");
  await s.hook("invoice.paid", b.invoice(2)); await s.hook("invoice.paid", b.invoice(3)); await ended(b);
  assert.deepEqual(await state(b), [3, "paid"]);
  });

  await t.test("an early invoice that does not say which plan it is for", async () => {
  // No metadata on it: the checkout that follows names the invoice and counts it
  const c = await plan(s, pat.token, "sub_c");
  await s.hook("invoice.paid", c.invoice(1, false));
  assert.deepEqual(await state(c), [0, "pending"]);
  await s.hook("checkout.session.completed", c.session({ invoice: c.invoice(1).id }));
  assert.deepEqual(await state(c), [1, "active"]);
  await s.hook("invoice.paid", c.invoice(2, false)); await s.hook("invoice.paid", c.invoice(3, false)); await ended(c);
  assert.deepEqual(await state(c), [3, "paid"]);
  });
});

test("11. being told of an old checkout again changes nothing, however many Stripe events have come since", async (t) => {
  const { stripe, k } = planFake();
  const s = await start(t, stripe);
  const pat = await s.signup("Pat Doe");

  await t.test("a finished plan stays finished", async () => {
  const a = await plan(s, pat.token, "sub_a");
  k.retrieve = () => a.session({ invoice: a.invoice(1).id, subscription: { id: "sub_a", status: "canceled", metadata: a.md } });
  assert.equal((await s.call("POST", "/api/me/checkout/confirm", { session_id: a.session().id }, pat.token)).status, 200);
  for (const n of [1, 2, 3]) await s.hook("invoice.paid", a.invoice(n));
  await s.hook("customer.subscription.deleted", { id: "sub_a", customer: "cus_1", status: "canceled", metadata: a.md });
  assert.deepEqual([(await a.now()).paid, (await a.now()).status], [3, "paid"]);
  const creates = k.creates;
  // Months later the old success page is opened again
  s.forgetEvents();
  const again = await s.call("POST", "/api/me/checkout/confirm", { session_id: a.session().id }, pat.token);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([(await a.now()).paid, (await a.now()).status], [3, "paid"], "a finished plan is never set back to active");
  assert.equal(k.creates, creates, "and no schedule is asked for on a subscription that is over");
  // Even a checkout fulfilled before the member's record kept its id: the plan's own state decides
  s.edit("pat.doe@example.com", (c) => { delete c.fulfilled; });
  assert.equal((await s.call("POST", "/api/me/checkout/confirm", { session_id: a.session().id }, pat.token)).status, 200);
  assert.deepEqual([(await a.now()).paid, (await a.now()).status], [3, "paid"]);
  assert.equal(k.creates, creates);
  });

  await t.test("one visit paid for once is one paid visit", async () => {
  const visit = { id: "cs_visit_1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_1", client_reference_id: pat.client.id, amount_total: 9000, currency: "usd", metadata: { kind: "service", service: "followup", clientId: pat.client.id } };
  await s.hook("checkout.session.completed", visit);
  const waiting = async () => (await s.call("GET", "/api/me/chart", undefined, pat.token)).body.paidVisits.length;
  assert.equal(await waiting(), 1);
  s.forgetEvents();
  assert.equal((await s.hook("checkout.session.completed", visit)).status, 200);
  assert.equal(await waiting(), 1, "not a second visit for the same payment");
  });
});

test("2. an affiliate's Stripe set-up and status check never undo what was saved while Stripe was answering", async (t) => {
  let gate = null, open;
  const hold = () => { gate = new Promise((r) => (open = () => { gate = null; r(); })); };
  const stripe = { webhooks: real.webhooks,
    accounts: { create: async () => { if (gate) await gate; return { id: "acct_pat", details_submitted: false, payouts_enabled: false }; }, retrieve: async (id) => { if (gate) await gate; return { id, details_submitted: true, payouts_enabled: true }; } },
    accountLinks: { create: async () => ({ url: "https://connect.example.com/setup" }) } };
  const s = await start(t, stripe);
  const adm = await s.login(), pat = await s.signup("Pat Doe"), sam = await s.signup("Sam Roe");
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true, password: "admin-pass-123" }, adm)).status, 200);
  assert.equal((await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat.token)).status, 200);

  // Pat starts the Stripe set-up; while Stripe makes the account, Sam logs pain
  hold();
  const onboard = s.call("POST", "/api/me/affiliate/stripe/onboard", {}, pat.token);
  await tick();
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 3, note: "" }, sam.token)).status, 201);
  open();
  assert.equal((await onboard).status, 200);
  assert.equal(s.client("pat.doe@example.com").affiliate.stripeAccountId, "acct_pat");
  assert.equal((s.client("sam.roe@example.com").painLog || []).length, 1, "Sam's entry is still there");

  // Pat comes back from Stripe; while the status is fetched, Sam's membership payment lands
  s.edit("sam.roe@example.com", (c) => { c.stripeCustomerId = "cus_sam"; });
  hold();
  const status = s.call("GET", "/api/me/affiliate/stripe/status", undefined, pat.token);
  await tick();
  assert.equal((await s.hook("customer.subscription.created", { id: "sub_sam", object: "subscription", customer: "cus_sam", status: "active", metadata: { kind: "membership", tier: "member" }, items: { data: [{ current_period_start: 1793200000, current_period_end: 1795800000 }] } })).status, 200);
  open();
  const st = await status;
  assert.equal(st.status, 200); assert.equal(st.body.payoutsEnabled, true);
  assert.equal(s.client("pat.doe@example.com").affiliate.stripe.payoutsEnabled, true, "Pat's status is saved");
  assert.equal(s.client("sam.roe@example.com").membership.tier, "member", "and Sam is still a member");
});

test("5. one invoice, one open payment page; a second payment that still gets through is kept, told to the owner and refundable", async (t) => {
  const f = checkoutFake();
  const s = await start(t, f.stripe, {}, { mail: true });
  const adm = await s.login(), u = "/api/admin/invoices";
  const make = async (over) => { const r = await s.call("POST", u, { description: "Workshop seat", amount: 45, ...over }, adm); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.invoices[0]; };
  const row = async (id) => (await s.call("GET", u, undefined, adm)).body.invoices.find((x) => x.id === id);

  await t.test("(b) asking to pay again hands back the page that is still open", async () => {
  const g = await make({ name: "Gia Guest", email: "gia@example.com" });
  const p1 = await s.call("POST", `/api/invoices/${g.id}/pay`, {}), p2 = await s.call("POST", `/api/invoices/${g.id}/pay`, {});
  assert.equal(p1.body.url, "https://pay.example.com/cs_1"); assert.equal(p2.body.url, p1.body.url, "the same page, not a second one");
  assert.equal(f.made.length, 1);
  // from inside the app the page has to come back to the app: the browser's page is closed before the new one opens
  const p3 = await s.call("POST", `/api/invoices/${g.id}/pay`, { ui: "app" });
  assert.equal(p3.body.url, "https://pay.example.com/cs_2"); assert.deepEqual(f.expired, ["cs_1"]);
  assert.equal([...f.sessions.values()].filter((x) => x.status === "open").length, 1, "never two open pages for one invoice");
  });

  // Two pages opened at the same moment, before either was known to the other
  const h = await make({ name: "Hal Guest", email: "hal@example.com" });
  await f.together(() => s.call("POST", `/api/invoices/${h.id}/pay`, {}), () => s.call("POST", `/api/invoices/${h.id}/pay`, {}));
  const [first, second] = [...f.sessions.values()].filter((x) => x.metadata.linkId === h.id).map((x) => x.id);
  assert.ok(first && second && f.sessions.get(second).status === "open");
  await t.test("(a) paying on one page closes the invoice's other open page", async () => {
  assert.equal((await s.hook("checkout.session.completed", f.paidSession(first))).status, 200);
  await tick();
  assert.equal(f.sessions.get(second).status, "expired", "the other page can no longer take the money");
  });

  await t.test("(c) a second payment that completes all the same is kept, told to the owner and refundable", async () => {
  // the payer was already on Stripe's page, past the point where it could be closed
  assert.equal((await s.hook("checkout.session.completed", f.paidSession(second))).status, 200);
  let r = await row(h.id);
  assert.equal(r.status, "paid"); assert.equal(r.refunded, 0);
  assert.deepEqual(r.extra.map((x) => [x.sessionId, x.amount, x.refunded]), [[second, 4500, 0]], "kept on the invoice with its own checkout");
  // told twice is still one extra payment
  await s.hook("checkout.session.completed", f.paidSession(second));
  await s.hook("checkout.session.completed", f.paidSession(first));
  assert.equal((await row(h.id)).extra.length, 1);
  const mails = await s.mails();
  const alert = mails.filter((m) => m.to === "coach@example.com" && /Paid twice: invoice/.test(m.subject));
  assert.equal(alert.length, 1, "the owner is told, once");
  assert.match(alert[0].text, /\$45\.00/); assert.match(alert[0].text, /nothing was refunded automatically/i);
  assert.equal(f.refunds.length, 0, "no automatic refund");
  assert.match(JSON.stringify((await s.call("GET", "/api/admin/audit?action=invoice", undefined, adm)).body), /invoice\.paid_again/);
  // refunded through the ordinary refund screen, by its checkout: the invoice itself stays paid
  assert.equal((await s.call("POST", "/api/admin/refunds", { linkId: h.id, sessionId: "cs_nope", password: "admin-pass-123" }, adm)).status, 404);
  const back = await s.call("POST", "/api/admin/refunds", { linkId: h.id, sessionId: second, password: "admin-pass-123" }, adm);
  assert.equal(back.status, 200, JSON.stringify(back.body)); assert.equal(back.body.amount, 4500);
  assert.deepEqual(f.refunds.map((x) => [x.charge, x.amount]), [["ch_" + second, 4500]]);
  r = await row(h.id);
  assert.equal(r.status, "paid"); assert.equal(r.refunded, 0); assert.equal(r.extra[0].refunded, 4500);
  assert.equal(f.charges.get("ch_" + first).amount_refunded, 0, "the first payment is untouched");
  });

  await t.test("a client's invoice (it lives on their chart) behaves the same", async () => {
  const cal = await s.signup("Cal Client");
  const c = await make({ recipients: [{ clientId: cal.client.id }] });
  await f.together(() => s.call("POST", `/api/invoices/${c.id}/pay`, {}), () => s.call("POST", `/api/invoices/${c.id}/pay`, {}));
  const [c1, c2] = [...f.sessions.values()].filter((x) => x.metadata.linkId === c.id).map((x) => x.id);
  await s.hook("checkout.session.completed", f.paidSession(c1)); await tick();
  assert.equal(f.sessions.get(c2).status, "expired");
  await s.hook("checkout.session.completed", f.paidSession(c1));
  assert.equal((await row(c.id)).extra, undefined, "the same payment told twice is not a second payment");
  await s.hook("checkout.session.completed", f.paidSession(c2));
  assert.deepEqual((await row(c.id)).extra.map((x) => x.sessionId), [c2]);
  });

  await t.test("settled another way (cash at the desk), its open page is closed, as when it is voided", async () => {
  const k = await make({ name: "Kit Guest", email: "kit@example.com" });
  await s.call("POST", `/api/invoices/${k.id}/pay`, {});
  const page = [...f.sessions.values()].find((x) => x.metadata.linkId === k.id).id;
  assert.equal((await s.call("POST", `${u}/${k.id}/status`, { status: "paid", method: "cash" }, adm)).status, 200);
  assert.equal(f.sessions.get(page).status, "expired");
  });
});

test("12. a refund pressed twice is one refund on the invoice, in the ledger and in the payer's inbox", async (t) => {
  const f = checkoutFake();
  const s = await start(t, f.stripe, {}, { mail: true });
  const adm = await s.login();
  const g = (await s.call("POST", "/api/admin/invoices", { description: "Workshop seat", amount: 45, name: "Gia Guest", email: "gia@example.com" }, adm)).body.invoices[0];
  await s.call("POST", `/api/invoices/${g.id}/pay`, {});
  await s.hook("checkout.session.completed", f.paidSession("cs_1"));
  // Both presses reach Stripe before either refund is made: the same key, so Stripe makes one refund and answers both
  let open; f.st.refundGate = new Promise((r) => (open = r));
  const body = { linkId: g.id, amount: 10, password: "admin-pass-123" };
  const a = s.call("POST", "/api/admin/refunds", body, adm), b = s.call("POST", "/api/admin/refunds", body, adm);
  await tick(100); open(); f.st.refundGate = null;
  assert.deepEqual([(await a).status, (await b).status], [200, 200]);
  assert.equal(f.refunds.length, 1); assert.equal(f.charges.get("ch_cs_1").amount_refunded, 1000);
  const row = (await s.call("GET", "/api/admin/invoices", undefined, adm)).body.invoices.find((x) => x.id === g.id);
  assert.equal(row.refunded, 1000, "$10 went back, so $10 is what the invoice says");
  const log = (await s.call("GET", "/api/admin/audit?action=refund.issued", undefined, adm)).body;
  assert.equal((JSON.stringify(log).match(/refund\.issued/g) || []).length, 1, "one line in the ledger");
  assert.equal((await s.mails()).filter((m) => m.to === "gia@example.com" && m.subject === "Your MD Fit refund").length, 1, "one email");
  // a second refund of the same amount, asked for afterwards, is a refund of its own
  const more = await s.call("POST", "/api/admin/refunds", body, adm);
  assert.equal(more.status, 200); assert.equal(f.refunds.length, 2);
  assert.equal((await s.call("GET", "/api/admin/invoices", undefined, adm)).body.invoices.find((x) => x.id === g.id).refunded, 2000);
});

test("c. a refund made in Stripe's own dashboard is marked on what it paid for, once", async (t) => {
  const f = checkoutFake();
  const s = await start(t, f.stripe);
  const adm = await s.login();
  const guestRow = async (id) => (await s.call("GET", "/api/admin/invoices", undefined, adm)).body.invoices.find((x) => x.id === id);

  await t.test("an invoice sent to someone without an account", async () => {
  const g = (await s.call("POST", "/api/admin/invoices", { description: "Workshop seat", amount: 45, name: "Gia Guest", email: "gia@example.com" }, adm)).body.invoices[0];
  await s.call("POST", `/api/invoices/${g.id}/pay`, {});
  await s.hook("checkout.session.completed", f.paidSession("cs_1"));
  assert.equal((await s.hook("charge.refunded", f.refundedCharge("cs_1", 2000))).status, 200);
  assert.deepEqual([(await guestRow(g.id)).status, (await guestRow(g.id)).refunded], ["paid", 2000]);
  await s.hook("charge.refunded", f.refundedCharge("cs_1", 2000)); // the same refund, told again
  assert.equal((await guestRow(g.id)).refunded, 2000);
  await s.hook("charge.refunded", f.refundedCharge("cs_1", 4500));
  assert.deepEqual([(await guestRow(g.id)).status, (await guestRow(g.id)).refunded], ["refunded", 4500]);
  });

  const cal = await s.signup("Cal Client"), id = cal.client.id;
  await t.test("an invoice on a client's chart, with a refund made in the workspace and its own Stripe event", async () => {
  const inv = (await s.call("POST", `/api/admin/emr/${id}/invoices`, { description: "Private matter", amount: 120 }, adm)).body;
  await s.call("POST", `/api/admin/emr/${id}/invoices/${inv.id}/paylink`, {}, adm);
  await s.hook("checkout.session.completed", f.paidSession("cs_2"));
  const chartRow = async () => (await s.call("GET", `/api/admin/emr/${id}/billing`, undefined, adm)).body.invoices.find((x) => x.number === inv.number);
  assert.equal((await chartRow()).status, "paid");
  // refunded in the workspace, and then Stripe's own event about that same refund arrives: counted once
  assert.equal((await s.call("POST", "/api/admin/refunds", { clientId: id, invoiceId: inv.id, amount: 20, password: "admin-pass-123" }, adm)).status, 200);
  await s.hook("charge.refunded", { ...f.charges.get("ch_cs_2"), refunded: false });
  assert.equal((await chartRow()).refunded, 2000);
  // the rest goes back from the dashboard
  await s.hook("charge.refunded", f.refundedCharge("cs_2", 12000));
  assert.deepEqual([(await chartRow()).status, (await chartRow()).refunded], ["refunded", 12000]);
  });

  await t.test("a plan paid in full (Gold): refunded in part it stays paid, in full it is refunded", async () => {
  const co = await s.call("POST", "/api/me/checkout/protocol", { service: "followup", sessions: 12, plan: "gold" }, cal.token);
  assert.equal(co.status, 200, JSON.stringify(co.body));
  await s.hook("checkout.session.completed", f.paidSession(co.body.id));
  const planNow = async () => (await s.call("GET", "/api/me/payments", undefined, cal.token)).body.protocols[0];
  assert.equal((await planNow()).status, "paid");
  const total = f.charges.get("ch_" + co.body.id).amount;
  await s.hook("charge.refunded", f.refundedCharge(co.body.id, 5000));
  assert.deepEqual([(await planNow()).status, (await planNow()).refunded], ["paid", 5000]);
  await s.hook("charge.refunded", f.refundedCharge(co.body.id, total));
  assert.deepEqual([(await planNow()).status, (await planNow()).refunded], ["refunded", total]);
  // the old success page opened afterwards does not make it paid again
  s.forgetEvents(); s.edit("cal.client@example.com", (c) => { delete c.fulfilled; });
  await s.hook("checkout.session.completed", f.paidSession(co.body.id));
  assert.equal((await planNow()).status, "refunded");
  });
});

test("b. a paid invoice whose Stripe customer is nobody here still goes on the revenue ledger", async (t) => {
  const s = await start(t, { webhooks: real.webhooks, subscriptions: { retrieve: async () => { throw new Error("No such subscription"); } } });
  const paid = { id: "in_ghost", object: "invoice", customer: "cus_nobody_here", amount_paid: 8000, currency: "usd", status_transitions: { paid_at: 1793200000 }, metadata: {} };
  assert.equal((await s.hook("invoice.paid", paid)).status, 200);
  assert.deepEqual(s.readJson("revenue").map((r) => [r.ref, r.grossCents, r.category, r.clientId]), [["in_ghost", 8000, "clinic", null]]);
  await s.hook("invoice.paid", paid);
  assert.equal(s.readJson("revenue").length, 1, "once");
});

test("6. a refund landing while the manager's payout is in flight is clawed back in full", async (t) => {
  let clock = new Date("2026-11-20T15:00:00Z"), mid = null;
  const transfers = [];
  const stripe = { webhooks: real.webhooks, subscriptions: { retrieve: async () => { throw new Error("No such subscription"); } },
    paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { balance_transaction: { fee: 600, available_on: unix("2026-11-22T00:00:00Z") } } }) },
    transfers: { create: async (p) => { transfers.push(p.amount); if (mid) await mid(); return { id: "tr_" + transfers.length }; } } };
  const s = await start(t, stripe, { adminEmail: "jared@example.com", managerEmail: "josh@example.com", stripePublishableKey: "pk_test_public", now: () => clock });
  const owner = await s.login("jared@example.com");
  const mgr = await s.call("POST", "/api/admin/staff", { password: "staff-pass-1234", name: "Josh Lerner", email: "josh@example.com", role: "manager" }, owner);
  assert.equal(mgr.status, 201, JSON.stringify(mgr.body));
  await s.signup("Sam Roe"); s.edit("sam.roe@example.com", (c) => { c.stripeCustomerId = "cus_sam"; });
  assert.equal((await s.call("PUT", "/api/admin/partner-share/settings", { password: "admin-pass-123", enabled: true, managerStaffId: mgr.body.staff.id }, owner)).status, 200);
  s.writeJson("partner-share", { ...s.readJson("partner-share", {}), stripeAccountId: "acct_mgr", stripe: { payoutsEnabled: true, detailsSubmitted: true } });
  const ledger = () => s.readJson("partner-share-ledger").map((x) => [x.kind, x.cents, x.status]);
  const refund = (total) => s.hook("charge.refunded", { object: "charge", id: "ch_1", payment_intent: "pi_1", amount: 20000, amount_refunded: total, customer: "cus_sam" });

  // $200 membership, $6 fee: 15% of $194 = $29.10, cleared and ready
  const ts = unix("2026-11-20T15:00:00Z");
  await s.hook("invoice.paid", { object: "invoice", id: "in_1", customer: "cus_sam", amount_paid: 20000, currency: "usd", billing_reason: "subscription_cycle", status_transitions: { paid_at: ts }, metadata: {},
    parent: { subscription_details: { subscription: "sub_1", metadata: { kind: "membership", tier: "premium" } } }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_1" } }] } });
  await tick(100);
  clock = new Date("2026-11-23T15:00:00Z");
  assert.deepEqual((await s.call("POST", "/api/admin/partner-share/run", { job: "clear" }, owner)).body, { cleared: 1 });
  assert.deepEqual(ledger(), [["share", 2910, "ready"]]);

  // Half is refunded while the transfer is on its way to Stripe
  mid = async () => { mid = null; assert.equal((await refund(10000)).status, 200); };
  const out = await s.call("POST", "/api/admin/partner-share/run", { job: "payout" }, owner);
  assert.equal(out.body.paid.cents, 2910); assert.deepEqual(transfers, [2910]);
  assert.deepEqual(ledger(), [["share", 2910, "paid"], ["clawback", -1500, "ready"]], "paid at what was sent; what the refund took off is owed back");
  // The rest is refunded later: everything that was paid on it comes back, not part of it
  await refund(20000);
  const rows = ledger();
  assert.deepEqual(rows, [["share", 2910, "paid"], ["clawback", -1500, "ready"], ["clawback", -1410, "ready"]]);
  assert.equal(rows.reduce((a, r) => a + r[1], 0), 0, "nothing is kept on a payment that was refunded in full");
});

test("7. a commission that is ready from the start is on Net Revenue too: Stripe's fee comes off before it is paid", async (t) => {
  for (const [name, settings, paidDaysAgo, afterClear] of [["no hold", { holdDays: 0 }, 0, false], ["no hold, cleared first", { holdDays: 0 }, 0, true], ["an invoice delivered after its hold", { holdDays: 7 }, 10, true]]) {
    await t.test(name, async (t2) => {
      const clock = new Date("2026-11-20T10:00:00Z"), transfers = [];
      const stripe = { webhooks: real.webhooks, subscriptions: { retrieve: async () => { throw new Error("No such subscription"); } },
        paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { balance_transaction: { fee: 88, available_on: unix("2026-11-22T00:00:00Z") } } }) },
        transfers: { create: async (p) => { transfers.push(p.amount); return { id: "tr_" + transfers.length }; } } };
      const s = await start(t2, stripe, { now: () => clock });
      const adm = await s.login();
      assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true, ratePct: 10, minPayoutCents: 100, password: "admin-pass-123", ...settings }, adm)).status, 200);
      const pat = await s.signup("Pat Doe");
      const code = (await s.call("GET", "/api/me/referral", undefined, pat.token)).body.code;
      assert.equal((await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat.token)).status, 200);
      await s.signup("Sam Roe", { referralCode: code });
      s.edit("sam.roe@example.com", (c) => { c.stripeCustomerId = "cus_sam"; });
      s.edit("pat.doe@example.com", (c) => { c.affiliate.stripeAccountId = "acct_pat"; c.affiliate.stripe = { detailsSubmitted: true, payoutsEnabled: true }; });
      const paidAt = Math.floor(clock.getTime() / 1000) - paidDaysAgo * 86400;
      await s.hook("invoice.paid", { object: "invoice", id: "in_1", customer: "cus_sam", amount_paid: 1995, currency: "usd", billing_reason: "subscription_cycle", status_transitions: { paid_at: paidAt }, metadata: {},
        parent: { subscription_details: { subscription: "sub_1", metadata: { kind: "membership", tier: "member" } } }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_1" } }] } });
      await tick(100); // Stripe reports the fee to the revenue ledger
      assert.deepEqual(s.readJson("commissions").map((r) => [r.status, r.cents]), [["ready", 200]], "ready at once, before the fee is known");
      assert.equal(s.readJson("revenue")[0].feeCents, 88);
      if (afterClear) {
        await s.call("POST", "/api/admin/affiliates/run", { job: "clear" }, adm);
        assert.deepEqual(s.readJson("commissions").map((r) => [r.status, r.baseCents, r.feeCents, r.cents]), [["ready", 1907, 88, 191]], "10% of $19.95 less the $0.88 fee");
      }
      const out = (await s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, adm)).body;
      assert.deepEqual(transfers, [191], "what is transferred is the commission on Net Revenue");
      assert.equal(out.paid[0].cents, 191);
      assert.deepEqual(s.readJson("commissions").map((r) => [r.status, r.baseCents, r.feeCents, r.cents]), [["paid", 1907, 88, 191]]);
    });
  }
});

test("8. the accountability credit counts each day on one invoice, and the app shows the window the invoice will charge", async (t) => {
  const items = [];
  let clock = new Date("2026-11-10T15:00:00Z");
  const stripe = { webhooks: real.webhooks, invoiceItems: { create: async (p) => { items.push([p.invoice, p.amount, p.description]); return {}; } } };
  const s = await start(t, stripe, { now: () => clock });
  const pat = await s.signup("Pat Doe");
  s.edit("pat.doe@example.com", (c) => { c.stripeCustomerId = "cus_1"; c.workouts = [{ date: "2026-10-20" }, { date: "2026-11-03" }, { date: "2026-11-15" }]; });
  // Billed on the 15th at 2pm UTC (9am in Sarasota). Stripe says so when the subscription renews.
  const sub = (from, to) => ({ id: "sub_a", object: "subscription", customer: "cus_1", status: "active", metadata: { kind: "membership", tier: "accountability" }, items: { data: [{ current_period_start: unix(from), current_period_end: unix(to) }] } });
  const invoice = (id, from, to) => ({ id, object: "invoice", customer: "cus_1", amount_due: 2995, period_start: unix(from), period_end: unix(to), parent: { subscription_details: { subscription: "sub_a" } } });
  assert.equal((await s.hook("customer.subscription.updated", sub("2026-10-15T14:00:00Z", "2026-11-15T14:00:00Z"))).status, 200);

  let a;
  await t.test("the app shows the billing period, not the calendar month, and the invoice credits the same days", async () => {
  // What the app shows on the 10th of November
  a = (await s.call("GET", "/api/me/accountability", undefined, pat.token)).body;
  assert.equal(a.enabled, true);
  assert.deepEqual([a.from, a.to], ["2026-10-15", "2026-11-14"]);
  assert.equal(a.activeDays, 2, "20 October and 3 November are both in this bill");
  assert.equal(a.credit, 2); assert.equal(a.owed, 27.95);
  // and the invoice that closes that period credits the same two days
  clock = new Date("2026-11-15T14:00:05Z");
  assert.equal((await s.hook("invoice.created", invoice("in_nov", "2026-10-15T14:00:00Z", "2026-11-15T14:00:00Z"))).status, 200);
  assert.deepEqual(items, [["in_nov", -200, "Accountability credit: 2 active days (−$2.00)"]]);
  });

  await t.test("a workout on the renewal day is credited on one invoice, the one for the period that starts that day", async () => {
  if (!items.length) await s.hook("invoice.created", invoice("in_nov", "2026-10-15T14:00:00Z", "2026-11-15T14:00:00Z"));
  await s.hook("customer.subscription.updated", sub("2026-11-15T14:00:00Z", "2026-12-15T14:00:00Z"));
  await s.hook("invoice.created", invoice("in_dec", "2026-11-15T14:00:00Z", "2026-12-15T14:00:00Z"));
  assert.deepEqual(items.map((x) => [x[0], x[1]]), [["in_nov", -200], ["in_dec", -100]]);
  assert.equal(items.reduce((n, x) => n - x[1], 0), 300, "three active days, three dollars, over the two invoices");
  a = (await s.call("GET", "/api/me/accountability", undefined, pat.token)).body;
  assert.deepEqual([a.from, a.to, a.activeDays], ["2026-11-15", "2026-12-14", 1]);
  });

  await t.test("an evening renewal is that evening's day in Sarasota; an older record uses the month up to its 'until'", async () => {
  // A renewal late in the evening in Sarasota is that evening's day, not the next (which it is in UTC)
  await s.hook("customer.subscription.updated", sub("2026-12-16T01:30:00Z", "2027-01-16T01:30:00Z"));
  a = (await s.call("GET", "/api/me/accountability", undefined, pat.token)).body;
  assert.deepEqual([a.from, a.to], ["2026-12-15", "2027-01-14"]);
  // A membership record from before the period was kept: the month that ends on its "until"
  s.edit("pat.doe@example.com", (c) => { delete c.membership.periodStart; delete c.membership.periodEnd; c.membership.until = "2026-11-15"; });
  clock = new Date("2026-11-10T15:00:00Z");
  a = (await s.call("GET", "/api/me/accountability", undefined, pat.token)).body;
  assert.deepEqual([a.from, a.to, a.activeDays], ["2026-10-15", "2026-11-14", 2]);
  });
});

test("9. the member's calendar and its feed put a payment on the clinic's day, evenings included", async (t) => {
  const { mountMemberCalendar } = require("../lib/member-calendar");
  const { mountPayments } = require("../lib/payments");
  const kept = new Map(), app = { set: (k, v) => kept.set(k, v), get: (k) => kept.get(k), post() {} }, none = { post() {}, get() {}, put() {} };
  const store = { read: (n, d) => d, write() {} }, quiet = { warn() {}, info() {}, error() {} }, cfg = { tz: "America/New_York", stripeWebhookSecret: "w" };
  // Member since October; renews 1 December at 9pm in Sarasota (2am on the 2nd in UTC)
  const client = { id: "c1", stripeCustomerId: "cus_1", membership: { tier: "member", since: "2026-10-01", until: "2026-12-02", periodStart: unix("2026-11-02T02:00:00Z"), periodEnd: unix("2026-12-02T02:00:00Z"), stripeSubscriptionId: "sub_1", status: "active" } };
  // An invoice written and paid at the desk at 7:30pm on 18 November, and a card payment taken at 9pm that evening
  app.set("emrApi", { chartOf: () => ({ clinic: { invoices: [{ id: "i1", number: "1001", date: "2026-11-18", amount: 12000, status: "paid", paidAt: "2026-11-19T00:30:00.000Z" },
    { id: "i2", number: "1002", date: "2026-11-10", amount: 5000, status: "paid", paidAt: "2026-11-12T15:00:00.000Z" }] } }) });
  cfg.stripeClient = { charges: { list: async () => ({ data: [{ id: "ch_1", created: unix("2026-11-19T02:00:00Z"), amount: 9000, status: "succeeded", metadata: { kind: "service" } }] }) },
    customers: { retrieve: async () => ({}) }, paymentMethods: { list: async () => ({ data: [] }) }, invoices: { list: async () => ({ data: [] }) } };
  const pay = mountPayments({ app, admin: none, me: none, store, clients: () => [client], save() {}, today: () => "2026-11-19", notify: {}, cfg, settings: () => ({}), activity() {}, logger: quiet });
  await t.test("a card payment's date (Billing tab)", async () => {
    assert.equal((await pay.billing(client)).charges[0].date, "2026-11-18", "9pm on the 18th is the 18th");
  });
  const cal = mountMemberCalendar({ app, me: null, store, cfg, clients: () => [client], save() {}, tiers: () => [{ id: "member", name: "Membership" }] });
  const on = async (d) => (await cal.entries(client)).filter((e) => e.date === d).map((e) => `${e.t}|${e.s}`);
  await t.test("an invoice paid in the evening", async () => {
    assert.deepEqual((await on("2026-11-18")).filter((x) => /^Invoice/.test(x)), ["Invoice 1001: $120.00|Paid"], "written and paid the same evening: one entry, that day");
    assert.deepEqual((await on("2026-11-19")).filter((x) => /nvoice/.test(x)), [], "not a second entry the day after");
    assert.deepEqual(await on("2026-11-12"), ["Paid invoice 1002|$50.00"], "one paid on a later day still shows that day");
  });
  await t.test("a card payment taken in the evening", async () => {
    assert.deepEqual((await on("2026-11-18")).filter((x) => /^Visit/.test(x)), ["Visit: $90.00|Paid"]);
    assert.deepEqual((await on("2026-11-19")).filter((x) => /^Visit/.test(x)), []);
  });
  await t.test("the membership's renewal", async () => {
    assert.deepEqual(await on("2026-12-01"), ["Membership renews|Billed to the card on file"], "on the evening it is charged");
    assert.deepEqual(await on("2026-12-02"), []);
  });
  await t.test("the calendar feed", async () => {
    const ics = await cal.feed(client);
    assert.match(ics, /DTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261119\r\nSUMMARY:MD Fit invoice 1001/);
    assert.equal(/DTSTART;VALUE=DATE:20261119/.test(ics), false, "nothing on the 19th");
    assert.match(ics, /DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\nSUMMARY:MD Fit membership renews/);
  });
});
