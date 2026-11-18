"use strict";
// Affiliate commissions: the edges. First invoices that beat the membership webhook, tax, add-ons, the earning
// window, partial refunds and disputes under the current Stripe API, Connect events, payouts that fail, overlap or
// race a refund, members who leave versus members the clinic pauses, settings bounds, and Stripe not configured.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Stripe = require("stripe");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

const WHSEC = "whsec_test_secret", CONNECT_WHSEC = "whsec_connect_secret";
const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-affx-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", siteUrl: "https://mdfit.example.com", noVideoSync: true, noAffiliateJobs: true, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const readJson = (n, d = []) => { const f = path.join(dataDir, n + ".json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d; };
  const writeJson = (n, v) => fs.writeFileSync(path.join(dataDir, n + ".json"), JSON.stringify(v));
  const hook = async (ev, secret = WHSEC) => { const payload = JSON.stringify(ev); const header = real.webhooks.generateTestHeaderString({ payload, secret }); const r = await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload }); return r.status; };
  return { call, adminToken, base, readJson, writeJson, hook, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

// A Stripe stand-in: records every call; subscriptions and invoice payments answer from tables the test fills
function fakeStripe() {
  const calls = [], subs = {}, invoiceOfPI = {};
  const st = { payoutsEnabled: true, failTransfer: 0, gate: null, entered: null };
  const fake = {
    webhooks: real.webhooks,
    accounts: {
      create: async (p) => (calls.push(["accounts.create", p]), { id: "acct_pat", details_submitted: false, payouts_enabled: false }),
      retrieve: async (id) => ({ id, details_submitted: st.payoutsEnabled, payouts_enabled: st.payoutsEnabled }),
      createLoginLink: async (id) => ({ url: `https://connect.stripe.com/express/${id}` })
    },
    accountLinks: { create: async () => ({ url: "https://connect.stripe.com/setup/s/abc" }) },
    subscriptions: { retrieve: async (id) => { calls.push(["subscriptions.retrieve", id]); if (!subs[id]) throw new Error("No such subscription"); return { id, metadata: subs[id] }; } },
    invoicePayments: { list: async (p) => { calls.push(["invoicePayments.list", p]); const inv = invoiceOfPI[p.payment.payment_intent]; return { data: inv ? [{ invoice: inv }] : [] }; } },
    transfers: { create: async (p, opts) => {
      calls.push(["transfers.create", p, opts]);
      if (st.entered) st.entered();
      if (st.gate) await st.gate;
      if (st.failTransfer > 0) { st.failTransfer--; throw new Error("Insufficient funds in Stripe balance"); }
      return { id: "tr_" + calls.filter((c) => c[0] === "transfers.create").length };
    } }
  };
  return { fake, calls, subs, invoiceOfPI, st };
}

// Pat (the affiliate, joined, Stripe connected and payable) referred Sam (Stripe customer cus_sam)
async function world(t, settings = {}, extra = {}) {
  const f = fakeStripe();
  let clock = new Date("2026-11-02T10:00:00Z");
  const s = await start({ stripeClient: f.fake, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: WHSEC, stripeConnectWebhookSecret: CONNECT_WHSEC, now: () => clock, ...extra });
  t.after(s.close);
  const adm = await s.adminToken();
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true, ratePct: 5, holdDays: 7, minPayoutCents: 100, ...settings }, adm)).status, 200);
  const pat = (await signup(s)).body.token;
  const code = (await s.call("GET", "/api/me/referral", undefined, pat)).body.code;
  assert.equal((await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat)).status, 200);
  const sam = (await signup(s, { name: "Sam Roe", email: "sam@example.com", referralCode: code })).body.token;
  const list = s.readJson("clients");
  const P = list.find((c) => c.email === "pat@example.com"), S = list.find((c) => c.email === "sam@example.com");
  S.stripeCustomerId = "cus_sam";
  P.affiliate.stripeAccountId = "acct_pat"; P.affiliate.stripe = { detailsSubmitted: true, payoutsEnabled: true };
  s.writeJson("clients", list);
  const ts = () => Math.floor(clock.getTime() / 1000);
  let n = 0;
  const invoice = (over = {}, md = { kind: "membership", tier: "member" }, sub = "sub_sam") => ({ id: "evt_" + ++n, type: "invoice.paid", created: ts(), data: { object: {
    object: "invoice", id: "in_" + n, customer: "cus_sam", amount_paid: 1995, currency: "usd", billing_reason: "subscription_cycle",
    parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: md } }, status_transitions: { paid_at: ts() }, metadata: {}, ...over } } });
  const ledger = () => s.readJson("commissions");
  const mine = async () => (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  return { s, f, adm, pat, sam, P, S, invoice, ledger, mine, setClock: (d) => { clock = new Date(d); }, ts };
}

