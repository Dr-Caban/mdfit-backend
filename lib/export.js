// Exporting client data (Workspace → Clients → Export). Owner, Nov 2026.
//
// Two files, for chosen clients or for everyone:
//   - a spreadsheet (CSV): one row per client with contact details, status, membership and visit dates;
//   - full records (JSON): each client's account details, chart, plan, measures, documents and notes, for a patient's
//     request for their record or for moving to another system.
//
// HIPAA-minded handling: staff only; every export is in the audit ledger with how many records and which kind, never
// their content; the file is sent as a download with caching off; nothing that works as a key is ever included (no
// password hashes, sign-in or reset tokens, booking tokens, device tokens or payment-processor ids). Clinical notes
// above the standard tier are listed without their text: those are opened one at a time in the workspace, where each
// opening is recorded.
"use strict";
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const MAX_IDS = 2000;

function mountExport({ app, admin, audit, activity, limiter, clients, appointments, today, toCsv, notesApi }) {
  const limit = limiter(20, 60 * 60 * 1000);
  const live = (xs) => (xs || []).filter((x) => !x.removedAt);
  const visitsOf = (c, appts) => appts.filter((a) => a.clientId === c.id || (!!a.email && a.email === c.email));
  const isPatient = (c) => !!(c.patient && c.patient.status === "active");

  function row(c, appts, t) {
    const emr = app.get("emrApi"), ch = emr ? emr.chartOf(c) : { clinic: {} }, k = ch.clinic || {};
    const mine = visitsOf(c, appts);
    const done = mine.filter((a) => a.status === "completed" || (a.status === "booked" && a.date < t)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
    const m = c.membership && (!c.membership.until || c.membership.until >= t) ? c.membership : null;
    return {
      name: c.name || "", email: c.email || "", phone: c.phone || "", clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient",
      status: isPatient(c) ? "active patient" : "member", patientSince: (c.patient && c.patient.since) || "",
      membership: m ? m.tier : "", paidThrough: m ? m.until || "" : "", joined: c.createdAt || "", lastSignIn: c.lastLoginAt || "",
      nextVisit: next ? `${next.date} ${next.time}` : "", lastVisit: done[0] ? done[0].date : "", visits: done.length,
      tags: k.tags || [], alerts: live(k.allergies).map((a) => a.name),
      owed: ((k.invoices || []).filter((x) => x.status === "unpaid").reduce((n, x) => n + x.amount, 0) / 100).toFixed(2)
    };
  }
  const COLS = ["name", "email", "phone", "clientType", "status", "patientSince", "membership", "paidThrough", "joined", "lastSignIn", "nextVisit", "lastVisit", "visits", "tags", "alerts", "owed"];

  function record(c, appts) {
    const emr = app.get("emrApi"), intake = app.get("intakeApi");
    const ch = emr ? emr.chartOf(c) : { notes: [], movements: [], clinic: {} }, k = ch.clinic || {};
    const body = (x) => { try { return JSON.parse(x.body); } catch { return null; } };
    return {
      id: c.id, name: c.name || "", email: c.email || "", phone: c.phone || "", clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient",
      patient: { active: isPatient(c), since: (c.patient && c.patient.since) || null, endedAt: (c.patient && c.patient.endedAt) || null },
      joined: c.createdAt || null, lastSignIn: c.lastLoginAt || null,
      membership: c.membership ? { type: c.membership.tier, since: c.membership.since || "", paidThrough: c.membership.until || "" } : null,
      appointments: visitsOf(c, appts).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))
        .map((a) => ({ date: a.date, time: a.time, type: a.typeName || "", minutes: a.minutes || 0, status: a.status, areas: a.areas || [], painLevel: a.painLevel ?? null, notes: a.notes || "", payment: a.payment || "" })),
      plan: c.plan ? { treatmentPlan: c.plan.notes || "", protocols: c.plan.exercises || [], updatedAt: c.plan.updatedAt || null } : null,
      assignedPrograms: (c.assignedPrograms || []).map((p) => ({ id: p.id, note: p.note || "", assignedAt: p.assignedAt || null })),
      painLog: c.painLog || [], workouts: (c.workouts || []).slice(-1000),
      chart: ch.unreadable ? { unreadable: true } : {
        careSummary: k.summary || "", tags: k.tags || [],
        notesToPatient: live(ch.notes).map((n) => ({ at: n.at, text: n.text })),
        movements: live(ch.movements).map((m) => ({ at: m.at, name: m.name, dose: m.dose || "", cue: m.cue || "" })),
        medications: live(k.meds).map(({ id, ...x }) => x), allergiesAndAlerts: live(k.allergies).map(({ id, ...x }) => x),
        measures: live(k.measures).map(({ id, ...x }) => x),
        consents: (k.consents || []).map(({ id, removedAt, ...x }) => ({ ...x, revokedAt: removedAt || null })),
        invoices: (k.invoices || []).map((x) => ({ number: x.number, date: x.date, description: x.description, amount: (x.amount / 100).toFixed(2), status: x.status, method: x.method || "", paidAt: x.paidAt || null })),
        documentsIssued: live(k.docs).map((x) => ({ at: x.at, kind: x.kind, title: x.title, content: body(x) })),
        files: live(k.files).map((f) => ({ at: f.at, name: f.name, type: f.type, size: f.size, note: "The file itself is downloaded from the chart's Files tab." }))
      },
      newPatientDocuments: intake ? intake.docsOf(c) : [],
      clinicalNotes: notesApi ? notesApi.forClient(c.id).map((n) => ({ template: n.template, sensitivity: n.tier, status: n.status, tags: n.tags || [], createdAt: n.createdAt, signedAt: n.signedAt, signedBy: n.signedBy,
        ...(n.withheld ? { text: null, note: "Restricted note: open it in the workspace, where each opening is recorded." } : n.unreadable ? { text: null, note: "This note could not be opened with the server's current keys." } : { text: n.text, addenda: n.addendaList || [] }) })) : []
    };
  }

  admin.post("/export/clients", limit.mw, (req, res) => {
    const b = req.body || {}, kind = b.kind === "records" ? "records" : b.kind === "csv" ? "csv" : fail("Pick what to export.");
    const everyone = b.all === true;
    if (!everyone && (!Array.isArray(b.ids) || !b.ids.length)) fail("Pick at least one client, or export everyone.");
    if (!everyone && b.ids.length > MAX_IDS) fail(`Up to ${MAX_IDS} clients at a time.`);
    const want = everyone ? null : new Set(b.ids.map(String));
    const list = clients().filter((c) => !want || want.has(c.id)).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    if (!list.length) fail("None of those clients were found.");
    const appts = appointments(), t = today();
    if (audit) audit.record({ actor: "admin", action: "export.clients", subject: list.length === 1 ? list[0].id : "", ip: req.ip, meta: { kind, count: list.length, all: everyone } });
    activity("clients_exported", { count: list.length, kind });
    res.set({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    if (kind === "csv") return res.type("text/csv").attachment(`mdfit-clients-${t}.csv`).send(toCsv(list.map((c) => row(c, appts, t)), COLS));
    res.type("application/json").attachment(`mdfit-client-records-${t}.json`)
      .send(JSON.stringify({ exportedAt: new Date().toISOString(), practice: "MD Fit", count: list.length, clients: list.map((c) => record(c, appts)) }, null, 2));
  });
}

module.exports = { mountExport };
