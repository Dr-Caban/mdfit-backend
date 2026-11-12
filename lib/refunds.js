// Refunds (Workspace → a client's Billing tab, and Payments → Invoices). Owner, Nov 2026.
//
// Giving money back is the one thing in the workspace that cannot be undone, so it sits behind the owner's password
// even for someone already signed in: the password is asked for each refund and checked here, on the server.
//
//   - A refund goes back to the card it came from, through Stripe, for all or part of what is left on that payment.
//     Cash and check payments are not refunded here: those are settled by hand and the invoice is marked unpaid.
//   - Which payment: one of the card payments listed for a client (it must belong to that client's own Stripe
//     customer), or an invoice that was paid online (on a chart, or one sent to someone without an account).
//   - Wrong passwords are counted and, after a few, refused for a while. Every attempt is in the audit ledger: the
//     amount and the invoice number or the tail of the payment id, never a card number (this server never has one).
//   - Pressing twice cannot refund twice: Stripe is given the same idempotency key for the same refund.
//   - The person is emailed that a refund is on its way and how long cards usually take.
"use strict";
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const usd = (cents) => "$" + (cents / 100).toFixed(2);
const firstOf = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

function mountRefunds({ app, admin, store, cfg, notify, audit, limiter, logger, clients, payApi, checkPassword }) {
  const tries = limiter(6, 15 * 60 * 1000);
  const record = (action, subject, ip, meta) => audit && audit.record({ actor: "admin", action, subject: subject || "", ip, meta });

  admin.post("/refunds", async (req, res) => {
    const b = req.body || {};
    if (tries.blocked(req.ip)) return res.status(429).json({ error: "Too many wrong passwords. Wait fifteen minutes before trying a refund again." });
    if (!checkPassword(String(b.password || ""))) { tries.hit(req.ip); record("refund.denied", String(b.clientId || ""), req.ip, {}); return res.status(403).json({ error: "That is not the owner password. Nothing was refunded." }); }
    if (!payApi || !payApi.refund || !payApi.enabled()) return res.status(503).json({ error: "Card payments are not switched on, so there is nothing to refund through here." });
    const cents = b.amount === undefined || b.amount === "" || b.amount === null ? null : Math.round(Number(b.amount) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents <= 0)) fail("Enter the amount to refund, or leave it empty to refund all of it.");

    const emr = app.get("emrApi"), links = app.get("invoiceLinks");
    let c = null, target = null, label = "", to = null, after = null;
    if (b.linkId) {
      const t = links ? links.all().find((x) => x.id === String(b.linkId)) : null;
      if (!t) return res.status(404).json({ error: "Invoice not found." });
      if (t.clientId) { b.clientId = t.clientId; b.invoiceId = t.invoiceId; }
      else {
        if (t.status !== "paid" || !t.sessionId) fail("Only an invoice that was paid by card online can be refunded here.");
        target = { sessionId: t.sessionId }; label = t.number; to = { name: t.name, email: t.email };
        after = (r) => links.refunded(t.id, r.amount, r.left === 0);
      }
    }
    if (!target) {
      c = clients().find((x) => x.id === String(b.clientId || ""));
      if (!c) return res.status(404).json({ error: "Client not found." });
      to = { name: c.name, email: c.email };
      if (b.invoiceId) {
        const inv = emr ? emr.chartOf(c).clinic.invoices.find((x) => x.id === String(b.invoiceId)) : null;
        if (!inv) return res.status(404).json({ error: "Invoice not found." });
        if (!inv.sessionId || (inv.status !== "paid" && inv.status !== "refunded")) fail("Only an invoice that was paid by card online can be refunded here. One paid by cash or check is settled by hand: mark it unpaid.");
        target = { sessionId: inv.sessionId }; label = inv.number;
        after = (r) => emr.refundInvoice(c, inv.id, r.amount, r.left === 0);
      } else if (/^(ch|py)_[A-Za-z0-9]+$/.test(String(b.chargeId || ""))) {
        if (!c.stripeCustomerId) fail("This client has no card payments.");
        target = { chargeId: String(b.chargeId), customer: c.stripeCustomerId }; label = "payment …" + String(b.chargeId).slice(-6);
      } else fail("Pick the payment to refund.");
    }

    let r;
    try { r = await payApi.refund({ ...target, amount: cents }); }
    catch (err) {
      if (err instanceof ValidationError) throw err;
      if (logger) logger.error("refund_failed", { type: err && err.type, code: err && err.code });
      const denied = err && (err.type === "StripePermissionError" || err.statusCode === 403 || err.statusCode === 401);
      return res.status(502).json({ error: denied ? "Stripe did not let this key issue a refund. Give the key write access to Refunds in the Stripe dashboard, or refund this payment in Stripe itself." : "Stripe did not accept the refund. Nothing was refunded here; check the payment in Stripe." });
    }
    if (after) { try { after(r); } catch (e) { if (logger) logger.error("refund_mark_failed", { error: e.message }); } }
    record("refund.issued", c ? c.id : "", req.ip, { amount: r.amount, of: r.total, what: label, full: r.left === 0 });
    if (notify.enabled && to && to.email) notify.client(to.email, "Your MD Fit refund",
      `Hi ${firstOf(to.name)},\n\nA refund of ${usd(r.amount)} is on its way back to the card you paid with. Banks usually show it within 5 to 10 business days.\n\nQuestions? Call ${cfg.phone || "941-313-0562"}.\n\nMD Fit`);
    res.json({ ok: true, amount: r.amount, left: r.left, total: r.total });
  });
}

module.exports = { mountRefunds };