test("affiliates edge: the first invoice can beat the membership webhook; the subscription's own metadata decides, tax never counts", async (t) => {
  const w = await world(t);
  // Sam has no membership on record yet. The invoice carries the subscription's metadata: Membership earns.
  assert.equal(w.S.membership, undefined);
  assert.equal(await w.s.hook(w.invoice({ billing_reason: "subscription_create" })), 200);
  assert.deepEqual(w.ledger().map((r) => [r.tier, r.cents, r.status]), [["member", 100, "pending"]]);
  // A protocol (clinical) subscription, and a clinical tier named in metadata, earn nothing
  await w.s.hook(w.invoice({ amount_paid: 30000 }, { kind: "protocol" }, "sub_protocol"));
  await w.s.hook(w.invoice({ amount_paid: 5000 }, { kind: "membership", tier: "expert" }, "sub_expert"));
  await w.s.hook(w.invoice({ amount_paid: 20000 }, { kind: "membership", tier: "premium" }, "sub_premium"));
  assert.equal(w.ledger().length, 1);
  // No metadata on the invoice: Stripe is asked. Accountability earns; tax is taken out first ($31.95 - $2.00 tax).
  w.f.subs.sub_acc = { kind: "membership", tier: "accountability" };
  await w.s.hook(w.invoice({ amount_paid: 3195, total_taxes: [{ amount: 200 }], parent: { subscription_details: { subscription: "sub_acc" } } }));
  const acc = w.ledger().find((r) => r.tier === "accountability");
  assert.equal(acc.baseCents, 2995); assert.equal(acc.cents, 150);
  // A subscription Stripe doesn't know, and an invoice with no subscription at all (a one-off clinic charge): nothing
  await w.s.hook(w.invoice({ parent: { subscription_details: { subscription: "sub_gone" } } }));
  await w.s.hook(w.invoice({ amount_paid: 12000, parent: null }));
  assert.equal(w.ledger().length, 2);
  // A $0 invoice (trial, fully discounted) earns nothing
  await w.s.hook(w.invoice({ amount_paid: 0 }));
  assert.equal(w.ledger().length, 2);
});

test("affiliates edge: subscription add-ons the owner lists earn on their own line only; never more than was paid; never on a protocol", async (t) => {
  const w = await world(t, { eligibleAddOns: ["sunny_unlimited", " bad key! ", ""] });
  const r = await w.s.call("GET", "/api/admin/affiliates", undefined, w.adm);
  assert.deepEqual(r.body.settings.eligibleAddOns, ["sunny_unlimited"], "junk keys are dropped");
  const lines = [{ price: { lookup_key: "sunny_unlimited", id: "price_1" }, amount: 599, description: "Solomon unlimited" }, { price: { lookup_key: "massage_60", id: "price_2" }, amount: 9000 }];
  await w.s.hook(w.invoice({ amount_paid: 9599, lines: { data: lines } }, { kind: "addon" }, "sub_addon"));
  assert.deepEqual(w.ledger().map((x) => [x.baseCents, x.cents, x.label]), [[599, 30, "Solomon unlimited"]]);
  // The same add-on on a protocol subscription: nothing
  await w.s.hook(w.invoice({ amount_paid: 9599, lines: { data: lines } }, { kind: "protocol" }, "sub_protocol"));
  // An add-on line bigger than what was paid (a credit took most of it): capped at what was paid
  await w.s.hook(w.invoice({ amount_paid: 200, lines: { data: [lines[0]] } }, { kind: "addon" }, "sub_addon"));
  assert.deepEqual(w.ledger().map((x) => x.baseCents), [599, 200]);
});

