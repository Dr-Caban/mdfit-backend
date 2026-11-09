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

function mountPayments({ app, admin, store, me, clients, save, today, notify, cfg, settings, activity, logger, setReconcile }) {
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
    const c = clients().find((x) => x.id === clientId);
    if (c.stripeCustomerId) return c.stripeCustomerId;
    const cu = await stripe.customers.create({ email: c.email, name: c.name, metadata: { clientId: c.id } });
    // Read the clients again after the Stripe call: saving the copy from before it would undo anything saved meanwhile
    const list = clients(), fresh = list.find((x) => x.id === clientId);
    if (fresh) { fresh.stripeCustomerId = cu.id; save(list); }
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
    if (body && body.ui === "app") {
      // The iPhone / Android app: Stripe's hosted page in a native browser sheet (Apple Pay / Google Pay work there,
      // unlike inside the app's web view). Stripe sends the member to /app-return, which hands control back to the app.
      const [path, hash = ""] = String(returnPath).split("#");
      const next = `${path}${path.includes("?") ? "&" : "?"}session_id=SESSION${hash ? "#" + hash : ""}`;
      const cancel = String(params.cancel_url || "").replace(site(), "") || "/account#premium";
      return { ...params,
        success_url: `${site()}/app-return?to=${encodeURIComponent(next)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site()}/app-return?cancel=1&to=${encodeURIComponent(cancel)}` };
    }
    if (body && body.ui === "embedded") {
      const { success_url, cancel_url, ...rest } = params;
      // session_id goes in the query, before any #tab, or the app reads "premium?session_id=…" as the tab and shows Home
      const [path, hash = ""] = String(returnPath).split("#");
      const ret = `${site()}${path}${path.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}${hash ? "#" + hash : ""}`;
      return { ...rest, ui_mode: "embedded_page", return_url: ret }; // API 2026-03-25.dahlia+: "embedded" was renamed (the old value is rejected)
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
      success_url: `${site()}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}#premium`, cancel_url: `${site()}/account#premium`,
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
          success_url: `${site()}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}#premium`, cancel_url: `${site()}/#pricing`, integration_identifier: `mdfit_protocol_${letters()}` }
      : { mode: "subscription", customer, client_reference_id: c.id,
          line_items: [{ price_data: { currency: "usd", unit_amount: per, recurring: { interval: "month" }, product_data: { name } }, quantity: 1 }],
          subscription_data: { metadata: meta }, metadata: meta,
          success_url: `${site()}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}#premium`, cancel_url: `${site()}/#pricing`, integration_identifier: `mdfit_installments_${letters()}` };
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
      success_url: `${site()}/account?checkout=success&kind=service&svc=${svc.id}&session_id={CHECKOUT_SESSION_ID}`,
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
    const inApp = req.body && req.body.ui === "app";
    const p = await stripe.billingPortal.sessions.create({ customer: req.client.stripeCustomerId,
      return_url: inApp ? `${site()}/app-return?to=${encodeURIComponent("/account#premium")}` : `${site()}/account#premium` });
    res.json({ url: p.url });
  });
  me.get("/payments", (req, res) => res.json({ enabled: enabled(), protocols: req.client.protocols || [], membership: req.client.membership || null, hasBilling: !!req.client.stripeCustomerId }));

  // The accountability tier: $1 off per active day, up to 20 days, never below the tier's floor (owner: $29.95 → $10)
  const acctTier = (c) => { const t = c.membership && tiers().find((x) => x.id === c.membership.tier); return t && t.accountability ? t : null; };
  const acctCredit = (t, days) => Math.max(0, Math.min(days, ACCOUNTABILITY_THRESHOLD, Math.round((t.price - (t.floor || 0)) * 100) / 100));
  me.get("/accountability", (req, res) => {
    const c = req.client, t = acctTier(c);
    const d = today();
    const monthStart = d.slice(0, 8) + "01";
    const days = activityDays(c, monthStart, d);
    if (!t) return res.json({ enabled: false, activeDays: days, threshold: ACCOUNTABILITY_THRESHOLD, month: d.slice(0, 7) });
    const credit = acctCredit(t, days), owed = Math.round(Math.max(0, t.price - credit) * 100) / 100;
    res.json({ enabled: true, activeDays: days, threshold: ACCOUNTABILITY_THRESHOLD, price: t.price, floor: t.floor || 0, credit, owed, atFloor: days >= ACCOUNTABILITY_THRESHOLD, free: owed <= 0, month: d.slice(0, 7) });
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
  // Receipt email when someone becomes a paying member (first payment) and on every monthly renewal.
  // Membership name, amount, date and the Stripe invoice link only: no health details.
  const money = (amountCents, cur = "usd") => `${String(cur).toUpperCase() === "USD" ? "$" : String(cur).toUpperCase() + " "}${((Number(amountCents) || 0) / 100).toFixed(2)}`;
  function receipt(c, { tier, amount, currency, when, url, number, first }) {
    if (!notify.enabled) return;
    const t = tiers().find((x) => x.id === tier), name = t ? t.name : "MD Fit membership";
    const date = new Date(when ? when * 1000 : Date.now()).toLocaleDateString("en-US", { timeZone: cfg.tz || "America/New_York", month: "long", day: "numeric", year: "numeric" });
    const amt = amount == null ? (t ? money(cents(t.price)) : "") : money(amount, currency);
    const firstName = String(c.name || "").split(" ")[0] || "there";
    notify.client(c.email, first ? `Welcome to ${name}: your MD Fit receipt` : `Your MD Fit receipt: ${name}`,
      `Hi ${firstName},\n\n${first ? `Thank you for joining ${name}. Everything it includes is open in your account now:\n${site()}/account#premium` : `Thanks for staying with ${name}.`}\n\n` +
      `Receipt\n• ${name}${amt ? `: ${amt}` : ""}\n• Paid ${date}${number ? `\n• Invoice ${number}` : ""}\n` +
      `• Billed monthly to the card on file. Change or cancel any time from Manage billing: ${site()}/account#premium\n` +
      `${url ? `\nView or download the invoice: ${url}\n` : ""}\nMD Fit · Sarasota, FL · 941-313-0562`);
    activity("membership_receipt", { email: c.email, tier, first: !!first });
  }
  const seen = () => store.read("stripeEvents", []);
  const LIVE = ["active", "trialing", "past_due"];
  // Write what a Stripe subscription says onto the client record. Used by the webhook, by the reconcile below and by
  // the checkout confirm the site calls, so a missed webhook never leaves a paying member looking "free".
  function applySubscription(c, o, { deleted = false } = {}) {
    const md = o.metadata || {}, item = o.items && o.items.data && o.items.data[0];
    const periodEnd = (item && item.current_period_end) || o.current_period_end;
    if (md.kind === "membership") {
      const live = !deleted && LIVE.includes(o.status);
      if (live) {
        const prev = c.membership || {};
        c.membership = { tier: md.tier, since: prev.since || today(), until: isoDate(periodEnd), stripeSubscriptionId: o.id, status: o.status, cancelAtPeriodEnd: !!o.cancel_at_period_end };
        if (c.membershipRequest) delete c.membershipRequest;
        return true;
      }
      if (c.membership && c.membership.stripeSubscriptionId === o.id) { c.membership = null; return true; }
    } else if (md.kind === "protocol") {
      const p = (c.protocols || []).find((x) => x.subscriptionId === o.id || x.id === md.protocolId);
      if (p && deleted) { p.status = p.paid >= p.payments ? "paid" : "ended"; return true; }
    }
    return false;
  }
  // The first payment of a checkout: review code used up, receipt, protocol marked paid. `o` is the Checkout Session.
  // Runs once per session whether the webhook or the site's confirm gets there first (the session id is recorded).
  async function fulfillSession(c, o, list) {
    const md = o.metadata || {};
    const mark = `cs:${o.id}`;
    if (seen().includes(mark)) return false;
    store.write("stripeEvents", [...seen(), mark].slice(-1000));
    if (md.kind === "membership" && md.rewardCode) {
      const fb = store.read("feedback", []), f = fb.find((x) => x.rewardCode === md.rewardCode);
      if (f && !f.rewardUsedAt) { f.rewardUsedAt = new Date().toISOString(); store.write("feedback", fb); }
    }
    if (md.kind === "membership") receipt(c, { tier: md.tier, amount: o.amount_total, currency: o.currency, when: o.created, first: true });
    if (md.kind === "protocol") {
      const p = (c.protocols || []).find((x) => x.id === md.protocolId);
      if (p) { p.status = o.mode === "subscription" ? "active" : "paid"; p.paidAt = new Date().toISOString(); if (o.mode === "payment") p.paid = 1; if (o.subscription) p.subscriptionId = typeof o.subscription === "string" ? o.subscription : o.subscription.id; }
      save(list);
      if (o.mode === "subscription" && o.subscription) await scheduleEnd(typeof o.subscription === "string" ? o.subscription : o.subscription.id, Number(md.payments) || 1);
      notify.owner(`Protocol purchased: ${c.name}`, `${c.name} (${c.email}) bought ${p ? `${p.serviceName}, ${p.sessions} visits, ${p.label}` : "a protocol"}.`);
      return true;
    }
    save(list);
    return true;
  }

  // Reconcile with Stripe when a client who has paid through Stripe shows no live membership on our side (the webhook
  // never arrived, or the member paid before it was configured). At most once every 10 minutes per client; returns a
  // promise only when there is something to check, so the usual request path stays synchronous.
  const reconciledAt = new Map();
  function reconcile(c) {
    if (!stripe || !c || !c.stripeCustomerId || active(c)) return null;
    const last = reconciledAt.get(c.id) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return null;
    reconciledAt.set(c.id, Date.now());
    return (async () => {
      const subs = await stripe.subscriptions.list({ customer: c.stripeCustomerId, limit: 10 });
      const sub = (subs.data || []).find((s) => s.metadata && s.metadata.kind === "membership" && LIVE.includes(s.status));
      if (!sub) return false;
      const list = clients(), fresh = list.find((x) => x.id === c.id);
      if (!fresh || !applySubscription(fresh, sub)) return false;
      save(list);
      logger.info("membership_reconciled", { clientId: c.id, tier: fresh.membership.tier, subscription: sub.id });
      return true;
    })().catch((e) => { logger.warn("membership_reconcile_failed", { clientId: c.id, error: e.message }); return false; });
  }

  // The site calls this when it comes back from Checkout with the session id: membership (or protocol) is granted right
  // away from Stripe's answer, without waiting for the webhook.
  me.post("/checkout/confirm", async (req, res) => {
    if (!stripe) return off(res);
    const id = String((req.body && req.body.session_id) || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) fail("Missing checkout session.");
    const o = await stripe.checkout.sessions.retrieve(id, { expand: ["subscription"] });
    const customer = typeof o.customer === "string" ? o.customer : o.customer && o.customer.id;
    const mine = (customer && customer === req.client.stripeCustomerId) || o.client_reference_id === req.client.id || (o.metadata && o.metadata.clientId === req.client.id);
    if (!mine) return res.status(403).json({ error: "That checkout isn't yours." });
    if (o.payment_status === "unpaid" || o.status !== "complete") return res.json({ paid: false, status: o.status, payment_status: o.payment_status });
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    if (customer && !c.stripeCustomerId) c.stripeCustomerId = customer;
    const sub = o.subscription && typeof o.subscription === "object" ? o.subscription : null;
    let changed = false;
    if (sub && sub.metadata && sub.metadata.kind) changed = applySubscription(c, sub) || changed;
    if (changed) save(list);
    await fulfillSession(c, o, list); // saves too
    const now = clients().find((x) => x.id === c.id) || c;
    res.json({ paid: true, membership: now.membership || null, amountTotal: o.amount_total, currency: o.currency,
      discount: o.total_details && o.total_details.amount_discount || 0, subtotal: o.amount_subtotal });
  });

  async function handle(ev) {
    const o = ev.data.object, list = clients();
    const md = o.metadata || {};
    const who = () => findClient(list, { customer: typeof o.customer === "string" ? o.customer : o.customer && o.customer.id, clientId: md.clientId || o.client_reference_id });
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (o.payment_status === "unpaid") return; // delayed payment methods: wait for async_payment_succeeded
        const c = who(); if (!c) return logger.warn("stripe_unmatched", { type: ev.type, id: o.id });
        await fulfillSession(c, { ...o, created: ev.created }, list); // no-op when the site's confirm already did it
        return;
      }
      case "checkout.session.async_payment_failed": {
        const c = who(); if (c && md.kind === "protocol") { const p = (c.protocols || []).find((x) => x.id === md.protocolId); if (p) p.status = "failed"; save(list); }
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const c = who(); if (!c) return;
        applySubscription(c, o, { deleted: ev.type === "customer.subscription.deleted" });
        save(list); return;
      }
      case "invoice.created": {
        // Accountability discount: credit $1 per activity day (20 max, never below the tier's floor) on membership invoices.
        if (!stripe) return;
        const c = who(); if (!c) return;
        const at = acctTier(c); if (!at) return;
        const subId = (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || o.subscription;
        if (!subId || subId !== c.membership.stripeSubscriptionId) return;
        // Billing period: from the start of the period to today
        const periodStart = o.period_start ? isoDate(o.period_start) : today().slice(0, 8) + "01";
        const periodEnd = o.period_end ? isoDate(o.period_end) : today();
        const days = activityDays(c, periodStart, periodEnd);
        if (days <= 0) return;
        const creditCents = Math.min(cents(acctCredit(at, days)), o.amount_due || cents(at.price));
        if (creditCents <= 0) return;
        try {
          await stripe.invoiceItems.create({ customer: typeof o.customer === "string" ? o.customer : o.customer.id, invoice: o.id,
            amount: -creditCents, currency: "usd", description: `Accountability credit: ${days} active day${days === 1 ? "" : "s"} (−$${(creditCents / 100).toFixed(2)})` });
          logger.info("accountability_credit", { clientId: c.id, days, creditCents });
        } catch (e) { logger.warn("accountability_credit_failed", { error: e.message }); }
        return;
      }
      case "invoice.paid": {
        const c = who(); if (!c) return;
        const subId = (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || o.subscription;
        const p = (c.protocols || []).find((x) => subId && x.subscriptionId === subId);
        if (p) { p.paid = Math.min(p.payments, (p.paid || 0) + 1); if (p.paid >= p.payments) p.status = "paid"; save(list); }
        // Monthly renewal of a membership (the first payment's receipt goes out from checkout.session.completed)
        if (o.billing_reason === "subscription_cycle" && subId && c.membership && c.membership.stripeSubscriptionId === subId)
          receipt(c, { tier: c.membership.tier, amount: o.amount_paid, currency: o.currency, when: (o.status_transitions && o.status_transitions.paid_at) || ev.created, url: o.hosted_invoice_url, number: o.number });
        return;
      }
      case "invoice.payment_failed": {
        const c = who(); if (!c) return;
        notify.owner(`Payment failed: ${c.name}`, `A payment from ${c.name} (${c.email}) failed. Stripe will retry automatically.`);
        { const push = app.get("push"); if (push) push.toClient(c.id, { title: "Payment didn't go through", body: "Please update your card in the app.", route: "premium" }); }
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
    store.write("stripeEvents", [...seen(), ev.id].slice(-1000)); // fresh read: events handled meanwhile stay recorded
    res.json({ received: true });
  });

  // ---------------- Admin ----------------
  admin.get("/payments", (req, res) => {
    res.json({ enabled: enabled(), webhook: !!whsec, clients: clients().filter((c) => c.stripeCustomerId || (c.protocols || []).length).map((c) => ({
      id: c.id, name: c.name, email: c.email, stripeCustomerId: c.stripeCustomerId || null, membership: c.membership || null, protocols: c.protocols || [] })) });
  });
  if (typeof setReconcile === "function") setReconcile(reconcile);
  return { enabled, protocolQuote, reconcile };
}

module.exports = { mountPayments, protocolQuote, activityDays, API_VERSION };
