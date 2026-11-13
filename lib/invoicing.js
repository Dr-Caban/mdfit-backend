// Invoice generator (Workspace → Payments → Invoices). Owner, Nov 2026.
//
// The owner's events system has a generator that drafts a ticket, sends it to one person or many, and can put a
// payment in front of it. A medical practice sends invoices, not tickets, so this is that generator for invoices:
// staff write once what it is for and how much, pick the people (clients from the list, or anyone by name and
// email), draft the words of the email, and each person is sent their own invoice with a link to pay it by card.
//
// How it fits what is already here:
//   - For a client, the invoice is written on their chart like any other (same numbers, same Billing tab, same
//     "still owed" totals). For someone without an account it is kept here. Either way it is one invoice per person.
//   - The link in the email does not run out: it opens a fresh Stripe page each time, until the invoice is paid or
//     voided.
//   - An invoice is only ever marked paid by card on Stripe's word: the signed webhook, or this server asking Stripe
//     about a checkout it started itself. The payer's browser is never believed, and a payer who closes the page
//     straight after paying is still marked paid. However many times Stripe or the page says so, it happens once.
//   - A link's address is 128 random bits from the system's generator. It is the only thing that opens the public
//     page, and that page shows a first name, the invoice number, the amount and staff's own message: never an email
//     address, and never what the invoice is for.
//   - Stripe is told the invoice number and the amount. Emails carry the number, the amount and staff's own words.
//   - Someone with an account is also told on their phone and in the app: a notification that says an invoice is
//     waiting (no amount, nothing about what it is for), and the invoice in the app's bell with a Pay button.
//   - Voiding closes any open payment page. If a payment still lands on a voided invoice, the money is not lost
//     track of: it is marked paid and the owner is told, to honour it or refund it in Stripe.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const MAX = 3000, MAX_PEOPLE = 50;
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max);
const line = (v, max) => clean(v, max).replace(/\s+/g, " ");
const firstOf = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const usd = (cents) => "$" + (cents / 100).toFixed(2);