test("affiliates edge: the earning window ends after durationMonths; a hold of 0 days is ready at once; a rate change leaves old rows alone", async (t) => {
  const w = await world(t, { durationMonths: 2, holdDays: 0 });
  await w.s.hook(w.invoice());
  assert.equal(w.ledger()[0].status, "ready");
  await w.s.call("PUT", "/api/admin/affiliates/settings", { ratePct: 10 }, w.adm);
  w.setClock("2027-01-02T10:00:00Z"); await w.s.hook(w.invoice());
  w.setClock("2027-02-02T10:00:00Z"); await w.s.hook(w.invoice());
  assert.deepEqual(w.ledger().map((r) => [r.ratePct, r.cents]), [[5, 100], [10, 200]], "earns through month two, not after");
});

test("affiliates edge: partial refunds take back their share, a full refund reverses the rest; a dispute is found through the payment intent", async (t) => {
  const w = await world(t);
  await w.s.hook(w.invoice({ payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_1" } }] } }));
  const row = w.ledger()[0]; assert.equal(row.paymentIntent, "pi_1");
  // Current API: the charge has no invoice field, only its payment intent
  const refund = (amt, id) => ({ id, type: "charge.refunded", created: w.ts(), data: { object: { object: "charge", id: "ch_1", customer: "cus_sam", payment_intent: "pi_1", amount: 1995, amount_refunded: amt } } });
  await w.s.hook(refund(998, "evt_rf1"));
  let led = w.ledger();
  assert.deepEqual(led.map((r) => [r.kind, r.cents, r.status]), [["commission", 100, "pending"], ["clawback", -50, "pending"]]);
  assert.equal((await w.mine()).balances.pendingCents, 50);
  await w.s.hook(refund(998, "evt_rf1b")); // the same running total again: nothing more
  assert.equal(w.ledger().length, 2);
  await w.s.hook(refund(1995, "evt_rf2"));
  led = w.ledger();
  assert.deepEqual(led.map((r) => r.status), ["reversed", "reversed"]);
  assert.deepEqual([(await w.mine()).balances.pendingCents, (await w.mine()).balances.readyCents], [0, 0]);
  // A dispute whose invoice only Stripe knows: looked up, then reversed in full
  await w.s.hook(w.invoice());
  const inv = w.ledger().find((r) => r.status === "pending").invoiceId;
  w.f.invoiceOfPI.pi_d = inv;
  await w.s.hook({ id: "evt_dp", type: "charge.dispute.created", created: w.ts(), data: { object: { object: "dispute", id: "dp_1", charge: "ch_d", payment_intent: "pi_d", amount: 1995 } } });
  assert.equal(w.ledger().find((r) => r.invoiceId === inv).status, "reversed");
  assert.ok(w.f.calls.some((c) => c[0] === "invoicePayments.list"));
  // A refund for a payment that earned nothing changes nothing
  await w.s.hook({ id: "evt_rx", type: "charge.refunded", created: w.ts(), data: { object: { object: "charge", id: "ch_x", payment_intent: "pi_unknown", amount: 500, amount_refunded: 500 } } });
  assert.equal(w.ledger().length, 3);
});

test("affiliates edge: Connect events are signed with their own secret; only account.updated is read, never a connected account's own payments", async (t) => {
  const w = await world(t);
  const list = w.s.readJson("clients"); list.find((c) => c.id === w.P.id).affiliate.stripe = { detailsSubmitted: false, payoutsEnabled: false }; w.s.writeJson("clients", list);
  const upd = { id: "evt_acct", type: "account.updated", account: "acct_pat", created: w.ts(), data: { object: { object: "account", id: "acct_pat", details_submitted: true, payouts_enabled: true } } };
  assert.equal(await w.s.hook(upd, CONNECT_WHSEC), 200);
  assert.equal((await w.mine()).stripe.payoutsEnabled, true);
  assert.equal(await w.s.hook({ ...upd, id: "evt_bad" }, "whsec_wrong"), 400);
  // A payment on the affiliate's own account must never look like Sam paying the clinic
  const ev = w.invoice(); ev.account = "acct_pat";
  assert.equal(await w.s.hook(ev, CONNECT_WHSEC), 200);
  assert.equal(w.ledger().length, 0);
});

test("affiliates edge: payouts survive a failed transfer, never overlap, and a refund mid-transfer becomes a clawback", async (t) => {
  const w = await world(t, { holdDays: 0 });
  await w.s.hook(w.invoice());
  // Stripe balance too low: the rows stay ready, the owner is told, the next run pays them
  w.f.st.failTransfer = 1;
  let out = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.equal(out.failed.length, 1); assert.match(out.failed[0].error, /Insufficient/);
  assert.equal(w.ledger()[0].status, "ready");
  out = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.equal(out.paid.length, 1);
  const tc = w.f.calls.filter((c) => c[0] === "transfers.create");
  assert.equal(tc.length, 2); assert.ok(tc[0][2].idempotencyKey); assert.equal(tc[0][2].idempotencyKey, tc[1][2].idempotencyKey, "a retry of the same rows carries the same key");
  // Two runs at once: one transfer. A refund lands while the transfer is in flight.
  await w.s.hook(w.invoice());
  const inv = w.ledger().find((r) => r.status === "ready").invoiceId;
  let release; w.f.st.gate = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { w.f.st.entered = r; });
  const first = w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm);
  await entered;
  const second = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.match(second.error, /already running/);
  await w.s.hook({ id: "evt_mid", type: "charge.refunded", created: w.ts(), data: { object: { object: "charge", id: "ch_m", invoice: inv, amount: 1995, amount_refunded: 1995 } } });
  release(); out = (await first).body;
  assert.equal(out.paid.length, 1);
  assert.equal(w.f.calls.filter((c) => c[0] === "transfers.create").length, 3);
  const led = w.ledger();
  assert.equal(led.find((r) => r.invoiceId === inv && r.kind === "commission").status, "paid");
  assert.deepEqual(led.filter((r) => r.kind === "clawback").map((r) => [r.cents, r.status]), [[-100, "ready"]]);
  assert.equal((await w.mine()).balances.readyCents, -100, "it comes off the next payout");
  // A negative balance never pays out
  out = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.equal(out.paid.length, 0); assert.match(out.skipped[0].why, /minimum/);
});

test("affiliates edge: a member who leaves stops earning but is still paid; a pause by the clinic holds both and can't be undone by the member", async (t) => {
  const w = await world(t, { holdDays: 0 });
  await w.s.hook(w.invoice());
  let r = await w.s.call("POST", "/api/me/affiliate/leave", {}, w.pat);
  assert.equal(r.body.status, "left"); assert.equal(r.body.joined, false);
  await w.s.hook(w.invoice());
  assert.equal(w.ledger().length, 1, "no new commissions after leaving");
  let out = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.equal(out.paid.length, 1, "what was earned is still paid");
  // Rejoin, then the clinic pauses
  assert.equal((await w.s.call("POST", "/api/me/affiliate/join", { agree: true }, w.pat)).body.status, "active");
  await w.s.hook(w.invoice());
  assert.equal((await w.s.call("PUT", `/api/admin/affiliates/${w.P.id}`, { status: "paused" }, w.adm)).status, 200);
  assert.equal((await w.s.call("POST", "/api/me/affiliate/join", { agree: true }, w.pat)).status, 403);
  assert.equal((await w.s.call("POST", "/api/me/affiliate/leave", {}, w.pat)).body.status, "paused", "leaving can't turn a pause into a payout");
  out = (await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.adm)).body;
  assert.equal(out.paid.length, 0); assert.match(out.skipped[0].why, /paused/);
  // The owner can't enrol someone who never agreed to the terms, but can block anyone
  assert.equal((await w.s.call("PUT", `/api/admin/affiliates/${w.S.id}`, { status: "active" }, w.adm)).status, 409);
  assert.equal((await w.s.call("PUT", `/api/admin/affiliates/${w.S.id}`, { status: "removed" }, w.adm)).status, 200);
  assert.equal((await w.s.call("POST", "/api/me/affiliate/join", { agree: true }, w.sam)).status, 403);
  assert.equal((await w.s.call("PUT", `/api/admin/affiliates/${w.S.id}`, { status: "boss" }, w.adm)).status, 400);
  assert.equal((await w.s.call("PUT", "/api/admin/affiliates/nobody", { status: "removed" }, w.adm)).status, 404);
});

