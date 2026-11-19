// HIPAA patient-rights and compliance records (45 CFR Part 164), on top of the audit ledger and encrypted store:
//   (a) Right of access §164.524: a member downloads their own record (GET /api/me/records); Admin exports any client's.
//   (b) Accounting of disclosures §164.528: disclosures outside treatment/payment/operations, recorded by hand, listed
//       per client; the member can see their own accounting.
//   (c) Amendment requests §164.526: member asks for a correction; Admin accepts or denies with a reason; 60-day due
//       date, one 30-day extension.
//   (d) Restrictions and confidential communications §164.522: member preferences (reach me by email only, don't leave
//       voicemail, don't text, other requests) shown to Admin before anyone picks up the phone.
//   (e) Retention: how long records are kept (default 7 years: Florida medical records + the 6-year HIPAA documentation
//       rule) and a dry-run report of what would be eligible for purge. Nothing is ever deleted here.
//   (f) Breach / security incident log §164.308(a)(6), Subpart D: discovery date, risk assessment, and every
//       notification deadline computed (HIPAA 60 days; media when >500 in a state; HHS now or in the annual log;
//       Florida FIPA 30 days).
//   (g) Notice of Privacy Practices §164.520: acknowledgment comes from the intake "Consent & policies" document when
//       it exists; a member without one can acknowledge from their account (never asked twice).
// Free text in every record here is AES-256-GCM encrypted before it is stored (same cipher as messages), on top of the
// encrypted data store. Emails never carry the content: "you have a new …, sign in to see it".
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { cipher } = require("./messages");
const { DOCS, patientStatus, intakeCipher } = require("./intake");

const DAY = 864e5;
const DEFAULT_SETTINGS = {
  retentionYears: 7,        // clinical records: Florida (5 years from last contact for chiropractic/physicians) and HIPAA documentation (6) rounded up
  auditRetentionYears: 6,   // §164.316(b)(2) and §164.530(j): 6 years
  includeVisitNotesInMemberExport: false, // Dr. Jared's session notes stay out of the self-service download unless the owner turns this on
  privacyOfficer: "", securityOfficer: "", nppVersion: "", nppUpdatedAt: "", lastRiskAnalysisAt: "", lastTrainingAt: ""
};
const AMENDMENT_STATUSES = ["pending", "accepted", "denied"];
const INCIDENT_STATUSES = ["open", "closed"];
const CONCLUSIONS = ["pending", "breach", "not-a-breach"];
const CONTACT_BY = ["", "email", "text", "phone"];
const STATE_RE = /^[A-Z]{2}$/;

const fail = (m) => { throw new ValidationError(m); };
const text = (v, label, max, min = 0) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : fail(`${label} must be text.`);
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};
const dateOf = (v, label, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) { if (required) fail(`${label} is required.`); return ""; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T12:00:00Z"))) fail(`${label} must be a date (YYYY-MM-DD).`);
  return s;
};
const count = (v, label) => { const n = v === "" || v == null ? 0 : Number(v); if (!Number.isInteger(n) || n < 0 || n > 1e8) fail(`${label} must be a whole number.`); return n; };
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
const id = () => crypto.randomBytes(6).toString("hex");

