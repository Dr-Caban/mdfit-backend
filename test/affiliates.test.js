"use strict";
// Affiliate commissions on subscriptions: who may earn, on what, the hold, payouts through Stripe Express, refunds,
// the owner's settings and the line that keeps clinical tiers out.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-aff-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", siteUrl: "https://mdfit.example.com", noVideoSync: true, noAffiliateJobs: true, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined), headers: res.headers }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const readJson = (n, d = []) => { const f = path.join(dataDir, n + ".json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d; };
  const writeJson = (n, v) => fs.writeFileSync(path.join(dataDir, n + ".json"), JSON.stringify(v));
  return { call, adminToken, base, dataDir, readJson, writeJson, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

test("affiliates: join, earn 5% of a referred friend's subscription, hold, Stripe Express payout, refund, and nothing clinical ever earns", async (t) => {
  const Stripe = require("stripe");
  const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });
  const calls = [];
  let payoutsEnabled = false;
  const fake = {
    webhooks: real.webhooks,
    accounts: {
      create: async (p) => (calls.push(["accounts.create", p]), { id: "acct_pat", details_submitted: false, payouts_enabled: false }),
      retrieve: async (id) => ({ id, details_submitted: payoutsEnabled, payouts_enabled: payoutsEnabled }),
      createLoginLink: async (id) => ({ url: `https://connect.stripe.com/express/${id}` })
    },
    accountLinks: { create: async (p) => (calls.push(["accountLinks.create", p]), { url: "https://connect.stripe.com/setup/s/abc" }) },
    transfers: { create: async (p) => (calls.push(["transfers.create", p]), { id: "tr_" + calls.length }) }
  };
  let clock = new Date("2026-11-02T10:00:00Z");
  const whsec = "whsec_test_secret";
  const s = await start({ stripeClient: fake, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: whsec, now: () => clock }); t.after(s.close);
  const hook = async (ev) => { const payload = JSON.stringify(ev); const header = real.webhooks.generateTestHeaderString({ payload, secret: whsec }); const r = await fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload }); return r.status; };
  const adm = await s.adminToken();

  // Pat refers Sam (Membership) and Lee (Expert Advice, which is access to Dr. Jared)
  const pat = (await signup(s)).body.token;
  const code = (await s.call("GET", "/api/me/referral", undefined, pat)).body.code;
  const sam = (await signup(s, { name: "Sam Roe", email: "sam@example.com", referralCode: code })).body.token;
  await signup(s, { name: "Lee Poe", email: "lee@example.com", referralCode: code });
  const list = s.readJson("clients"), P = list.find((c) => c.email === "pat@example.com"), S = list.find((c) => c.email === "sam@example.com"), L = list.find((c) => c.email === "lee@example.com");
  S.stripeCustomerId = "cus_sam"; S.membership = { tier: "member", since: "2026-11-02", until: "2026-12-02", stripeSubscriptionId: "sub_sam", status: "active" };
  L.stripeCustomerId = "cus_lee"; L.membership = { tier: "expert", since: "2026-11-02", until: "2026-12-02", stripeSubscriptionId: "sub_lee", status: "active" };
  s.writeJson("clients", list);
  const invoice = (over) => ({ id: "evt_" + Math.random().toString(36).slice(2), type: "invoice.paid", created: Math.floor(clock.getTime() / 1000), data: { object: { object: "invoice", id: "in_x", customer: "cus_sam", subscription: "sub_sam", amount_paid: 1995, currency: "usd", billing_reason: "subscription_cycle", status_transitions: { paid_at: Math.floor(clock.getTime() / 1000) }, metadata: {}, ...over } } });

  // Off by default: a paid invoice earns nothing, and nobody can join
  assert.equal(await hook(invoice({ id: "in_0" })), 200);
  assert.deepEqual(s.readJson("commissions"), []);
  assert.equal((await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat)).status, 409);

  // The owner switches it on. The clinical tiers cannot be made eligible, whatever is sent.
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true })).status, 401, "owner only");
  let r = await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true, eligibleTiers: ["member", "expert"] }, adm);
  assert.equal(r.status, 400); assert.match(r.body.error, /access to a clinician/);
  r = await s.call("PUT", "/api/admin/affiliates/settings", { enabled: true, ratePct: 5, holdDays: 7, minPayoutCents: 2500 }, adm);
  assert.equal(r.status, 200); assert.deepEqual(r.body.settings.eligibleTiers, ["member", "accountability"]);
  assert.deepEqual(r.body.tiers.filter((x) => x.clinical).map((x) => x.id), ["expert", "premium", "premium-plus"]);
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { ratePct: 51 }, adm)).status, 400);

  // Sam pays before Pat has joined: no commission (the programme is opt-in)
  assert.equal(await hook(invoice({ id: "in_1" })), 200);
  assert.deepEqual(s.readJson("commissions"), []);

  // Pat joins: terms must be agreed
  assert.equal((await s.call("POST", "/api/me/affiliate/join", {}, pat)).status, 400);
  r = await s.call("POST", "/api/me/affiliate/join", { agree: true }, pat);
  assert.equal(r.status, 200); assert.equal(r.body.joined, true); assert.equal(r.body.ratePct, 5); assert.deepEqual(r.body.eligible.map((x) => x.id), ["member", "accountability"]);

  // Sam's next monthly payment: 5% of $19.95 = $1.00, pending for 7 days; the same invoice twice counts once
  assert.equal(await hook(invoice({ id: "in_2" })), 200);
  assert.equal(await hook(invoice({ id: "in_2" })), 200);
  let led = s.readJson("commissions");
  assert.equal(led.length, 1); assert.equal(led[0].cents, 100); assert.equal(led[0].status, "pending"); assert.equal(led[0].referrerId, P.id); assert.equal(led[0].clientId, S.id); assert.equal(led[0].tier, "member");
  // Lee's Expert Advice payment earns nothing, and a protocol (clinic) invoice earns nothing
  assert.equal(await hook(invoice({ id: "in_3", customer: "cus_lee", subscription: "sub_lee", amount_paid: 5000 })), 200);
  assert.equal(await hook(invoice({ id: "in_4", subscription: "sub_protocol_sam", amount_paid: 30000 })), 200);
  assert.equal(s.readJson("commissions").length, 1);
  let mine = (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  assert.deepEqual([mine.balances.pendingCents, mine.balances.readyCents, mine.balances.paidCents], [100, 0, 0]);
  assert.equal(mine.ledger[0].who, "Sam R."); assert.match(mine.ledger[0].what, /^Membership · Nov 2026/); assert.equal(mine.referred, 2);
  assert.equal(mine.stripe.connected, false);

  // Stripe Express: one account, then the set-up link
  r = await s.call("POST", "/api/me/affiliate/stripe/onboard", {}, pat);
  assert.equal(r.status, 200); assert.equal(r.body.url, "https://connect.stripe.com/setup/s/abc");
  const created = calls.find((c) => c[0] === "accounts.create")[1];
  assert.equal(created.type, "express"); assert.equal(created.email, "pat@example.com"); assert.equal(created.metadata.clientId, P.id);
  await s.call("POST", "/api/me/affiliate/stripe/onboard", {}, pat);
  assert.equal(calls.filter((c) => c[0] === "accounts.create").length, 1, "the account is created once; a second press only makes a new link");
  assert.equal(s.readJson("clients").find((c) => c.id === P.id).affiliate.stripeAccountId, "acct_pat");
  assert.equal((await s.call("POST", "/api/me/affiliate/stripe/onboard", {}, sam)).status, 409, "join first");

  // The hold: nothing clears at day 6, it clears at day 7
  clock = new Date("2026-11-08T10:00:00Z");
  assert.deepEqual((await s.call("POST", "/api/admin/affiliates/run", { job: "clear" }, adm)).body.moved, {});
  clock = new Date("2026-11-09T10:01:00Z");
  assert.deepEqual((await s.call("POST", "/api/admin/affiliates/run", { job: "clear" }, adm)).body.moved, { [P.id]: 100 });
  mine = (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  assert.deepEqual([mine.balances.pendingCents, mine.balances.readyCents], [0, 100]);

  // Payout: not until Stripe says payouts are enabled, and not under the minimum
  let out = (await s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, adm)).body;
  assert.equal(out.paid.length, 0); assert.match(out.skipped[0].why, /Stripe account not ready/);
  payoutsEnabled = true;
  assert.equal((await s.call("GET", "/api/me/affiliate/stripe/status", undefined, pat)).body.payoutsEnabled, true);
  out = (await s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, adm)).body;
  assert.equal(out.paid.length, 0); assert.match(out.skipped[0].why, /under the \$25\.00 minimum/);
  await s.call("PUT", "/api/admin/affiliates/settings", { minPayoutCents: 100 }, adm);
  out = (await s.call("POST", "/api/admin/affiliates/run", { job: "payout" }, adm)).body;
  assert.deepEqual(out.paid.map((p) => [p.clientId, p.cents]), [[P.id, 100]]);
  const tr = calls.find((c) => c[0] === "transfers.create")[1];
  assert.equal(tr.amount, 100); assert.equal(tr.destination, "acct_pat"); assert.equal(tr.currency, "usd");
  led = s.readJson("commissions"); assert.equal(led[0].status, "paid"); assert.equal(led[0].transferId, "tr_" + calls.length);
  mine = (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  assert.deepEqual([mine.balances.readyCents, mine.balances.paidCents], [0, 100]);
  assert.equal((await s.call("POST", "/api/me/affiliate/stripe/dashboard", {}, pat)).body.url, "https://connect.stripe.com/express/acct_pat");

  // A refund: a pending commission is reversed; a paid one becomes a clawback against the next payout
  assert.equal(await hook(invoice({ id: "in_5" })), 200); // pending again
  assert.equal(await hook({ id: "evt_r1", type: "charge.refunded", created: Math.floor(clock.getTime() / 1000), data: { object: { object: "charge", id: "ch_5", customer: "cus_sam", invoice: "in_5", amount_refunded: 1995 } } }), 200);
  assert.equal(await hook({ id: "evt_r2", type: "charge.refunded", created: Math.floor(clock.getTime() / 1000), data: { object: { object: "charge", id: "ch_2", customer: "cus_sam", invoice: "in_2", amount_refunded: 1995 } } }), 200);
  led = s.readJson("commissions");
  assert.equal(led.find((x) => x.invoiceId === "in_5").status, "reversed");
  const claw = led.find((x) => x.kind === "clawback"); assert.equal(claw.cents, -100); assert.equal(claw.status, "ready");
  mine = (await s.call("GET", "/api/me/affiliate", undefined, pat)).body;
  assert.equal(mine.balances.readyCents, -100); assert.match(mine.ledger.find((x) => x.cents === -100).who, /refund/);

  // The owner's view, an adjustment, and the export
  const ov = (await s.call("GET", "/api/admin/affiliates", undefined, adm)).body;
  assert.equal(ov.affiliates.length, 1); assert.equal(ov.affiliates[0].name, "Pat Doe"); assert.equal(ov.affiliates[0].referred, 2); assert.equal(ov.affiliates[0].stripe.payoutsEnabled, true);
  assert.equal(ov.totals.paidCents, 100); assert.equal(ov.lastPayout.paid, 1);
  r = await s.call("POST", "/api/admin/affiliates/adjust", { clientId: P.id, cents: 250, reason: "Thank you for the first ten referrals" }, adm);
  assert.equal(r.status, 201);
  assert.equal((await s.call("GET", "/api/me/affiliate", undefined, pat)).body.balances.readyCents, 150);
  const csv = await fetch(s.base + "/api/admin/affiliates/export", { headers: { authorization: "Bearer " + adm } });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /^id,date,kind,affiliate,/); assert.match(text, /"Pat Doe","Sam Roe","Membership","19.95","5","1.00","paid"/);

  // Pausing stops new commissions; what was earned stays
  assert.equal((await s.call("PUT", `/api/admin/affiliates/${P.id}`, { status: "paused" }, adm)).status, 200);
  assert.equal(await hook(invoice({ id: "in_6" })), 200);
  assert.equal(s.readJson("commissions").filter((x) => x.invoiceId === "in_6").length, 0);
  assert.equal((await s.call("GET", "/api/me/affiliate", undefined, pat)).body.status, "paused");
});

