// The member's Progress calendar, kept in step with the clinic.
//
// Workouts, visits, classes, pain logs and the care plan already reach the calendar through their own /api/me routes.
// This adds the money and the plan, which had no place on it:
//   - invoices on the member's chart (lib/emr.js): the day each was written, and the day it was paid;
//   - card payments Stripe holds for the member (memberships, visits, care plans), from payApi.billing();
//   - the membership: the day it started, and the day it renews, ends or is paid through.
// GET /api/me/calendar returns them as calendar entries: { date, k: "bill" | "plan", t, s, path? }.
//
// It also tells the member's open app when any of it changes, with a "calendar_changed" event on their socket:
//   - a visit or class booking is added, moved or cancelled from anywhere (workspace, Cal.com, the public pages):
//     watched at the store, so no booking path can be missed;
//   - and wherever code calls app.get("calendarChanged")(clientId): a workout logged on another device, a payment, a
//     membership change, an invoice written or paid.
// The event carries nothing but a reason word; the app asks for its own data again.
//
// iPhone (or any) Calendar: each member can subscribe to a private feed of the same calendar, at
// /api/calendar-feed/<token>.ics (GET /api/me/calendar/feed gives the link, POST .../reset makes a new one and the old
// link stops working). It carries visits, classes, billing and subscription dates for 90 days back and everything
// ahead. A calendar app keeps a copy and may sync it to the cloud, so titles say only what kind of thing it is ("MD Fit
// visit", "MD Fit class: Mobility", "MD Fit invoice INV-1001: $120.00"): no visit type, no invoice description, no notes.
const crypto = require("crypto");

