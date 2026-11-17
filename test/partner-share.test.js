"use strict";
// The manager's revenue share (Agreement Revision 2, Section 4) and the revenue ledger: categories (Exhibit A), Net
// Revenue (2.7), clearing, the owner's automatic-payout switch, payment notices, refunds, statements, and who may see
// what (Section 11.2: no patient data in the manager's console).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Stripe = require("stripe");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

const WHSEC = "whsec_test_secret";
const real = new Stripe("sk_test_fake", { apiVersion: "2026-10-28.endive" });

function fakeStripe() {
  const calls = [], intents = {}, st = { payoutsEnabled: true, failTransfer: false };
  const fake = {
    webhooks: real.webhooks,
    accounts: { create: async (p) => (calls.push(["accounts.create", p]), { id: "acct_mgr", details_submitted: false, payouts_enabled: false }), retrieve: async (id) => ({ id, details_submitted: st.payoutsEnabled, payouts_enabled: st.payoutsEnabled }) },
    accountLinks: { create: async () => ({ url: "https://connect.stripe.com/setup/s/m" }) },
    accountSessions: { create: async (p) => (calls.push(["accountSessions.create", p]), { client_secret: "accs_mgr" }) },
    subscriptions: { retrieve: async () => { throw new Error("No such subscription"); } },
    paymentIntents: { retrieve: async (id) => { calls.push(["paymentIntents.retrieve", id]); const bt = intents[id]; if (!bt) throw new Error("No such intent"); return { id, latest_charge: { balance_transaction: bt } }; } },
    transfers: { create: async (p, o) => { calls.push(["transfers.create", p, o]); if (st.failTransfer) throw new Error("Insufficient funds"); return { id: "tr_" + calls.filter((c) => c[0] === "transfers.create").length }; } }
  };
  return { fake, calls, intents, st };
}

async function start(t) {
  const f = fakeStripe();
  let clock = new Date("2026-11-20T15:00:00Z");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-share-"));
  const app = createApp({ adminEmail: "jared@example.com", adminPasswordHash: hashPassword("owner-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: "https://mdfit.example.com", noVideoSync: true, noAffiliateJobs: true, stripeClient: f.fake, stripeSecretKey: "rk_test_x", stripeWebhookSecret: WHSEC, stripePublishableKey: "pk_test_public", now: () => clock });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await res.text(); let data; try { data = JSON.parse(text); } catch {} return { status: res.status, body: data, text }; };
  const readJson = (n, d = []) => { const p = path.join(dataDir, n + ".json"); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d; };
  const writeJson = (n, v) => fs.writeFileSync(path.join(dataDir, n + ".json"), JSON.stringify(v));
  const hook = async (ev) => { const payload = JSON.stringify(ev); const header = real.webhooks.generateTestHeaderString({ payload, secret: WHSEC }); return (await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload })).status; };
  const owner = (await call("POST", "/api/admin/login", { email: "jared@example.com", password: "owner-pass-123" })).body.token;
  const staffLogin = async (body) => { const r = await call("POST", "/api/admin/staff", { password: "staff-pass-1234", ...body }, owner); assert.equal(r.status, 201, JSON.stringify(r.body)); return { id: r.body.staff.id, token: (await call("POST", "/api/admin/login", { email: body.email, password: "staff-pass-1234" })).body.token }; };
  // A member who pays (Stripe customer cus_sam)
  await call("POST", "/api/clients/signup", { name: "Sam Roe", email: "sam@example.com", phone: "941-555-0100", password: "sam-pass-123" });
  const list = readJson("clients"); list[0].stripeCustomerId = "cus_sam"; writeJson("clients", list);
  let n = 0;
  const ts = () => Math.floor(clock.getTime() / 1000);
  const invoice = (over = {}, md = { kind: "membership", tier: "member" }) => { n++; return { id: "evt_" + n, type: "invoice.paid", created: ts(), data: { object: { object: "invoice", id: "in_" + n, customer: "cus_sam", amount_paid: 1995, currency: "usd", billing_reason: "subscription_cycle",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_" + n, metadata: md } }, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_" + n } }] }, status_transitions: { paid_at: ts() }, metadata: {}, ...over } } }; };
  const checkout = (md, amount = 15000) => { n++; return { id: "evt_" + n, type: "checkout.session.completed", created: ts(), data: { object: { object: "checkout.session", id: "cs_" + n, mode: "payment", payment_status: "paid", customer: "cus_sam", client_reference_id: list[0].id, amount_total: amount, currency: "usd", payment_intent: "pi_" + n, metadata: md, total_details: { amount_tax: 0 } } } }; };
  return { f, call, hook, owner, staffLogin, readJson, writeJson, invoice, checkout, setClock: (d) => { clock = new Date(d); }, ts, client: list[0] };
}