test("affiliates: the free month for a referral can be switched off once commissions pay for referrals; the switch is off by default (unchanged behaviour)", async (t) => {
  const s = await start(); t.after(s.close);
  const adm = await s.adminToken();
  const pat = (await signup(s)).body.token;
  const code = (await s.call("GET", "/api/me/referral", undefined, pat)).body.code;
  await signup(s, { name: "Sam Roe", email: "sam@example.com", referralCode: code });
  let P = s.readJson("clients").find((c) => c.email === "pat@example.com");
  assert.equal(P.membership && P.membership.tier, "member", "the free month, as before");
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { freeMonthReward: false }, adm)).status, 200);
  await signup(s, { name: "Lee Poe", email: "lee@example.com", referralCode: code });
  P = s.readJson("clients").find((c) => c.email === "pat@example.com");
  assert.equal(P.referrals, 2, "the referral is still counted");
  assert.equal(P.membership.until, s.readJson("clients").find((c) => c.email === "pat@example.com").membership.until);
  const { clinicalTier } = require("../lib/affiliates");
  assert.equal(clinicalTier({ id: "member", meetings: 0 }), false);
  assert.equal(clinicalTier({ id: "custom", directMessages: true }), true);
  assert.equal(clinicalTier({ id: "vip", meetings: 1 }), true);
});
