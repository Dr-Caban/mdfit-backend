// New-patient intake documents (SimplePractice-style packet), filled out from the private link in the booking email.
// Every appointment gets a packet: Client information, Pain Assessment Initial Intake (or Massage preferences for a
// medical massage), Health history, and Consent & policies (e-signed). Each document is saved on its own, so a client
// can do one now and the rest later; Admin shows "Documents x of y complete" and each completed document.
//
// The documents are defined once here (DOCS) and served to the intake page and to Admin, so both stay in step.
//
// HIPAA-minded handling:
// - Answers are encrypted with AES-256-GCM before they're stored (on top of the encrypted data store).
// - Nothing from the forms goes in an email. Dr. Jared gets "documents completed, read them in Admin"; every Admin view
//   is recorded in the audit ledger.
// - Access for the client is by the private token from their booking confirmation (same as the cancel link).
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { cipher } = require("./messages");

const MASSAGE_TYPES = ["massage", "massage90"];
const CONDITIONS = ["Blood thinners", "Recent surgery (last 6 months)", "Pregnant", "History of blood clots / DVT", "Recent fracture",
  "Osteoporosis", "High blood pressure", "Heart condition", "Diabetes", "Cancer (current or past)", "Skin condition, rash or open wounds",
  "Numbness or tingling", "Varicose veins"];
const PRESSURE = ["Light", "Medium", "Firm", "Deep", "Not sure"];
const HISTORY_CONDITIONS = [...CONDITIONS, "Arthritis", "Asthma / lung condition", "Stroke", "Seizures", "Pacemaker or implanted device",
  "Joint replacement", "Autoimmune condition", "Kidney or liver disease", "Thyroid condition", "Anxiety / depression"];
const AREAS = ["Neck", "Left shoulder", "Right shoulder", "Upper / mid back", "Low back", "Left hip", "Right hip", "Left knee", "Right knee",
  "Left ankle / foot", "Right ankle / foot", "Elbow / wrist / hand", "Head / jaw", "Other"];