test("affiliates edge: settings are bounded; adjustments are bounded; only the owner sees the owner's view; a member sees only their own ledger", async (t) => {
  const w = await world(t);
  const bad = [{ ratePct: 2.555 }, { ratePct: -1 }, { ratePct: "x" }, { holdDays: 61 }, { holdDays: 1.5 }, { minPayoutCents: 99 }, { minPayoutCents: 100001 },
    { durationMonths: 121 }, { eligibleTiers: "member" }, { eligibleTiers: ["nope"] }, { eligibleTiers: ["premium-plus"] }, { enabled: "yes" }, { freeMonthReward: 1 }, {}, { eligibleAddOns: "x" }];
  for (const b of bad) assert.equal((await w.s.call("PUT", "/api/admin/affiliates/settings", b, w.adm)).status, 400, JSON.stringify(b));
  assert.equal((await w.s.call("PUT", "/api/admin/affiliates/settings", { ratePct: 7.5 }, w.adm)).body.settings.ratePct, 7.5);
  for (const b of [{ clientId: w.P.id, cents: 0, reason: "zero" }, { clientId: w.P.id, cents: 1.5, reason: "half" }, { clientId: w.P.id, cents: 100001, reason: "too much" }, { clientId: w.P.id, cents: 100, reason: "" }])
    assert.equal((await w.s.call("POST", "/api/admin/affiliates/adjust", b, w.adm)).status, 400, JSON.stringify(b));
  assert.equal((await w.s.call("POST", "/api/admin/affiliates/adjust", { clientId: w.S.id, cents: 100, reason: "not an affiliate" }, w.adm)).status, 404);
  assert.equal((await w.s.call("POST", "/api/admin/affiliates/run", { job: "rm -rf" }, w.adm)).status, 400);
  // Who can see what
  assert.equal((await w.s.call("GET", "/api/admin/affiliates", undefined, w.pat)).status, 401);
  assert.equal((await w.s.call("GET", "/api/me/affiliate")).status, 401);
  assert.equal((await w.s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, w.pat)).status, 401);
  await w.s.hook(w.invoice());
  const sam = (await w.s.call("GET", "/api/me/affiliate", undefined, w.sam)).body;
  assert.equal(sam.ledger.length, 0); assert.equal(sam.balances.pendingCents, 0); assert.equal(sam.joined, false);
  const pat = await w.mine();
  assert.equal(pat.ledger.length, 1); assert.equal(pat.ledger[0].who, "Sam R.");
  assert.ok(!JSON.stringify(pat).includes("sam@example.com"), "an affiliate never sees who they referred beyond a first name and initial");
  // The funnel: link opened -> joined -> paying for an eligible subscription now
  const code = (await w.s.call("GET", "/api/me/referral", undefined, w.pat)).body.code;
  await w.s.call("POST", "/api/referral/visit", { code }); await w.s.call("POST", "/api/referral/visit", { code: code.toLowerCase() });
  const list = w.s.readJson("clients"); list.find((c) => c.id === w.S.id).membership = { tier: "member", until: "2026-12-02", stripeSubscriptionId: "sub_sam", status: "active" }; w.s.writeJson("clients", list);
  assert.deepEqual((await w.mine()).funnel, { opened: 2, joined: 1, paying: 1 });
});

