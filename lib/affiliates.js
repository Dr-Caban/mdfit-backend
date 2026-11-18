// Affiliate commissions on subscriptions (owner, Nov 2026).
//
// A member who joins the programme earns a share of what the people they referred pay for **Recurring Memberships
// and subscription add-ons** in the app (Agreement Rev. 2, Sections 4.3 and 5.3, Exhibit A): any monthly membership
// tier the owner ticks, including the plans that come with remote one-on-one sessions, and any add-on price the owner
// lists. A membership is access to MD Fit Online, the rehab clinic's member discounts and partner gyms and studios;
// time with a clinician is one of its features, not what is being sold.
// What never earns a commission is care itself: clinic visits, massage, treatment plans, invoices from the chart and
// one-time remote clinical services. Those are not subscriptions, so they never reach this module, and a commission
// never varies with whether a member uses the clinic (5.3). The owner's attorney reviews the programme before it is
// switched on.
//
// How a commission moves:
//   invoice.paid (Stripe webhook) -> pending, for `holdDays` in case the payment is refunded
//   the hold ends               -> ready
//   payout (the 1st, or by hand) -> paid: one Stripe transfer per affiliate to their Express account, once `ready`
//                                  reaches `minPayoutCents`
//   a refund or dispute          -> reversed if not yet paid out; a negative "clawback" entry if it was
// Each step is pushed to the affiliate's open app over the realtime connection ("referral_update"), so the balances
// on their Profile move the moment a friend pays.
//
// Money that is not the clinic's to keep: the commission is paid out of the subscription revenue it came from, by
// transfer from the platform's Stripe balance. Stripe Express holds the affiliate's identity and bank details; this
// server stores only the account id and whether payouts are enabled.
//
// Records: `affiliates` (the owner's settings), `commissions` (the ledger; ids, cents and dates, no names), and on
// each member `affiliate` ({ joinedAt, terms, status, stripeAccountId, stripe: { detailsSubmitted, payoutsEnabled } }).
"use strict";
const crypto = require("crypto");
const Stripe = require("stripe");
const { ValidationError } = require("./validate");
const content = require("./content");
const { API_VERSION } = require("./payments");

const fail = (m) => { throw new ValidationError(m); };
const id = () => crypto.randomBytes(6).toString("hex");
const TERMS_VERSION = 1;
const DEFAULTS = { enabled: false, ratePct: 5, holdDays: 7, minPayoutCents: 2500, durationMonths: 0, eligibleTiers: ["member", "accountability"], eligibleAddOns: [], freeMonthReward: true };
const LEDGER_MAX = 50000;
const STATUSES = ["active", "paused", "removed"]; // set by the owner; a member who leaves is "left"

