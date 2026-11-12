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
    // Review rewards were retired (owner, Nov 2026): no code gives a discount any more
    void code; return null;
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
  // One service, paid for once. `visit` is set when the patient picked a time first (Medical record): the appointment
  // id rides along in the metadata so the held slot becomes a real booking the moment Stripe says it is paid.
  async function serviceCheckout(c, svc, opts = {}) {
    if (!enabled()) { const e = new Error("Online payment isn't switched on yet. Call 941-313-0562 to book."); e.status = 503; throw e; }
    const customer = await ensureCustomer(c.id);
    const visit = opts.appointmentId ? { appointmentId: String(opts.appointmentId) } : null;
    const name = visit && opts.date ? `${svc.name} · ${opts.date} ${opts.time}` : `${svc.name} · 1 visit`;
    const meta = { kind: "service", service: svc.id, clientId: c.id, ...(visit ? { apptId: visit.appointmentId } : {}) };
    const done = `/account?checkout=success&kind=service&svc=${svc.id}${visit ? "&visit=1" : ""}`;
    const base = {
      mode: "payment", customer, client_reference_id: c.id,
      line_items: [{ price_data: { currency: "usd", unit_amount: cents(svc.rate), product_data: { name } }, quantity: 1 }],
      payment_intent_data: { metadata: meta }, metadata: meta,
      ...(visit ? { expires_at: Math.floor(Date.now() / 1000) + 30 * 60 } : {}),
      success_url: `${site()}${done}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: visit ? `${site()}/account#home` : `${site()}/#services`,
      integration_identifier: `mdfit_service_${letters()}`
    };
    const session = await stripe.checkout.sessions.create(withUiMode(base, opts, done));
    activity("checkout_started", { email: c.email, kind: "service", service: svc.id, ...(visit ? { visit: 1 } : {}) });
    return session.url ? { url: session.url, id: session.id } : { clientSecret: session.client_secret, id: session.id };
  }

  // An invoice written in the chart, paid by card on a Stripe-hosted page. Stripe is told the invoice number and
  // the amount only: never what the invoice was for.
  async function invoiceCheckout(c, inv) {
    if (!enabled()) { const e = new Error("Card payments are not switched on."); e.status = 503; throw e; }
    const customer = await ensureCustomer(c.id);
    const meta = { kind: "invoice", invoiceId: inv.id, clientId: c.id };
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer, client_reference_id: c.id,
      line_items: [{ price_data: { currency: "usd", unit_amount: inv.amount, product_data: { name: `MD Fit invoice ${inv.number}` } }, quantity: 1 }],
      payment_intent_data: { metadata: meta }, metadata: meta,
      success_url: `${site()}/account?checkout=success&kind=invoice&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${site()}/account`,
      integration_identifier: `mdfit_invoice_${letters()}`
    });
    activity("checkout_started", { email: c.email, kind: "invoice" });
    return { url: session.url, id: session.id };
  }
  // A card to keep on file, typed on a Stripe-hosted page (setup mode: nothing is charged, and the card number never
  // touches this server). Stripe is told which client it is and nothing else.
  async function cardSetup(c) {
    if (!enabled()) { const e = new Error("Card payments are not switched on."); e.status = 503; throw e; }
    const customer = await ensureCustomer(c.id);
    const session = await stripe.checkout.sessions.create({
      mode: "setup", customer, client_reference_id: c.id, currency: "usd",
      metadata: { kind: "card", clientId: c.id }, setup_intent_data: { metadata: { kind: "card", clientId: c.id } },
      success_url: `${site()}/account?card=saved`, cancel_url: `${site()}/account`,
      integration_identifier: `mdfit_card_${letters()}`
    });
    return { url: session.url, id: session.id };
  }
  // What the card processor holds for one person, for the Billing tab: recent charges, the card on file (brand and
  // last four digits only) and anything still open. Each part is asked for on its own, so one refusal (a restricted
  // key without that permission) doesn't hide the rest.
  async function billing(c) {
    if (!stripe || !c || !c.stripeCustomerId) return null;
    const out = { charges: null, card: null, open: 0 }, customer = c.stripeCustomerId;
    const what = (x) => { const k = x.metadata && x.metadata.kind; return k === "service" ? "Visit" : k === "protocol" ? "Care plan" : k === "membership" ? "Membership" : x.description || "Card payment"; };
    try {
      const r = await stripe.charges.list({ customer, limit: 40 });
      out.charges = (r.data || []).filter((x) => !(x.metadata && x.metadata.kind === "invoice")).map((x) => ({
        id: x.id, number: x.receipt_number || "", date: isoDate(x.created), amount: x.amount, receiptUrl: x.receipt_url || "", description: what(x),
        status: x.refunded ? "refunded" : x.amount_refunded ? "part refunded" : x.status === "succeeded" ? "paid" : x.status === "failed" ? "failed" : "pending" }));
    } catch (e) { logger.warn("stripe_billing_charges", { error: e.message }); }
    try {
      const cu = await stripe.customers.retrieve(customer, { expand: ["invoice_settings.default_payment_method"] });
      let pm = cu && cu.invoice_settings && cu.invoice_settings.default_payment_method;
      if (!pm || typeof pm === "string") { const l = await stripe.paymentMethods.list({ customer, type: "card", limit: 1 }); pm = l.data && l.data[0]; }
      if (pm && pm.card) out.card = { brand: pm.card.brand, last4: pm.card.last4, exp: `${String(pm.card.exp_month).padStart(2, "0")}/${String(pm.card.exp_year).slice(-2)}` };
    } catch (e) { logger.warn("stripe_billing_card", { error: e.message }); }
    try { const r = await stripe.invoices.list({ customer, status: "open", limit: 20 }); out.open = (r.data || []).reduce((n, x) => n + (x.amount_remaining || 0), 0); }
    catch (e) { logger.warn("stripe_billing_open", { error: e.message }); }
    return out;
  }

  me.post("/checkout/service", async (req, res) => {
    if (!enabled()) return off(res);
    const s = settings();
    const svc = (s.services || []).find((x) => x.id === (req.body && req.body.service));
    if (!svc) fail("Pick a service.");
    res.json(await serviceCheckout(req.client, svc, { ui: req.body && req.body.ui }));
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
    if (md.kind === "invoice") {
      const emr = app.get("emrApi");
      const was = emr ? (emr.chartOf(c).clinic.invoices.find((x) => x.id === md.invoiceId) || {}).status : "";
      const inv = emr ? emr.invoicePaid(c, md.invoiceId, { sessionId: o.id }) : null;
      if (inv && was !== "paid" && notify.enabled) notify.client(c.email, `Your MD Fit receipt: invoice ${inv.number}`,
        `Hi ${String(c.name || "").split(" ")[0] || "there"},\n\nThank you. Your payment for invoice ${inv.number} is in.\n\nReceipt\n• Invoice ${inv.number}: $${((o.amount_total == null ? inv.amount : o.amount_total) / 100).toFixed(2)}\n• Paid ${new Date(o.created ? o.created * 1000 : Date.now()).toLocaleDateString("en-US", { timeZone: cfg.tz || "America/New_York", month: "long", day: "numeric", year: "numeric" })}\n\nMD Fit · Sarasota, FL · 941-313-0562`);
      return true;
    }
    if (md.kind === "service") {
      // A single visit paid up front (video evaluation / follow-up): it waits in Admin → Medical record for a time
      const svc = (settings().services || []).find((x) => x.id === md.service) || { id: md.service, name: "Visit", remote: false };
      const emr = app.get("emrApi");
      // The patient picked the time before paying: the held slot becomes a booking now (email and link go out from there)
      const booked = emr && md.apptId ? emr.confirmScheduled(c, { appointmentId: md.apptId, service: svc.id, name: svc.name, amount: o.amount_total, currency: o.currency, sessionId: o.id }) : null;
      if (emr && !md.apptId) emr.recordPaidVisit(c, { service: svc.id, name: svc.name, amount: o.amount_total, currency: o.currency, sessionId: o.id });
      const firstName = String(c.name || "").split(" ")[0] || "there";
      const amt = o.amount_total == null ? money(cents(svc.rate || 0)) : money(o.amount_total, o.currency);
      if (notify.enabled) notify.client(c.email, `Your MD Fit receipt: ${svc.name}`,
        `Hi ${firstName},\n\nThank you. Your payment for ${svc.name} is in.\n\nReceipt\n• ${svc.name}: ${amt}\n• Paid ${new Date(o.created ? o.created * 1000 : Date.now()).toLocaleDateString("en-US", { timeZone: cfg.tz || "America/New_York", month: "long", day: "numeric", year: "numeric" })}\n\n${booked ? `Your visit is booked for ${booked.date} at ${booked.time}; the link is in a separate email and in your account under Appointments. ` : svc.remote ? "Dr. Jared will schedule your video visit and the link will show in your account under Appointments. " : ""}Questions? Reply to this email or call 941-313-0562.\n\nMD Fit · Sarasota, FL`);
      notify.owner(`Visit paid: ${c.name}`, `${c.name} (${c.email}) paid ${amt} for ${svc.name}.${booked ? `\n\nThey picked the time themselves: ${booked.date} at ${booked.time}.` : svc.remote ? `\n\nSchedule the video visit: Admin → Medical record → ${c.name} → Video visits.` : ""}`);
      activity("service_paid", { email: c.email, service: svc.id });
    }
    return true;
  }

  // A setup-mode Checkout Session finished: the card the client just saved becomes the customer's default, so later
  // invoices use it and the Billing tab shows it. `o` is the Checkout Session. Safe to run again for the same session:
  // setting the same default twice changes nothing, and the saved time comes from the event, not from the clock.
  // A refusal from Stripe is logged and not thrown: the card is on file either way (billing() falls back to the
  // customer's first card). Only ids are logged, never anything about the card.
  async function cardSaved(c, o) {
    const idOf = (x) => (typeof x === "string" ? x : (x && x.id) || "");
    const customer = idOf(o.customer) || c.stripeCustomerId || "";
    try {
      const si = typeof o.setup_intent === "string" ? await stripe.setupIntents.retrieve(o.setup_intent) : o.setup_intent;
      const pm = idOf(si && si.payment_method);
      if (customer && pm) await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm } });
      else logger.warn("stripe_card_default_skipped", { clientId: c.id, session: o.id });
    } catch (e) { logger.warn("stripe_card_default_failed", { clientId: c.id, session: o.id, error: e.message }); }
    // Read the clients again after the Stripe calls: saving the copy from before them would undo anything saved meanwhile
    const list = clients(), fresh = list.find((x) => x.id === c.id);
    const at = new Date(o.created ? o.created * 1000 : Date.now()).toISOString();
    if (fresh && !(fresh.cardSavedAt >= at)) { fresh.cardSavedAt = at; save(list); }
  }

  // Reconcile with Stripe when a client who has paid through Stripe shows no live membership on our side (the webhook
  // never arrived, or the member paid before it was configured). At most once every 10 minutes per client; returns a
  // promise only when there is something to check, so the usual request path stays synchronous.
  const reconciledAt = new Map();
  // Also runs for a membership an admin granted by hand while a Stripe subscription exists: the record is then
  // linked to the subscription so renewals and cancellations keep it in step.
  const needsCheck = (c) => !active(c) || !c.membership.stripeSubscriptionId;
  function reconcile(c) {
    if (!stripe || !c || !c.stripeCustomerId || !needsCheck(c)) return null;
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
        // Setup mode (a card saved on file, payment_status "no_payment_required"): nothing was bought, so nothing to fulfill
        if (o.mode === "setup") return cardSaved(c, { ...o, created: ev.created });
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
  // Closing an account must never leave a live subscription behind. Cancels the membership outright (not at
  // period end: the member is giving up access now) and ends any protocol instalment plan.
  app.set("cancelSubscriptions", async (c) => {
    if (!stripe || !c) return null;
    const ids = new Set();
    if (c.membership && c.membership.stripeSubscriptionId) ids.add(c.membership.stripeSubscriptionId);
    for (const p of c.protocols || []) if (p.subscriptionId) ids.add(p.subscriptionId);
    if (c.stripeCustomerId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: c.stripeCustomerId, status: "active", limit: 20 });
        for (const s of subs.data || []) ids.add(s.id);
      } catch (e) { logger.warn("deletion_sub_list_failed", { clientId: c.id, error: e.message }); }
    }
    const cancelled = [];
    for (const id of ids) {
      try { await stripe.subscriptions.cancel(id); cancelled.push(id); }
      catch (e) { logger.warn("deletion_sub_cancel_failed", { subscription: id, error: e.message }); }
    }
    if (cancelled.length) { const list = clients(), fresh = list.find((x) => x.id === c.id); if (fresh) { fresh.membership = null; save(list); } }
    return { cancelled: cancelled.length };
  });

  // Money that actually moved through Stripe since a moment (Workspace → System economics). It is read from the
  // account's balance history, the one place the processing fee of each payment is written down. A restricted key
  // that may not read that falls back to the list of charges: what was charged and refunded, with no fees.
  // Amounts only: no customer, no description. Payouts to the bank are not income and are left out.
  const MOVES = { charge: "charge", payment: "charge", refund: "refund", payment_refund: "refund", stripe_fee: "fee", stripe_fx_fee: "fee", tax_fee: "fee", adjustment: "other", payment_failure_refund: "refund" };
  async function income(since) {
    if (!stripe) return { on: false, rows: [] };
    const rows = []; let n = 0, truncated = false;
    try {
      for await (const t of stripe.balanceTransactions.list({ created: { gte: since }, limit: 100 })) {
        if (++n > 5000) { truncated = true; break; }
        const kind = MOVES[t.type]; if (!kind || t.currency !== "usd") continue;
        rows.push({ at: t.created, kind, amount: t.amount, fee: kind === "fee" ? 0 : t.fee || 0 });
      }
      return { on: true, fees: true, rows, truncated };
    } catch (err) {
      if (!err || (err.type !== "StripePermissionError" && err.statusCode !== 403 && err.statusCode !== 401)) throw err;
    }
    rows.length = 0; n = 0;
    for await (const c of stripe.charges.list({ created: { gte: since }, limit: 100 })) {
      if (++n > 5000) { truncated = true; break; }
      if (!c.paid || c.status !== "succeeded" || c.currency !== "usd") continue;
      rows.push({ at: c.created, kind: "charge", amount: c.amount, fee: 0 });
      if (c.amount_refunded) rows.push({ at: c.created, kind: "refund", amount: c.amount_refunded, fee: 0 });
    }
    return { on: true, fees: false, rows, truncated };
  }

  if (typeof setReconcile === "function") setReconcile(reconcile);
  const payApi = { enabled, protocolQuote, reconcile, serviceCheckout, invoiceCheckout, cardSetup, billing, income, tiers };
  app.set("payApi", payApi);
  return payApi;
}

module.exports = { mountPayments, protocolQuote, activityDays, API_VERSION };
