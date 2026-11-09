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

function mountEmr({ app, admin, me, store, cfg, notify, activity, audit, settings, appointments, clients, save, today, payEnabled }) {
  const C = cipher([process.env.INTAKE_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const now = () => (cfg && typeof cfg.now === "function" ? cfg.now() : new Date()).toISOString();
  const empty = () => ({ notes: [], movements: [] });
  const chartOf = (c) => { if (!c || !c.chart) return empty(); try { const ch = JSON.parse(C.dec(c.chart) || "{}"); return { notes: ch.notes || [], movements: ch.movements || [] }; } catch { return empty(); } };
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
      notes: live(ch.notes).sort((a, b) => (a.at < b.at ? 1 : -1)), movements: live(ch.movements), paidVisits: openCredits(c), visits: videoVisits(c, appts, t), updatedAt: c.chartAt || null };
  };
  const find = (req, res) => { const list = clients(), c = list.find((x) => x.id === req.params.id); if (!c) res.status(404).json({ error: "Client not found." }); return [list, c]; };

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
  function useCredit(c, appointmentId) {
    const list = clients(), fresh = list.find((x) => x.id === c.id); if (!fresh) return null;
    const cr = openCredits(fresh).sort((a, b) => (a.paidAt < b.paidAt ? -1 : 1))[0]; if (!cr) return null;
    cr.usedAt = now(); cr.appointmentId = appointmentId; save(list);
    return cr;
  }
  const api = { chartOf, isPatient, recordPaidVisit, useCredit, openCredits };
  app.set("emrApi", api);
  return api;
}

module.exports = { mountEmr };