test("partner share: categories by Exhibit A, Net Revenue after Stripe's fee, clears when Stripe clears, paid only once the owner switches automatic payouts on, with a payment notice the manager accepts", async (t) => {
  const s = await start(t);
  const mgr = await s.staffLogin({ name: "Josh Lerner", email: "josh@example.com", role: "manager" });
  const dev = await s.staffLogin({ name: "Dev Person", email: "dev@example.com", role: "developer" });
  // Not set up: the manager's console says whose it is; the developer never gets in; settings are the owner's
  assert.equal((await s.call("GET", "/api/admin/partner/share", undefined, mgr.token)).status, 403);
  assert.equal((await s.call("GET", "/api/admin/partner/share", undefined, dev.token)).status, 403);
  assert.equal((await s.call("PUT", "/api/admin/partner-share/settings", { enabled: true, managerStaffId: mgr.id }, mgr.token)).status, 403, "the manager can't set their own share");
  assert.equal((await s.call("PUT", "/api/admin/partner-share/settings", { managerStaffId: dev.id }, s.owner)).status, 400, "only a Manager account can hold the share");
  let r = await s.call("PUT", "/api/admin/partner-share/settings", { enabled: true, managerStaffId: mgr.id }, s.owner);
  assert.equal(r.status, 200); assert.equal(r.body.activePct, 15); assert.equal(r.body.autoPay, false);

  // Payments, one of each kind
  s.f.intents.pi_1 = { fee: 88, available_on: Math.floor(Date.parse("2026-11-22T00:00:00Z") / 1000) };
  assert.equal(await s.hook(s.invoice()), 200); // Membership $19.95 -> online
  const settings = s.readJson("settings", {}); settings.services = [{ id: "video-eval", name: "Video evaluation", remote: true }, { id: "eval", name: "Evaluation", remote: false }]; s.writeJson("settings", settings);
  s.f.intents.pi_2 = { fee: 465, available_on: Math.floor(Date.parse("2026-11-22T00:00:00Z") / 1000) };
  await s.hook(s.checkout({ kind: "service", service: "video-eval" }));          // remote evaluation -> online (Exhibit A)
  await s.hook(s.checkout({ kind: "service", service: "eval" }));                // in-person visit -> clinic
  await s.hook(s.invoice({ amount_paid: 30000 }, { kind: "protocol" }));          // protocol -> clinic
  await s.hook(s.checkout({ kind: "mystery" }, 5000));                          // unknown -> unclassified
  let rev = s.readJson("revenue");
  assert.deepEqual(rev.map((x) => x.category), ["online", "online", "clinic", "clinic", "unclassified"]);
  let led = s.readJson("partner-share-ledger");
  assert.equal(led.length, 2, "only online revenue earns a share");
  assert.deepEqual(led.map((x) => [x.pct, x.status]), [[15, "pending"], [15, "pending"]]);
  // The same payment twice (webhook retry, or the site's confirm) is one row
  await s.hook({ ...s.checkout({ kind: "service", service: "eval" }), data: { object: { ...s.checkout({}).data.object, id: rev[2].ref, mode: "payment", amount_total: 15000, metadata: { kind: "service", service: "eval" }, client_reference_id: s.client.id, customer: "cus_sam" } } });
  assert.equal(s.readJson("revenue").length, 5);

  // The owner classifies the unknown one as online: it earns from then on
  const unc = (await s.call("GET", "/api/admin/partner-share", undefined, s.owner)).body.unclassified[0];
  assert.equal((await s.call("POST", "/api/admin/partner-share/classify", { revenueId: unc.id, category: "online" }, mgr.token)).status, 403);
  assert.equal((await s.call("POST", "/api/admin/partner-share/classify", { revenueId: unc.id, category: "online" }, s.owner)).status, 200);
  assert.equal(s.readJson("partner-share-ledger").length, 3);

  // Before Stripe clears the funds: still pending. After: ready, with Stripe's fee out of the base (Section 2.7)
  assert.equal((await s.call("POST", "/api/admin/partner-share/run", { job: "clear" }, s.owner)).body.cleared, 0);
  s.setClock("2026-11-22T01:00:00Z");
  assert.equal((await s.call("POST", "/api/admin/partner-share/run", { job: "clear" }, s.owner)).body.cleared, 2, "the third has no fee from Stripe yet, so it waits");
  led = s.readJson("partner-share-ledger");
  const mem = led.find((x) => x.product === "Membership"), vid = led.find((x) => x.product === "Video evaluation");
  assert.equal(mem.status, "ready"); assert.equal(mem.netCents, 1995 - 88); assert.equal(mem.cents, Math.round((1995 - 88) * 0.15));
  assert.equal(vid.cents, Math.round((15000 - 465) * 0.15));

  // What the manager sees: amounts and products, never who paid
  let view = (await s.call("GET", "/api/admin/partner/share", undefined, mgr.token)).body;
  assert.equal(view.pct, 15); assert.equal(view.balances.readyCents, mem.cents + vid.cents);
  assert.ok(!JSON.stringify(view).includes("sam@example.com") && !JSON.stringify(view).includes("Sam") && !JSON.stringify(view).includes(s.client.id), "no patient data in the manager's console");

  // Automatic payouts are off: the hourly job pays nothing. The manager sets up their own Express account.
  r = await s.call("POST", "/api/admin/partner/stripe/session", {}, mgr.token);
  assert.equal(r.status, 200); assert.equal(r.body.clientSecret, "accs_mgr");
  assert.equal(s.f.calls.find((c) => c[0] === "accountSessions.create")[1].account, "acct_mgr");
  assert.equal((await s.call("POST", "/api/admin/partner/stripe/session", {}, s.owner)).status, 403, "the owner doesn't open the manager's bank details");
  await s.call("GET", "/api/admin/partner/stripe/status", undefined, mgr.token);
  // The owner switches automatic payouts on: recorded with who and when
  r = await s.call("PUT", "/api/admin/partner-share/settings", { autoPay: true }, s.owner);
  assert.equal(r.body.autoPay, true); assert.equal(r.body.autoPayOnBy, "jared@example.com"); assert.ok(r.body.autoPayOnAt);
  r = await s.call("POST", "/api/admin/partner-share/run", { job: "payout" }, s.owner);
  assert.equal(r.body.paid.cents, mem.cents + vid.cents);
  const tr = s.f.calls.find((c) => c[0] === "transfers.create");
  assert.equal(tr[1].destination, "acct_mgr"); assert.ok(tr[2].idempotencyKey);
  // The payment notice: the manager accepts it; the owner can't accept for them
  view = (await s.call("GET", "/api/admin/partner/share", undefined, mgr.token)).body;
  const notice = view.notices[0];
  assert.equal(notice.cents, mem.cents + vid.cents); assert.match(notice.text, /Section 4/); assert.equal(notice.acceptedAt, null);
  assert.equal((await s.call("POST", `/api/admin/partner/notices/${notice.id}/accept`, {}, s.owner)).status, 403);
  r = await s.call("POST", `/api/admin/partner/notices/${notice.id}/accept`, {}, mgr.token);
  assert.equal(r.status, 200); assert.ok(r.body.acceptedAt);

  // A refund after payout: a clawback comes off the next payout
  await s.hook({ id: "evt_rf", type: "charge.refunded", created: s.ts(), data: { object: { object: "charge", id: "ch_1", payment_intent: "pi_1", amount: 1995, amount_refunded: 1995 } } });
  led = s.readJson("partner-share-ledger");
  assert.deepEqual(led.filter((x) => x.kind === "clawback").map((x) => [x.cents, x.status]), [[-mem.cents, "ready"]]);

  // The month's statement (Section 4.8) and its CSV: categories, fees, net, share; no names
  const st = (await s.call("GET", "/api/admin/partner/statement?month=2026-11", undefined, mgr.token)).body;
  assert.equal(st.categories.clinic.payments, 2); assert.equal(st.categories.clinic.grossCents, 45000);
  assert.equal(st.categories.online.payments, 3); assert.equal(st.categories.online.feesPending, 1);
  const csv = await s.call("GET", "/api/admin/partner/statement.csv?month=2026-11", undefined, mgr.token);
  assert.match(csv.text, /^date,product,category,gross_usd/); assert.ok(!csv.text.includes("sam@example.com"));
  // Continuing share (Section 9.2): after active service ends, new payments earn 5%
  await s.call("PUT", "/api/admin/partner-share/settings", { status: "continuing" }, s.owner);
  await s.hook(s.invoice());
  assert.equal(s.readJson("partner-share-ledger").slice(-1)[0].pct, 5);
});