// Breach notification clock. discoveredAt starts every deadline (§164.404(b): discovery = first day known, or should
// have been known). states: [{ state, count }] of affected people by state of residence.
function computeDeadlines({ discoveredAt, affectedCount = 0, states = [] }) {
  if (!discoveredAt) return null;
  const year = Number(discoveredAt.slice(0, 4));
  const fl = (states.find((s) => s.state === "FL") || {}).count || 0;
  return {
    individuals: { by: addDays(discoveredAt, 60), rule: "§164.404: notify each affected individual without unreasonable delay, no later than 60 days after discovery." },
    media: { required: states.some((s) => s.count > 500), states: states.filter((s) => s.count > 500).map((s) => s.state), by: addDays(discoveredAt, 60),
      rule: "§164.406: more than 500 residents of one state or jurisdiction: notify prominent media there within 60 days." },
    hhs: affectedCount >= 500
      ? { by: addDays(discoveredAt, 60), rule: "§164.408(b): 500 or more people: notify the Secretary of HHS at the same time as individuals (within 60 days)." }
      : { by: `${year + 1}-03-01`, rule: "§164.408(c): fewer than 500 people: log it and report to HHS within 60 days after the end of the calendar year of discovery." },
    floridaIndividuals: { required: fl > 0, by: addDays(discoveredAt, 30), rule: "Florida FIPA §501.171(4): notify affected Florida residents within 30 days of determining a breach occurred or is believed to have occurred." },
    floridaAttorneyGeneral: { required: fl >= 500, by: addDays(discoveredAt, 30), rule: "Florida FIPA §501.171(3): 500 or more Florida residents: notify the Department of Legal Affairs within 30 days." },
    businessAssociate: { rule: "§164.410: a business associate that discovers a breach must tell MD Fit within 60 days; MD Fit's clock starts when the associate tells us (or should have)." }
  };
}