// Field types: text, email, tel, date, textarea, select, radio, checks (multi), scale (0-10), yesno, agree (must be checked), sign (typed name)
const DOCS = [
  { id: "info", title: "Client information", minutes: 2, intro: "Your contact details, so we can reach you and keep your records straight.",
    fields: [
      { k: "name", label: "Full legal name", type: "text", required: true, max: 80, prefill: "name" },
      { k: "dob", label: "Date of birth", type: "date", required: true },
      { k: "sex", label: "Sex", type: "radio", options: ["Female", "Male", "Prefer not to say"] },
      { k: "phone", label: "Mobile phone", type: "tel", required: true, max: 30, prefill: "phone" },
      { k: "email", label: "Email", type: "email", required: true, max: 120, prefill: "email" },
      { k: "address", label: "Street address", type: "text", max: 120 },
      { k: "city", label: "City, state, ZIP", type: "text", max: 80 },
      { k: "contactBy", label: "Best way to reach you", type: "radio", options: ["Text", "Phone call", "Email"] },
      { k: "occupation", label: "Occupation", type: "text", max: 80 },
      { k: "emergencyName", label: "Emergency contact name", type: "text", required: true, max: 80 },
      { k: "emergencyRelation", label: "Relationship", type: "text", max: 40 },
      { k: "emergencyPhone", label: "Emergency contact phone", type: "tel", required: true, max: 30 },
      { k: "doctor", label: "Primary care doctor (name and practice)", type: "text", max: 120 },
      { k: "heardFrom", label: "How did you hear about MD Fit?", type: "select", options: ["Google search", "Google Maps / reviews", "Friend or family", "Doctor referral", "Instagram / Facebook", "Event or flyer", "Other"] }
    ] },
  { id: "pain", title: "Pain Assessment Initial Intake", minutes: 4, forTypes: "notMassage", intro: "Tell us what's going on so Dr. Jared can find the root cause of your pain.",
    fields: [
      { k: "complaint", label: "What brings you in? Describe your main problem.", type: "textarea", required: true, max: 1000 },
      { k: "areas", label: "Where do you feel it? (check all that apply)", type: "checks", options: AREAS, required: true },
      { k: "started", label: "When did it start?", type: "select", options: ["Less than 2 weeks ago", "2 to 6 weeks ago", "6 weeks to 3 months ago", "3 to 12 months ago", "More than a year ago"], required: true },
      { k: "how", label: "How did it start?", type: "radio", options: ["Injury or accident", "Came on gradually", "After surgery", "Not sure"] },
      { k: "painNow", label: "Pain right now", type: "scale", required: true },
      { k: "painWorst", label: "Pain at its worst", type: "scale" },
      { k: "painBest", label: "Pain at its best", type: "scale" },
      { k: "feels", label: "What does it feel like? (check all that apply)", type: "checks", options: ["Sharp", "Dull / aching", "Burning", "Throbbing", "Stiffness", "Tingling / pins and needles", "Numbness", "Weakness"] },
      { k: "spreads", label: "Does the pain travel or spread? Where?", type: "text", max: 200 },
      { k: "worse", label: "What makes it worse?", type: "textarea", max: 600 },
      { k: "better", label: "What makes it better?", type: "textarea", max: 600 },
      { k: "timeOfDay", label: "When is it worst?", type: "radio", options: ["Morning", "During the day", "Evening", "At night", "No pattern"] },
      { k: "limits", label: "What activities is it stopping you from doing?", type: "textarea", max: 600 },
      { k: "treated", label: "Treatment you've already tried (PT, chiropractor, injections, medication…)", type: "textarea", max: 600 },
      { k: "imaging", label: "Any X-ray, MRI or CT for this?", type: "radio", options: ["No", "X-ray", "MRI", "CT", "More than one"] },
      { k: "goals", label: "What would you like to get back to? Your goals.", type: "textarea", required: true, max: 600 }
    ] },
  { id: "massage", title: "Massage preferences", minutes: 2, forTypes: "massage", intro: "Help us plan your medical massage.",
    fields: [
      { k: "focus", label: "Where would you like us to focus?", type: "textarea", required: true, max: 600 },
      { k: "painLevel", label: "Pain level today", type: "scale" },
      { k: "pressure", label: "Preferred pressure", type: "radio", options: PRESSURE },
      { k: "goals", label: "What would you like from this session?", type: "textarea", max: 600 },
      { k: "avoid", label: "Any areas to avoid?", type: "text", max: 200 }
    ] },
  { id: "history", title: "Health history", minutes: 3, intro: "Your health background helps us keep your treatment safe.",
    fields: [
      { k: "conditions", label: "Do you have, or have you had, any of these? (check all that apply)", type: "checks", options: HISTORY_CONDITIONS },
      { k: "surgeries", label: "Past surgeries (what and when)", type: "textarea", max: 600 },
      { k: "medications", label: "Current medications and supplements", type: "textarea", max: 600 },
      { k: "allergies", label: "Allergies (medications, latex, lotions, oils…)", type: "text", max: 300 },
      { k: "redFlags", label: "Recently: unexplained weight loss, fever, night pain that doesn't ease, or new bladder/bowel changes?", type: "yesno", required: true },
      { k: "redFlagsMore", label: "If yes, tell us more", type: "textarea", max: 600 },
      { k: "exercise", label: "How often do you exercise?", type: "radio", options: ["Rarely", "1-2 days a week", "3-4 days a week", "5+ days a week"] },
      { k: "other", label: "Anything else Dr. Jared should know?", type: "textarea", max: 1000 }
    ] },
  { id: "consent", title: "Consent & policies", minutes: 2, intro: "Please read and sign. You'll get a copy of anything you ask for at your visit.",
    fields: [
      { k: "treatment", type: "agree", required: true, label: "Consent to evaluation and treatment",
        text: "I consent to evaluation and treatment by Dr. Jared Caban and MD Fit, which may include hands-on soft-tissue work, assisted stretching, corrective exercise and medical massage. I understand some soreness is normal, that results are not guaranteed, and that I can ask questions or stop any treatment at any time. I will tell my provider about any change in my health." },
      { k: "privacy", type: "agree", required: true, label: "Notice of privacy practices",
        text: "I acknowledge that I can read MD Fit's Privacy Policy (mymdfit.com/privacy-policy), which explains how my health information is used and protected, and that I can ask for a copy at any time." },
      { k: "financial", type: "agree", required: true, label: "Payment and cancellation policy",
        text: "I agree to pay for services at the time of my visit unless other arrangements were made. Please cancel or reschedule at least 24 hours ahead so the time can go to someone else. Repeated no-shows or late cancellations may count as a used visit on a plan, or limit online booking." },
      { k: "messages", type: "agree", label: "Appointment messages",
        text: "MD Fit may send me appointment confirmations and reminders by email and text message. (Optional)" },
      { k: "signature", type: "sign", required: true, label: "Signature: type your full legal name" }
    ] }
];

