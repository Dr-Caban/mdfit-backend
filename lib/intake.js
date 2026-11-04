// Medical massage intake: a short health form clients fill out after booking a massage (no evaluation needed).
// HIPAA-minded handling:
// - The answers are encrypted with AES-256-GCM before they're stored (on top of the encrypted data store).
// - Nothing from the form goes in an email. Dr. Jared gets "intake received, read it in Admin"; he reads it in Admin,
//   where every view is recorded in the audit ledger.
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

const fail = (m) => { throw new ValidationError(m); };
const txt = (v, label, max, min = 0) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : fail(`${label} must be text.`);
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};

function intakeInput(b) {
  if (!b || typeof b !== "object") fail("Fill out the form.");
  const pain = b.painLevel === "" || b.painLevel == null ? null : Number(b.painLevel);
  if (pain !== null && !(Number.isInteger(pain) && pain >= 0 && pain <= 10)) fail("Pain level must be 0 to 10.");
  const conditions = Array.isArray(b.conditions) ? b.conditions.filter((c) => CONDITIONS.includes(c)) : [];
  if (b.consent !== true && b.consent !== "on" && b.consent !== "true") fail("Please confirm the consent statement.");
  return {
    focus: txt(b.focus, "Where you'd like us to focus", 600, 2),
    painLevel: pain,
    pressure: PRESSURE.includes(b.pressure) ? b.pressure : "Not sure",
    goals: txt(b.goals, "Goals", 600),
    conditions,
    medications: txt(b.medications, "Medications", 600),
    allergies: txt(b.allergies, "Allergies", 300),
    other: txt(b.other, "Anything else", 1000),
    emergencyName: txt(b.emergencyName, "Emergency contact", 80),
    emergencyPhone: txt(b.emergencyPhone, "Emergency contact phone", 30),
    signature: txt(b.signature, "Signature (type your full name)", 80, 2),
    consentAt: new Date().toISOString()
  };
}

function mountIntake({ app, admin, store, cfg, notify, activity, limiter, appointments, tokenMatches, prettyDate, prettyTime }) {
  const C = cipher([process.env.INTAKE_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const all = () => store.read("intakes", []);
  const limit = limiter(20, 60 * 60 * 1000);
  const find = (req) => {
    const token = (req.body && req.body.token) || req.query.token;
    const a = appointments().find((x) => x.id === req.params.id);
    if (!a || !MASSAGE_TYPES.includes(a.typeId) || !tokenMatches(token, a.cancelToken)) return null;
    return a;
  };

  // What the intake page needs to greet the client (no health details)
  app.get("/api/appointments/:id/intake", limit.mw, (req, res) => {
    const a = find(req);
    if (!a) return res.status(404).json({ error: "This intake link isn't valid. Please call 941-313-0562." });
    res.json({ name: a.name.split(" ")[0], typeName: a.typeName, date: a.date, time: a.time, done: !!a.intakeAt, conditions: CONDITIONS, pressure: PRESSURE });
  });

  app.post("/api/appointments/:id/intake", limit.mw, (req, res) => {
    const a = find(req);
    if (!a) return res.status(404).json({ error: "This intake link isn't valid. Please call 941-313-0562." });
    if (a.status === "cancelled") return res.status(409).json({ error: "This appointment was cancelled." });
    const data = intakeInput(req.body);
    const list = all().filter((x) => x.appointmentId !== a.id); // a resubmission replaces the earlier one
    list.push({ id: crypto.randomBytes(6).toString("hex"), appointmentId: a.id, createdAt: new Date().toISOString(), data: C.enc(JSON.stringify(data)) });
    store.write("intakes", list);
    const appts = appointments(), rec = appts.find((x) => x.id === a.id);
    rec.intakeAt = new Date().toISOString();
    store.write("appointments", appts);
    activity("intake", { email: a.email, date: a.date });
    notify.owner(`Massage intake received: ${a.name}, ${prettyDate(a.date)} at ${prettyTime(a.time)}`,
      `${a.name} filled out their medical massage intake form.\n\nFor privacy the answers aren't in this email. Read them in Admin → Appointments:\n${cfg.siteUrl || ""}/admin`);
    res.status(201).json({ ok: true });
  });

  // Admin: read one intake (logged in the audit ledger like every admin request)
  admin.get("/appointments/:id/intake", (req, res) => {
    const rec = all().find((x) => x.appointmentId === req.params.id);
    if (!rec) return res.status(404).json({ error: "No intake form yet." });
    let data = {};
    try { data = JSON.parse(C.dec(rec.data) || "{}"); } catch {}
    res.json({ createdAt: rec.createdAt, ...data });
  });
}

module.exports = { mountIntake, intakeInput, MASSAGE_TYPES, CONDITIONS, PRESSURE };