function mountHipaa({ app, admin, me, store, cfg, notify, activity, limiter, audit, appointments, clients, save, today }) {
  const C = cipher([process.env.HIPAA_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const IC = intakeCipher(cfg);
  const MC = cipher([process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]); // message bodies (lib/messages)
  const enc = (s) => (s ? C.enc(s) : "");
  const dec = (s) => (s ? C.dec(s) : "");
  const nowIso = () => cfg.now().toISOString();
  const siteLink = (hash) => `${cfg.siteUrl || ""}/account#${hash}`;
  const exportLimit = limiter(10, 60 * 60 * 1000);
  const requestLimit = limiter(20, 60 * 60 * 1000);

  const settingsOf = () => ({ ...DEFAULT_SETTINGS, ...store.read("compliance-settings", {}) });
  const disclosures = () => store.read("disclosures", []);
  const amendments = () => store.read("amendments", []);
  const incidents = () => store.read("incidents", []);
  const intakes = () => store.read("intakes", []);
  const clientById = (cid) => clients().find((c) => c.id === cid) || null;
  const who = (c) => (c ? { clientId: c.id, clientName: c.name, clientEmail: c.email } : { clientId: "", clientName: "Former client", clientEmail: "" });

  // ---- Notice of Privacy Practices: the intake consent document carries the acknowledgment; the account can add one
  const parseIntake = (r) => { try { return JSON.parse(IC.dec(r.data) || "{}"); } catch { return {}; } };
  function nppStatus(c) {
    if (c.nppAck && c.nppAck.at) return { acknowledged: true, at: c.nppAck.at, via: "account", version: c.nppAck.version || "" };
    const mine = new Set(appointments().filter((a) => a.email === c.email).map((a) => a.id));
    const consents = intakes().filter((r) => r.doc === "consent" && (r.clientId === c.id || mine.has(r.appointmentId)));
    for (const r of consents) { const d = parseIntake(r); if (d.privacy === true) return { acknowledged: true, at: d.signedAt || r.createdAt, via: "intake" }; }
    return { acknowledged: false, at: null, via: null };
  }

  // ---- The patient's record, as one plain JSON document (designated record set: profile, visits, intake answers,
  // messages, pain diary, plan, document metadata, privacy records). Dr. Jared's session notes only when asked for.
  const label = (doc, d) => (doc ? doc.fields.map((f) => ({ label: f.label, value: d[f.k] === undefined ? null : d[f.k] })).filter((f) => f.value !== null && f.value !== "")
    : Object.entries(d).map(([k, value]) => ({ label: k, value })));
  function intakeDocs(c, mine) {
    const ids = new Set(mine.map((a) => a.id));
    return intakes().filter((r) => r.clientId === c.id || ids.has(r.appointmentId)).map((r) => {
      const d = parseIntake(r), doc = DOCS.find((x) => x.id === r.doc);
      return { id: r.id, document: doc ? doc.title : "Massage intake", completedAt: r.createdAt, onFile: !!r.clientId, appointmentId: r.appointmentId || null, signedAt: d.signedAt || d.consentAt || null, answers: label(doc, d) };
    });
  }
  function buildRecord(c, { visitNotes = false, accessLog = false } = {}) {
    const mine = appointments().filter((a) => a.email === c.email).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
    const docs = store.read("documents", []).filter((d) => d && d.clientId === c.id);
    const own = (r) => r.clientId === c.id;
    const out = {
      format: "mdfit-patient-record/1", exportedAt: nowIso(), practice: "MD Fit, Sarasota FL",
      notice: "This is a copy of the records MD Fit holds about you. Keep it somewhere private: it contains your health information.",
      profile: { id: c.id, name: c.name, firstName: c.firstName || "", lastName: c.lastName || "", email: c.email, phone: c.phone || "", createdAt: c.createdAt, lastLoginAt: c.lastLoginAt || null,
        membership: c.membership || null, documentsOnFile: patientStatus(c), emr: { status: c.emr_sync_status || c.emrSyncStatus || "pending", patientId: c.emr_patient_id || c.emrPatientId || "" } },
      privacy: { preferences: c.privacy || {}, noticeOfPrivacyPractices: nppStatus(c) },
      appointments: mine.map(({ cancelToken, adminNotes, googleEventId, calUid, ...a }) => ({ ...a, ...(visitNotes ? { visitNotes: adminNotes || "" } : {}) })),
      intakeDocuments: intakeDocs(c, mine),
      messages: store.read("messages", []).filter(own).map((m) => ({ from: m.from, body: MC.dec(m.body), at: m.at, readAt: m.readAt || null })),
      painLog: c.painLog || [], plan: c.plan || null, vitals: c.vitals || [], workouts: (c.workouts || []).map(({ id, title, date, minutes }) => ({ id, title, date, minutes })),
      documents: docs.map((d) => ({ id: d.id, name: d.name || d.title || d.filename || "", type: d.mime || d.type || "", size: d.size || null, createdAt: d.createdAt || null })),
      amendmentRequests: amendments().filter(own).map(viewAmendment),
      disclosures: disclosures().filter(own).map(viewDisclosure)
    };
    // The chart (lib/emr.js). The patient's own copy carries what the app already shows them; a staff export carries
    // the whole chart and the clinical notes. File contents are not inlined: they are listed, and opened one at a time.
    const emr = app && app.get("emrApi");
    if (emr) { const ch = emr.chartOf(c), on = (xs) => (xs || []).filter((x) => !x.removedAt);
      out.chart = visitNotes ? { notes: ch.notes, movements: ch.movements, events: ch.events, clinic: { ...ch.clinic, files: (ch.clinic.files || []).map(({ id, name, type, size, at, removedAt }) => ({ id, name, type, size, at, removedAt })) } }
        : { notes: on(ch.notes), movements: on(ch.movements) }; }
    const notesApi = app && app.get("notesApi");
    if (visitNotes && notesApi) out.clinicalNotes = notesApi.forClient(c.id);
    if (accessLog && audit) out.accessLog = audit.list({ subject: c.id, limit: 1000 }).map((e) => ({ seq: e.seq, at: e.ts, who: e.actor, what: e.action }));
    return out;
  }
  const sendRecord = (res, c, rec) => {
    res.set("Content-Disposition", `attachment; filename="mdfit-records-${String(c.name || "patient").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${rec.exportedAt.slice(0, 10)}.json"`);
    res.json(rec);
  };

  // ---- Views (decrypted for the response; the store keeps ciphertext)
  function viewDisclosure(d) {
    return { id: d.id, clientId: d.clientId, date: d.date, recipient: dec(d.recipient), purpose: dec(d.purpose), description: dec(d.description), basis: d.basis || "", recordedBy: d.recordedBy, createdAt: d.createdAt };
  }
  function viewAmendment(a) {
    const open = a.status === "pending";
    return { id: a.id, clientId: a.clientId, status: a.status, createdAt: a.createdAt, dueAt: a.dueAt, extendedAt: a.extendedAt || null,
      overdue: open && a.dueAt < today(), daysLeft: open ? Math.ceil((Date.parse(a.dueAt + "T12:00:00Z") - Date.parse(today() + "T12:00:00Z")) / DAY) : null,
      record: dec(a.record), request: dec(a.request), reason: dec(a.reason), decidedAt: a.decidedAt || null, decidedBy: a.decidedBy || "", decisionReason: dec(a.decisionReason) };
  }
  function viewIncident(i) {
    let risk = {}; try { risk = JSON.parse(dec(i.risk) || "{}"); } catch {}
    return { id: i.id, title: dec(i.title), description: dec(i.description), status: i.status, discoveredAt: i.discoveredAt, occurredAt: i.occurredAt || "", affectedCount: i.affectedCount, states: i.states || [],
      riskAssessment: risk, notifications: i.notifications || {}, deadlines: computeDeadlines(i), createdAt: i.createdAt, updatedAt: i.updatedAt || i.createdAt, closedAt: i.closedAt || null };
  }

  // ================= Member =================
  if (me) {
    // (a) Download my records. Every export is in the audit ledger (ids only).
    me.get("/records", exportLimit.mw, (req, res) => {
      const c = req.client;
      if (audit) audit.record({ actor: `client:${c.id}`, action: "client.records.export", subject: c.id, ip: req.ip, meta: { via: "account" } });
      activity("records_export", { email: c.email });
      sendRecord(res, c, buildRecord(c, { visitNotes: settingsOf().includeVisitNotesInMemberExport === true }));
    });

    // (d) + (g) Privacy preferences and the Notice of Privacy Practices acknowledgment
    const prefsOf = (c) => ({ contactBy: "", noVoicemail: false, noText: false, restrictions: "", updatedAt: null, ...(c.privacy || {}) });
    me.get("/privacy", (req, res) => res.json({ preferences: prefsOf(req.client), npp: nppStatus(req.client), nppVersion: settingsOf().nppVersion, disclosures: disclosures().filter((d) => d.clientId === req.client.id).length }));
    me.put("/privacy", (req, res) => {
      const b = req.body || {};
      const contactBy = typeof b.contactBy === "string" ? b.contactBy.trim().toLowerCase() : "";
      if (!CONTACT_BY.includes(contactBy)) fail("Pick how we should reach you: email, text or phone.");
      const list = clients(), c = list.find((x) => x.id === req.client.id);
      c.privacy = { contactBy, noVoicemail: b.noVoicemail === true, noText: b.noText === true, restrictions: text(b.restrictions, "Your request", 1000), updatedAt: nowIso() };
      save(list);
      res.json({ preferences: prefsOf(c) });
    });
    me.post("/privacy/acknowledge", (req, res) => {
      const list = clients(), c = list.find((x) => x.id === req.client.id);
      const st = nppStatus(c);
      if (st.acknowledged) return res.json({ npp: st, already: true }); // never asked twice: the intake consent already covers it
      c.nppAck = { at: nowIso(), version: settingsOf().nppVersion || "" };
      save(list);
      res.status(201).json({ npp: nppStatus(c) });
    });

    // (b) My accounting of disclosures
    me.get("/disclosures", (req, res) => res.json(disclosures().filter((d) => d.clientId === req.client.id).map(viewDisclosure).sort((a, b) => (a.date < b.date ? 1 : -1))));

    // (c) Ask for a correction to my record
    me.get("/amendments", (req, res) => res.json(amendments().filter((a) => a.clientId === req.client.id).map(viewAmendment).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))));
    me.post("/amendments", requestLimit.mw, (req, res) => {
      const b = req.body || {}, c = req.client;
      const rec = { id: id(), clientId: c.id, status: "pending", createdAt: nowIso(), dueAt: addDays(today(), 60),
        record: enc(text(b.record, "Which record", 200, 1)), request: enc(text(b.request, "What should change", 2000, 1)), reason: enc(text(b.reason, "Why", 1000)) };
      store.write("amendments", [...amendments(), rec]);
      activity("amendment_request", { email: c.email });
      notify.owner(`Amendment request from ${c.name}`, `${c.name} asked for a correction to their record. HIPAA gives you 60 days to answer (due ${rec.dueAt}).\n\nFor privacy the request itself isn't in this email. Read it in Admin → Compliance → Amendments:\n${cfg.siteUrl || ""}/admin#compliance`);
      res.status(201).json(viewAmendment(rec));
    });
  }

  // ================= Admin =================
  // (a) Export any client's record (session notes and the access log included). The audit middleware records the view.
  const canCharts = (req) => !!(req.account && (req.account.isOwner || (req.account.permissions || []).includes("charts")));
  const chartsOnly = (req, res) => { if (canCharts(req)) return true; res.status(403).json({ error: 'Your account doesn\'t have the "Charts & clinical notes" permission. Ask the practice owner to turn it on.', need: "charts" }); return false; };
  admin.get("/clients/:id/records", (req, res) => {
    if (!chartsOnly(req, res)) return;
    const c = clientById(req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    activity("records_export", { email: c.email, by: "admin" });
    sendRecord(res, c, buildRecord(c, { visitNotes: true, accessLog: true }));
  });
  // (d) What this person asked about how we contact them, plus their NPP status
  admin.get("/clients/:id/privacy", (req, res) => {
    const c = clientById(req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json({ preferences: { contactBy: "", noVoicemail: false, noText: false, restrictions: "", updatedAt: null, ...(c.privacy || {}) }, npp: nppStatus(c) });
  });

  // (b) Accounting of disclosures
  const disclosureInput = (b, req, cid) => ({
    id: id(), clientId: cid, date: dateOf(b.date, "Date", false) || today(), recipient: enc(text(b.recipient, "Who received it", 200, 1)), purpose: enc(text(b.purpose, "Purpose", 300, 1)),
    description: enc(text(b.description, "What was disclosed", 2000, 1)), basis: text(b.basis, "Legal basis", 100), recordedBy: req.admin, createdAt: nowIso()
  });
  admin.get("/clients/:id/disclosures", (req, res) => {
    if (!chartsOnly(req, res)) return;
    const c = clientById(req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const exports = audit ? audit.list({ subject: c.id, limit: 200 }).filter((e) => /records/.test(e.action)).map((e) => ({ at: e.ts, who: e.actor, what: e.action })) : [];
    res.json({ client: who(c), disclosures: disclosures().filter((d) => d.clientId === c.id).map(viewDisclosure).sort((a, b) => (a.date < b.date ? 1 : -1)), exports });
  });
  admin.post("/clients/:id/disclosures", (req, res) => {
    if (!chartsOnly(req, res)) return;
    const c = clientById(req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const d = disclosureInput(req.body || {}, req, c.id);
    store.write("disclosures", [...disclosures(), d]); // append-only: an accounting is kept for six years
    res.status(201).json(viewDisclosure(d));
  });
  admin.get("/disclosures", (req, res) => {
    const cl = new Map(clients().map((c) => [c.id, c]));
    const list = disclosures().filter((d) => !req.query.clientId || d.clientId === req.query.clientId);
    res.json(list.map((d) => ({ ...viewDisclosure(d), ...who(cl.get(d.clientId)) })).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 500));
  });

  // (d) Staff record what a patient asked for in person or by phone
  admin.put("/clients/:id/privacy", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id), b = req.body || {};
    if (!c) return res.status(404).json({ error: "Client not found." });
    const contactBy = typeof b.contactBy === "string" ? b.contactBy.trim().toLowerCase() : "";
    if (!CONTACT_BY.includes(contactBy)) fail("Pick how to reach them: email, text or phone.");
    c.privacy = { contactBy, noVoicemail: b.noVoicemail === true, noText: b.noText === true, restrictions: text(b.restrictions, "Their request", 1000), updatedAt: nowIso(), recordedBy: req.admin };
    save(list);
    res.json({ preferences: c.privacy, npp: nppStatus(c) });
  });
  // (g) A notice acknowledged on paper at the front desk
  admin.post("/clients/:id/privacy/acknowledge", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    if (!nppStatus(c).acknowledged) { c.nppAck = { at: nowIso(), version: settingsOf().nppVersion || "", recordedBy: req.admin, via: "paper" }; save(list); }
    res.json({ npp: nppStatus(c) });
  });
  // (c) A correction asked for in person, by phone or on paper: same 60-day clock as one sent from the app
  admin.post("/clients/:id/amendments", (req, res) => {
    if (!chartsOnly(req, res)) return;
    const c = clientById(req.params.id), b = req.body || {};
    if (!c) return res.status(404).json({ error: "Client not found." });
    const rec = { id: id(), clientId: c.id, status: "pending", createdAt: nowIso(), dueAt: addDays(today(), 60), recordedBy: req.admin,
      record: enc(text(b.record, "Which record", 200, 1)), request: enc(text(b.request, "What should change", 2000, 1)), reason: enc(text(b.reason, "Why", 1000)) };
    store.write("amendments", [...amendments(), rec]);
    res.status(201).json(viewAmendment(rec));
  });

  // (c) Amendment requests
  admin.get("/amendments", (req, res) => {
    const cl = new Map(clients().map((c) => [c.id, c]));
    const st = req.query.status;
    res.json(amendments().filter((a) => !st || a.status === st).map((a) => ({ ...viewAmendment(a), ...who(cl.get(a.clientId)) })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });
  admin.patch("/amendments/:id", (req, res) => {
    const list = amendments(), a = list.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "Request not found." });
    const b = req.body || {};
    if (!["accepted", "denied"].includes(b.status)) fail("Decision must be accepted or denied.");
    if (a.status !== "pending") fail("This request was already answered.");
    const reason = text(b.reason, "Reason", 2000, b.status === "denied" ? 1 : 0); // §164.526(d): a denial must say why, in plain language
    Object.assign(a, { status: b.status, decidedAt: nowIso(), decidedBy: req.admin, decisionReason: enc(reason) });
    store.write("amendments", list);
    const c = clientById(a.clientId);
    if (c) notify.client(c.email, "Dr. Jared answered your records request", `Hi ${String(c.name || "").split(" ")[0]},\n\nDr. Jared has answered your request to correct your record. Sign in to read the answer:\n${siteLink("profile")}\n\nMD Fit`);
    res.json(viewAmendment(a));
  });
  admin.post("/amendments/:id/extend", (req, res) => {
    const list = amendments(), a = list.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "Request not found." });
    if (a.status !== "pending") fail("This request was already answered.");
    if (a.extendedAt) fail("HIPAA allows one 30-day extension, and it was already used.");
    a.extendedAt = nowIso(); a.dueAt = addDays(a.dueAt, 30);
    store.write("amendments", list);
    const c = clientById(a.clientId);
    if (c) notify.client(c.email, "Your records request: we need a little more time", `Hi ${String(c.name || "").split(" ")[0]},\n\nWe're still working on your request to correct your record and will answer by ${a.dueAt}. You can see the status in your account:\n${siteLink("profile")}\n\nMD Fit`);
    res.json(viewAmendment(a));
  });

  // (e) Compliance settings and the retention dry run
  admin.get("/compliance", (req, res) => {
    const am = amendments().filter((a) => a.status === "pending"), t = today();
    res.json({ settings: settingsOf(), counts: { openIncidents: incidents().filter((i) => i.status !== "closed").length, pendingAmendments: am.length, overdueAmendments: am.filter((a) => a.dueAt < t).length, disclosures: disclosures().length } });
  });
  admin.put("/compliance/settings", (req, res) => {
    const b = req.body || {}, cur = settingsOf();
    const years = (v, label, cur) => { if (v === undefined) return cur; const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 50) fail(`${label} must be 1 to 50 years.`); return n; };
    const s = {
      retentionYears: years(b.retentionYears, "Record retention", cur.retentionYears), auditRetentionYears: years(b.auditRetentionYears, "Audit log retention", cur.auditRetentionYears),
      includeVisitNotesInMemberExport: b.includeVisitNotesInMemberExport === undefined ? cur.includeVisitNotesInMemberExport : b.includeVisitNotesInMemberExport === true,
      privacyOfficer: b.privacyOfficer === undefined ? cur.privacyOfficer : text(b.privacyOfficer, "Privacy officer", 120), securityOfficer: b.securityOfficer === undefined ? cur.securityOfficer : text(b.securityOfficer, "Security officer", 120),
      nppVersion: b.nppVersion === undefined ? cur.nppVersion : text(b.nppVersion, "Notice version", 40), nppUpdatedAt: b.nppUpdatedAt === undefined ? cur.nppUpdatedAt : dateOf(b.nppUpdatedAt, "Notice date"),
      lastRiskAnalysisAt: b.lastRiskAnalysisAt === undefined ? cur.lastRiskAnalysisAt : dateOf(b.lastRiskAnalysisAt, "Risk analysis date"), lastTrainingAt: b.lastTrainingAt === undefined ? cur.lastTrainingAt : dateOf(b.lastTrainingAt, "Training date")
    };
    store.write("compliance-settings", s);
    res.json(s);
  });
  // Dry run only: what would be past its retention period today. Deleting is a separate, deliberate step that is not built.
  admin.get("/compliance/retention", (req, res) => {
    const s = settingsOf(), t = today();
    const cutoff = `${Number(t.slice(0, 4)) - s.retentionYears}${t.slice(4)}`, auditCutoff = `${Number(t.slice(0, 4)) - s.auditRetentionYears}${t.slice(4, 7)}`;
    const group = (name, rows, keyOf) => {
      const old = rows.filter((r) => { const k = keyOf(r); return k && String(k).slice(0, 10) < cutoff; });
      const keys = old.map((r) => String(keyOf(r)).slice(0, 10)).sort();
      return { name, total: rows.length, eligible: old.length, oldest: keys[0] || null, newest: keys[keys.length - 1] || null, sample: old.slice(0, 20).map((r) => r.id || r.email || "") };
    };
    const appts = appointments(), cl = clients();
    const lastSeen = (c) => { const mine = appts.filter((a) => a.email === c.email).map((a) => a.date); return [c.lastLoginAt || "", c.createdAt || "", ...mine].sort().pop(); };
    const st = store.read("audit-state", { months: [] });
    res.json({
      dryRun: true, today: t, cutoff, auditCutoff, retentionYears: s.retentionYears, auditRetentionYears: s.auditRetentionYears,
      note: "Nothing is deleted by this report. Florida and HIPAA both measure retention from the last contact; review each group before any purge.",
      groups: [
        group("Appointments and visit notes", appts, (a) => a.date),
        group("Intake documents", intakes(), (r) => r.createdAt),
        group("Client accounts (no login or visit since the cutoff)", cl, lastSeen),
        group("Messages", store.read("messages", []), (m) => m.at),
        group("Evaluation requests (leads)", store.read("leads", []), (l) => l.createdAt),
        group("Reviews", store.read("feedback", []), (f) => f.createdAt),
        group("Uploaded documents", store.read("documents", []), (d) => d.createdAt),
        group("Amendment requests", amendments(), (a) => a.createdAt),
        group("Disclosure accounting", disclosures(), (d) => d.date),
        group("Incident log", incidents(), (i) => i.discoveredAt)
      ],
      auditMonths: { total: (st.months || []).length, eligible: (st.months || []).filter((m) => m < auditCutoff) }
    });
  });

  // (g) Who has not acknowledged the Notice of Privacy Practices
  admin.get("/compliance/npp", (req, res) => {
    const rows = clients().map((c) => ({ id: c.id, name: c.name, email: c.email, npp: nppStatus(c) }));
    res.json({ total: rows.length, acknowledged: rows.filter((r) => r.npp.acknowledged).length, missing: rows.filter((r) => !r.npp.acknowledged).map(({ id, name, email }) => ({ id, name, email })) });
  });

  // (f) Security incidents and breaches
  function incidentInput(b, cur = {}) {
    const states = b.states === undefined ? cur.states || [] : (Array.isArray(b.states) ? b.states : []).map((s) => {
      const st = String((s && s.state) || "").trim().toUpperCase();
      if (!STATE_RE.test(st)) fail("State must be a two-letter code, like FL.");
      return { state: st, count: count(s.count, `${st} count`) };
    });
    const r = b.riskAssessment === undefined ? null : b.riskAssessment;
    const risk = r === null ? undefined : (() => {
      if (!r || typeof r !== "object") fail("Risk assessment must be an object.");
      const conclusion = r.conclusion === undefined ? "pending" : String(r.conclusion);
      if (!CONCLUSIONS.includes(conclusion)) fail("Conclusion must be pending, breach or not-a-breach.");
      return { nature: text(r.nature, "Nature of the information", 2000), recipient: text(r.recipient, "Who received it", 1000), acquired: text(r.acquired, "Was it actually viewed", 1000), mitigation: text(r.mitigation, "Mitigation", 2000), conclusion, notes: text(r.notes, "Notes", 4000) };
    })();
    const n = b.notifications === undefined ? undefined : Object.fromEntries(["individualsAt", "mediaAt", "hhsAt", "floridaAt", "floridaAttorneyGeneralAt"].map((k) => [k, dateOf(b.notifications && b.notifications[k], k)]));
    const status = b.status === undefined ? cur.status || "open" : String(b.status);
    if (!INCIDENT_STATUSES.includes(status)) fail("Status must be open or closed.");
    return {
      title: b.title === undefined ? cur.title : enc(text(b.title, "Title", 200, 1)), description: b.description === undefined ? cur.description : enc(text(b.description, "What happened", 4000)),
      discoveredAt: b.discoveredAt === undefined ? cur.discoveredAt : dateOf(b.discoveredAt, "Discovery date", true), occurredAt: b.occurredAt === undefined ? cur.occurredAt || "" : dateOf(b.occurredAt, "Date it happened"),
      affectedCount: b.affectedCount === undefined ? cur.affectedCount || 0 : count(b.affectedCount, "People affected"), states,
      risk: risk === undefined ? cur.risk || "" : enc(JSON.stringify(risk)), notifications: n === undefined ? cur.notifications || {} : { ...(cur.notifications || {}), ...n }, status
    };
  }
  admin.get("/incidents", (req, res) => res.json(incidents().map(viewIncident).sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1))));
  admin.post("/incidents", (req, res) => {
    const b = req.body || {};
    if (!b.title) fail("Title is required.");
    if (!b.discoveredAt) fail("Discovery date is required.");
    const i = { id: id(), ...incidentInput(b), createdAt: nowIso(), createdBy: req.admin };
    store.write("incidents", [...incidents(), i]);
    activity("incident_logged", { id: i.id });
    res.status(201).json(viewIncident(i));
  });
  admin.patch("/incidents/:id", (req, res) => {
    const list = incidents(), i = list.find((x) => x.id === req.params.id);
    if (!i) return res.status(404).json({ error: "Incident not found." });
    const next = incidentInput(req.body || {}, i);
    Object.assign(i, next, { updatedAt: nowIso(), closedAt: next.status === "closed" ? i.closedAt || nowIso() : null });
    store.write("incidents", list);
    res.json(viewIncident(i));
  });

  return { buildRecord, nppStatus, settingsOf };
}

module.exports = { mountHipaa, computeDeadlines, DEFAULT_SETTINGS, AMENDMENT_STATUSES };