const money = (cents) => "$" + (Math.round(Number(cents) || 0) / 100).toFixed(2);
const day = (v) => {
  if (v == null || v === "") return "";
  if (typeof v === "number") return new Date(v * (v < 1e12 ? 1000 : 1)).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

function mountMemberCalendar({ app, me, store, cfg = {}, clients, save, logger, tiers, zonedToUtc, cacheMs = 3 * 60 * 1000, debounceMs = 400 } = {}) {
  const log = logger || { warn() {}, info() {} };
  const tierName = (id) => { try { const t = (tiers ? tiers() : []).find((x) => x.id === id); return t ? t.name : ""; } catch { return ""; } };
  const charges = new Map(); // clientId -> { at, rows }: Stripe is asked at most every few minutes per member

  // ---- Tell a member's devices that their calendar changed (debounced: one save can touch many rows)
  const pending = new Map();
  function calendarChanged(clientId, why = "update") {
    if (!clientId) return;
    charges.delete(clientId);
    if (pending.has(clientId)) return;
    pending.set(clientId, setTimeout(() => {
      pending.delete(clientId);
      try { const rt = app.get("rt"); if (rt) rt.emitToClient(clientId, "calendar_changed", { why }); } catch { /* not connected */ }
    }, debounceMs));
  }
  app.set("calendarChanged", calendarChanged);

  // ---- Visit and class bookings: watch the store, so every path that saves one is covered
  const verifiedByEmail = () => {
    const m = new Map();
    for (const c of clients()) if (c.email && c.emailVerifiedAt) m.set(String(c.email).toLowerCase(), c.id);
    return m;
  };
  function changedRows(before, after) {
    const old = new Map((Array.isArray(before) ? before : []).map((r) => [r && r.id, JSON.stringify(r)]));
    const out = [];
    for (const r of after) { if (!r) continue; if (old.get(r.id) !== JSON.stringify(r)) out.push(r); old.delete(r.id); }
    for (const [id, s] of old) { try { out.push(JSON.parse(s)); } catch { /* skip */ } void id; }
    return out;
  }
  const WATCH = { appointments: "visit", bookings: "class" };
  const write = store.write;
  store.write = (name, data, ...rest) => {
    if (!WATCH[name] || !Array.isArray(data)) return write(name, data, ...rest);
    let before = []; try { before = store.read(name, []); } catch { before = []; }
    const r = write(name, data, ...rest);
    try {
      const rows = changedRows(before, data);
      if (rows.length) {
        const byEmail = rows.some((x) => !x.clientId && x.email) ? verifiedByEmail() : null;
        const ids = new Set();
        for (const x of rows) {
          if (x.clientId) ids.add(x.clientId);
          const e = x.email && byEmail ? byEmail.get(String(x.email).toLowerCase()) : null;
          if (e) ids.add(e);
        }
        ids.forEach((id) => calendarChanged(id, WATCH[name]));
      }
    } catch (e) { log.warn("calendar_watch", { error: e.message }); }
    return r;
  };

  // ---- What the calendar shows about money and the plan
  async function cardPayments(c) {
    const pay = app.get("payApi");
    if (!pay || typeof pay.billing !== "function" || !c.stripeCustomerId) return [];
    const hit = charges.get(c.id);
    if (hit && Date.now() - hit.at < cacheMs) return hit.rows;
    let rows = [];
    try { const b = await pay.billing(c); rows = (b && b.charges) || []; }
    catch (e) { log.warn("calendar_charges", { error: e.message }); rows = hit ? hit.rows : []; }
    charges.set(c.id, { at: Date.now(), rows });
    if (charges.size > 2000) charges.delete(charges.keys().next().value);
    return rows;
  }

  function chartInvoices(c) {
    const emr = app.get("emrApi");
    try { return (emr && emr.chartOf(c).clinic.invoices) || []; } catch { return []; }
  }
  // An invoice's pay page, when one was sent from the workspace (lib/invoicing.js)
  function payPaths(c) {
    const links = app.get("invoiceLinks"), m = new Map();
    try { for (const t of (links && links.all()) || []) if (t.clientId === c.id && t.invoiceId) m.set(t.invoiceId, `/invoice?id=${t.id}`); } catch { /* none */ }
    return m;
  }

  async function entries(c) {
    const out = [];
    const add = (date, k, t, s, extra = {}) => { const d = day(date); if (isDay(d)) out.push({ date: d, k, t, s, ...extra }); };

    // Invoices on the chart
    const paths = payPaths(c);
    for (const inv of chartInvoices(c)) {
      if (!inv || inv.status === "void") continue;
      const name = inv.number ? `Invoice ${inv.number}` : "Invoice";
      const what = inv.description ? ` · ${String(inv.description).slice(0, 60)}` : "";
      const paidDay = day(inv.paidAt);
      if (inv.status === "unpaid") add(inv.date || inv.at, "bill", `${name}: ${money(inv.amount)}`, `Unpaid${what}`, paths.has(inv.id) ? { path: paths.get(inv.id) } : {});
      else if (inv.status === "refunded") add(inv.date || inv.at, "bill", `${name}: ${money(inv.amount)}`, `Refunded${what}`);
      else {
        add(inv.date || inv.at, "bill", `${name}: ${money(inv.amount)}`, `${paidDay && paidDay !== day(inv.date || inv.at) ? "Paid later" : "Paid"}${what}`);
        if (paidDay && paidDay !== day(inv.date || inv.at)) add(paidDay, "bill", `Paid ${name.toLowerCase()}`, money(inv.amount));
      }
    }

    // Card payments (invoices are shown above from the chart, so their charges aren't counted twice)
    for (const ch of await cardPayments(c)) {
      const k = ch.description === "Membership" ? "plan" : "bill";
      const state = ch.status === "paid" ? "Paid" : ch.status === "part refunded" ? `Paid · ${money(ch.refunded)} refunded` : ch.status === "refunded" ? "Refunded" : ch.status === "failed" ? "Payment didn't go through" : "Pending";
      add(ch.date, k, `${ch.description}: ${money(ch.amount)}`, state, ch.receiptUrl ? { receipt: ch.receiptUrl } : {});
    }

    // The membership
    const m = c.membership;
    if (m && m.tier) {
      const name = tierName(m.tier) || "Membership";
      if (m.since) add(m.since, "plan", `${name} started`, "Membership");
      if (m.until) {
        const stripe = !!m.stripeSubscriptionId, ending = stripe && (m.cancelAtPeriodEnd || ["canceled", "unpaid", "incomplete_expired"].includes(m.status));
        add(m.until, "plan", ending ? `${name} ends` : stripe ? `${name} renews` : `${name} paid through`,
          ending ? "It won't renew. Restart any time from Membership." : stripe ? "Billed to the card on file" : "Membership");
      }
    }
    return out;
  }

  if (me) me.get("/calendar", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const fresh = clients().find((x) => x.id === req.client.id) || req.client;
    res.json({ entries: await entries(fresh) });
  });

  // ---- The subscribable feed
  const FEED_RE = /^[a-f0-9]{48}$/;
  const site = () => String(cfg.siteUrl || "https://www.mymdfit.com").replace(/\/+$/, "");
  const feedUrl = (t) => `${site()}/api/calendar-feed/${t}.ics`;
  function feedToken(clientId, fresh) {
    const list = clients(), c = list.find((x) => x.id === clientId); if (!c) return null;
    if (fresh || !c.calFeed || !FEED_RE.test(c.calFeed.token || "")) {
      c.calFeed = { token: crypto.randomBytes(24).toString("hex"), at: new Date().toISOString() };
      if (save) save(list); else store.write("clients", list);
    }
    return c.calFeed.token;
  }
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const ics = (v) => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  // Lines over 75 bytes continue on the next line after a space (RFC 5545)
  const fold = (line) => { const out = []; let cur = ""; for (const ch of line) { if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = " " + ch; } else cur += ch; } out.push(cur); return out.join("\r\n"); };
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const ymd = (d) => d.replace(/-/g, "");
  const nextDay = (d) => new Date(Date.parse(d + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
  const toUtc = (date, time) => (zonedToUtc ? zonedToUtc(date, time, cfg.tz || "America/New_York") : new Date(`${date}T${time}:00Z`));

  async function feed(c) {
    const now = new Date(), from = new Date(now.getTime() - 90 * 864e5).toISOString().slice(0, 10), ev = [];
    const timed = (uid, date, time, minutes, summary, extra = []) => {
      if (!isDay(date) || date < from || !/^\d{2}:\d{2}$/.test(time || "")) return;
      const start = toUtc(date, time), end = new Date(start.getTime() + (Number(minutes) || 60) * 60000);
      ev.push([`UID:${uid}@mymdfit.com`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${ics(summary)}`, ...extra]);
    };
    const allDay = (uid, date, summary) => {
      if (!isDay(date) || date < from) return;
      ev.push([`UID:${uid}@mymdfit.com`, `DTSTAMP:${stamp(now)}`, `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(date))}`, `SUMMARY:${ics(summary)}`, "TRANSP:TRANSPARENT"]);
    };
    // Visits: the member's own, by account or by an email they have proved is theirs
    const email = String(c.email || "").toLowerCase(), verified = !!c.emailVerifiedAt;
    const mine = (a) => a.clientId === c.id || (verified && a.email && String(a.email).toLowerCase() === email);
    for (const a of store.read("appointments", [])) {
      if (!a || !mine(a) || a.status === "cancelled") continue;
      const video = /telehealth|video|remote|online/i.test(`${a.typeName || ""} ${a.typeId || ""}`);
      timed(`visit-${a.id}`, a.date, a.time, a.minutes, video ? "MD Fit video visit" : "MD Fit visit",
        [`DESCRIPTION:${ics(video ? "Join from the MD Fit app." : "Details are in the MD Fit app.")}`, ...(video ? [] : [`LOCATION:${ics(cfg.clinicAddress || "MD Fit, Sarasota")}`])]);
    }
    // Classes booked under the member's proved email
    if (verified) {
      const byId = new Map(store.read("classes", []).map((x) => [x.id, x]));
      for (const b of store.read("bookings", [])) {
        if (!b || String(b.email || "").toLowerCase() !== email) continue;
        const k = byId.get(b.classId) || {};
        timed(`class-${b.id}`, b.date, b.time || k.time, k.durationMin || 60, `MD Fit class: ${b.title || k.title || "Class"}`, k.location ? [`LOCATION:${ics(k.location)}`] : []);
      }
    }
    // Billing and the subscription, the same entries the app's calendar shows, by title only
    for (const x of await entries(c)) {
      const unpaid = /^Unpaid/.test(x.s || "");
      // "Invoice INV-1001: $120.00" reads "MD Fit invoice INV-1001: $120.00"; a title already naming MD Fit stays as it is
      const title = /^MD Fit\b/.test(x.t) ? x.t : /^[A-Z][a-z]/.test(x.t) ? `MD Fit ${x.t.charAt(0).toLowerCase()}${x.t.slice(1)}` : `MD Fit ${x.t}`;
      allDay(`${x.k}-${crypto.createHash("sha1").update(x.date + x.t).digest("hex").slice(0, 16)}`, x.date, `${title}${unpaid ? " (unpaid)" : ""}`);
    }
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MD Fit//Member calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:MD Fit", "X-WR-CALDESC:Your MD Fit visits\\, classes\\, billing and subscription", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
      ...ev.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"];
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  if (me) {
    me.get("/calendar/feed", (req, res) => { res.set("Cache-Control", "no-store"); const t = feedToken(req.client.id); const url = feedUrl(t); res.json({ url, webcal: url.replace(/^https?:/, "webcal:") }); });
    me.post("/calendar/feed/reset", (req, res) => { res.set("Cache-Control", "no-store"); const t = feedToken(req.client.id, true); const url = feedUrl(t); res.json({ url, webcal: url.replace(/^https?:/, "webcal:") }); });
  }
  app.get("/api/calendar-feed/:file", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    const m = /^([a-f0-9]{48})\.ics$/.exec(String(req.params.file || ""));
    const c = m ? clients().find((x) => x.calFeed && x.calFeed.token && same(x.calFeed.token, m[1])) : null;
    if (!c) return res.status(404).type("text/plain").send("Not found.");
    try { res.type("text/calendar; charset=utf-8").send(await feed(c)); }
    catch (e) { log.warn("calendar_feed", { error: e.message }); res.status(500).type("text/plain").send("Try again later."); }
  });

  return { calendarChanged, entries, feed, feedToken };
}

module.exports = { mountMemberCalendar };
