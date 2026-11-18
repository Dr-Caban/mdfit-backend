// The manager's revenue share (Junior Partnership, Platform & EMR Agreement, Revision 2, Section 4) and the revenue
// ledger it is calculated from.
//
// Every Stripe payment is recorded when it is paid and tagged with its category (Section 4.7, Exhibit A):
//   online        MD Fit Online Revenue: memberships, subscription add-ons, remote visits (video evaluation/follow-up)
//   clinic        In-Clinic Services: in-person visits, protocols and packages, invoices for care. 100% the Clinic's.
//   unclassified  anything the code can't place. It earns nothing until the owner classifies it (Section 4.7: a new
//                 product is classified in writing before launch).
//
// The manager's share is a percentage of the Net Revenue of each online payment (Section 2.7: what was received, less
// refunds, sales tax and Stripe's fee), 15% while active (4.2) and 5% once active service ends (9.2), except that
// customers of partners the manager originated keep 15% (4.4). Each share:
//   pending   until the payment has cleared in Stripe (the charge's funds are available) and any hold the owner sets
//   ready     the fee is known and the net is final
//   paid      transferred to the manager's Stripe Express account. Automatically only while the owner has switched
//             automatic payouts on (the agreement says monthly, Section 4.8; paying as each payment clears is a change
//             the owner makes on the record). Otherwise the owner pays from the workspace.
//   reversed  refunded or disputed before it was paid; a paid share that is refunded later becomes a negative
//             "clawback" row that comes off the next payout.
// Each payout produces a payment notice for the manager, who accepts it in the console.
//
// No patient data is ever shown to the manager: rows carry the product, category, date and amounts only.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const newId = () => crypto.randomBytes(6).toString("hex");
const cents = (n) => Math.round(Number(n) || 0);
const DEFAULTS = { enabled: false, managerStaffId: "", activePct: 15, continuingPct: 5, status: "active", holdDays: 0, autoPay: false, minPayoutCents: 100, serviceCategory: {} };
const CATEGORIES = ["online", "clinic", "unclassified"];
const AGREEMENT = "Junior Partnership, Platform & EMR Agreement (Revision 2)";

