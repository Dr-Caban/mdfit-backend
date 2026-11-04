// Stripe payments for MD Fit, following Stripe's integration best practices:
// - Checkout Sessions (Stripe-hosted) for every payment; no payment_method_types (dynamic payment methods).
// - Memberships = subscriptions, one Stripe Product per tier; review reward = a one-time % off coupon.
// - Protocols: Gold / Bronze (pay as you go) = one-time payments; Silver / Platinum 12- and 24-month = monthly installments
//   that end on their own (subscription schedule with a fixed duration).
// - Fulfillment only from verified webhooks (never the success page). Events resolve through the Stripe object
//   graph (customer id -> our client); metadata is only a fallback. Processed event ids are remembered (idempotent).
// - Keys come from the environment only: STRIPE_SECRET_KEY (use a restricted key, rk_...) and STRIPE_WEBHOOK_SECRET.
// - No health details ever go to Stripe: product names describe the service and visit count only.
"use strict";
const crypto = require("crypto");
const Stripe = require("stripe");
const { ValidationError } = require("./validate");

const API_VERSION = "2026-10-28.endive";
const fail = (msg) => { throw new ValidationError(msg); };
const cents = (dollars) => Math.round(dollars * 100);
const letters = () => Array.from(crypto.randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join("");
const isoDate = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");

// Same math as the pricing page (frontend/pricing.js), computed on the server so prices can't be changed in the browser.
// Plans: Gold = evaluation + every visit paid upfront, % off. Silver = same total in N monthly payments.
// Bronze = pay as you go, one visit at a time. Platinum = spread over 12 or 24 months for a small %.
function protocolQuote(svc, n, plans, plan, evalRate = 0) {
  const base = (svc.withEval ? evalRate : 0) + svc.rate * n;
  switch (plan) {
    case "gold": return { mode: "payment", total: base * (1 - plans.gold / 100), payments: 1, label: `Gold, paid in full${plans.gold ? ` (${plans.gold}% off)` : ""}` };
    case "silver": return { mode: "installments", total: base * (1 - plans.silver / 100), payments: plans.silverPayments, label: `Silver, ${plans.silverPayments} monthly payments${plans.silver ? ` (${plans.silver}% off)` : ""}` };
    case "ext12": return { mode: "installments", total: base * (1 + plans.ext12 / 100), payments: 12, label: `Platinum, 12 monthly payments (+${plans.ext12}%)` };
    case "ext24": return { mode: "installments", total: base * (1 + plans.ext24 / 100), payments: 24, label: `Platinum, 24 monthly payments (+${plans.ext24}%)` };
    case "payg": return { mode: "payment", total: svc.rate, payments: 1, label: "Bronze, pay as you go: 1 visit", single: true };
    default: fail("Pick a payment plan.");
  }
}

// Count unique calendar days with logged activity (workouts or pain entries) in a date range [from, to] (inclusive, YYYY-MM-DD).
function activityDays(client, from, to) {
  const days = new Set();
  for (const w of client.workouts || []) { if (w.date >= from && w.date <= to) days.add(w.date); }
  for (const p of client.painLog || []) { if (p.date >= from && p.date <= to) days.add(p.date); }
  return days.size;
}

// Accountability discount: $1 off per activity day, free at 20 days.
const ACCOUNTABILITY_THRESHOLD = 20;
const ACCOUNTABILITY_CREDIT_PER_DAY = 100; // cents

function mountPayments({ app, admin, store, me, clients, save, today, notify, cfg, settings, activity, logger }) {
  const key = cfg.stripeSecretKey || process.env.STRIPE_SECRET_KEY || "";
  const whsec = cfg.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET || "";
  const stripe = cfg.stripeClient || (key ? new Stripe(key, { apiVersion: API_VERSION }) : null);
  // Checkout only turns on when webhooks can confirm payments too: taking money that can't be fulfilled
  // (no membership / plan granted) is worse than not offering checkout yet.
  const enabled = () => !!stripe && !!whsec;
  const site = () => cfg.siteUrl || "";
  const content = () => ({ tiers: [], ...store.read("content", {}) });
  const tiers = () => { const t = content().tiers; return t && t.length ? t : require("./content").defaultContent().tiers; };
  const off = (res) => res.status(503).json({ error: "Online payments aren't switched on yet. Dr. Jared will send you a payment link." });
  const findClient = (list, { customer, clientId }) => list.find((c) => customer && c.stripeCustomerId === customer) || list.find((c) => clientId && c.id === clientId);

  async function ensureCustomer(clientId) {
    const list = clients(), c = list.find((x) => x.id === clientId);
    if (c.stripeCustomerId) return c.stripeCustomerId;
    const cu = await stripe.customers.create({ email: c.email, name: c.name, metadata: { clientId: c.id } });
    c.stripeCustomerId = cu.id; save(list);
    return cu.id;
  }
  // One Product per membership tier; the Price is found by lookup key (includes the amount, so a price change makes a new Price)
  const priceCache = new Map();
  async function tierPrice(t) {
    const lk = `mdfit_tier_${t.id}_${cents(t.price)}_monthly`;
    if (priceCache.has(lk)) return priceCache.get(lk);
    const found = await stripe.prices.list({ lookup_keys: [lk], limit: 1 });
    let price = found.data[0];
    if (!price) {
      const product = await stripe.products.create({ name: `MD Fit ${t.name}`.replace(/^MD Fit MD Fit/, "MD Fit"), metadata: { tier: t.id } });
      price = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: cents(t.price), recurring: { interval: "month" }, lookup_key: lk, metadata: { tier: t.id } });
    }
    priceCache.set(lk, price.id);
    return price.id;
  }
  // If the client requests the embedded UI, return a client_secret instead of a redirect URL. The embedded
  // Stripe Checkout respects dynamic payment methods, so Apple Pay, Google Pay and Link all appear
  // automatically when they are enabled in the Stripe dashboard.
  function withUiMode(params, body, returnPath) {
    if (body && body.ui === "embedded") {
      const { success_url, cancel_url, ...rest } = params;
      return { ...rest, ui_mode: "embedded", return_url: `${site()}${returnPath}?session_id={CHECKOUT_SESSION_ID}` };
    }
    return params;
  }
  const respond = (res, session) => res.json(session.url ? { url: session.url, id: session.id } : { clientSecret: session.client_secret, id: session.id });

  async function reviewCoupon(pct) {
    const id = `mdfit-review-${pct}`;
    try { return (await stripe.coupons.retrieve(id)).id; }
    catch { return (await stripe.coupons.create({ id, percent_off: pct, duration: "once", name: `Review thank-you: ${pct}% off first month` })).id; }
  }
  const unusedReview = (code) => {
    if (!code) return null;
    const f = store.read("feedback", []).find((x) => x.rewardCode === String(code).toUpperCase());
    return f && !f.rewardUsedAt ? { code: f.rewardCode, pct: f.rewardPct ?? 30 } : null;
  };
  const active = (c) => c.membership && (!c.membership.until || c.membership.until >= today());

  // ---------------- Client endpoints ----------------
  me.post("/checkout/membership", async (req, res) => {
    if (!enabled()) return off(res);
    const t = tiers().find((x) => x.id === (req.body && req.body.tier));
    if (!t) fail("Pick a membership.");
    const c = req.client;
    if (active(c) && c.membership.stripeSubscriptionId) return res.status(409).json({ error: "You already have a membership. Use Manage billing to change it.", manage: true });
    const customer = await ensureCustomer(c.id);
    const review = unusedReview((req.body && req.body.rewardCode) || c.reviewCode);
    const session = await stripe.checkout.sessions.create(withUiMode({
      mode: "subscription", customer, client_reference_id: c.id,
      line_items: [{ price: await tierPrice(t), quantity: 1 }],
      ...(review ? { discounts: [{ coupon: await reviewCoupon(review.pct) }] } : { allow_promotion_codes: true }),
      metadata: { kind: "membership", tier: t.id, clientId: c.id, ...(review ? { rewardCode: review.code } : {}) },
      subscription_data: { metadata: { kind: "membership", tier: t.id, clientId: c.id } },
      success_url: `${site()}/account?checkout=success#premium`, cancel_url: `${site()}/account#premium`,
      integration_identifier: `mdfit_membership_${letters()}`
    }, req.body, "/account?checkout=success&kind=membership#premium"));
    activity("checkout_started", { email: c.email, kind: "membership", tier: t.id });
    respond(res, session);
  });

  me.post("/checkout/protocol", async (req, res) => {
    if (!enabled()) return off(res);
    const s = settings(), b = req.body || {};
    const svc = (s.services || []).find((x) => x.id === b.service && x.protocol);
    if (!svc) fail("Pick a service.");
    const n = Number(b.sessions);
    if (!(s.plans.packageSizes || []).includes(n)) fail("Pick a number of visits.");
    const evalSvc = (s.services || []).find((x) => x.id === "eval");
    const q = protocolQuote(svc, n, s.plans, b.plan, evalSvc ? evalSvc.rate : 0);
    const c = req.client, customer = await ensureCustomer(c.id);
    const visits = q.single ? 1 : n;
    const name = `${svc.name}: ${visits} visit${visits === 1 ? "" : "s"} · ${q.label}`;
    const per = cents(q.total / q.payments);
    const pid = crypto.randomBytes(6).toString("hex");
    const meta = { kind: "protocol", protocolId: pid, clientId: c.id, service: svc.id, sessions: String(visits), plan: b.plan, payments: String(q.payments) };
    const base = q.mode === "payment"
      ? { mode: "payment", customer, client_reference_id: c.id, line_items: [{ price_data: { currency: "usd", unit_amount: cents(q.total), product_data: { name } }, quantity: 1 }],
          payment_intent_data: { metadata: meta }, metadata: meta,
          success_url: `${site()}/account?checkout=success#premium`, cancel_url: `${site()}/#pricing`, integration_identifier: `mdfit_protocol_${letters()}` }
      : { mode: "subscription", customer, client_reference_id: c.id,
          line_items: [{ price_data: { currency: "usd", unit_amount: per, recurring: { interval: "month" }, product_data: { name } }, quantity: 1 }],
          subscription_data: { metadata: meta }, metadata: meta,
          success_url: `${site()}/account?checkout=success#premium`, cancel_url: `${site()}/#pricing`, integration_identifier: `mdfit_installments_${letters()}` };
    const session = await stripe.checkout.sessions.create(withUiMode(base, req.body, "/account?checkout=success&kind=protocol#premium"));
    const list = clients(), cl = list.find((x) => x.id === c.id);
    cl.protocols = [...(cl.protocols || []), { id: pid, service: svc.id, serviceName: svc.name, sessions: visits, plan: b.plan, label: q.label,
      total: Math.round(q.total * 100) / 100, payments: q.payments, paid: 0, status: "pending", guarantee: n >= s.plans.guaranteeMin && !q.single,
      checkoutSessionId: session.id, createdAt: new Date().toISOString() }];
    save(list);
    activity("checkout_started", { email: c.email, kind: "protocol", plan: b.plan });
    respond(res, session);
  });

  // Single service payment: pay for one evaluation, follow-up or massage without committing to a plan.
  // Each service row on the pricing page uses this endpoint.
  me.post("/checkout/service", async (req, res) => {
    if (!enabled()) return off(res);
    const s = settings();
    const svc = (s.services || []).find((x) => x.id === (req.body && req.body.service));
    if (!svc) fail("Pick a service.");
    const c = req.client, customer = await ensureCustomer(c.id);
    const name = `${svc.name} · 1 visit`;
    const meta = { kind: "service", service: svc.id, clientId: c.id };
    const base = {
      mode: "payment", customer, client_reference_id: c.id,
      line_items: [{ price_data: { currency: "usd", unit_amount: cents(svc.rate), product_data: { name } }, quantity: 1 }],
      payment_intent_data: { metadata: meta }, metadata: meta,
      success_url: `${site()}/account?checkout=success&kind=service&svc=${svc.id}`,
      cancel_url: `${site()}/#services`,
      integration_identifier: `mdfit_service_${letters()}`
    };
    const session = await stripe.checkout.sessions.create(withUiMode(base, req.body, `/account?checkout=success&kind=service&svc=${svc.id}`));
    activity("checkout_started", { email: c.email, kind: "service", service: svc.id });
    respond(res, session);
  });

  // Public: look up a session after return (checks nothing sensitive, used by the embedded flow)
  me.get("/checkout/session/:id", async (req, res) => {
    if (!enabled()) return off(res);
    try {
      const sess = await stripe.checkout.sessions.retrieve(req.params.id);
      if (sess.client_reference_id !== req.client.id) return res.status(404).json({ error: "Not found." });
      res.json({ id: sess.id, status: sess.status, paymentStatus: sess.payment_status });
    } catch { res.status(404).json({ error: "Not found." }); }
  });

  me.post("/billing-portal", async (req, res) => {
    if (!enabled()) return off(res);
    if (!req.client.stripeCustomerId) fail("No billing account yet.");
    const p = await stripe.billingPortal.sessions.create({ customer: req.client.stripeCustomerId, return_url: `${site()}/account#premium` });
    res.json({ url: p.url });
  });
  me.get("/payments", (req, res) => res.json({ enabled: enabled(), protocols: req.client.protocols || [], membership: req.client.membership || null, hasBilling: !!req.client.stripeCustomerId }));

  me.get("/accountability", (req, res) => {
    const c = req.client;
    const d = today();
    const monthStart = d.slice(0, 8) + "01";
    const days = activityDays(c, monthStart, d);
    const price = 19.95;
    const credit = Math.min(days, ACCOUNTABILITY_THRESHOLD);
    const owed = Math.max(0, price - credit);
    res.json({ activeDays: days, threshold: ACCOUNTABILITY_THRESHOLD, price, credit: Math.min(days, ACCOUNTABILITY_THRESHOLD), owed: Math.round(owed * 100) / 100, free: days >= ACCOUNTABILITY_THRESHOLD, month: d.slice(0, 7) });
  });

  // ---------------- Webhook ----------------
  async function scheduleEnd(subId, payments) {
    // End the installment plan on its own after N monthly payments
    const sched = await stripe.subscriptionSchedules.create({ from_subscription: subId });
    const ph = sched.phases[0];
    const items = ph.items.map((i) => ({ price: typeof i.price === "string" ? i.price : i.price.id, quantity: i.quantity }));
    try {
      await stripe.subscriptionSchedules.update(sched.id, { end_behavior: "cancel", phases: [{ items, start_date: ph.start_date, duration: { interval: "month", interval_count: payments } }] });
    } catch (e) {
      await stripe.subscriptionSchedules.update(sched.id, { end_behavior: "cancel", phases: [{ items, start_date: ph.start_date, iterations: payments }] });
    }
  }
  const seen = () => store.read("stripeEvents", []);
  async function handle(ev) {
    const o = ev.data.object, list = clients();
    const md = o.metadata || {};
    const who = () => findClient(list, { customer: typeof o.customer === "string" ? o.customer : o.customer && o.customer.id, clientId: md.clientId || o.client_reference_id });
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (o.payment_status === "unpaid") return; // delayed payment methods: wait for async_payment_succeeded
        const c = who(); if (!c) return logger.warn("stripe_unmatched", { type: ev.type, id: o.id });
        if (md.kind === "membership" && md.rewardCode) {
          const fb = store.read("feedback", []), f = fb.find((x) => x.rewardCode === md.rewardCode);
          if (f && !f.rewardUsedAt) { f.rewardUsedAt = new Date().toISOString(); store.write("feedback", fb); }
        }
        if (md.kind === "protocol") {
          const p = (c.protocols || []).find((x) => x.id === md.protocolId);
          if (p) { p.status = o.mode === "subscription" ? "active" : "paid"; p.paidAt = new Date().toISOString(); if (o.mode === "payment") p.paid = 1; if (o.subscription) p.subscriptionId = o.subscription; }
          save(list);
          if (o.mode === "subscription" && o.subscription) await scheduleEnd(o.subscription, Number(md.payments) || 1);
          notify.owner(`Protocol purchased: ${c.name}`, `${c.name} (${c.email}) bought ${p ? `${p.serviceName}, ${p.sessions} visits, ${p.label}` : "a protocol"}.`);
        }
        save(list); return;
      }
      case "checkout.session.async_payment_failed": {
        const c = who(); if (c && md.kind === "protocol") { const p = (c.protocols || []).find((x) => x.id === md.protocolId); if (p) p.status = "failed"; save(list); }
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const c = who(); if (!c) return;
        const item = o.items && o.items.data && o.items.data[0];
        const periodEnd = (item && item.current_period_end) || o.current_period_end;
        if (md.kind === "membership") {
          const live = ev.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(o.status);
          if (live) {
            const prev = c.membership || {};
            c.membership = { tier: md.tier, since: prev.since || today(), until: isoDate(periodEnd), stripeSubscriptionId: o.id, status: o.status, cancelAtPeriodEnd: !!o.cancel_at_period_end };
            if (c.membershipRequest) delete c.membershipRequest;
          } else if (c.membership && c.membership.stripeSubscriptionId === o.id) c.membership = null;
        } else if (md.kind === "protocol") {
          const p = (c.protocols || []).find((x) => x.subscriptionId === o.id || x.id === md.protocolId);
          if (p && ev.type === "customer.subscription.deleted") p.status = p.paid >= p.payments ? "paid" : "ended";
        }
        save(list); return;
      }
      case "invoice.created": {
        // Accountability discount: credit $1 per activity day (max = invoice total) on membership invoices.
        if (!stripe) return;
        const c = who(); if (!c) return;
        if (!c.membership || c.membership.tier !== "member") return;
        const subId = (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || o.subscription;
        if (!subId || subId !== c.membership.stripeSubscriptionId) return;
        // Billing period: from the start of the period to today
        const periodStart = o.period_start ? isoDate(o.period_start) : today().slice(0, 8) + "01";
        const periodEnd = o.period_end ? isoDate(o.period_end) : today();
        const days = activityDays(c, periodStart, periodEnd);
        if (days <= 0) return;
        const creditCents = Math.min(days * ACCOUNTABILITY_CREDIT_PER_DAY, o.amount_due || cents(19.95));
        try {
          await stripe.invoiceItems.create({ customer: typeof o.customer === "string" ? o.customer : o.customer.id, invoice: o.id,
            amount: -creditCents, currency: "usd", description: `Accountability credit: ${days} active day${days === 1 ? "" : "s"} (−$${(creditCents / 100).toFixed(2)})` });
          logger.info("accountability_credit", { email: c.email, days, creditCents });
        } catch (e) { logger.warn("accountability_credit_failed", { error: e.message }); }
        return;
      }
      case "invoice.paid": {
        const c = who(); if (!c) return;
        const subId = (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || o.subscription;
        const p = (c.protocols || []).find((x) => subId && x.subscriptionId === subId);
        if (p) { p.paid = Math.min(p.payments, (p.paid || 0) + 1); if (p.paid >= p.payments) p.status = "paid"; save(list); }
        return;
      }
      case "invoice.payment_failed": {
        const c = who(); if (!c) return;
        notify.owner(`Payment failed: ${c.name}`, `A payment from ${c.name} (${c.email}) failed. Stripe will retry automatically.`);
        notify.client(c.email, "Your MD Fit payment didn't go through", `Hi ${c.name.split(" ")[0]},\n\nYour latest MD Fit payment didn't go through. Please update your card here:\n${site()}/account#premium\n\nMD Fit`);
        return;
      }
      case "charge.refunded":
      case "charge.dispute.created":
      case "radar.early_fraud_warning.created": {
        const c = who();
        notify.owner(`Stripe alert: ${ev.type}`, `${c ? `${c.name} (${c.email})` : "A customer"}: ${ev.type} on ${o.id}. Review it in the Stripe Dashboard.`);
        activity("stripe_" + ev.type.replace(/\./g, "_"), { email: c ? c.email : "" });
        return;
      }
      default: return;
    }
  }
  app.post("/api/stripe/webhook", async (req, res) => {
    if (!enabled() || !whsec) return res.status(503).json({ error: "Stripe webhooks aren't configured." });
    let ev;
    try { ev = stripe.webhooks.constructEvent(req.rawBody, req.get("stripe-signature"), whsec); }
    catch (e) { logger.warn("stripe_bad_signature", { error: e.message }); return res.status(400).json({ error: "Bad signature." }); }
    const done = seen();
    if (done.includes(ev.id)) return res.json({ received: true, duplicate: true });
    try { await handle(ev); }
    catch (e) { logger.error("stripe_webhook_failed", { type: ev.type, error: e.message }); return res.status(500).json({ error: "Webhook handling failed." }); }
    store.write("stripeEvents", [...done, ev.id].slice(-1000));
    res.json({ received: true });
  });

  // ---------------- Admin ----------------
  admin.get("/payments", (req, res) => {
    res.json({ enabled: enabled(), webhook: !!whsec, clients: clients().filter((c) => c.stripeCustomerId || (c.protocols || []).length).map((c) => ({
      id: c.id, name: c.name, email: c.email, stripeCustomerId: c.stripeCustomerId || null, membership: c.membership || null, protocols: c.protocols || [] })) });
  });
  return { enabled, protocolQuote };
}

module.exports = { mountPayments, protocolQuote, activityDays, API_VERSION };
