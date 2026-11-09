// Electronic medical record (Admin → Medical record). Owner, Nov 2026.
//
// Who is in it: members who filled out the new-patient documents. "Waiting" = documents complete, not yet converted;
// "Active patient" = Dr. Jared converted them (one tap, undoable). Each patient has a chart: dated notes the patient can
// read, and prescribed movements (each linked to a library video) the patient sees on Home under "What to do next".
// Paid video visits (Stripe, lib/payments.js) land here too so Dr. Jared can see who has paid and still needs a time.
//
// HIPAA-minded handling: the chart is encrypted with AES-256-GCM before it is stored (on top of the encrypted store);
// every Admin view of a chart is in the audit ledger; emails and push notifications never carry chart content
// ("Dr. Jared added to your care plan", nothing more). Notes and movements are soft-removed, never erased.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { cipher } = require("./messages");
const { patientStatus, visitDocs } = require("./intake");

const MAX_NOTE = 4000, MAX_NOTES = 500, MAX_MOVES = 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{10,80}$/;
const fail = (m) => { throw new ValidationError(m); };
const text = (v, label, { min = 0, max = 200 } = {}) => {
  const s = String(v == null ? "" : v).trim();
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};
const id = () => crypto.randomBytes(6).toString("hex");

function mountEmr({ app, admin, me, store, cfg, notify, activity, audit, settings, appointments, clients, save, today, payEnabled, booking }) {
  const C = cipher([process.env.INTAKE_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const now = () => (cfg && typeof cfg.now === "function" ? cfg.now() : new Date()).toISOString();
  const empty = () => ({ notes: [], movements: [], events: [] });
  const chartOf = (c) => { if (!c || !c.chart) return empty(); try { const ch = JSON.parse(C.dec(c.chart) || "{}"); return { notes: ch.notes || [], movements: ch.movements || [], events: ch.events || [] }; } catch { return empty(); } };
  const setChart = (c, ch) => { c.chart = C.enc(JSON.stringify(ch)); c.chartAt = now(); };
  const live = (xs) => xs.filter((x) => !x.removedAt);
  const isPatient = (c) => !!(c.patient && c.patient.status === "active");
  const log = (req, action, c, meta = {}) => audit && audit.record({ actor: "admin", action, subject: c.id, ip: req.ip, meta });
  const first = (c) => String(c.name || "").split(" ")[0] || "there";

  // Paid-for visits (Stripe services) that still need a time on the calendar
  const credits = (c) => (c.visitCredits || []);
  const openCredits = (c) => credits(c).filter((x) => !x.usedAt);
  const videoVisits = (c, appts, t) => appts.filter((a) => (a.clientId === c.id || a.email === c.email) && a.status === "booked" && a.date >= t && (a.meetingLink || /remote|video|consult/i.test(a.typeId + " " + a.typeName)))
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1)).map((a) => ({ id: a.id, date: a.date, time: a.time, minutes: a.minutes, typeName: a.typeName, meetingLink: a.meetingLink || "", payment: a.payment || "" }));

  // Tell the patient something changed, without saying what (no chart content in email or push)
  function ping(c, what) {
    const push = app.get("push");
    if (push) push.toClient(c.id, { title: "Dr. Jared added to your care plan", body: `A new ${what} is waiting in MD Fit. Open the app to see what to do next.`, route: "home" });
    if (notify.enabled && cfg.siteUrl) notify.client(c.email, "Dr. Jared added to your care plan", `Hi ${first(c)},\n\nDr. Jared added a new ${what} to your care plan. For privacy it isn't in this email. See it on your Home screen under "What to do next":\n${cfg.siteUrl}/account\n\nMD Fit`);
  }

  const row = (c, appts, t) => {
    const ch = chartOf(c), st = patientStatus(c, visitDocs(c, appts));
    const mine = appts.filter((a) => a.clientId === c.id || a.email === c.email);
    const last = mine.filter((a) => a.status === "completed" || (a.status === "booked" && a.date < t)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
    return { id: c.id, name: c.name, email: c.email, phone: c.phone || "", patient: isPatient(c), since: c.patient && c.patient.since || null, documentsAt: c.intakeAt || null,
      documents: { total: st.total, done: st.done, complete: st.complete }, notes: live(ch.notes).length, movements: live(ch.movements).length,
      paidVisits: openCredits(c).length, lastVisit: last ? last.date : null, nextVisit: next ? { date: next.date, time: next.time, typeName: next.typeName } : null, lastLoginAt: c.lastLoginAt || null };
  };

  // Admin: everyone in the record. Active patients, and members whose documents are complete but who aren't converted yet.
  admin.get("/emr", (req, res) => {
    const appts = appointments(), t = today(), all = clients();
    const rows = all.filter((c) => isPatient(c) || patientStatus(c, visitDocs(c, appts)).complete || openCredits(c).length).map((c) => row(c, appts, t));
    const by = (k) => (a, b) => ((b[k] || "") > (a[k] || "") ? 1 : -1);
    res.json({ patients: rows.filter((r) => r.patient).sort(by("since")), waiting: rows.filter((r) => !r.patient).sort(by("documentsAt")) });
  });

  const detail = (c) => {
    const appts = appointments(), t = today(), ch = chartOf(c);
    return { ...row(c, appts, t), clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient", createdAt: c.createdAt,
      notes: live(ch.notes).sort((a, b) => (a.at < b.at ? 1 : -1)), movements: live(ch.movements), paidVisits: openCredits(c), visits: videoVisits(c, appts, t),
      record: record(c, appts, ch), updatedAt: c.chartAt || null };
  };
  const find = (req, res) => { const list = clients(), c = list.find((x) => x.id === req.params.id); if (!c) res.status(404).json({ error: "Client not found." }); return [list, c]; };

  // Admin: the homework pool. Every movement Dr. Jared has prescribed before, most-used first, so a new prescription
  // is one tap instead of a search. Names and counts only: no patient is named here.
  admin.get("/emr/pool", (req, res) => {
    const by = new Map();
    for (const c of clients()) {
      for (const m of live(chartOf(c).movements)) {
        const k = m.videoId;
        const x = by.get(k) || { videoId: k, name: m.name, dose: m.dose || "", cue: m.cue || "", uses: 0, lastAt: "" };
        x.uses += 1;
        if (m.at > x.lastAt) { x.lastAt = m.at; x.name = m.name; x.dose = m.dose || x.dose; x.cue = m.cue || x.cue; }
        by.set(k, x);
      }
    }
    const pool = [...by.values()].sort((a, b) => b.uses - a.uses || (a.lastAt < b.lastAt ? 1 : -1));
    res.json({ pool: pool.slice(0, 60) });
  });

  // Admin: one patient's chart (audited)
  admin.get("/emr/:id", (req, res) => {
    const [, c] = find(req, res); if (!c) return;
    log(req, "emr.view", c);
    res.json(detail(c));
  });

  // Admin: convert to an active patient (or back)
  admin.put("/emr/:id/patient", (req, res) => {
    const [list, c] = find(req, res); if (!c) return;
    const active = !!(req.body && req.body.active);
    c.patient = active ? { status: "active", since: (c.patient && c.patient.status === "active" && c.patient.since) || now(), by: "admin" } : { status: "former", since: c.patient && c.patient.since || null, endedAt: now(), by: "admin" };
    save(list);
    log(req, active ? "emr.convert" : "emr.unconvert", c);
    activity(active ? "patient_converted" : "patient_unconverted", { email: c.email });
    if (active) { const push = app.get("push"); if (push) push.toClient(c.id, { title: "Welcome to MD Fit care", body: "Dr. Jared opened your patient record. Your notes and movements will show on Home.", route: "home" }); }
    res.json({ patient: isPatient(c), since: c.patient.since });
  });

  // Admin: notes the patient can read
  admin.post("/emr/:id/notes", (req, res) => {
    const [list, c] = find(req, res); if (!c) return;
    const body = text(req.body && req.body.text, "Note", { min: 1, max: MAX_NOTE });
    const ch = chartOf(c);
    if (live(ch.notes).length >= MAX_NOTES) fail(`Up to ${MAX_NOTES} notes per patient.`);
    const n = { id: id(), at: now(), text: body };
    ch.notes.push(n); setChart(c, ch); save(list);
    log(req, "emr.note", c, { note: n.id });
    activity("patient_note", { email: c.email });
    ping(c, "note");
    res.status(201).json(n);
  });
  admin.delete("/emr/:id/notes/:nid", (req, res) => {
    const [list, c] = find(req, res); if (!c) return;
    const ch = chartOf(c), n = ch.notes.find((x) => x.id === req.params.nid && !x.removedAt);
    if (!n) return res.status(404).json({ error: "Note not found." });
    n.removedAt = now(); setChart(c, ch); save(list);
    log(req, "emr.note_removed", c, { note: n.id });
    res.json({ ok: true });
  });

  // Admin: prescribed movements, each linked to a library video (the id the member app plays)
  admin.post("/emr/:id/movements", (req, res) => {
    const [list, c] = find(req, res); if (!c) return;
    const b = req.body || {};
    const videoId = String(b.videoId || "").trim();
    if (!VIDEO_ID.test(videoId)) fail("Pick a movement from the library.");
    const m = { id: id(), at: now(), videoId, name: text(b.name, "Movement name", { min: 1, max: 80 }), dose: text(b.dose, "Sets and reps", { max: 120 }), cue: text(b.cue, "Cue", { max: 300 }) };
    const ch = chartOf(c);
    if (live(ch.movements).length >= MAX_MOVES) fail(`Up to ${MAX_MOVES} movements per patient.`);
    ch.movements.push(m); setChart(c, ch); save(list);
    log(req, "emr.movement", c, { movement: m.id, videoId });
    activity("patient_movement", { email: c.email });
    ping(c, "movement");
    res.status(201).json(m);
  });
  admin.delete("/emr/:id/movements/:mid", (req, res) => {
    const [list, c] = find(req, res); if (!c) return;
    const ch = chartOf(c), m = ch.movements.find((x) => x.id === req.params.mid && !x.removedAt);
    if (!m) return res.status(404).json({ error: "Movement not found." });
    m.removedAt = now(); setChart(c, ch); save(list);
    log(req, "emr.movement_removed", c, { movement: m.id });
    res.json({ ok: true });
  });

  // Member: what Dr. Jared left for me, and the video visits I can pay for
  me.get("/chart", (req, res) => {
    const c = req.client, ch = chartOf(c), appts = appointments(), t = today(), s = settings();
    const services = (s.services || []).filter((v) => v.remote && ["eval-remote", "followup-remote"].includes(v.id)).map((v) => ({ id: v.id, name: v.name, rate: v.rate, unit: v.unit || "", description: v.description || "" }));
    res.json({ patient: isPatient(c), since: c.patient && c.patient.since || null, updatedAt: c.chartAt || null,
      notes: live(ch.notes).sort((a, b) => (a.at < b.at ? 1 : -1)), movements: live(ch.movements),
      paidVisits: openCredits(c).map(({ sessionId, ...x }) => x), visits: videoVisits(c, appts, t),
      services, payOn: typeof payEnabled === "function" ? !!payEnabled() : false, inpatient: c.clientType === "inpatient" });
  });

  // Payments (lib/payments.js) call this when a service is paid: the visit waits here for a time on the calendar
  function recordPaidVisit(c, { service, name, amount, currency, sessionId }) {
    const list = clients(), fresh = list.find((x) => x.id === c.id); if (!fresh) return null;
    const cr = { id: id(), service, name, amount: amount == null ? null : amount, currency: currency || "usd", paidAt: now(), sessionId: sessionId || "", usedAt: null };
    fresh.visitCredits = [...credits(fresh), cr]; save(list);
    activity("visit_paid", { email: fresh.email, service });
    return cr;
  }
  // Scheduling a video visit (Admin → consult) uses up the oldest paid visit, so the record shows what is still owed
  function useCredit(c, appointmentId, creditId) {
    const list = clients(), fresh = list.find((x) => x.id === c.id); if (!fresh) return null;
    const open = openCredits(fresh);
    const cr = creditId ? open.find((x) => x.id === creditId) : open.sort((a, b) => (a.paidAt < b.paidAt ? -1 : 1))[0];
    if (!cr) return null;
    cr.usedAt = now(); cr.appointmentId = appointmentId; save(list);
    return cr;
  }
  // ---- The record, in order (Admin -> Medical record -> a patient -> Record)
  //
  // Everything that happened with this patient on one timeline, newest first: the documents, the day Dr. Jared opened
  // their record, every note and prescribed movement, every payment, and every video visit scheduled, finished or
  // cancelled. Most of it is read from data that already exists; a checkout the patient started and never finished is
  // the one thing that has to be written down as it happens, which is what timeline() is for.
  const MAX_EVENTS = 400;
  function timeline(c, ev) {
    const list = clients(), fresh = list.find((x) => x.id === c.id); if (!fresh) return;
    const ch = chartOf(fresh);
    ch.events = [...(ch.events || []), { id: id(), at: now(), ...ev }].slice(-MAX_EVENTS);
    setChart(fresh, ch); save(list);
  }
  function record(c, appts, ch = chartOf(c)) {
    const out = [];
    const add = (at, kind, title, detail = "") => { if (at) out.push({ at, kind, title, detail }); };
    add(c.createdAt, "joined", "Signed up for MD Fit");
    add(c.intakeAt, "documents", "New-patient documents completed");
    if (c.patient && c.patient.since) add(c.patient.since, "patient", "Opened as an active patient");
    if (c.patient && c.patient.endedAt) add(c.patient.endedAt, "patient", "Record closed");
    for (const n of live(ch.notes)) add(n.at, "note", "Note to the patient", n.text);
    for (const m of live(ch.movements)) add(m.at, "movement", "Prescribed " + m.name, [m.dose, m.cue].filter(Boolean).join(" · "));
    for (const x of ch.notes.filter((y) => y.removedAt)) add(x.removedAt, "removed", "Note removed");
    for (const x of ch.movements.filter((y) => y.removedAt)) add(x.removedAt, "removed", "Movement removed: " + x.name);
    for (const cr of credits(c)) {
      const amt = cr.amount == null ? "" : "$" + (cr.amount / 100).toFixed(cr.amount % 100 ? 2 : 0);
      add(cr.paidAt, "payment", "Paid for " + (cr.name || "a visit"), amt);
    }
    for (const a of mineAppts(c, appts)) {
      if (a.status === "hold" || a.heldOnly) continue; // a time that was only ever held while paying: see "lapsed" below
      const when = a.date + " " + a.time + " · " + a.minutes + " min";
      if (a.status === "cancelled") add(a.updatedAt || a.createdAt, "cancelled", "Cancelled: " + a.typeName, when);
      else {
        add(a.createdAt, "scheduled", "Scheduled " + a.typeName, when);
        if (a.status === "completed") add(a.completedAt || a.date + "T23:59:00.000Z", "visit", "Visit completed: " + a.typeName, when);
      }
    }
    // A patient who opened the checkout and never paid: the time was let go
    const byAppt = new Map(appts.map((a) => [a.id, a]));
    for (const e of ch.events || []) {
      if (e.kind !== "visit_held") continue;
      const a = byAppt.get(e.appointmentId);
      if (a && a.status !== "hold" && !a.heldOnly) continue;
      add(e.at, "lapsed", "Started paying for a video visit, didn't finish", e.date + " " + e.time);
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  // ---- Scheduling a paid video visit (patient-led, Nov 2026)
  //
  // The patient picks a time from Dr. Jared's own openings and pays on the spot: the online evaluation is 60 minutes
  // ($150) and the returning-patient follow-up is 30 minutes ($80, offered once they have had an evaluation). The slot
  // is held while Stripe takes the payment, so a second patient cannot land on the same video room; an abandoned
  // checkout lets the hold lapse by itself. A visit already paid for is scheduled straight away and uses that credit.
  const HOLD_MIN = 20;
  const SERVICES = ["eval-remote", "followup-remote"];
  const svcOf = (s, svcId) => (s.services || []).find((v) => v.id === svcId && v.remote);
  const typeOf = (s, svcId) => (s.appointmentTypes || []).find((t) => t.id === svcId);
  const minutesOf = (s, svcId) => { const t = typeOf(s, svcId); return (t && t.minutes) || Number(String((svcOf(s, svcId) || {}).unit || "60").match(/\d+/)) || 60; };
  const mineAppts = (c, appts) => appts.filter((a) => a.clientId === c.id || a.email === c.email);
  // The follow-up is for returning patients: they have had an evaluation (in studio or on video), or a visit with
  // Dr. Jared that is already behind them.
  const hadEval = (c, appts, t) => mineAppts(c, appts).some((a) => a.status !== "cancelled" && a.status !== "hold"
    && (a.status === "completed" || a.date < t) && /eval|consult/i.test(String(a.typeId) + " " + String(a.typeName)))
    || credits(c).some((x) => x.usedAt && x.service === "eval-remote");

  function bookable(c, s, appts, t) {
    const had = hadEval(c, appts, t);
    return SERVICES.map((svcId) => {
      const v = svcOf(s, svcId); if (!v) return null;
      const open = openCredits(c).find((x) => x.service === svcId);
      return { id: svcId, name: v.name, rate: v.rate, minutes: minutesOf(s, svcId), description: v.description || "",
        eligible: svcId === "eval-remote" ? true : had, paid: !!open,
        why: svcId === "followup-remote" && !had ? "Follow-ups are for returning patients. Start with the online evaluation." : "" };
    }).filter(Boolean);
  }

  // Member: which video visits I can book, and at what price
  me.get("/visits/options", (req, res) => {
    const c = req.client, s = settings(), appts = appointments(), t = today();
    res.json({ services: bookable(c, s, appts, t), payOn: typeof payEnabled === "function" ? !!payEnabled() : false,
      room: !!(s.booking && s.booking.telehealthUrl), timeZone: cfg.tz, patient: isPatient(c) });
  });

  // Member: Dr. Jared's open start times for one of those visits
  me.get("/visits/openings", async (req, res) => {
    if (!booking || !booking.openings) return res.status(503).json({ error: "Scheduling isn't available right now." });
    const s = settings(), svcId = String(req.query.service || "eval-remote");
    if (!SERVICES.includes(svcId) || !svcOf(s, svcId)) return res.status(400).json({ error: "Pick a video visit." });
    const type = typeOf(s, svcId);
    if (!type) return res.status(400).json({ error: "That visit isn't open for scheduling. Call 941-313-0562." });
    const appts = appointments(), t = today();
    const list = bookable(req.client, s, appts, t).find((x) => x.id === svcId);
    if (!list.eligible) return res.status(403).json({ error: list.why });
    const days = await booking.openings(type, String(req.query.from || ""), Number(req.query.days) || 21);
    res.json({ service: svcId, minutes: type.minutes, timeZone: cfg.tz, days });
  });

  // Member: take a time and pay for it. Returns a Stripe checkout to finish, or the booked visit when it is paid for.
  me.post("/visits/schedule", async (req, res, next) => {
    try {
      if (!booking || !booking.hold) return res.status(503).json({ error: "Scheduling isn't available right now." });
      const b = req.body || {}, s = settings(), svcId = String(b.service || "");
      const list = clients(), c = list.find((x) => x.id === req.client.id);
      const svc = svcOf(s, svcId), type = typeOf(s, svcId);
      if (!SERVICES.includes(svcId) || !svc || !type) return res.status(400).json({ error: "Pick a video visit." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || !/^\d{2}:\d{2}$/.test(b.time || "")) return res.status(400).json({ error: "Pick a date and a time." });
      const appts = appointments(), t = today();
      const opt = bookable(c, s, appts, t).find((x) => x.id === svcId);
      if (!opt.eligible) return res.status(403).json({ error: opt.why });
      const room = s.booking && s.booking.telehealthUrl;
      if (!room) return res.status(409).json({ error: "The video room isn't set up yet. Call 941-313-0562 and Dr. Jared will schedule you." });
      // Already paid for (or exempt): schedule it now, no second payment
      const credit = c.clientType === "inpatient" ? null : openCredits(c).sort((a, z) => (a.paidAt < z.paidAt ? -1 : 1))[0];
      const free = c.clientType === "inpatient";
      const appt = await booking.hold({ client: c, type, date: b.date, time: b.time, minutes: type.minutes, link: room,
        status: credit || free ? "booked" : "hold", payment: free ? "exempt" : credit ? "paid" : "due", service: svcId });
      if (!appt.ok) return res.status(appt.status || 409).json({ error: appt.error });
      if (credit || free) {
        if (credit) useCredit(c, appt.appointment.id, credit.id);
        timeline(c, { kind: "visit_scheduled", service: svcId, appointmentId: appt.appointment.id, date: b.date, time: b.time });
        activity("visit_self_scheduled", { email: c.email, service: svcId, date: b.date });
        return res.json({ booked: true, appointment: appt.appointment });
      }
      // Pay for it: the slot is held until the checkout is finished
      const payApi = app.get("payApi");
      const payReady = payApi && payApi.serviceCheckout && (typeof payApi.enabled !== "function" || payApi.enabled());
      if (!payReady) { booking.release(appt.appointment.id); return res.status(503).json({ error: "Online payment isn't switched on yet. Call 941-313-0562 and Dr. Jared will book this time for you." }); }
      let out;
      try { out = await payApi.serviceCheckout(c, svc, { ui: b.ui, appointmentId: appt.appointment.id, date: b.date, time: b.time }); }
      catch (err) { booking.release(appt.appointment.id); return next(err); }
      timeline(c, { kind: "visit_held", service: svcId, appointmentId: appt.appointment.id, date: b.date, time: b.time });
      res.json({ booked: false, holdId: appt.appointment.id, holdMinutes: HOLD_MIN, ...out });
    } catch (err) { next(err); }
  });

  // Member: give up a held time (the checkout was closed). Lapses on its own too.
  me.post("/visits/:id/release", (req, res) => {
    if (booking && booking.release) booking.release(req.params.id, req.client.id);
    res.json({ ok: true });
  });

  // Stripe tells us the visit is paid for (lib/payments.js): the held time becomes a real booking.
  function confirmScheduled(c, { appointmentId, service, name, amount, currency, sessionId }) {
    const cr = recordPaidVisit(c, { service, name, amount, currency, sessionId });
    const ok = booking && booking.confirm ? booking.confirm(appointmentId, c) : null;
    if (ok && cr) useCredit(c, appointmentId, cr.id);
    if (ok) timeline(c, { kind: "visit_scheduled", service, appointmentId, date: ok.date, time: ok.time, paid: true });
    return ok;
  }

  const api = { chartOf, isPatient, recordPaidVisit, useCredit, openCredits, confirmScheduled };
  app.set("emrApi", api);
  return api;
}

module.exports = { mountEmr };
