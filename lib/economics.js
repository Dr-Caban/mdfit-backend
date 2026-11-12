// System economics (Workspace → Admin → System economics). Owner, Nov 2026.
//
// One screen that answers "what does this system take in, what does it cost to run, and what is left": money taken
// through Stripe month by month (with Stripe's own fees and refunds), invoices settled outside Stripe, what is still
// owed, the card memberships that are running, and the monthly running costs the owner keeps here.
//
// Every figure is read from a record: Stripe's balance history, the invoices on the charts, the member list, the
// calendar. Nothing is estimated on the server and nothing is filled in when a source cannot be read: the answer says
// which source was unavailable instead. Costs are the one thing no system here can read (hosting, email and video
// bills live with those vendors; rent and insurance live nowhere online), so the owner types them in and they are
// kept in the store, each marked as a system cost (what the software costs to run) or an expense (everything else).
//
// The overview is totals only: no names, no invoice descriptions, nothing about any one person. Opening one month
// lists that month's payments line by line, with the payer's name and the kind of payment (membership, visit,
// invoice) so the owner can see what a total is made of; it never says what an invoice or a visit was for.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const MAX_COSTS = 40, STRIPE_TTL_MS = 5 * 60 * 1000;

function mountEconomics({ app, admin, store, clients, appointments, tiers, income, monthOf, now, today, logger }) {
  const costs = () => (store.read("economics", { costs: [] }).costs || []).map((x) => ({ ...x, kind: x.kind === "expense" ? "expense" : "system" }));
  const sums = (lines) => { const of = (k) => lines.filter((x) => x.kind === k).reduce((s, x) => s + x.monthly, 0); return { systemMonthly: of("system"), expensesMonthly: of("expense"), costsMonthly: of("system") + of("expense") }; };
  // The months shown, oldest first, ending with the current one (in the clinic's own time zone)
  function monthsBack(n) {
    const cur = monthOf(now()), out = []; let y = Number(cur.slice(0, 4)), m = Number(cur.slice(5, 7));
    for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, "0")}`); if (--m === 0) { m = 12; y--; } }
    return out;
  }
  const empty = (months, make) => Object.fromEntries(months.map((m) => [m, make()]));

  // Stripe is asked at most once every five minutes however often the screen is opened
  let held = null;
  async function stripeSide(months) {
    const key = months[0] + ":" + months.length;
    if (held && held.key === key && Date.now() - held.at < STRIPE_TTL_MS) return held.value;
    const byMonth = empty(months, () => ({ gross: 0, refunds: 0, fees: 0, other: 0, net: 0, payments: 0 }));
    let value;
    try {
      // a day's margin before the first month: the cut is made by month below, in clinic time
      const since = Math.floor(Date.parse(months[0] + "-01T00:00:00Z") / 1000) - 86400;
      const r = await income(since);
      if (!r.on) value = { on: false, byMonth };
      else {
        for (const t of r.rows) {
          const row = byMonth[monthOf(new Date(t.at * 1000))]; if (!row) continue;
          if (t.kind === "charge") { row.gross += t.amount; row.payments++; }
          else if (t.kind === "refund") row.refunds += Math.abs(t.amount);
          else if (t.kind === "fee") row.fees += Math.abs(t.amount);
          else row.other += t.amount;
          if (t.fee) row.fees += t.fee;
        }
        for (const row of Object.values(byMonth)) row.net = row.gross - row.refunds - row.fees + row.other;
        value = { on: true, fees: !!r.fees, truncated: !!r.truncated, byMonth, checkedAt: new Date().toISOString() };
      }
    } catch (err) {
      if (logger) logger.error("economics_stripe_failed", { type: err && err.type, code: err && err.code });
      // never the processor's own wording: it can describe the key
      return { on: true, error: "Stripe did not let this key read the account's payments. The key needs read access to Balance transactions (or Charges) in the Stripe dashboard.", byMonth };
    }
    held = { key, at: Date.now(), value };
    return value;
  }

  admin.get("/economics", async (req, res) => {
    const n = Math.min(12, Math.max(3, Number(req.query.months) || 6)), months = monthsBack(n);
    const list = clients(), emr = app.get("emrApi"), t = today();

    // Invoices written on the charts: what was settled outside Stripe (cash, check…), and what is still owed.
    // One paid online went through Stripe and is already in Stripe's figures, so it is not counted a second time.
    const outside = empty(months, () => 0), owed = { count: 0, total: 0 };
    let unreadable = 0;
    for (const c of list) {
      let ch; try { ch = emr ? emr.chartOf(c) : null; } catch { ch = null; }
      const inv = ch && ch.clinic && ch.clinic.invoices; if (!inv) { if (c.chart) unreadable++; continue; }
      for (const x of inv) {
        if (x.removedAt || x.status === "void") continue;
        if (x.status === "unpaid") { owed.count++; owed.total += x.amount; }
        else if (x.status === "paid" && !x.sessionId) { const m = x.paidAt ? monthOf(new Date(x.paidAt)) : String(x.date || "").slice(0, 7); if (m in outside) outside[m] += x.amount; }
      }
    }

    // Invoices from the generator for people without an account are kept with their links, not on a chart
    const il = app.get("invoiceLinks");
    for (const x of (il ? il.all() : [])) {
      if (x.clientId) continue; // on a chart: counted above
      if (x.status === "unpaid") { owed.count++; owed.total += x.amount; }
      else if (x.status === "paid" && !x.sessionId) { const m = x.paidAt ? monthOf(new Date(x.paidAt)) : ""; if (m in outside) outside[m] += x.amount; }
    }

    // Memberships: a card subscription that is running, against the listed monthly price of its type
    const live = (c) => c.membership && (!c.membership.until || c.membership.until >= t);
    const paying = list.filter((c) => live(c) && c.membership.stripeSubscriptionId), byHand = list.filter((c) => live(c) && !c.membership.stripeSubscriptionId);
    const kinds = tiers().map((k) => ({ id: k.id, name: k.name, price: Math.round(Number(k.price || 0) * 100), paying: paying.filter((c) => c.membership.tier === k.id).length, byHand: byHand.filter((c) => c.membership.tier === k.id).length }));

    const signups = empty(months, () => 0);
    for (const c of list) { const m = c.createdAt ? monthOf(new Date(c.createdAt)) : ""; if (m in signups) signups[m]++; }
    const visits = empty(months, () => 0);
    for (const a of appointments()) { if ((a.status === "completed" || (a.status === "booked" && a.date < t)) && String(a.date).slice(0, 7) in visits) visits[String(a.date).slice(0, 7)]++; }

    const lines = costs();
    res.set("Cache-Control", "no-store");
    res.json({
      months, currentMonth: months[months.length - 1],
      stripe: await stripeSide(months),
      outside, owed, unreadableCharts: unreadable,
      members: { paying: paying.length, byHand: byHand.length, kinds, listMonthly: kinds.reduce((s, k) => s + k.price * k.paying, 0) },
      people: { total: list.length, signups }, visits,
      costs: lines, ...sums(lines)
    });
  });

  // ---- One month, line by line: what its totals are made of
  const WHAT = { membership: "Membership", service: "Visit", invoice: "Invoice", invoice_link: "Invoice", protocol: "Care plan" };
  const detailHeld = new Map();
  admin.get("/economics/month", async (req, res) => {
    const m = String(req.query.m || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return res.status(400).json({ error: "Pick a month." });
    const list = clients(), emr = app.get("emrApi"), byCustomer = new Map(list.filter((c) => c.stripeCustomerId).map((c) => [c.stripeCustomerId, c]));
    const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)), next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    let stripe = { on: false, lines: [] };
    const had = detailHeld.get(m);
    if (had && Date.now() - had.at < STRIPE_TTL_MS) stripe = had.value;
    else {
      try {
        // a day's margin either side: the cut is made by month in clinic time
        const r = await income(Math.floor(Date.parse(m + "-01T00:00:00Z") / 1000) - 86400, { until: Math.floor(Date.parse(next + "-01T00:00:00Z") / 1000) + 86400, detail: true });
        stripe = !r.on ? { on: false, lines: [] } : { on: true, fees: !!r.fees, truncated: !!r.truncated, checkedAt: new Date().toISOString(),
          lines: r.rows.filter((t) => monthOf(new Date(t.at * 1000)) === m).sort((a, b) => b.at - a.at).map((t) => ({ at: new Date(t.at * 1000).toISOString(), kind: t.kind, amount: Math.abs(t.amount), fee: t.fee || 0, customer: t.customer || "", what: WHAT[t.what] || "" })) };
        detailHeld.set(m, { at: Date.now(), value: stripe }); if (detailHeld.size > 24) detailHeld.delete(detailHeld.keys().next().value);
      } catch (err) {
        if (logger) logger.error("economics_stripe_failed", { type: err && err.type, code: err && err.code });
        stripe = { on: true, error: "Stripe did not let this key read the account's payments.", lines: [] };
      }
    }
    // names are looked up fresh each time, from this server's own list: Stripe is never asked who someone is
    const lines = stripe.lines.map(({ customer, ...t }) => { const c = byCustomer.get(customer); return { ...t, name: c ? c.name : "", clientId: c ? c.id : null }; });
    const outside = [];
    for (const c of list) {
      let ch; try { ch = emr ? emr.chartOf(c) : null; } catch { ch = null; }
      for (const x of (ch && ch.clinic && ch.clinic.invoices) || []) {
        if (x.removedAt || x.status !== "paid" || x.sessionId) continue;
        if ((x.paidAt ? monthOf(new Date(x.paidAt)) : String(x.date || "").slice(0, 7)) === m) outside.push({ at: x.paidAt || null, number: x.number, amount: x.amount, method: x.method || "", name: c.name, clientId: c.id });
      }
    }
    const il = app.get("invoiceLinks");
    for (const x of (il ? il.all() : [])) if (!x.clientId && x.status === "paid" && !x.sessionId && x.paidAt && monthOf(new Date(x.paidAt)) === m) outside.push({ at: x.paidAt, number: x.number, amount: x.amount, method: x.method || "", name: x.name, clientId: null });
    outside.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    res.set("Cache-Control", "no-store");
    res.json({ month: m, stripe: { ...stripe, lines }, outside, costs: costs(), ...sums(costs()) });
  });

  // The running costs, replaced as a whole list (the screen sends every line each time, like the other settings)
  admin.put("/economics/costs", (req, res) => {
    const rows = (req.body && req.body.costs); if (!Array.isArray(rows)) fail("Send the list of costs.");
    if (rows.length > MAX_COSTS) fail(`Keep it to ${MAX_COSTS} lines.`);
    const had = new Map(costs().map((x) => [x.id, x]));
    const next = rows.map((r) => {
      const name = String((r && r.name) || "").replace(/\s+/g, " ").trim().slice(0, 60), dollars = Number(r && r.monthly);
      if (!name) fail("Every cost needs a name.");
      if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1000000) fail(`Enter what ${name} costs a month, in dollars.`);
      const id = r.id && had.has(String(r.id)) ? String(r.id) : crypto.randomBytes(6).toString("hex");
      return { id, name, kind: r.kind === "expense" ? "expense" : "system", monthly: Math.round(dollars * 100) };
    });
    store.write("economics", { costs: next, updatedAt: new Date().toISOString() });
    res.json({ costs: next, ...sums(next) });
  });
}

module.exports = { mountEconomics };