function mountPartnerShare({ app, admin, store, cfg, logger, audit, notify, clients, staff }) {
  const now = () => (typeof cfg.now === "function" ? cfg.now() : new Date());
  const log = (lvl, msg, data) => { if (logger && logger[lvl]) logger[lvl](msg, data); };
  const stripe = () => { const p = app.get("stripeClient"); return p || null; };
  const publishableKey = () => cfg.stripePublishableKey || process.env.STRIPE_PUBLISHABLE_KEY || "";
  const site = () => String(cfg.siteUrl || "https://www.mymdfit.com").replace(/\/+$/, "");

  // ---------- records ----------
  const settings = () => ({ ...DEFAULTS, ...(store.read("partner-share", {}) || {}) });
  const writeSettings = (s) => store.write("partner-share", s);
  const revenue = () => store.read("revenue", []);
  const saveRevenue = (l) => store.write("revenue", l);
  const shares = () => store.read("partner-share-ledger", []);
  const saveShares = (l) => store.write("partner-share-ledger", l);
  const notices = () => store.read("partner-notices", []);
  const saveNotices = (l) => store.write("partner-notices", l);
  const partners = () => store.read("partners", []);

  const sum = (rows, st) => rows.filter((r) => r.status === st).reduce((a, r) => a + r.cents, 0);
  const balances = (rows) => ({ pendingCents: sum(rows, "pending"), readyCents: sum(rows, "ready"), paidCents: sum(rows, "paid"), reversedCents: sum(rows, "reversed") });
  const netOf = (r) => Math.max(0, r.grossCents - (r.taxCents || 0) - (r.feeCents || 0) - (r.refundedCents || 0));

  // Which partner (Exhibit D) a customer came through, if any, and whether the manager originated that partner
  const partnerOf = (c) => { const p = c && c.referredPartner ? partners().find((x) => x.id === c.referredPartner) : null; return p || null; };
  const pctFor = (S, rev) => (S.status === "active" || rev.originated ? S.activePct : S.continuingPct);

  // ---------- recording payments (called from lib/payments.js) ----------
  function record(row) {
    const list = revenue();
    if (list.some((r) => r.ref === row.ref)) return null; // the same payment, seen twice (webhook + the site's confirm)
    const c = row.clientId ? clients().find((x) => x.id === row.clientId) : null, p = partnerOf(c);
    const rev = { id: newId(), feeCents: null, availableOn: null, refundedCents: 0, partnerId: p ? p.id : null, originated: !!(p && p.originatedByManager), ...row };
    saveRevenue([...list, rev]);
    const S = settings();
    if (rev.category === "online" && S.enabled && S.managerStaffId) addShare(rev, S);
    log("info", "revenue_recorded", { id: rev.id, category: rev.category, kind: rev.kind, grossCents: rev.grossCents });
    lookupFees(rev.id).catch(() => {}); // learn the fee and when the funds clear; retried by the tick if Stripe is slow
    return rev;
  }
  function addShare(rev, S) {
    const l = shares();
    if (l.some((x) => x.revenueId === rev.id && x.kind === "share")) return;
    const pct = pctFor(S, rev);
    const est = Math.round(netOf(rev) * pct / 100); // final once the Stripe fee is known
    l.push({ id: newId(), kind: "share", revenueId: rev.id, ts: rev.ts, product: rev.product, pct, cents: est, status: "pending", clearsAt: null, paidAt: null, transferId: null });
    saveShares(l);
  }
  // A paid invoice (memberships, add-ons, protocol instalments, invoices for care). `sub` comes from the affiliates
  // module's subscriptionOf (the subscription's own metadata decides).
  async function recordInvoice(c, inv, ev) {
    try {
      if (!inv || !inv.id || !(cents(inv.amount_paid) > 0)) return null;
      const aff = app.get("affiliates");
      const sub = aff ? await aff.subscriptionOf(c || {}, inv) : { subId: null };
      const tax = aff ? aff.taxOf(inv) : 0;
      const md = inv.metadata || {};
      const category = sub.kind === "membership" || sub.kind === "addon" ? "online"
        : sub.kind === "protocol" || md.kind === "invoice" || md.kind === "invoice_link" || (!sub.subId && md.kind !== "online") ? "clinic"
        : md.category && CATEGORIES.includes(md.category) ? md.category : "unclassified";
      const paidAt = new Date(((inv.status_transitions && inv.status_transitions.paid_at) || (ev && ev.created) || now().getTime() / 1000) * 1000);
      return record({ ts: paidAt.toISOString(), source: "invoice", ref: inv.id, kind: sub.kind || md.kind || "invoice", product: sub.tier ? tierName(sub.tier) : (md.kind === "invoice" ? "Invoice for care" : "Invoice"),
        category, clientId: c ? c.id : null, grossCents: cents(inv.amount_paid), taxCents: tax, paymentIntent: aff ? aff.paymentIntentOf(inv) : null, subscriptionId: sub.subId || null });
    } catch (e) { log("warn", "revenue_record_failed", { ref: inv && inv.id, error: e.message }); return null; }
  }
  // A one-off Checkout payment (a visit paid up front, an invoice link). Subscriptions are recorded from their invoices.
  function recordCheckout(c, o) {
    try {
      if (!o || !o.id || o.mode !== "payment" || !(cents(o.amount_total) > 0)) return null;
      const md = o.metadata || {}, S = settings();
      let category = "unclassified", product = md.kind || "Payment";
      if (md.kind === "service") {
        const svc = ((store.read("settings", {}) || {}).services || []).find((x) => x.id === md.service) || {};
        category = S.serviceCategory[md.service] || (svc.remote ? "online" : "clinic"); // Exhibit A: a remote evaluation is MD Fit Online
        product = svc.name || "Visit";
      } else if (md.kind === "protocol" || md.kind === "invoice" || md.kind === "invoice_link") { category = "clinic"; product = md.kind === "protocol" ? "Protocol" : "Invoice for care"; }
      const tax = cents(o.total_details && o.total_details.amount_tax);
      const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id;
      return record({ ts: new Date((o.created || now().getTime() / 1000) * 1000).toISOString(), source: "checkout", ref: o.id, kind: md.kind || "payment", product, category,
        clientId: c ? c.id : null, grossCents: cents(o.amount_total), taxCents: tax, paymentIntent: pi || null });
    } catch (e) { log("warn", "revenue_record_failed", { ref: o && o.id, error: e.message }); return null; }
  }
  const tierName = (tid) => { const t = (require("./content").tiersOf(store.read("content", {})) || []).find((x) => x.id === tid); return t ? t.name : tid; };

  // Stripe's fee and the moment the funds clear, from the charge's balance transaction
  async function lookupFees(revId) {
    const s = stripe(); if (!s) return;
    const r0 = revenue().find((r) => r.id === revId);
    if (!r0 || r0.feeCents != null) return;
    let pi = r0.paymentIntent;
    if (!pi && r0.source === "invoice" && s.invoicePayments) {
      const l = await s.invoicePayments.list({ invoice: r0.ref, limit: 1 });
      const ip = l && l.data && l.data[0], p = ip && ip.payment;
      pi = p && (typeof p.payment_intent === "string" ? p.payment_intent : p.payment_intent && p.payment_intent.id);
    }
    if (!pi) return;
    const intent = await s.paymentIntents.retrieve(pi, { expand: ["latest_charge.balance_transaction"] });
    const bt = intent && intent.latest_charge && intent.latest_charge.balance_transaction;
    if (!bt || typeof bt !== "object") return;
    const list = revenue(), r = list.find((x) => x.id === revId); if (!r) return;
    r.paymentIntent = pi; r.feeCents = cents(bt.fee); r.availableOn = bt.available_on ? new Date(bt.available_on * 1000).toISOString() : null;
    saveRevenue(list);
  }

  // ---------- refunds and disputes ----------
  async function onRefund(o) {
    try {
      if (!o) return null;
      const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id;
      const inv = typeof o.invoice === "string" ? o.invoice : o.invoice && o.invoice.id;
      const list = revenue(), r = list.find((x) => (pi && x.paymentIntent === pi) || (inv && x.ref === inv));
      if (!r) return null;
      const refunded = o.object === "dispute" ? r.grossCents : Math.min(r.grossCents, cents(o.amount_refunded));
      if (refunded <= (r.refundedCents || 0)) return null;
      r.refundedCents = refunded;
      saveRevenue(list);
      const l = shares(), sh = l.find((x) => x.revenueId === r.id && x.kind === "share");
      if (!sh || sh.status === "reversed") return r;
      const full = refunded >= r.grossCents;
      if (sh.status === "pending") { if (full) { sh.status = "reversed"; sh.reversedAt = now().toISOString(); } else sh.cents = Math.round(netOf(r) * sh.pct / 100); }
      else if (sh.status === "ready") { const target = full ? 0 : Math.round(netOf(r) * sh.pct / 100); if (target <= 0) { sh.status = "reversed"; sh.reversedAt = now().toISOString(); } else sh.cents = target; }
      else if (sh.status === "paid") {
        const owed = full ? 0 : Math.round(netOf(r) * sh.pct / 100);
        const already = l.filter((x) => x.revenueId === r.id && x.kind === "clawback").reduce((a, x) => a + x.cents, 0);
        const delta = owed - (sh.cents + already);
        if (delta < 0) l.push({ id: newId(), kind: "clawback", revenueId: r.id, ts: now().toISOString(), product: r.product, pct: sh.pct, cents: delta, status: "ready", clearsAt: now().toISOString(), paidAt: null, transferId: null });
      }
      saveShares(l);
      log("info", "partner_share_refund", { revenueId: r.id, refundedCents: refunded });
      return r;
    } catch (e) { log("warn", "partner_share_refund_failed", { error: e.message }); return null; }
  }

  // ---------- clearing and paying ----------
  // Pending shares clear when Stripe says the payment's funds are available (plus the owner's hold, if any)
  async function clear(at = now()) {
    const S = settings();
    for (const sh of shares().filter((x) => x.status === "pending" && x.kind === "share")) {
      const r = revenue().find((x) => x.id === sh.revenueId);
      if (r && r.feeCents == null) { try { await lookupFees(r.id); } catch (e) { log("warn", "partner_fee_lookup_failed", { revenueId: r.id, error: e.message }); } }
    }
    const l = shares(), rev = revenue(); let moved = 0;
    for (const sh of l) {
      if (sh.status !== "pending" || sh.kind !== "share") continue;
      const r = rev.find((x) => x.id === sh.revenueId);
      if (!r || r.feeCents == null || !r.availableOn) continue; // not cleared in Stripe yet
      const clearsAt = new Date(Math.max(Date.parse(r.availableOn), Date.parse(r.ts) + (S.holdDays || 0) * 864e5));
      sh.clearsAt = clearsAt.toISOString();
      if (clearsAt > at) continue;
      sh.cents = Math.round(netOf(r) * sh.pct / 100); sh.netCents = netOf(r); sh.feeCents = r.feeCents;
      sh.status = sh.cents > 0 ? "ready" : "reversed";
      moved++;
    }
    if (moved) saveShares(l);
    return moved;
  }
  let paying = false;
  async function payout(by) {
    const S = settings(), s = stripe(), out = { paid: null, skipped: null };
    if (!s) return { ...out, skipped: "Stripe is not configured on the API." };
    if (!S.stripeAccountId || !(S.stripe && S.stripe.payoutsEnabled)) return { ...out, skipped: "The manager's Stripe account can't receive payouts yet." };
    if (paying) return { ...out, skipped: "A payout is already running." };
    paying = true;
    try {
      const ready = shares().filter((x) => x.status === "ready");
      const total = ready.reduce((a, x) => a + x.cents, 0);
      if (total < (S.minPayoutCents || 100)) return { ...out, skipped: total <= 0 ? "Nothing to pay." : `Under the $${((S.minPayoutCents || 100) / 100).toFixed(2)} minimum.` };
      const ids = ready.map((x) => x.id).sort();
      const idem = "share_" + crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 40);
      const tr = await s.transfers.create({ amount: total, currency: "usd", destination: S.stripeAccountId, description: "MD Fit Online revenue share",
        transfer_group: `partner_share_${now().toISOString().slice(0, 7)}`, metadata: { rows: String(ids.length), by } }, { idempotencyKey: idem });
      const at = now().toISOString(), l = shares(), want = new Set(ids), extra = [];
      for (const x of l) {
        if (!want.has(x.id)) continue;
        if (x.status === "reversed") extra.push({ id: newId(), kind: "clawback", revenueId: x.revenueId, ts: at, product: x.product, pct: x.pct, cents: -x.cents, status: "ready", clearsAt: at, paidAt: null, transferId: null });
        x.status = "paid"; x.paidAt = at; x.transferId = tr.id;
      }
      saveShares([...l, ...extra]);
      const paidRows = l.filter((x) => want.has(x.id));
      const from = paidRows.map((x) => x.ts).sort()[0], to = paidRows.map((x) => x.ts).sort().slice(-1)[0];
      const notice = { id: newId(), ts: at, transferId: tr.id, cents: total, rows: ids, from, to, by,
        text: `$${(total / 100).toFixed(2)} was transferred to your Stripe account for your revenue share on ${ids.length} cleared payment${ids.length === 1 ? "" : "s"} (${from.slice(0, 10)} to ${to.slice(0, 10)}), under Section 4 of the ${AGREEMENT}. The breakdown is in your console. Accepting confirms you have reviewed this payment and its breakdown. A question about an amount is raised in writing under Section 12.2.`,
        acceptedAt: null };
      saveNotices([...notices(), notice]);
      if (audit) audit.record({ actor: by.startsWith("admin:") ? by : `system:${by}`, action: "partner_share.payout", subject: tr.id, meta: { cents: total, rows: ids.length } });
      log("info", "partner_share_payout", { cents: total, rows: ids.length, transferId: tr.id, by });
      const mgr = staff && staff.byId(S.managerStaffId);
      if (mgr && notify && notify.client) { try { notify.client(mgr.email, `MD Fit payment notice: $${(total / 100).toFixed(2)}`, `${notice.text}\n\nReview and accept it in your console: ${site()}/manager#partner\n\nMD Fit Online`); } catch {} }
      return { ...out, paid: { cents: total, rows: ids.length, transferId: tr.id, noticeId: notice.id } };
    } catch (e) { log("warn", "partner_share_payout_failed", { error: e.message }); return { ...out, skipped: `Stripe refused the transfer: ${e.message}` }; }
    finally { paying = false; }
  }
  // Hourly: clear what Stripe has cleared; pay it out at once if the owner switched automatic payouts on
  async function tick() {
    try { await clear(); } catch (e) { log("warn", "partner_share_clear_failed", { error: e.message }); }
    const S = settings();
    if (S.enabled && S.autoPay) { const r = await payout("schedule"); if (r.skipped && !/Nothing to pay|minimum/.test(r.skipped)) log("info", "partner_share_payout_skipped", { why: r.skipped }); }
  }
  if (!cfg.noAffiliateJobs) { setTimeout(() => tick().catch(() => {}), 30000).unref(); setInterval(() => tick().catch(() => {}), 60 * 60 * 1000).unref(); }

  // ---------- statements (Section 4.8) ----------
  function statement(month) {
    if (!/^\d{4}-\d{2}$/.test(String(month || ""))) fail("Month is YYYY-MM.");
    const rows = revenue().filter((r) => String(r.ts).slice(0, 7) === month);
    const by = {};
    for (const c of CATEGORIES) {
      const rs = rows.filter((r) => r.category === c);
      by[c] = { payments: rs.length, grossCents: rs.reduce((a, r) => a + r.grossCents, 0), taxCents: rs.reduce((a, r) => a + (r.taxCents || 0), 0),
        feeCents: rs.reduce((a, r) => a + (r.feeCents || 0), 0), refundedCents: rs.reduce((a, r) => a + (r.refundedCents || 0), 0), netCents: rs.reduce((a, r) => a + netOf(r), 0),
        feesPending: rs.filter((r) => r.feeCents == null).length };
    }
    const ids = new Set(rows.map((r) => r.id)), sh = shares().filter((x) => ids.has(x.revenueId) || String(x.ts).slice(0, 7) === month);
    const comm = (store.read("commissions", []) || []).filter((x) => String(x.ts).slice(0, 7) === month && x.status !== "reversed");
    return { month, agreement: AGREEMENT, categories: by, share: { ...balances(sh), earnedCents: sh.filter((x) => x.status !== "reversed").reduce((a, x) => a + x.cents, 0) },
      partnerCommissionsCents: comm.reduce((a, x) => a + x.cents, 0), payouts: notices().filter((n) => String(n.ts).slice(0, 7) === month).map((n) => ({ ts: n.ts, cents: n.cents, transferId: n.transferId, acceptedAt: n.acceptedAt })) };
  }

  // ---------- views (no patient data: no names, no emails, no client ids) ----------
  const shareRow = (x) => { const r = revenue().find((y) => y.id === x.revenueId) || {}; return { id: x.id, kind: x.kind, ts: x.ts, product: x.product || r.product || "", category: r.category || "",
    grossCents: r.grossCents || 0, taxCents: r.taxCents || 0, feeCents: r.feeCents, refundedCents: r.refundedCents || 0, netCents: r.grossCents != null ? netOf(r) : null, pct: x.pct, cents: x.cents,
    status: x.status, clearsAt: x.clearsAt, paidAt: x.paidAt, viaPartner: r.partnerId ? (partners().find((p) => p.id === r.partnerId) || {}).name || "" : "" }; };
  const managerView = () => {
    const S = settings(), l = shares();
    return { enabled: S.enabled, status: S.status, pct: S.status === "active" ? S.activePct : S.continuingPct, activePct: S.activePct, continuingPct: S.continuingPct, holdDays: S.holdDays,
      autoPay: S.autoPay, autoPayOnAt: S.autoPayOnAt || null, agreement: AGREEMENT, balances: balances(l),
      stripe: { connected: !!S.stripeAccountId, payoutsEnabled: !!(S.stripe && S.stripe.payoutsEnabled), detailsSubmitted: !!(S.stripe && S.stripe.detailsSubmitted), embedded: !!(stripe() && publishableKey()), publishableKey: publishableKey() || null },
      ledger: l.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 300).map(shareRow), notices: notices().slice().reverse().slice(0, 50) };
  };

  // ---------- the manager's console: /api/admin/partner/* (permission "partner"; only the named manager, or the owner) ----------
  // The console (/manager) is one person's: the staff account whose email is MANAGER_EMAIL on the server, with the
  // Manager role, signed in as themselves. Nobody else, the owner included (the owner has everything they need under
  // /partner-share). Unset or mismatched, nobody gets in.
  const managerEmail = () => String(cfg.managerEmail || process.env.MANAGER_EMAIL || "").trim().toLowerCase();
  const isManager = (req) => {
    const a = req.account, want = managerEmail();
    return !!(a && !a.isOwner && want && (a.roles || [a.role]).includes("manager") && String(a.email || "").toLowerCase() === want);
  };
  const mine = (req, res) => { if (isManager(req)) return true; res.status(403).json({ error: managerEmail() ? "This console is only for the MD Fit Online manager." : "The manager console isn't set up on the server (MANAGER_EMAIL)." }); return false; };
  admin.get("/partner/share", (req, res) => { if (mine(req, res)) res.json(managerView()); });
  admin.get("/partner/statement", (req, res) => { if (mine(req, res)) res.json(statement(req.query.month || now().toISOString().slice(0, 7))); });
  admin.get("/partner/statement.csv", (req, res) => {
    if (!mine(req, res)) return;
    const month = String(req.query.month || now().toISOString().slice(0, 7)); statement(month);
    const ids = new Set(revenue().filter((r) => String(r.ts).slice(0, 7) === month).map((r) => r.id));
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`, d = (c) => (c == null ? "" : (c / 100).toFixed(2));
    const lines = [["date", "product", "category", "gross_usd", "tax_usd", "stripe_fee_usd", "refunded_usd", "net_usd", "share_pct", "share_usd", "status", "paid_at", "via_partner"].join(",")];
    for (const r of revenue().filter((x) => ids.has(x.id))) {
      const sh = shares().find((x) => x.revenueId === r.id && x.kind === "share");
      lines.push([r.ts, r.product, r.category, d(r.grossCents), d(r.taxCents), d(r.feeCents), d(r.refundedCents), d(netOf(r)), sh ? sh.pct : "", sh ? d(sh.cents) : "", sh ? sh.status : "", sh ? sh.paidAt || "" : "",
        r.partnerId ? (partners().find((p) => p.id === r.partnerId) || {}).name || "" : ""].map(q).join(","));
    }
    res.set("Content-Type", "text/csv; charset=utf-8"); res.set("Content-Disposition", `attachment; filename="mdfit-online-statement-${month}.csv"`);
    res.send(lines.join("\n") + "\n");
  });
  admin.post("/partner/notices/:id/accept", (req, res) => {
    if (!mine(req, res)) return;
    const l = notices(), n = l.find((x) => x.id === req.params.id);
    if (!n) return res.status(404).json({ error: "Notice not found." });
    if (!n.acceptedAt) { n.acceptedAt = now().toISOString(); n.acceptedBy = req.account.email; saveNotices(l); if (audit) audit.record({ actor: `admin:${req.account.email}`, action: "partner_share.notice_accept", subject: n.id, ip: req.ip, meta: { cents: n.cents, transferId: n.transferId } }); }
    res.json(n);
  });
  // The manager's own Stripe Express account, embedded in the console (Connect embedded components)
  async function ensureAccount(req) {
    const S = settings(), s = stripe();
    if (S.stripeAccountId) return S.stripeAccountId;
    const acct = await s.accounts.create({ type: "express", country: "US", email: req.account.email, business_type: "individual", capabilities: { transfers: { requested: true } },
      business_profile: { product_description: "Revenue share from MD Fit Online", url: site() }, metadata: { staffId: req.account.id, purpose: "partner_share" }, tos_acceptance: { service_agreement: "full" } });
    writeSettings({ ...settings(), stripeAccountId: acct.id, stripe: { detailsSubmitted: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled } });
    if (audit) audit.record({ actor: `admin:${req.account.email}`, action: "partner_share.stripe_account", subject: acct.id, ip: req.ip });
    return acct.id;
  }
  const onlyTheManager = (req, res) => { if (!mine(req, res)) return false; if (!stripe()) { res.status(503).json({ error: "Stripe is not configured on the API." }); return false; } return true; };
  admin.post("/partner/stripe/session", async (req, res) => {
    if (!onlyTheManager(req, res)) return;
    if (!publishableKey()) return res.status(503).json({ error: "Embedded payouts aren't set up on the server." });
    try {
      const account = await ensureAccount(req), bank = { external_account_collection: true };
      const s = await stripe().accountSessions.create({ account, components: { account_onboarding: { enabled: true, features: bank },
        payouts: { enabled: true, features: { ...bank, instant_payouts: true, standard_payouts: false, edit_payout_schedule: false } }, account_management: { enabled: true, features: bank }, notification_banner: { enabled: true, features: bank } } });
      res.set("Cache-Control", "no-store"); res.json({ clientSecret: s.client_secret, publishableKey: publishableKey() });
    } catch (e) { log("warn", "partner_session_failed", { error: e.message }); res.status(502).json({ error: "Stripe could not open payouts. Try again in a minute." }); }
  });
  admin.post("/partner/stripe/onboard", async (req, res) => {
    if (!onlyTheManager(req, res)) return;
    try {
      const account = await ensureAccount(req);
      const link = await stripe().accountLinks.create({ account, type: "account_onboarding", refresh_url: `${site()}/manager#partner`, return_url: `${site()}/manager#partner` });
      res.json({ url: link.url });
    } catch (e) { res.status(502).json({ error: "Stripe could not start the set-up. Try again in a minute." }); }
  });
  admin.get("/partner/stripe/status", async (req, res) => {
    if (!mine(req, res)) return;
    const S = settings();
    if (!stripe() || !S.stripeAccountId) return res.json({ connected: false });
    try { const a = await stripe().accounts.retrieve(S.stripeAccountId); writeSettings({ ...settings(), stripe: { detailsSubmitted: !!a.details_submitted, payoutsEnabled: !!a.payouts_enabled } }); } catch {}
    res.json({ connected: true, ...(settings().stripe || {}) });
  });
  function onAccountUpdated(acct) {
    const S = settings();
    if (acct && acct.id && acct.id === S.stripeAccountId) writeSettings({ ...S, stripe: { detailsSubmitted: !!acct.details_submitted, payoutsEnabled: !!acct.payouts_enabled } });
  }

  // ---------- the owner: /api/admin/partner-share/* (not in the route map, so owner only) ----------
  function validate(b, cur) {
    const out = {};
    const pct = (k, label) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!Number.isFinite(n) || n < 0 || n > 50 || Math.round(n * 100) !== n * 100) fail(`${label} is a percentage from 0 to 50.`); out[k] = n; };
    if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") fail("Enabled is on or off."); out.enabled = b.enabled; }
    if (b.autoPay !== undefined) { if (typeof b.autoPay !== "boolean") fail("Automatic payouts is on or off."); out.autoPay = b.autoPay; }
    if (b.managerStaffId !== undefined) {
      const id = String(b.managerStaffId || ""), rec = id ? staff && staff.byId(id) : null;
      if (id && (!rec || !((Array.isArray(rec.roles) && rec.roles.length ? rec.roles : [rec.role]).includes("manager")) || rec.active !== true)) fail("Choose an active staff account with the Manager role.");
      if (id && String(rec.email || "").toLowerCase() !== managerEmail()) fail("The share goes only to the manager account set on the server (MANAGER_EMAIL).");
      out.managerStaffId = id;
    }
    pct("activePct", "The active share"); pct("continuingPct", "The continuing share");
    if (b.status !== undefined) { if (!["active", "continuing"].includes(b.status)) fail("Status is active or continuing."); out.status = b.status; }
    if (b.holdDays !== undefined) { const n = Number(b.holdDays); if (!Number.isInteger(n) || n < 0 || n > 60) fail("The hold is 0 to 60 days."); out.holdDays = n; }
    if (b.minPayoutCents !== undefined) { const n = Number(b.minPayoutCents); if (!Number.isInteger(n) || n < 100 || n > 100000) fail("The payout minimum is $1 to $1,000."); out.minPayoutCents = n; }
    if (b.serviceCategory !== undefined) {
      if (!b.serviceCategory || typeof b.serviceCategory !== "object") fail("Service categories are a map of service id to online or clinic.");
      out.serviceCategory = {};
      for (const [k, v] of Object.entries(b.serviceCategory)) { if (!["online", "clinic"].includes(v)) fail("A service is online or clinic."); out.serviceCategory[String(k).slice(0, 60)] = v; }
    }
    if (!Object.keys(out).length) fail("Nothing to change.");
    return out;
  }
  admin.get("/partner-share", (req, res) => {
    const S = settings();
    res.json({ settings: { ...S }, view: managerView(), managers: (staff ? staff.listFor() : []).filter((x) => (x.roles || [x.role]).includes("manager")).map((x) => ({ id: x.id, name: x.name, email: x.email, active: x.active })),
      unclassified: revenue().filter((r) => r.category === "unclassified").slice(-200).reverse().map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, product: r.product, grossCents: r.grossCents })),
      statement: statement(now().toISOString().slice(0, 7)) });
  });
  admin.get("/partner-share/settings", (req, res) => res.json(settings()));
  admin.put("/partner-share/settings", (req, res) => {
    const cur = settings(), changed = validate(req.body || {}, cur), next = { ...cur, ...changed };
    if (changed.autoPay === true && !cur.autoPay) { next.autoPayOnAt = now().toISOString(); next.autoPayOnBy = req.admin; } // the owner's consent, on the record
    if (changed.autoPay === false) { next.autoPayOnAt = null; next.autoPayOnBy = null; }
    writeSettings(next);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "partner_share.settings", ip: req.ip, meta: { changed, before: Object.fromEntries(Object.keys(changed).map((k) => [k, cur[k]])) } });
    res.json(settings());
  });
  admin.post("/partner-share/classify", (req, res) => {
    const { revenueId, category } = req.body || {};
    if (!["online", "clinic"].includes(category)) fail("Category is online or clinic.");
    const list = revenue(), r = list.find((x) => x.id === revenueId);
    if (!r) return res.status(404).json({ error: "Payment not found." });
    if (r.category !== "unclassified") return res.status(409).json({ error: "That payment is already classified." });
    r.category = category; r.classifiedBy = req.admin; r.classifiedAt = now().toISOString();
    saveRevenue(list);
    const S = settings();
    if (category === "online" && S.enabled && S.managerStaffId) addShare(r, S);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "partner_share.classify", subject: r.id, ip: req.ip, meta: { category } });
    res.json({ id: r.id, category });
  });
  admin.post("/partner-share/run", async (req, res) => {
    const job = req.body && req.body.job;
    if (job === "clear") return res.json({ cleared: await clear() });
    if (job === "payout") return res.json(await payout(`admin:${req.admin}`));
    fail("Job is clear or payout.");
  });

  // ---------- PATF: partners (Exhibit D) and attribution ----------
  // A partner (a gym, an affiliate business, a referral partner, an API partner) gets its own code and link, which work
  // exactly like a member's referral code (lib/clients.js credits a sign-up to the partner when the code is a partner's).
  // The manager registers partners they originate (Section 7.2); the owner acknowledges within five business days or
  // disputes in writing, and an undisputed registration is deemed acknowledged. Non-circumvention runs 24 months (7.3).
  const savePartners = (l) => store.write("partners", l);
  const PARTNER_TYPES = ["gym", "affiliate", "referral", "api", "other"];
  const businessDaysAfter = (iso, n) => { const d = new Date(iso); let added = 0; while (added < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) added++; } return d.toISOString(); };
  const partnerState = (p, at = now()) => p.disputedAt ? "disputed" : p.acknowledgedAt ? "acknowledged" : new Date(p.ackDueAt) <= at ? "deemed acknowledged" : "awaiting acknowledgment";
  const codeTaken = (code) => { const k = code.toUpperCase(); return clients().some((c) => String(c.referralCode || "").toUpperCase() === k) || partners().some((p) => p.code === k); };
  function newCode(name) {
    const prefix = String(name || "").replace(/[^a-zA-Z]/g, "").slice(0, 5).toUpperCase() || "PTNR";
    let code; do { code = `P-${prefix}${crypto.randomBytes(2).toString("hex").toUpperCase()}`; } while (codeTaken(code));
    return code;
  }
  function checkPartner(b, cur = {}) {
    const out = {};
    const txt = (k, label, max, need) => { if (b[k] === undefined) { if (need && !cur[k]) fail(`${label} is needed.`); return; } const v = String(b[k] || "").trim(); if (need && !v) fail(`${label} is needed.`); if (v.length > max) fail(`${label} is too long.`); out[k] = v; };
    txt("name", "The partner's name", 120, true); txt("contact", "Contact", 200, false); txt("notes", "Notes", 1000, false);
    if (b.type !== undefined) { if (!PARTNER_TYPES.includes(b.type)) fail(`Type is one of: ${PARTNER_TYPES.join(", ")}.`); out.type = b.type; }
    if (b.ratePct !== undefined) { const n = Number(b.ratePct); if (!Number.isFinite(n) || n < 0 || n > 15 || Math.round(n * 100) !== n * 100) fail("The partner's commission is 0 to 15% of Net Revenue from their customers' memberships (the Partner Allowance, Section 4.3)."); out.ratePct = n; }
    if (b.code !== undefined && b.code !== "") { const c = String(b.code).trim().toUpperCase(); if (!/^[A-Z0-9][A-Z0-9-]{3,19}$/.test(c)) fail("A code is 4 to 20 letters, numbers or dashes."); if (c !== cur.code && codeTaken(c)) fail("That code is already used."); out.code = c; }
    return out;
  }
  const isOwner = (req) => !!(req.account && req.account.isOwner);
  function createPartner(req, b) {
    const S = settings(), byManager = !isOwner(req);
    const fields = checkPartner(b);
    const at = now().toISOString();
    const p = { id: newId(), name: fields.name, contact: fields.contact || "", type: fields.type || "referral", notes: fields.notes || "", code: fields.code || newCode(fields.name), ratePct: fields.ratePct != null ? fields.ratePct : 0,
      originatedByManager: byManager ? true : b.originatedByManager === true, registeredAt: at, registeredBy: req.account.email, ackDueAt: businessDaysAfter(at, 5), acknowledgedAt: byManager ? null : at, acknowledgedBy: byManager ? null : req.account.email,
      disputedAt: null, disputeReason: "", status: "active", nonCircumventionUntil: new Date(Date.parse(at) + 730 * 864e5).toISOString() };
    savePartners([...partners(), p]);
    if (audit) audit.record({ actor: `admin:${req.account.email}`, action: "partners.register", subject: p.id, ip: req.ip, meta: { name: p.name, code: p.code, ratePct: p.ratePct, originatedByManager: p.originatedByManager } });
    if (byManager && notify && notify.owner) { try { notify.owner(`Partner registered: ${p.name}`, `${req.account.name || req.account.email} registered ${p.name} (${p.type}) under Section 7.2 of the ${AGREEMENT}, commission ${p.ratePct}% within the Partner Allowance, code ${p.code}.\n\nAcknowledge or dispute it in writing by ${p.ackDueAt.slice(0, 10)} (Workspace > Affiliates & partners). Undisputed, it is deemed acknowledged.`); } catch {} }
    return p;
  }
  // PATF figures for every partner and for member referrals: clicks (link visits), sign-ups, paying now, attributed
  // revenue and commission. Counts and amounts only.
  function patf(month) {
    const ev = store.read("referral-events", []) || [], list = clients(), rev = revenue(), day = now().toISOString().slice(0, 10);
    const inMonth = (iso) => !month || String(iso || "").slice(0, 7) === month;
    const rows = partners().map((p) => {
      const mine = list.filter((c) => c.referredPartner === p.id), r = rev.filter((x) => x.partnerId === p.id && inMonth(x.ts));
      const recurring = r.filter((x) => x.category === "online" && (x.kind === "membership" || x.kind === "addon"));
      const net = recurring.reduce((a, x) => a + netOf(x), 0);
      return { id: p.id, name: p.name, type: p.type, code: p.code, link: `${site()}/login?signup&ref=${encodeURIComponent(p.code)}`, ratePct: p.ratePct, originatedByManager: p.originatedByManager,
        registeredAt: p.registeredAt, state: partnerState(p), ackDueAt: p.ackDueAt, disputeReason: p.disputeReason || "", status: p.status, nonCircumventionUntil: p.nonCircumventionUntil,
        clicks: ev.filter((e) => e.type === "visit" && String(e.code || "").toUpperCase() === p.code && inMonth(e.ts)).length,
        signups: mine.filter((c) => inMonth(c.createdAt)).length,
        payingNow: mine.filter((c) => c.membership && c.membership.stripeSubscriptionId && (!c.membership.until || c.membership.until >= day)).length,
        revenueCents: r.reduce((a, x) => a + x.grossCents, 0), membershipNetCents: net, commissionDueCents: Math.round(net * p.ratePct / 100) };
    });
    const memberCodes = new Set(list.filter((c) => c.referralCode).map((c) => String(c.referralCode).toUpperCase()));
    const comm = (store.read("commissions", []) || []).filter((x) => inMonth(x.ts) && x.status !== "reversed");
    const members = { clicks: ev.filter((e) => e.type === "visit" && memberCodes.has(String(e.code || "").toUpperCase()) && inMonth(e.ts)).length,
      copies: ev.filter((e) => (e.type === "copy" || e.type === "copy_link" || e.type === "share") && inMonth(e.ts)).length,
      signups: list.filter((c) => c.referredBy && inMonth(c.createdAt)).length, payingNow: list.filter((c) => c.referredBy && c.membership && c.membership.stripeSubscriptionId && (!c.membership.until || c.membership.until >= day)).length,
      commissionsCents: comm.reduce((a, x) => a + x.cents, 0) };
    return { month: month || null, partners: rows, members, unmatchedCodes: ev.filter((e) => e.type === "unmatched" && inMonth(e.ts)).length };
  }
  admin.get("/partner/patf", (req, res) => { if (mine(req, res)) res.json(patf(req.query.month ? String(req.query.month) : null)); });
  admin.post("/partner/partners", (req, res) => { if (!mine(req, res)) return; res.status(201).json(createPartner(req, req.body || {})); });
  admin.post("/partner-share/partners", (req, res) => res.status(201).json(createPartner(req, req.body || {})));
  admin.put("/partner-share/partners/:id", (req, res) => {
    const l = partners(), p = l.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "Partner not found." });
    const b = req.body || {}, changed = checkPartner(b, p);
    if (b.status !== undefined) { if (!["active", "ended"].includes(b.status)) fail("Status is active or ended."); changed.status = b.status; }
    if (b.acknowledge === true) { p.acknowledgedAt = now().toISOString(); p.acknowledgedBy = req.admin; p.disputedAt = null; p.disputeReason = ""; }
    if (b.dispute !== undefined) { const why = String(b.dispute || "").trim(); if (why.length < 3) fail("Say why the registration is disputed."); if (new Date(p.ackDueAt) <= now() && !p.disputedAt) fail("The five business days to dispute this registration have passed (Section 7.2)."); p.disputedAt = now().toISOString(); p.disputeReason = why.slice(0, 500); }
    Object.assign(p, changed);
    savePartners(l);
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "partners.update", subject: p.id, ip: req.ip, meta: { changed, acknowledge: b.acknowledge === true, dispute: b.dispute !== undefined } });
    res.json(p);
  });
  admin.get("/partner-share/patf", (req, res) => res.json(patf(req.query.month ? String(req.query.month) : null)));
  // Used by lib/clients.js: a sign-up or a visit with a partner's code
  const partnerByCode = (code) => { const k = String(code || "").trim().toUpperCase(); return k ? partners().find((p) => p.code === k && p.status === "active") || null : null; };

  const api = { recordInvoice, recordCheckout, onRefund, onAccountUpdated, clear, payout, tick, statement, settings, partnerByCode, patf };
  app.set("partnerShare", api);
  return api;
}

module.exports = { mountPartnerShare, DEFAULTS };