test("affiliates edge: embedded Stripe payouts get a fresh account session for the member's own account; no publishable key means the hosted page instead", async (t) => {
  const w = await world(t, {}, { stripePublishableKey: "pk_test_public" });
  const sessions = [];
  w.f.fake.accountSessions = { create: async (p) => (sessions.push(p), { client_secret: "accs_secret_" + sessions.length }) };
  const me = await w.mine();
  assert.equal(me.stripe.embedded, true); assert.equal(me.stripe.publishableKey, "pk_test_public");
  let r = await w.s.call("POST", "/api/me/affiliate/stripe/session", {}, w.pat);
  assert.equal(r.status, 200); assert.deepEqual(r.body, { clientSecret: "accs_secret_1", publishableKey: "pk_test_public" });
  assert.equal(sessions[0].account, "acct_pat", "only ever the member's own account");
  const c = sessions[0].components;
  assert.equal(c.account_onboarding.enabled, true); assert.equal(c.payouts.enabled, true); assert.equal(c.payouts.features.instant_payouts, true);
  assert.equal(c.payouts.features.edit_payout_schedule, false); assert.equal(c.notification_banner.enabled, true); assert.equal(c.account_management.enabled, true);
  // A member who hasn't joined gets nothing; the account is never created for them
  assert.equal((await w.s.call("POST", "/api/me/affiliate/stripe/session", {}, w.sam)).status, 409);
  assert.equal(sessions.length, 1);
  // Stripe failing is a plain error, not a crash
  w.f.fake.accountSessions.create = async () => { throw new Error("boom"); };
  assert.equal((await w.s.call("POST", "/api/me/affiliate/stripe/session", {}, w.pat)).status, 502);
});