test("PATF partners: the manager registers a partner (Section 7.2), its code credits sign-ups and revenue to it, the Partner Allowance is capped at 15%, and originated partners keep the 15% share after active service ends", async (t) => {
  const s = await start(t);
  const mgr = await s.staffLogin({ name: "Josh Lerner", email: "josh@example.com", role: "manager" });
  const dev = await s.staffLogin({ name: "Dev Person", email: "dev@example.com", role: "developer" });
  await s.call("PUT", "/api/admin/partner-share/settings", { enabled: true, managerStaffId: mgr.id }, s.owner);
  // Registration: capped at 15%; the developer has no access
  assert.equal((await s.call("POST", "/api/admin/partner/partners", { name: "Iron Gym", type: "gym", ratePct: 20 }, mgr.token)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/partner/partners", { name: "Iron Gym", type: "gym", ratePct: 10 }, dev.token)).status, 403);
  let r = await s.call("POST", "/api/admin/partner/partners", { name: "Iron Gym", type: "gym", contact: "owner@irongym.example", ratePct: 10 }, mgr.token);
  assert.equal(r.status, 201);
  const p = r.body;
  assert.match(p.code, /^P-IRONG[0-9A-F]{4}$/); assert.equal(p.originatedByManager, true); assert.equal(p.acknowledgedAt, null);
  assert.equal(p.ackDueAt.slice(0, 10), "2026-11-27", "five business days from Friday Nov 20");
  // A visit and a sign-up with the partner's code
  await s.call("POST", "/api/referral/visit", { code: p.code });
  r = await s.call("POST", "/api/clients/signup", { name: "Gym Member", email: "gm@example.com", phone: "941-555-0111", password: "gm-pass-12345", referralCode: p.code });
  assert.equal(r.status, 201);
  let list = s.readJson("clients"); const gm = list.find((c) => c.email === "gm@example.com");
  assert.equal(gm.referredPartner, p.id); assert.equal(gm.referredBy, undefined);
  assert.equal((await s.call("POST", "/api/me/referral/claim", { code: "ANYCODE1" }, r.body.token)).status, 409, "a partner's customer can't add a second code");
  gm.stripeCustomerId = "cus_gm"; gm.membership = { tier: "member", until: "2026-12-20", stripeSubscriptionId: "sub_gm", status: "active" }; s.writeJson("clients", list);
  // The owner moves the manager to the continuing share: ordinary online revenue earns 5%, the originated partner's customers 15% (Section 4.4)
  await s.call("PUT", "/api/admin/partner-share/settings", { status: "continuing" }, s.owner);
  await s.hook(s.invoice()); // Sam, no partner
  const gmInv = s.invoice({ customer: "cus_gm" }); await s.hook(gmInv);
  const led = s.readJson("partner-share-ledger");
  assert.deepEqual(led.map((x) => x.pct), [5, 15]);
  // PATF figures: clicks, sign-ups, paying, revenue, commission due within the allowance; no names
  const patf = (await s.call("GET", "/api/admin/partner/patf", undefined, mgr.token)).body;
  const row = patf.partners[0];
  assert.deepEqual([row.clicks, row.signups, row.payingNow, row.revenueCents, row.membershipNetCents], [1, 1, 1, 1995, 1995]);
  assert.equal(row.commissionDueCents, Math.round(1995 * 0.10)); assert.equal(row.state, "awaiting acknowledgment");
  assert.ok(!JSON.stringify(patf).includes("gm@example.com") && !JSON.stringify(patf).includes("Gym Member"));
  // The owner can dispute within five business days; after that it's deemed acknowledged and can't be
  s.setClock("2026-11-28T15:00:00Z");
  assert.equal((await s.call("GET", "/api/admin/partner/patf", undefined, mgr.token)).body.partners[0].state, "deemed acknowledged");
  assert.equal((await s.call("PUT", `/api/admin/partner-share/partners/${p.id}`, { dispute: "We already work with them" }, s.owner)).status, 400);
  assert.equal((await s.call("PUT", `/api/admin/partner-share/partners/${p.id}`, { ratePct: 12 }, mgr.token)).status, 403, "the manager can't change a partner's terms after registering");
  // The affiliate programme is held to the same 15% allowance
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { ratePct: 16 }, s.owner)).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/affiliates/settings", { ratePct: 15 }, s.owner)).status, 200);
});