const docsFor = (typeId) => DOCS.filter((d) => !d.forTypes || (d.forTypes === "massage" ? MASSAGE_TYPES.includes(typeId) : !MASSAGE_TYPES.includes(typeId)));

const fail = (m) => { throw new ValidationError(m); };
const txt = (v, label, max, min = 0) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : fail(`${label} must be text.`);
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};
const yes = (v) => v === true || v === "on" || v === "true" || v === "yes";

// Check one document's answers against its definition; returns the cleaned answers
function docInput(doc, b) {
  if (!b || typeof b !== "object") fail("Fill out the form.");
  const out = {};
  for (const f of doc.fields) {
    const v = b[f.k], label = f.label.replace(/\?.*$|\(.*$/, "").trim() || f.k;
    if (f.type === "checks") {
      const list = Array.isArray(v) ? [...new Set(v.filter((x) => f.options.includes(x)))] : [];
      if (f.required && !list.length) fail(`${label}: check at least one.`);
      out[f.k] = list;
    } else if (f.type === "scale") {
      const n = v === "" || v == null ? null : Number(v);
      if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 10)) fail(`${label} must be 0 to 10.`);
      if (f.required && n === null) fail(`${label} is required.`);
      out[f.k] = n;
    } else if (f.type === "yesno") {
      if (v !== "Yes" && v !== "No") { if (f.required) fail(`${label}: answer yes or no.`); out[f.k] = ""; } else out[f.k] = v;
    } else if (f.type === "agree") {
      if (f.required && !yes(v)) fail(`Please agree to: ${f.label}.`);
      out[f.k] = yes(v);
    } else if (f.type === "radio" || f.type === "select") {
      const s = typeof v === "string" ? v : "";
      if (s && !f.options.includes(s)) fail(`${label}: pick one of the options.`);
      if (f.required && !s) fail(`${label} is required.`);
      out[f.k] = s;
    } else if (f.type === "date") {
      const s = typeof v === "string" ? v.trim() : "";
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(`${label} must be a date.`);
      if (f.required && !s) fail(`${label} is required.`);
      out[f.k] = s;
    } else if (f.type === "email") {
      const s = txt(v, label, f.max || 120, f.required ? 3 : 0);
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(`${label} doesn't look like an email address.`);
      out[f.k] = s;
    } else {
      out[f.k] = txt(v, label, f.max || 200, f.required ? (f.type === "sign" ? 2 : 1) : 0);
    }
  }
  if (doc.fields.some((f) => f.type === "sign")) out.signedAt = new Date().toISOString();
  return out;
}

// The original single massage form (kept so an intake link opened on an older page still works)
function intakeInput(b) {
  if (!b || typeof b !== "object") fail("Fill out the form.");
  const pain = b.painLevel === "" || b.painLevel == null ? null : Number(b.painLevel);
  if (pain !== null && !(Number.isInteger(pain) && pain >= 0 && pain <= 10)) fail("Pain level must be 0 to 10.");
  const conditions = Array.isArray(b.conditions) ? b.conditions.filter((c) => CONDITIONS.includes(c)) : [];
  if (!yes(b.consent)) fail("Please confirm the consent statement.");
  return {
    focus: txt(b.focus, "Where you'd like us to focus", 600, 2), painLevel: pain, pressure: PRESSURE.includes(b.pressure) ? b.pressure : "Not sure",
    goals: txt(b.goals, "Goals", 600), conditions, medications: txt(b.medications, "Medications", 600), allergies: txt(b.allergies, "Allergies", 300),
    other: txt(b.other, "Anything else", 1000), emergencyName: txt(b.emergencyName, "Emergency contact", 80), emergencyPhone: txt(b.emergencyPhone, "Emergency contact phone", 30),
    signature: txt(b.signature, "Signature (type your full name)", 80, 2), consentAt: new Date().toISOString()
  };
}
const LEGACY_LABELS = { focus: "Where to focus", painLevel: "Pain level", pressure: "Pressure", goals: "Goals", conditions: "Conditions", medications: "Medications",
  allergies: "Allergies", other: "Anything else", emergencyName: "Emergency contact", emergencyPhone: "Emergency phone", signature: "Signature", consentAt: "Signed" };