function mountAffiliates({ app, admin, me, store, cfg, logger, activity, audit, notify, limiter, clients, save, today }) {
  const key = cfg.stripeSecretKey || process.env.STRIPE_SECRET_KEY || "";
  const stripe = cfg.stripeClient || (key ? new Stripe(key, { apiVersion: API_VERSION }) : null);
  const now = () => (cfg.now ? cfg.now() : new Date());
  const site = () => String(cfg.siteUrl || "https://www.mymdfit.com").replace(/\/+$/, "");
  const log = (lvl, msg, data) => { if (logger && logger[lvl]) logger[lvl](msg, data); };
  const rt = () => app.get("rt");
  const business = require("./business-notify").createBusinessNotify({ cfg, notify, logger });
  // Public by design (it ships in every Stripe web page); embedded payouts need it in the browser
  const publishableKey = () => cfg.stripePublishableKey || process.env.STRIPE_PUBLISHABLE_KEY || "";

  // ---------- settings ----------
  const tiers = () => content.tiersOf(store.read("content", {}));
  const settings = () => {
    const s = { ...DEFAULTS, ...(store.read("affiliates", {}) || {}) };
    const ok = new Set(tiers().map((t) => t.id));
    s.eligibleTiers = (s.eligibleTiers || []).filter((t) => ok.has(t)); // a tier that no longer exists drops out
    return s;
  };
  function validate(b) {
    const cur = settings(), out = {};
    if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") fail("Enabled is on or off."); out.enabled = b.enabled; }
    if (b.ratePct !== undefined) { const n = Number(b.ratePct); if (!Number.isFinite(n) || n < 0 || n > 15 || Math.round(n * 100) !== n * 100) fail("The commission rate is a percentage from 0 to 15 (the Partner Allowance, Agreement Section 4.3), with up to two decimals."); out.ratePct = n; }
    if (b.holdDays !== undefined) { const n = Number(b.holdDays); if (!Number.isInteger(n) || n < 0 || n > 60) fail("The hold is a whole number of days from 0 to 60."); out.holdDays = n; }
    if (b.minPayoutCents !== undefined) { const n = Number(b.minPayoutCents); if (!Number.isInteger(n) || n < 100 || n > 100000) fail("The payout minimum is from $1 to $1,000, in cents."); out.minPayoutCents = n; }
    if (b.durationMonths !== undefined) { const n = Number(b.durationMonths); if (!Number.isInteger(n) || n < 0 || n > 120) fail("How long a referral earns is a whole number of months, 0 for as long as they stay."); out.durationMonths = n; }
    if (b.freeMonthReward !== undefined) { if (typeof b.freeMonthReward !== "boolean") fail("The free month is on or off."); out.freeMonthReward = b.freeMonthReward; }
    if (b.eligibleTiers !== undefined) {
      if (!Array.isArray(b.eligibleTiers)) fail("Eligible subscriptions is a list of tier ids.");
      const all = tiers();
      for (const tid of b.eligibleTiers) {
        const t = all.find((x) => x.id === tid);
        if (!t) fail(`There is no subscription tier "${tid}".`);
      }
      out.eligibleTiers = [...new Set(b.eligibleTiers)];
    }
    if (b.eligibleAddOns !== undefined) {
      if (!Array.isArray(b.eligibleAddOns)) fail("Add-ons is a list of Stripe price lookup keys or price ids.");
      out.eligibleAddOns = [...new Set(b.eligibleAddOns.map((x) => String(x || "").trim()).filter((x) => /^[A-Za-z0-9_.:-]{1,80}$/.test(x)))].slice(0, 50);
    }
    if (!Object.keys(out).length) fail("Nothing to change.");
    return { before: cur, after: { ...cur, ...out }, changed: out };
  }
  const tierOut = (s) => tiers().map((t) => ({ id: t.id, name: t.name, price: t.price, eligible: s.eligibleTiers.includes(t.id) }));

  // ---------- the ledger ----------
  const ledger = () => store.read("commissions", []);
  // Trimming only ever drops settled rows (paid or reversed), oldest first: money still owed is never forgotten
  const saveLedger = (l) => {
    let rows = l;
    if (rows.length > LEDGER_MAX) {
      let drop = rows.length - LEDGER_MAX;
      rows = rows.filter((r) => !(drop > 0 && (r.status === "paid" || r.status === "reversed") && drop--));
    }
    store.write("commissions", rows);
  };
  const cents = (n) => Math.round(Number(n) || 0);
  const sum = (rows, st) => rows.filter((r) => r.status === st).reduce((a, r) => a + r.cents, 0);
  const balances = (rows) => ({ pendingCents: sum(rows, "pending"), readyCents: sum(rows, "ready"), paidCents: sum(rows, "paid"), reversedCents: sum(rows, "reversed") });
  const shortName = (c) => { if (!c) return "A member"; const f = c.firstName || String(c.name || "").split(" ")[0] || "Member", l = (c.lastName || String(c.name || "").split(" ").slice(1).join(" ")).trim(); return l ? `${f} ${l[0]}.` : f; };
  const tierName = (tid) => { const t = tiers().find((x) => x.id === tid); return t ? t.name : tid; };
  const monthOf = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: cfg.tz || "America/New_York" });
  const push = (clientId, data) => { try { const r = rt(); if (r) r.emitToClient(clientId, "referral_update", data); } catch {} };

  const memberRows = (rows, list) => rows.map((r) => {
    const from = list.find((x) => x.id === r.clientId);
    return { id: r.id, at: r.ts, who: r.kind === "adjustment" ? "MD Fit" : r.kind === "clawback" ? `${shortName(from)} (refund)` : shortName(from),
      what: r.kind === "adjustment" ? r.reason || "Adjustment" : `${r.label || "Subscription"} · ${monthOf(r.ts)}`, cents: r.cents, status: r.status, clearsAt: r.clearsAt || null, paidAt: r.paidAt || null };
  });

  // Is this member an affiliate who can earn right now?
  const earning = (c, S = settings()) => !!(S.enabled && c && c.affiliate && c.affiliate.status === "active");

  // ---------- Stripe webhooks hand these over (lib/payments.js) ----------
  // A subscription invoice was paid by someone who was referred. Only eligible subscriptions and add-ons count.
  // Which subscription an invoice is for, and what kind it is. The subscription's own metadata (set at checkout:
  // kind "membership" + tier, or kind "protocol") is the authority; it rides on the invoice in current API versions.
  // The member record is the fallback, and Stripe itself the last resort: the first invoice of a new subscription
  // often arrives before the webhook that writes the membership onto the member.
  async function subscriptionOf(c, inv) {
    const sd = (inv.parent && inv.parent.subscription_details) || inv.subscription_details || {};
    const subId = sd.subscription || (typeof inv.subscription === "string" ? inv.subscription : inv.subscription && inv.subscription.id) || null;
    if (!subId) return { subId: null };
    let md = sd.metadata && sd.metadata.kind ? sd.metadata : null;
    if (!md && c.membership && c.membership.stripeSubscriptionId === subId) md = { kind: "membership", tier: c.membership.tier };
    if (!md && (c.protocols || []).some((p) => p.subscriptionId === subId)) md = { kind: "protocol" };
    if (!md && stripe) { try { md = (await stripe.subscriptions.retrieve(subId)).metadata || {}; } catch (e) { log("warn", "affiliate_sub_lookup_failed", { subId, error: e.message }); } }
    return { subId, kind: (md && md.kind) || "", tier: (md && md.tier) || "" };
  }
  // Tax is the state's, not revenue: it never counts toward a commission
  const taxOf = (inv) => Array.isArray(inv.total_taxes) ? inv.total_taxes.reduce((a, t) => a + cents(t.amount), 0) : cents(inv.tax);
  const paymentIntentOf = (inv) => {
    const p = inv.payments && inv.payments.data && inv.payments.data.find((x) => x.payment && x.payment.payment_intent);
    const pi = (p && p.payment.payment_intent) || inv.payment_intent || null;
    return typeof pi === "string" ? pi : pi && pi.id || null;
  };

  async function onInvoicePaid(c, inv, ev) {
    try {
      if (!c || !c.referredBy || !inv || !inv.id) return null;
      if (!settings().enabled) return null;
      if (ledger().some((r) => r.invoiceId === inv.id && r.kind === "commission")) return null; // cheap early out for a repeat
      const sub = await subscriptionOf(c, inv);
      // Everything below runs without awaiting, so two deliveries of one invoice cannot both write a row
      const S = settings(); if (!S.enabled) return null;
      const list = clients(), referrer = list.find((x) => x.id === c.referredBy);
      if (!referrer || referrer.id === c.id || !earning(referrer, S)) return null;
      const rows = ledger();
      if (rows.some((r) => r.invoiceId === inv.id && r.kind === "commission")) return null; // the same invoice, delivered twice
      const subId = sub.subId;
      let baseCents = 0, label = "", tier = "";
      const tierOk = sub.kind === "membership" && S.eligibleTiers.includes(sub.tier);
      if (tierOk) {
        baseCents = cents(inv.amount_paid) - taxOf(inv); tier = sub.tier; label = tierName(tier);
      } else if (S.eligibleAddOns.length && sub.kind !== "protocol") {
        for (const line of (inv.lines && inv.lines.data) || []) {
          const p = line.price || {}, pd = (line.pricing && line.pricing.price_details) || {};
          const keys = [p.lookup_key, p.id, pd.price, line.metadata && line.metadata.addon].filter(Boolean).map(String);
          if (keys.some((k) => S.eligibleAddOns.includes(k))) { baseCents += cents(line.amount); label = label || line.description || "Subscription add-on"; }
        }
        baseCents = Math.min(baseCents, cents(inv.amount_paid) - taxOf(inv)); // never more than was actually paid
      }
      if (baseCents <= 0) return null;
      const paidAt = new Date(((inv.status_transitions && inv.status_transitions.paid_at) || (ev && ev.created) || now().getTime() / 1000) * 1000);
      if (S.durationMonths > 0) { // a referral earns for a set time from the first commission it produced
        const first = rows.filter((r) => r.referrerId === referrer.id && r.clientId === c.id && r.kind === "commission").map((r) => r.ts).sort()[0];
        if (first) { const end = new Date(first); end.setMonth(end.getMonth() + S.durationMonths); if (paidAt > end) return null; }
      }
      const amount = Math.round((baseCents * S.ratePct) / 100);
      if (amount < 1) return null;
      const clearsAt = new Date(paidAt.getTime() + S.holdDays * 864e5);
      const row = { id: id(), kind: "commission", ts: paidAt.toISOString(), referrerId: referrer.id, clientId: c.id, invoiceId: inv.id, paymentIntent: paymentIntentOf(inv), subscriptionId: subId, tier, label,
        baseCents, ratePct: S.ratePct, cents: amount, status: S.holdDays > 0 && clearsAt > now() ? "pending" : "ready", clearsAt: clearsAt.toISOString() };
      saveLedger([...rows, row]);
      log("info", "affiliate_commission", { referrerId: referrer.id, clientId: c.id, invoiceId: inv.id, cents: amount, status: row.status });
      if (activity) activity("affiliate_commission", { email: referrer.email, cents: amount });
      push(referrer.id, { kind: row.status, cents: amount, from: shortName(c), what: label, balances: balances(ledger().filter((r) => r.referrerId === referrer.id)) });
      return row;
    } catch (e) { log("warn", "affiliate_commission_failed", { error: e.message }); return null; }
  }
  // Which invoice a refunded charge or a dispute was for. Older API versions put the invoice on the charge; current
  // ones link it through the payment intent (the commission row remembers it, and Stripe can be asked).
  async function invoiceForPayment(o) {
    const direct = typeof o.invoice === "string" ? o.invoice : o.invoice && o.invoice.id;
    if (direct) return direct;
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id;
    if (!pi) return null;
    const local = ledger().find((r) => r.paymentIntent === pi && r.kind === "commission");
    if (local) return local.invoiceId;
    if (stripe && stripe.invoicePayments) {
      try {
        const l = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
        const ip = l && l.data && l.data[0];
        if (ip && ip.invoice) return typeof ip.invoice === "string" ? ip.invoice : ip.invoice.id;
      } catch (e) { log("warn", "affiliate_refund_lookup_failed", { paymentIntent: pi, error: e.message }); }
    }
    return null;
  }
  // A refund or dispute: the share of the commission that payment earned is taken back. A dispute takes all of it;
  // a refund takes the refunded share (Stripe sends the running total on each partial refund). Not yet paid out:
  // the row is reversed (in full) or a matching negative row waits beside it (in part). Already paid out: a negative
  // "clawback" row comes off the next payout. A dispute later won by the clinic is not restored automatically; the
  // owner can add an adjustment.
  async function onRefund(o) {
    try {
      if (!o) return null;
      const invoiceId = await invoiceForPayment(o);
      if (!invoiceId) return null;
      const share = o.object === "dispute" || !(cents(o.amount) > 0) ? 1 : Math.min(1, cents(o.amount_refunded) / cents(o.amount));
      if (!(share > 0)) return null;
      const rows = ledger(), row = rows.find((r) => r.invoiceId === invoiceId && r.kind === "commission");
      if (!row || row.status === "reversed") return null;
      const target = Math.round(row.cents * share), delta = target - (row.takenBackCents || 0);
      if (delta <= 0) return null;
      row.takenBackCents = target;
      let out;
      if (target >= row.cents && row.status !== "paid") {
        row.status = "reversed"; row.reversedAt = now().toISOString(); out = row;
        for (const r of rows) if (r.invoiceId === invoiceId && r.kind === "clawback" && r.status !== "paid") { r.status = "reversed"; r.reversedAt = row.reversedAt; }
      } else {
        const waiting = row.status === "pending";
        out = { id: id(), kind: "clawback", ts: now().toISOString(), referrerId: row.referrerId, clientId: row.clientId, invoiceId, tier: row.tier, label: row.label,
          baseCents: -Math.round((row.baseCents || 0) * (delta / row.cents)), ratePct: row.ratePct, cents: -delta, status: waiting ? "pending" : "ready", clearsAt: waiting ? row.clearsAt : now().toISOString() };
        rows.push(out);
      }
      saveLedger(rows);
      log("info", "affiliate_commission_reversed", { referrerId: row.referrerId, invoiceId, cents: delta, share, paidAlready: row.status === "paid" });
      push(row.referrerId, { kind: "reversed", cents: delta, balances: balances(ledger().filter((r) => r.referrerId === row.referrerId)) });
      return out;
    } catch (e) { log("warn", "affiliate_reverse_failed", { error: e.message }); return null; }
  }
  // Stripe tells us an Express account changed (identity verified, bank added, payouts switched on or off)
  function onAccountUpdated(acct) {
    try {
      if (!acct || !acct.id) return;
      const list = clients(), c = list.find((x) => x.affiliate && x.affiliate.stripeAccountId === acct.id);
      if (!c) return;
      c.affiliate.stripe = { detailsSubmitted: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled, updatedAt: now().toISOString() };
      save(list);
      push(c.id, { kind: "stripe", stripe: c.affiliate.stripe });
    } catch (e) { log("warn", "affiliate_account_update_failed", { error: e.message }); }
  }

  // ---------- jobs ----------
  // The hold ends: pending becomes ready
  function clear(at = now()) {
    const rows = ledger(), moved = {};
    // Net Revenue (Agreement Section 2.7): once Stripe's fee for the payment is known (the revenue ledger learns it), the
    // commission is worked out on what was paid less tax and that fee. If Stripe hasn't reported it, the base stays as is.
    const rev = store.read("revenue", []) || [];
    for (const r of rows) if (r.status === "pending" && r.clearsAt && new Date(r.clearsAt) <= at) {
      const paid = r.kind === "commission" && rev.find((x) => x.ref === r.invoiceId && x.feeCents != null);
      if (paid && !r.feeCents) { r.feeCents = paid.feeCents; r.baseCents = Math.max(0, r.baseCents - paid.feeCents); r.cents = Math.round((r.baseCents * r.ratePct) / 100); }
      r.status = "ready"; moved[r.referrerId] = (moved[r.referrerId] || 0) + r.cents;
    }
    if (Object.keys(moved).length) {
      saveLedger(rows);
      for (const [rid, c] of Object.entries(moved)) push(rid, { kind: "ready", cents: c, balances: balances(rows.filter((r) => r.referrerId === rid)) });
    }
    return moved;
  }
  // Pay out what is ready: one transfer per affiliate whose Express account can receive payouts.
  // Safe to run twice at once (the second returns "already running"), safe to crash halfway (each affiliate's rows
  // are written the moment their transfer succeeds, and the transfer carries an idempotency key made from exactly
  // those rows, so a retry within Stripe's window cannot pay the same rows twice), and safe against webhooks landing
  // mid-run (rows are re-read and updated by id, never overwritten from a stale copy).
  let paying = false;
  const PAYS_OUT = new Set(["active", "left"]); // "left": the member stopped earning; what they earned is still theirs
  async function payout(by = "schedule") {
    const out = { paid: [], skipped: [], failed: [] };
    if (!stripe) return { ...out, error: "Stripe is not configured on the API." };
    if (paying) return { ...out, error: "A payout is already running." };
    paying = true;
    try {
      const S = settings(), list = clients(), byAff = new Map();
      for (const r of ledger()) if (r.status === "ready") byAff.set(r.referrerId, [...(byAff.get(r.referrerId) || []), r]);
      for (const [rid, mine] of byAff) {
        const c = list.find((x) => x.id === rid), a = c && c.affiliate, total = mine.reduce((s, r) => s + r.cents, 0);
        if (!c || !a || !PAYS_OUT.has(a.status)) { out.skipped.push({ clientId: rid, cents: total, why: a && a.status === "paused" ? "paused by the clinic" : "not an affiliate" }); continue; }
        if (!a.stripeAccountId || !(a.stripe && a.stripe.payoutsEnabled)) { out.skipped.push({ clientId: rid, cents: total, why: "Stripe account not ready for payouts" }); continue; }
        if (total < S.minPayoutCents) { out.skipped.push({ clientId: rid, cents: total, why: `under the $${(S.minPayoutCents / 100).toFixed(2)} minimum` }); continue; }
        const ids = mine.map((r) => r.id).sort();
        const idem = "aff_" + crypto.createHash("sha256").update(rid + ":" + ids.join(",")).digest("hex").slice(0, 40);
        let tr;
        try {
          tr = await stripe.transfers.create({ amount: total, currency: "usd", destination: a.stripeAccountId, description: "MD Fit affiliate commission",
            transfer_group: `affiliate_${rid}_${now().toISOString().slice(0, 7)}`, metadata: { clientId: rid, commissions: String(mine.length), by } }, { idempotencyKey: idem });
        } catch (e) { out.failed.push({ clientId: rid, cents: total, error: e.message }); log("warn", "affiliate_payout_failed", { clientId: rid, cents: total, error: e.message }); continue; }
        // Fresh read: a refund may have reversed one of these rows while the transfer was in flight. It was paid all
        // the same, so it is marked paid and the refund becomes a clawback against the next payout.
        const at = now().toISOString(), fresh = ledger(), want = new Set(ids), extra = [];
        for (const r of fresh) {
          if (!want.has(r.id)) continue;
          if (r.status === "reversed") extra.push({ id: id(), kind: "clawback", ts: at, referrerId: r.referrerId, clientId: r.clientId, invoiceId: r.invoiceId, tier: r.tier, label: r.label,
            baseCents: -(r.baseCents || 0), ratePct: r.ratePct, cents: -r.cents, status: "ready", clearsAt: at });
          r.status = "paid"; r.paidAt = at; r.transferId = tr.id;
        }
        saveLedger([...fresh, ...extra]);
        out.paid.push({ clientId: rid, cents: total, transferId: tr.id });
        log("info", "affiliate_payout", { clientId: rid, cents: total, transferId: tr.id, commissions: mine.length, by });
        if (activity) activity("affiliate_payout", { email: c.email, cents: total });
        push(rid, { kind: "paid", cents: total, balances: balances(ledger().filter((r) => r.referrerId === rid)) });
      }
      store.write("affiliates-payouts", { lastRunAt: now().toISOString(), lastMonth: now().toISOString().slice(0, 7), by, paid: out.paid.length, failed: out.failed.length });
      if (out.failed.length) { try { business("Affiliate payout: some transfers failed", out.failed.map((f) => `${f.clientId}: ${f.error}`).join("\n")); } catch {} }
      return out;
    } finally { paying = false; }
  }
  // Every hour: end holds that are due; on the 1st, pay out once
  if (!cfg.noAffiliateJobs) {
    const tick = () => {
      try { clear(); } catch (e) { log("warn", "affiliate_clear_failed", { error: e.message }); }
      const d = now(), month = d.toISOString().slice(0, 7), last = store.read("affiliates-payouts", {}) || {};
      if (settings().enabled && d.getUTCDate() === 1 && last.lastMonth !== month) payout("schedule").catch((e) => log("warn", "affiliate_payout_failed", { error: e.message }));
    };
    setTimeout(tick, 20000).unref(); setInterval(tick, 60 * 60 * 1000).unref();
  }

  // ---------- member ----------
  const joinLimit = limiter(10, 60 * 60 * 1000), linkLimit = limiter(10, 60 * 60 * 1000);
  // Opened the link -> joined -> paying for an eligible subscription now. Counts only, never who.
  const funnel = (c, list, S) => {
    const code = String(c.referralCode || "").toUpperCase(), day = now().toISOString().slice(0, 10);
    const opened = code ? (store.read("referral-events", []) || []).filter((e) => e.type === "visit" && String(e.code || "").toUpperCase() === code).length : 0;
    const mine = list.filter((x) => x.referredBy === c.id);
    const paying = mine.filter((x) => x.membership && x.membership.stripeSubscriptionId && S.eligibleTiers.includes(x.membership.tier) && (!x.membership.until || x.membership.until >= day)).length;
    return { opened, joined: mine.length, paying };
  };
  const memberView = (c, S = settings()) => {
    const mine = ledger().filter((r) => r.referrerId === c.id), list = clients();
    const a = c.affiliate || null;
    return {
      enabled: S.enabled, joined: !!(a && (a.status === "active" || a.status === "paused")), status: a ? a.status : "none", joinedAt: a ? a.joinedAt : null,
      ratePct: S.ratePct, holdDays: S.holdDays, minPayoutCents: S.minPayoutCents, durationMonths: S.durationMonths, freeMonth: S.freeMonthReward !== false, termsVersion: TERMS_VERSION,
      eligible: tiers().filter((t) => S.eligibleTiers.includes(t.id)).map((t) => ({ id: t.id, name: t.name, price: t.price })), addOns: S.eligibleAddOns,
      stripe: { connected: !!(a && a.stripeAccountId), detailsSubmitted: !!(a && a.stripe && a.stripe.detailsSubmitted), payoutsEnabled: !!(a && a.stripe && a.stripe.payoutsEnabled), available: !!stripe, embedded: !!(stripe && publishableKey()), publishableKey: publishableKey() || null },
      balances: balances(mine), referred: list.filter((x) => x.referredBy === c.id).length, funnel: funnel(c, list, S),
      ledger: memberRows(mine.slice().sort((x, y) => (x.ts < y.ts ? 1 : -1)).slice(0, 100), list)
    };
  };
  me.get("/affiliate", (req, res) => res.json(memberView(req.client)));
  me.post("/affiliate/join", (req, res) => {
    const S = settings(); if (!S.enabled) return res.status(409).json({ error: "The affiliate programme is not open yet." });
    if (!(req.body && req.body.agree === true)) fail("Please agree to the affiliate terms first.");
    if (joinLimit.blocked(req.client.id)) return res.status(429).json({ error: "Too many tries. Try again later." });
    joinLimit.hit(req.client.id);
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    const was = c.affiliate || {};
    if (was.status === "removed") return res.status(403).json({ error: "This account cannot join the affiliate programme. Contact the clinic." });
    if (was.status === "paused") return res.status(403).json({ error: "Your affiliate account is paused. Contact the clinic." });
    c.affiliate = { ...was, joinedAt: was.joinedAt || now().toISOString(), terms: TERMS_VERSION, agreedAt: now().toISOString(), status: "active" };
    save(list);
    if (activity) activity("affiliate_joined", { email: c.email });
    if (audit) audit.record({ actor: `client:${c.id}`, action: "affiliate.join", subject: c.id, ip: req.ip, meta: { terms: TERMS_VERSION } });
    res.json(memberView(c, S));
  });
  me.post("/affiliate/leave", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    if (!c.affiliate || c.affiliate.status !== "active") return res.json(memberView(c)); // a pause or removal by the clinic stays
    c.affiliate.status = "left"; c.affiliate.leftAt = now().toISOString(); // no new commissions; what is already earned is still paid out
    save(list);
    if (audit) audit.record({ actor: `client:${c.id}`, action: "affiliate.leave", subject: c.id, ip: req.ip });
    res.json(memberView(c));
  });
  // Stripe Express: create the account once, then send them to Stripe's own set-up page. It comes back to the app.
  // The member's Express account, created once. Shared by the hosted set-up link and the embedded components.
  async function ensureAccount(c, list, req) {
    if (c.affiliate.stripeAccountId) return c.affiliate.stripeAccountId;
    const acct = await stripe.accounts.create({ type: "express", country: "US", email: c.email, business_type: "individual",
      capabilities: { transfers: { requested: true } }, business_profile: { product_description: "Referral commissions from MD Fit", url: site() },
      metadata: { clientId: c.id }, tos_acceptance: { service_agreement: "full" } });
    c.affiliate.stripeAccountId = acct.id; c.affiliate.stripe = { detailsSubmitted: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled, updatedAt: now().toISOString() };
    save(list);
    if (audit) audit.record({ actor: `client:${c.id}`, action: "affiliate.stripe_account", subject: c.id, ip: req.ip, meta: { account: acct.id } });
    return acct.id;
  }
  const sessionLimit = limiter(60, 60 * 60 * 1000);
  const affiliateFor = (req, res, lim = linkLimit) => {
    if (!stripe) { res.status(503).json({ error: "Payouts are not set up on the server yet." }); return null; }
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    if (!c.affiliate || c.affiliate.status !== "active") { res.status(409).json({ error: "Set up affiliate commission first." }); return null; }
    if (lim.blocked(c.id)) { res.status(429).json({ error: "Too many tries. Try again later." }); return null; }
    lim.hit(c.id);
    return { list, c };
  };
  // Stripe's hosted set-up page. Used where embedded components can't run (the native apps' web views) and as a fallback.
  me.post("/affiliate/stripe/onboard", async (req, res) => {
    const got = affiliateFor(req, res); if (!got) return;
    const { list, c } = got;
    try {
      const account = await ensureAccount(c, list, req);
      const link = await stripe.accountLinks.create({ account, type: "account_onboarding",
        refresh_url: `${site()}/account?affiliate=stripe-again#profile`, return_url: `${site()}/account?affiliate=stripe-done#profile` });
      res.json({ url: link.url });
    } catch (e) { log("warn", "affiliate_onboard_failed", { clientId: c.id, error: e.message }); res.status(502).json({ error: "Stripe could not start the set-up. Try again in a minute." }); }
  });
  // Embedded Stripe Connect (set-up, payouts with instant payouts, account details, notices), shown inside the app.
  // Each call is a fresh, short-lived Account Session for the member's own account only; the client secret it returns
  // works for nothing else. Express accounts are Stripe-verified, so Stripe may ask the member to sign in in a popup.
  me.post("/affiliate/stripe/session", async (req, res) => {
    if (!publishableKey()) return res.status(503).json({ error: "Embedded payouts aren't set up on the server." });
    const got = affiliateFor(req, res, sessionLimit); if (!got) return;
    const { list, c } = got;
    try {
      const account = await ensureAccount(c, list, req);
      const bank = { external_account_collection: true };
      const s = await stripe.accountSessions.create({ account, components: {
        account_onboarding: { enabled: true, features: bank },
        payouts: { enabled: true, features: { ...bank, instant_payouts: cfg.affiliateInstantPayouts !== false, standard_payouts: false, edit_payout_schedule: false } },
        account_management: { enabled: true, features: bank },
        notification_banner: { enabled: true, features: bank } } });
      res.set("Cache-Control", "no-store");
      res.json({ clientSecret: s.client_secret, publishableKey: publishableKey() });
    } catch (e) { log("warn", "affiliate_session_failed", { clientId: c.id, error: e.message }); res.status(502).json({ error: "Stripe could not open payouts. Try again in a minute." }); }
  });
  // Ask Stripe where the account stands (called when they come back from Stripe)
  me.get("/affiliate/stripe/status", async (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id), a = c.affiliate;
    if (!stripe || !a || !a.stripeAccountId) return res.json({ connected: false, detailsSubmitted: false, payoutsEnabled: false });
    try {
      const acct = await stripe.accounts.retrieve(a.stripeAccountId);
      a.stripe = { detailsSubmitted: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled, updatedAt: now().toISOString() };
      save(list);
    } catch (e) { log("warn", "affiliate_status_failed", { clientId: c.id, error: e.message }); }
    res.json({ connected: true, ...(a.stripe || {}) });
  });
  // Their own Stripe Express dashboard: payouts, bank account, tax forms
  me.post("/affiliate/stripe/dashboard", async (req, res) => {
    const c = clients().find((x) => x.id === req.client.id), a = c.affiliate;
    if (!stripe || !a || !a.stripeAccountId) return res.status(409).json({ error: "Set up your Stripe account first." });
    try { const l = await stripe.accounts.createLoginLink(a.stripeAccountId); res.json({ url: l.url }); }
    catch (e) { res.status(502).json({ error: "Stripe could not open your payouts page. Try again in a minute." }); }
  });

  // ---------- owner ----------
  const adminRows = () => {
    const rows = ledger(), list = clients(), byId = new Map(list.map((c) => [c.id, c]));
    const affs = list.filter((c) => c.affiliate).map((c) => {
      const mine = rows.filter((r) => r.referrerId === c.id), a = c.affiliate;
      return { clientId: c.id, name: c.name, email: c.email, status: a.status, joinedAt: a.joinedAt, stripe: { connected: !!a.stripeAccountId, payoutsEnabled: !!(a.stripe && a.stripe.payoutsEnabled) },
        referred: list.filter((x) => x.referredBy === c.id).length, ...balances(mine) };
    }).sort((x, y) => (y.pendingCents + y.readyCents + y.paidCents) - (x.pendingCents + x.readyCents + x.paidCents));
    const recent = rows.slice().sort((x, y) => (x.ts < y.ts ? 1 : -1)).slice(0, 200).map((r) => ({ ...r, affiliate: (byId.get(r.referrerId) || {}).name || "Deleted account", referred: (byId.get(r.clientId) || {}).name || (r.kind === "adjustment" ? "" : "Deleted account") }));
    return { affiliates: affs, recent };
  };
  admin.get("/affiliates", (req, res) => {
    const S = settings(), rows = ledger();
    res.json({ settings: S, tiers: tierOut(S), totals: { ...balances(rows), affiliates: clients().filter((c) => c.affiliate && c.affiliate.status === "active").length, commissions: rows.filter((r) => r.kind === "commission").length },
      stripe: !!stripe, lastPayout: store.read("affiliates-payouts", null), ...adminRows() });
  });
  admin.put("/affiliates/settings", (req, res) => {
    const { before, after, changed } = validate(req.body || {});
    store.write("affiliates", after);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "affiliates.settings", ip: req.ip, meta: { changed, before: Object.fromEntries(Object.keys(changed).map((k) => [k, before[k]])) } });
    log("info", "affiliate_settings", { by: req.admin, changed: Object.keys(changed) });
    res.json({ settings: settings(), tiers: tierOut(settings()) });
  });
  admin.put("/affiliates/:clientId", (req, res) => {
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) fail("Status is active, paused or removed.");
    const list = clients(), c = list.find((x) => x.id === req.params.clientId);
    if (!c) return res.status(404).json({ error: "Member not found." });
    // Only a member who agreed to the terms can be made active; anyone can be blocked
    if (status !== "removed" && !(c.affiliate && c.affiliate.terms)) return res.status(409).json({ error: "This member hasn't joined the affiliate programme." });
    c.affiliate = { ...(c.affiliate || {}), status, statusBy: req.admin, statusAt: now().toISOString() };
    save(list);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "affiliates.status", subject: c.id, ip: req.ip, meta: { status } });
    push(c.id, { kind: "status", status });
    res.json({ ok: true, status });
  });
  admin.post("/affiliates/adjust", (req, res) => {
    const b = req.body || {}, n = Number(b.cents), reason = String(b.reason || "").trim();
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) fail("The adjustment is a whole number of cents, up to $1,000 either way.");
    if (reason.length < 3 || reason.length > 200) fail("Say why, in a few words.");
    const c = clients().find((x) => x.id === String(b.clientId || ""));
    if (!c || !c.affiliate) return res.status(404).json({ error: "That member is not an affiliate." });
    const row = { id: id(), kind: "adjustment", ts: now().toISOString(), referrerId: c.id, clientId: c.id, cents: n, status: "ready", clearsAt: now().toISOString(), reason, by: req.admin };
    saveLedger([...ledger(), row]);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "affiliates.adjust", subject: c.id, ip: req.ip, meta: { cents: n, reason } });
    push(c.id, { kind: "ready", cents: n, balances: balances(ledger().filter((r) => r.referrerId === c.id)) });
    res.status(201).json(row);
  });
  admin.post("/affiliates/run", async (req, res) => {
    const job = req.body && req.body.job;
    if (job === "clear") return res.json({ moved: clear() });
    if (job === "payout") { const out = await payout(`admin:${req.admin}`); if (audit) audit.record({ actor: `admin:${req.admin}`, action: "affiliates.payout", ip: req.ip, meta: { paid: out.paid.length, failed: out.failed.length } }); return res.json(out); }
    fail("Job is clear or payout.");
  });
  admin.get("/affiliates/export", (req, res) => {
    const list = clients(), byId = new Map(list.map((c) => [c.id, c]));
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [["id", "date", "kind", "affiliate", "referred member", "subscription", "base_usd", "rate_pct", "commission_usd", "status", "clears_at", "paid_at", "transfer_id", "reason"].join(",")];
    for (const r of ledger()) lines.push([r.id, r.ts, r.kind, (byId.get(r.referrerId) || {}).name || "", r.kind === "adjustment" ? "" : (byId.get(r.clientId) || {}).name || "", r.label || "", ((r.baseCents || 0) / 100).toFixed(2), r.ratePct == null ? "" : r.ratePct, (r.cents / 100).toFixed(2), r.status, r.clearsAt || "", r.paidAt || "", r.transferId || "", r.reason || ""].map(q).join(","));
    res.set("Content-Type", "text/csv; charset=utf-8"); res.set("Content-Disposition", `attachment; filename="mdfit-affiliate-commissions-${today()}.csv"`);
    res.send(lines.join("\n") + "\n");
  });

  const api = { settings, subscriptionOf, taxOf, paymentIntentOf, onInvoicePaid, onRefund, onAccountUpdated, clear, payout, earning};
  app.set("affiliates", api);
  return api;
}

module.exports = { mountAffiliates, DEFAULTS, TERMS_VERSION };