function mountInvoicing({ app, admin, me, store, cfg, notify, audit, limiter, logger, clients, payApi, now = () => new Date() }) {
  const all = () => store.read("invoiceLinks", []);
  const save = (list) => store.write("invoiceLinks", list.slice(-MAX));
  const emr = () => app.get("emrApi");
  const site = () => String(cfg.siteUrl || "").replace(/\/+$/, "");
  const linkOf = (t) => `${site()}/invoice?id=${t.id}`;
  const stamp = () => now().toISOString();
  const record = (action, t, meta = {}, actor = "admin", ip = "") => audit && audit.record({ actor, action, subject: t.clientId || "", ip, meta: { invoice: t.number, ...meta } });
  // Where an invoice stands. One on a chart is read from the chart, so marking it paid or void there shows here too.
  function state(t, list = clients()) {
    if (!t.clientId) return { status: t.status, paidAt: t.paidAt || null, method: t.method || "", online: !!t.sessionId, refunded: t.refunded || 0 };
    const c = list.find((x) => x.id === t.clientId), e = emr();
    let inv = null; try { inv = c && e ? e.chartOf(c).clinic.invoices.find((x) => x.id === t.invoiceId) : null; } catch { inv = null; }
    return inv ? { status: inv.status, paidAt: inv.paidAt || null, method: inv.method || "", online: !!inv.sessionId, refunded: inv.refunded || 0 } : { status: "void", paidAt: null, method: "", online: false, gone: true };
  }
  const row = (t, list) => ({ id: t.id, number: t.number, description: t.description, amount: t.amount, name: t.name, email: t.email, clientId: t.clientId || null, message: t.message,
    createdAt: t.createdAt, emailedAt: t.emailedAt || null, afterVoid: !!t.afterVoid, url: linkOf(t), ...state(t, list) });

  function offer(t, subject, words) {
    notify.client(t.email, line(subject, 120) || `MD Fit invoice ${t.number}`,
      `Hi ${firstOf(t.name)},\n\n${words ? words + "\n\n" : ""}Invoice ${t.number}: ${usd(t.amount)}\n\nPay securely by card here:\n${linkOf(t)}\n\nQuestions? Call ${cfg.phone || "941-313-0562"}.\n\nMD Fit`);
  }

  // Tell a client's own devices: a phone notification and a live notice to the open app. Never the amount or the
  // reason on a lock screen.
  function tell(t) {
    if (!t.clientId) return false;
    let told = false;
    try { const push = app.get("push"); if (push) { push.toClient(t.clientId, { title: "MD Fit sent you an invoice", body: "Open MD Fit to view and pay it.", route: "home", thread: "invoices", collapseId: "inv-" + t.id.slice(0, 12) }); told = true; } } catch { /* no devices registered */ }
    try { const rt = app.get("rt"); if (rt) rt.emitToClient(t.clientId, "invoice_sent", { number: t.number }); } catch { /* not connected */ }
    return told;
  }

  // ---- Paid by card. The one place that happens; safe to reach any number of times for the same payment.
  function paid(id, o) {
    const links = all(), t = links.find((x) => x.id === id);
    if (!t) { if (logger) logger.warn("invoice_link_unmatched", { session: o && o.id }); return null; }
    const was = state(t);
    if (was.status === "paid") return t;
    const late = was.status === "void", amount = o.amount_total == null ? t.amount : o.amount_total;
    if (t.clientId) {
      const c = clients().find((x) => x.id === t.clientId), e = emr();
      const inv = c && e && !was.gone ? e.invoicePaid(c, t.invoiceId, { sessionId: o.id }) : null;
      if (!inv) { // the chart or its invoice is gone: keep the payment on the link itself so it is never lost
        Object.assign(t, { clientId: null, invoiceId: null, status: "paid", method: "card", paidAt: stamp(), sessionId: o.id, orphaned: true });
      }
    } else Object.assign(t, { status: "paid", method: "card", paidAt: stamp(), sessionId: o.id });
    if (late) t.afterVoid = true;
    t.amountPaid = amount; save(links);
    record("invoice.paid_online", t, { amount, ...(late ? { afterVoid: true } : {}) }, "stripe");
    if (notify.enabled) notify.client(t.email, `Your MD Fit receipt: invoice ${t.number}`,
      `Hi ${firstOf(t.name)},\n\nThank you. Your payment for invoice ${t.number} is in.\n\nReceipt\n• Invoice ${t.number}: ${usd(amount)}\n• Paid ${now().toLocaleDateString("en-US", { timeZone: cfg.tz || "America/New_York", month: "long", day: "numeric", year: "numeric" })}\n\nQuestions? Call ${cfg.phone || "941-313-0562"}.\n\nMD Fit`);
    notify.owner(late ? `Paid after you voided it: invoice ${t.number}` : `Invoice paid: ${t.name}`,
      `${t.name} (${t.email}) paid ${usd(amount)} for invoice ${t.number}.${late ? "\n\nYou had voided this invoice, but its payment page was already open and the payment went through. It is marked paid so the money is accounted for: honour it, or refund it in Stripe." : ""}`);
    return t;
  }
  // Ask Stripe about the checkouts this server started for a link (used when the payer comes back from paying)
  async function settle(t) {
    if (state(t).status !== "unpaid" || !payApi || !payApi.linkSession) return t;
    for (const sid of (t.sessions || []).slice(-4).reverse()) {
      let o; try { o = await payApi.linkSession(sid); } catch { continue; }
      if (o && o.status === "complete" && o.payment_status !== "unpaid" && o.metadata && o.metadata.linkId === t.id) return paid(t.id, o) || t;
    }
    return t;
  }

  // ---------------------------------------------------------------- staff
  admin.get("/invoices", (req, res) => { const list = clients(); res.json({ invoices: all().slice().reverse().slice(0, 300).map((t) => row(t, list)), payments: !!(payApi && payApi.enabled()), email: !!notify.enabled }); });

  // Draft once, send to one person or many. Everyone gets an invoice of their own; nobody is sent two.
  admin.post("/invoices", (req, res) => {
    const b = req.body || {}, e = emr();
    if (!site()) return res.status(503).json({ error: "The website address is not set on the server, so a payment link cannot be made." });
    if (b.send && !(payApi && payApi.enabled())) return res.status(503).json({ error: "Card payments are not switched on, so there is no payment page to send. Create the invoices without sending, and mark them paid as you collect." });
    if (b.send && !notify.enabled) fail("Email isn't switched on for this server. Create the invoices and copy their links instead.");
    const description = line(b.description, 200); if (!description) fail("Say what the invoice is for.");
    const dollars = Number(b.amount);
    if (!Number.isFinite(dollars) || dollars < 0.5 || dollars > 20000) fail("Enter an amount between $0.50 and $20,000.");
    const asked = Array.isArray(b.recipients) ? b.recipients : [{ clientId: b.clientId, name: b.name, email: b.email }];
    if (!asked.length) fail("Add at least one person.");
    if (asked.length > MAX_PEOPLE) fail(`Send to at most ${MAX_PEOPLE} people at a time.`);
    // For someone with an account the name and address come from the account, not from what was typed
    const list = clients(), people = [], seen = new Set();
    for (const r of asked) {
      let who;
      if (r && r.clientId) { const c = list.find((x) => x.id === String(r.clientId)); if (!c) return res.status(404).json({ error: "One of the clients picked could not be found." }); who = { name: c.name, email: String(c.email || "").toLowerCase(), c }; }
      else { who = { name: line(r && r.name, 80), email: clean(r && r.email, 160).toLowerCase(), c: null }; if (!who.name) fail("Every person needs a name."); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(who.email)) fail(`Check the email address for ${who.name}.`);
        // typed in, but they do have an account: it goes on their chart all the same
        who.c = list.find((x) => String(x.email || "").toLowerCase() === who.email) || null; if (who.c) who.name = who.c.name; }
      if (seen.has(who.email)) continue; seen.add(who.email); people.push(who);
    }
    if (people.some((p) => p.c) && !e) return res.status(503).json({ error: "Charts are not available on this server." });
    const message = clean(b.message, 600), made = [], at = stamp();
    for (const who of people) {
      const t = { id: crypto.randomBytes(16).toString("hex"), description, amount: Math.round(dollars * 100), name: who.name, email: who.email, message, createdAt: at, sessions: [] };
      if (who.c) { const inv = e.writeInvoice(list, who.c, { description, amount: dollars }); Object.assign(t, { clientId: who.c.id, invoiceId: inv.id, number: inv.number }); }
      else Object.assign(t, { clientId: null, invoiceId: null, number: e ? e.nextNumber() : "INV-" + t.id.slice(0, 6).toUpperCase(), status: "unpaid" });
      if (b.send) { offer(t, b.subject, message); t.emailedAt = at; tell(t); }
      made.push(t);
      record("invoice.generated", t, { amount: t.amount, sent: !!b.send }, "admin", req.ip);
    }
    save([...all(), ...made]);
    const fresh = clients();
    res.status(201).json({ created: made.length, sent: b.send ? made.length : 0, invoices: made.map((t) => row(t, fresh)) });
  });

  const pick = (req, res) => { const links = all(), t = links.find((x) => x.id === req.params.id); if (!t) { res.status(404).json({ error: "Invoice not found." }); return []; } return [links, t]; };

  admin.post("/invoices/:id/send", (req, res) => {
    const [links, t] = pick(req, res); if (!t) return;
    const st = state(t).status; if (st !== "unpaid") fail(st === "paid" ? "This invoice is already paid." : "This invoice was voided.");
    if (!(payApi && payApi.enabled())) return res.status(503).json({ error: "Card payments are not switched on, so there is no payment page to send." });
    if (!notify.enabled) fail("Email isn't switched on for this server. Copy the invoice's link instead.");
    const b = req.body || {};
    if (b.message !== undefined) t.message = clean(b.message, 600);
    offer(t, b.subject, t.message); t.emailedAt = stamp(); tell(t);
    save(links); record("invoice.sent", t, {}, "admin", req.ip);
    res.json(row(t));
  });

  // Paid another way (cash, check…), void, or back to unpaid. For a client this is the chart's own invoice changing.
  admin.post("/invoices/:id/status", async (req, res) => {
    const [links, t] = pick(req, res); if (!t) return;
    const b = req.body || {}, cur = state(t), e = emr(), methods = (e && e.METHODS) || ["card", "cash", "check", "other"];
    if (!["paid", "void", "unpaid"].includes(b.status)) fail("Unknown change.");
    if (b.status === "void" && cur.status === "unpaid" && payApi && payApi.linkExpire) {
      // a payment page that is already open must not be left able to take the money
      for (const sid of t.sessions || []) { try { await payApi.linkExpire(sid); } catch { /* already finished or expired */ } }
      if (state(t).status === "paid") return res.status(409).json({ error: "This invoice was paid a moment ago, so it was not voided." });
    }
    if (t.clientId) {
      const list = clients(), c = list.find((x) => x.id === t.clientId);
      const inv = c && e ? e.changeInvoice(list, c, t.invoiceId, { status: b.status, method: b.method }) : null;
      if (!inv) return res.status(404).json({ error: "This invoice is no longer on the client's chart." });
    } else {
      const fresh = all(), f = fresh.find((x) => x.id === t.id) || t;
      if (b.status === "paid") { if (!methods.includes(b.method)) fail("Pick how it was paid."); if (f.status === "void") fail("A voided invoice can't be paid. Write a new one."); Object.assign(f, { status: "paid", method: b.method, paidAt: stamp() }); }
      else if (b.status === "void") { if ((f.status === "paid" || f.status === "refunded") && f.sessionId) fail("This was paid by card online. Refund it with the card processor instead of voiding it here."); Object.assign(f, { status: "void", voidAt: stamp() }); }
      else { if (f.sessionId) fail("This was paid by card online and can't be marked unpaid."); f.status = "unpaid"; delete f.method; delete f.paidAt; delete f.voidAt; }
      save(fresh);
    }
    record("invoice." + b.status, t, b.status === "paid" ? { method: b.method } : {}, "admin", req.ip);
    res.json(row(all().find((x) => x.id === t.id) || t));
  });

  // ---------------------------------------------------------------- the payer's own page (no sign-in: the address is the key)
  // The page asks "is it paid yet?" a few times after coming back from Stripe, so that has room of its own
  const open = limiter(60, 10 * 60 * 1000), paying = limiter(12, 10 * 60 * 1000), asking = limiter(40, 10 * 60 * 1000);
  const view = (t) => { const st = state(t); return { number: t.number, amount: t.amount, firstName: firstOf(t.name), message: t.message || "", status: st.status, ...(st.status === "paid" ? { paidAt: st.paidAt } : {}) }; };
  const mine = (req, res) => { const id = String(req.params.id || ""); const t = /^[0-9a-f]{32}$/.test(id) ? all().find((x) => x.id === id) : null; if (!t) res.status(404).json({ error: "This invoice link isn't valid. Check the link in your email." }); return t; };

  app.get("/api/invoices/:id", open.mw, (req, res) => { const t = mine(req, res); if (!t) return; res.set("Cache-Control", "no-store"); res.json(view(t)); });

  app.post("/api/invoices/:id/pay", paying.mw, async (req, res) => {
    let t = mine(req, res); if (!t) return;
    t = await settle(t); // paid in another tab a moment ago: no second payment page
    const st = state(t).status;
    if (st === "paid") return res.status(409).json({ error: "This invoice is already paid. Thank you.", paid: true });
    if (st === "void") return res.status(410).json({ error: "This invoice was withdrawn. Call the clinic if that is a surprise." });
    if (st === "refunded") return res.status(410).json({ error: "This invoice was paid and then refunded. Call the clinic if you have a question about it." });
    if (!payApi || !payApi.enabled()) return res.status(503).json({ error: "Card payments aren't available right now. Call the clinic to pay." });
    // Opened inside the MD Fit app: Stripe's page shows in the phone's own browser sheet and comes back through
    // /app-return, the way the app's other payments do.
    const inApp = !!(req.body && req.body.ui === "app"), back = (to, extra = "") => `${site()}/app-return?${extra}to=${encodeURIComponent(to)}`;
    const out = await payApi.linkCheckout({ id: t.id, number: t.number, amount: t.amount, email: t.email, clientId: t.clientId,
      successUrl: inApp ? `${back(`/invoice?id=${t.id}&paid=1`)}&session_id={CHECKOUT_SESSION_ID}` : `${linkOf(t)}&paid=1`, cancelUrl: inApp ? back(`/invoice?id=${t.id}`, "cancel=1&") : linkOf(t) });
    const links = all(), cur = links.find((x) => x.id === t.id);
    if (cur) { cur.sessions = [...(cur.sessions || []), out.id].slice(-8); save(links); }
    res.json({ url: out.url });
  });

  // Coming back from Stripe: this server asks Stripe itself whether its own checkout was paid
  app.post("/api/invoices/:id/confirm", asking.mw, async (req, res) => { const t = mine(req, res); if (!t) return; res.set("Cache-Control", "no-store"); res.json(view(await settle(t))); });

  // The member's own unpaid invoices from here, for the app's bell and its Pay button
  if (me) me.get("/invoices", (req, res) => {
    const list = clients();
    res.set("Cache-Control", "no-store");
    res.json({ invoices: all().filter((t) => t.clientId === req.client.id && state(t, list).status === "unpaid").slice(-20).reverse().map((t) => ({ number: t.number, amount: t.amount, description: t.description || "", at: t.emailedAt || t.createdAt, path: `/invoice?id=${t.id}` })) }); // description: what it is for, so Sunny can say why they got it
  });

  // A card refund went through for an invoice kept here (someone without an account)
  function refunded(id, cents, full) { const links = all(), t = links.find((x) => x.id === id); if (!t) return null; t.refunded = (t.refunded || 0) + cents; t.refundedAt = stamp(); if (full) t.status = "refunded"; save(links); return t; }
  const api = { paid, all, refunded };
  app.set("invoiceLinks", api);
  return api;
}

module.exports = { mountInvoicing };