test("affiliates edge: no publishable key, no embedded session (the app falls back to Stripe's hosted page)", async (t) => {
  const prev = process.env.STRIPE_PUBLISHABLE_KEY; delete process.env.STRIPE_PUBLISHABLE_KEY; t.after(() => { if (prev !== undefined) process.env.STRIPE_PUBLISHABLE_KEY = prev; });
  const w = await world(t);
  assert.equal((await w.mine()).stripe.embedded, false);
  assert.equal((await w.s.call("POST", "/api/me/affiliate/stripe/session", {}, w.pat)).status, 503);
  assert.equal((await w.s.call("POST", "/api/me/affiliate/stripe/onboard", {}, w.pat)).status, 200, "the hosted page still works");
});

test("affiliates edge: with Stripe not configured nothing breaks; the member is told payouts aren't ready", async (t) => {
  const s = await start({ stripeSecretKey: "", stripeClient: null }); t.after(s.close);
  const adm = await s.adminToken();
  await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true }, adm);
  const pat = (await signup(s)).body.token;
  assert.equal((await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat)).status, 200);
  const me = (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  assert.equal(me.stripe.available, false);
  assert.equal((await s.call("POST", "/api/me/affiliate/stripe/onboard", {}, pat)).status, 503);
  assert.equal((await s.call("GET", "/api/me/affiliate/stripe/status", undefined, pat)).body.connected, false);
  assert.equal((await s.call("POST", "/api/me/affiliate/stripe/dashboard", {}, pat)).status, 409);
  assert.match((await s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, adm)).body.error, /not configured/);
});