// Documents status for an appointment: { total, done, complete, docs: [{ id, title, done: iso|null }] }
function packetStatus(a) {
  const docs = docsFor(a.typeId).map((d) => ({ id: d.id, title: d.title, done: (a.docs && a.docs[d.id]) || null }));
  // An intake sent on the original single massage form counts as the whole massage packet
  if (a.intakeAt && !a.docs) docs.forEach((d) => (d.done = a.intakeAt));
  const done = docs.filter((d) => d.done).length;
  return { total: docs.length, done, complete: done === docs.length, docs };
}

function mountIntake({ app, admin, store, cfg, notify, activity, limiter, audit, appointments, tokenMatches, prettyDate, prettyTime }) {
  const C = cipher([process.env.INTAKE_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const all = () => store.read("intakes", []);
  const limit = limiter(60, 60 * 60 * 1000);
  const find = (req) => {
    const token = (req.body && req.body.token) || req.query.token;
    const a = appointments().find((x) => x.id === req.params.id);
    if (!a || !tokenMatches(token, a.cancelToken)) return null;
    return a;
  };
  const BAD = { error: "This intake link isn't valid. Please call 941-313-0562." };
  // Patient-side events go in the audit ledger too (appointment id, document, hashed IP; never the answers)
  const log = (req, action, a, meta = {}) => audit && audit.record({ actor: "patient", action, subject: a.id, ip: req.ip, meta });

  // What the intake page needs: greeting, which documents, their questions, and which are already done (never the answers).
  //
  // Access tradeoff: the link in the booking email carries the appointment's cancel token in the URL (?token=...), so
  // anyone who has that email, or that browser history, can open it. That is why this route only ever returns what the
  // booking email already contained (first name, visit type, date, contact details to prefill) plus which documents
  // are done. Saved answers are never sent back out: a document can be re-submitted (which replaces it) but not read.
  // The token is scoped to this one appointment and is checked in constant time; the request log keeps the path only
  // (no query string) and Referrer-Policy is no-referrer, so the token doesn't leak through logs or outbound links.
  app.get("/api/appointments/:id/intake", limit.mw, (req, res) => {
    const a = find(req);
    if (!a) return res.status(404).json(BAD);
    log(req, "intake.open", a);
    const st = packetStatus(a);
    res.json({
      name: a.name.split(" ")[0], typeName: a.typeName, date: a.date, time: a.time, cancelled: a.status === "cancelled",
      prefill: { name: a.name, email: a.email, phone: a.phone || "" },
      docs: docsFor(a.typeId).map((d) => ({ ...d, done: (st.docs.find((x) => x.id === d.id) || {}).done })),
      done: st.complete, total: st.total, completed: st.done,
      // older page still reads these
      conditions: CONDITIONS, pressure: PRESSURE
    });
  });

  // Save one document
  app.post("/api/appointments/:id/intake/:doc", limit.mw, (req, res) => {
    const a = find(req);
    if (!a) return res.status(404).json(BAD);
    if (a.status === "cancelled") return res.status(409).json({ error: "This appointment was cancelled." });
    const doc = docsFor(a.typeId).find((d) => d.id === req.params.doc);
    if (!doc) return res.status(404).json({ error: "That form isn't part of this appointment." });
    const data = docInput(doc, req.body);
    const list = all().filter((x) => !(x.appointmentId === a.id && x.doc === doc.id)); // re-submitting replaces it
    list.push({ id: crypto.randomBytes(6).toString("hex"), appointmentId: a.id, doc: doc.id, createdAt: new Date().toISOString(), data: C.enc(JSON.stringify(data)) });
    store.write("intakes", list);
    const appts = appointments(), rec = appts.find((x) => x.id === a.id);
    const wasComplete = packetStatus(rec).complete;
    rec.docs = { ...(rec.docs || {}), [doc.id]: new Date().toISOString() };
    const st = packetStatus(rec);
    if (st.complete) rec.intakeAt = rec.intakeAt && wasComplete ? rec.intakeAt : new Date().toISOString();
    store.write("appointments", appts);
    activity("intake", { email: a.email, date: a.date, doc: doc.id });
    log(req, "intake.submit", a, { doc: doc.id, completed: st.done, total: st.total });
    if (st.complete && !wasComplete) notify.owner(`Documents completed: ${a.name}, ${prettyDate(a.date)} at ${prettyTime(a.time)}`,
      `${a.name} completed all ${st.total} intake documents for their ${a.typeName}.\n\nFor privacy the answers aren't in this email. Read them in Admin → Appointments:\n${cfg.siteUrl || ""}/admin`);
    res.status(201).json({ ok: true, total: st.total, completed: st.done, done: st.complete });
  });

  // Original single massage form
  app.post("/api/appointments/:id/intake", limit.mw, (req, res) => {
    const a = find(req);
    if (!a || !MASSAGE_TYPES.includes(a.typeId)) return res.status(404).json(BAD);
    if (a.status === "cancelled") return res.status(409).json({ error: "This appointment was cancelled." });
    const data = intakeInput(req.body);
    const list = all().filter((x) => !(x.appointmentId === a.id && !x.doc));
    list.push({ id: crypto.randomBytes(6).toString("hex"), appointmentId: a.id, createdAt: new Date().toISOString(), data: C.enc(JSON.stringify(data)) });
    store.write("intakes", list);
    const appts = appointments(), rec = appts.find((x) => x.id === a.id);
    rec.intakeAt = new Date().toISOString();
    store.write("appointments", appts);
    activity("intake", { email: a.email, date: a.date });
    log(req, "intake.submit", a, { doc: "massage-form" });
    notify.owner(`Massage intake received: ${a.name}, ${prettyDate(a.date)} at ${prettyTime(a.time)}`,
      `${a.name} filled out their medical massage intake form.\n\nFor privacy the answers aren't in this email. Read them in Admin → Appointments:\n${cfg.siteUrl || ""}/admin`);
    res.status(201).json({ ok: true });
  });

  // Admin: every completed document for an appointment, as labelled answers (each view is in the audit ledger)
  admin.get("/appointments/:id/intake", (req, res) => {
    const a = appointments().find((x) => x.id === req.params.id);
    const recs = all().filter((x) => x.appointmentId === req.params.id);
    if (!recs.length) return res.status(404).json({ error: "No intake documents yet." });
    const dec = (r) => { try { return JSON.parse(C.dec(r.data) || "{}"); } catch { return {}; } };
    const show = (v) => (Array.isArray(v) ? v.join(", ") : v === true ? "Agreed" : v === false ? "No" : v == null ? "" : String(v));
    const docs = recs.map((r) => {
      const d = dec(r), def = DOCS.find((x) => x.id === r.doc);
      if (!def) return { id: "massage-form", title: "Massage intake", createdAt: r.createdAt, fields: Object.entries(LEGACY_LABELS).map(([k, label]) => ({ label, value: show(d[k]) })).filter((f) => f.value) };
      const fields = def.fields.map((f) => ({ label: f.label, value: f.type === "scale" && d[f.k] != null ? `${d[f.k]}/10` : show(d[f.k]) })).filter((f) => f.value);
      if (d.signedAt) fields.push({ label: "Signed", value: new Date(d.signedAt).toLocaleString("en-US", { timeZone: cfg.tz }) });
      return { id: def.id, title: def.title, createdAt: r.createdAt, fields };
    }).sort((x, y) => DOCS.findIndex((d) => d.id === x.id) - DOCS.findIndex((d) => d.id === y.id));
    const legacy = recs.find((r) => !r.doc);
    res.json({ status: a ? packetStatus(a) : null, docs, ...(legacy ? { createdAt: legacy.createdAt, ...dec(legacy) } : {}) });
  });
}

module.exports = { mountIntake, intakeInput, docInput, packetStatus, docsFor, DOCS, MASSAGE_TYPES, CONDITIONS, PRESSURE };
