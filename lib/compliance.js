// The practice's compliance records and the live checklist built from them (45 CFR Part 164, with Florida's rules).
// lib/hipaa.js holds the patient-facing rights (access, amendment, disclosures, privacy notice) and the incident log.
// This module holds what the practice itself must keep and show on request:
//   - Registers: risk analyses (§164.308(a)(1)), business associate agreements (§164.504(e), §164.314), policies
//     (§164.316), workforce training (§164.308(a)(5), §164.530(b)), devices that open the EMR (§164.310), backup
//     restore tests (§164.308(a)(7)) and audit-log reviews (§164.308(a)(1)(ii)(D)). Entries are never deleted, only
//     retired: documentation is kept six years (§164.316(b)(2)).
//   - The audit review: a summary of who did what, for the owner to read and sign off.
//   - The checklist: one row per requirement, its status worked out from what the system is actually doing right now.
// Nothing here holds patient data; the audit summary carries staff addresses and counts, never a patient's name.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (m) => { throw new ValidationError(m); };
const id = () => crypto.randomBytes(6).toString("hex");
const DAY = 864e5;
const TYPES = {
  risk: { label: "Risk analysis", party: "Who carried it out" },
  baa: { label: "Business associate agreement", party: "Vendor" },
  policy: { label: "Policy or procedure", party: "Owner of the policy" },
  training: { label: "Training", party: "Staff member (their sign-in email)" },
  device: { label: "Device or workstation", party: "Who uses it" },
  restore: { label: "Backup restore test", party: "Who tested it" },
  review: { label: "Audit log review", party: "Who reviewed it" }
};
const STATUSES = { baa: ["signed", "requested", "not-needed"], device: ["secured", "needs-attention"], policy: ["adopted", "draft"] };
// Vendors that handle patient data when the matching feature is in use. `match` is tested against what the owner typed.
const VENDORS = [
  { key: "hosting", name: "Railway (API and database hosting)", match: /railway/i, always: true },
  { key: "site", name: "Vercel (site hosting; requests pass through it)", match: /vercel/i, always: true },
  { key: "email", name: "Resend (email)", match: /resend/i, when: "email" },
  { key: "google", name: "Google Workspace (calendar)", match: /google/i, when: "calendar" },
  { key: "ai", name: "AI provider (scribe, Solomon AI answers)", match: /openai|amazon|aws|bedrock|azure|microsoft|google|anthropic/i, when: "ai" }
];
// The policies a small practice is expected to have in writing
const POLICIES = ["Privacy practices and patient rights", "Security (access, passwords, devices)", "Breach and incident response", "Workforce sanctions", "Contingency (backup and recovery)", "Minimum necessary and role access"];

function mountCompliance({ admin, store, cfg, audit, staff, hipaa, clients, today, mfaOn, emailOn, calendarOn, aiOn, backupBlocked, backupState, idleMinutes, lockout }) {
  const nowIso = () => (cfg && typeof cfg.now === "function" ? cfg.now() : new Date()).toISOString();
  const all = () => { const r = store.read("compliance-registers", {}); return r && typeof r === "object" && !Array.isArray(r) ? r : {}; };
  const of = (type) => (Array.isArray(all()[type]) ? all()[type] : []);
  const liveOf = (type) => of(type).filter((e) => !e.retiredAt);
  const text = (v, label, max, min = 0) => { const s = typeof v === "string" ? v.trim() : ""; if (s.length < min) fail(`${label} is required.`); if (s.length > max) fail(`${label} is too long (max ${max} characters).`); return s; };
  const date = (v, label, required = false) => { const s = typeof v === "string" ? v.trim() : ""; if (!s) { if (required) fail(`${label} is required.`); return ""; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T12:00:00Z"))) fail(`${label} must be a date (YYYY-MM-DD).`); return s; };
  const daysSince = (d) => (d ? Math.floor((Date.parse(today() + "T12:00:00Z") - Date.parse(String(d).slice(0, 10) + "T12:00:00Z")) / DAY) : Infinity);
  const latest = (type) => liveOf(type).map((e) => e.date).filter(Boolean).sort().pop() || "";

  function input(type, b, cur = {}) {
    const allowed = STATUSES[type];
    const status = b.status === undefined ? cur.status || (allowed ? allowed[0] : "") : String(b.status);
    if (allowed && !allowed.includes(status)) fail(`Status must be one of: ${allowed.join(", ")}.`);
    return {
      title: b.title === undefined ? cur.title : text(b.title, "Title", 160, 1), party: b.party === undefined ? cur.party || "" : text(b.party, TYPES[type].party, 160),
      date: b.date === undefined ? cur.date || "" : date(b.date, "Date", type !== "device"), reviewBy: b.reviewBy === undefined ? cur.reviewBy || "" : date(b.reviewBy, "Review by"),
      status: allowed ? status : "", notes: b.notes === undefined ? cur.notes || "" : text(b.notes, "Notes", 2000)
    };
  }
  const typeOf = (req) => { const t = String(req.params.type || ""); if (!TYPES[t]) fail("Unknown register."); return t; };

  admin.get("/compliance/registers", (req, res) => res.json({ types: TYPES, statuses: STATUSES, vendors: VENDORS.map(({ key, name }) => ({ key, name })), policies: POLICIES,
    registers: Object.fromEntries(Object.keys(TYPES).map((t) => [t, of(t).slice().sort((a, b) => (a.date < b.date ? 1 : -1))])) }));
  admin.post("/compliance/registers/:type", (req, res) => {
    const type = typeOf(req), b = req.body || {};
    if (!b.title) fail("Title is required.");
    const e = { id: id(), ...input(type, b), createdAt: nowIso(), createdBy: req.admin };
    store.write("compliance-registers", { ...all(), [type]: [...of(type), e] });
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: `compliance.${type}.added`, subject: e.id, ip: req.ip });
    res.status(201).json(e);
  });
  // Edit, or retire. There is no delete: compliance documentation is kept six years.
  admin.patch("/compliance/registers/:type/:id", (req, res) => {
    const type = typeOf(req), list = of(type).slice(), i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "Entry not found." });
    const b = req.body || {};
    list[i] = { ...list[i], ...input(type, b, list[i]), updatedAt: nowIso(), updatedBy: req.admin, ...(b.retired === true ? { retiredAt: list[i].retiredAt || nowIso() } : b.retired === false ? { retiredAt: null } : {}) };
    store.write("compliance-registers", { ...all(), [type]: list });
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: `compliance.${type}.${b.retired === true ? "retired" : "changed"}`, subject: list[i].id, ip: req.ip });
    res.json(list[i]);
  });

  // ---- Audit review: what happened, by person, for the owner to read and sign off (§164.308(a)(1)(ii)(D))
  function auditSummary(days) {
    const since = new Date(Date.parse(nowIso()) - days * DAY).toISOString();
    const entries = audit ? audit.list({ limit: 20000 }).filter((e) => e.ts >= since) : [];
    const tz = cfg.tz || "America/New_York";
    const hourOf = (ts) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(ts))) % 24;
    const people = new Map();
    const row = (actor) => { if (!people.has(actor)) people.set(actor, { who: actor.replace(/^admin:/, ""), total: 0, chartViews: 0, patients: new Set(), exports: 0, afterHours: 0, last: "" }); return people.get(actor); };
    let denied = 0, staffChanges = 0, settingsChanges = 0, exportsTotal = 0;
    for (const e of entries) {
      const a = String(e.action || ""), actor = String(e.actor || "");
      if (/denied/.test(a)) denied++;
      if (/^staff\./.test(a)) staffChanges++;
      if (/settings/.test(a)) settingsChanges++;
      if (!actor.startsWith("admin")) continue;
      const r = row(actor); r.total++; if (e.ts > r.last) r.last = e.ts;
      if (/^emr\.|^notes\.|chart/.test(a)) { r.chartViews++; if (e.subject) r.patients.add(e.subject); }
      if (/export|records/.test(a)) { r.exports++; exportsTotal++; }
      const h = hourOf(e.ts); if (h < 6 || h >= 22) r.afterHours++;
    }
    const chain = audit ? audit.verify() : { ok: false };
    return { days, since, total: entries.length, chainOk: !!chain.ok, denied, staffChanges, settingsChanges, exports: exportsTotal,
      people: [...people.values()].map((p) => ({ ...p, patients: p.patients.size })).sort((a, b) => b.total - a.total),
      lastReview: liveOf("review").slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null };
  }
  admin.get("/compliance/audit-review", (req, res) => res.json(auditSummary(Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30))))));
  admin.post("/compliance/audit-review", (req, res) => {
    const s = auditSummary(30), b = req.body || {};
    const e = { id: id(), title: `Audit log reviewed: ${s.total} entries, ${s.people.length} staff, ${s.denied} refused, chain ${s.chainOk ? "intact" : "NOT intact"}`, party: req.admin, date: today(), reviewBy: "", status: "",
      notes: text(b.notes, "Notes", 2000), createdAt: nowIso(), createdBy: req.admin };
    store.write("compliance-registers", { ...all(), review: [...of("review"), e] });
    if (audit) audit.record({ actor: `admin:${req.admin}`, action: "compliance.audit_review", subject: e.id, ip: req.ip, meta: { entries: s.total, chainOk: s.chainOk } });
    res.status(201).json(e);
  });

  // ---- The checklist. status: "met" (the system does it and the record is current), "action" (the system supports
  // it; something is waiting on a person), "notmet" (a safeguard is off).
  function checklist() {
    const S = hipaa.settingsOf(), people = clients(), rows = [];
    const add = (id, rule, title, status, detail, todo = "", go = "") => rows.push({ id, rule, title, status, detail, todo, go });
    const yearOld = (d) => daysSince(d) > 365;

    { const d = latest("risk");
      add("risk", "§164.308(a)(1)(ii)(A)", "Risk analysis", d && !yearOld(d) ? "met" : "action", d ? `Last risk analysis recorded ${d}.` : "No risk analysis is on record.", d && !yearOld(d) ? "" : "Carry out a written risk analysis and record it (yearly, and after any big change).", "registers:risk"); }
    add("officers", "§164.530(a), §164.308(a)(2)", "Privacy and security officers", S.privacyOfficer && S.securityOfficer ? "met" : "action",
      S.privacyOfficer && S.securityOfficer ? `Privacy officer: ${S.privacyOfficer}. Security officer: ${S.securityOfficer}.` : "One or both officers are not named.", S.privacyOfficer && S.securityOfficer ? "" : "Name both officers (one person can hold both).", "settings");
    { const flags = { email: !!emailOn(), calendar: !!calendarOn(), ai: !!aiOn() }, need = VENDORS.filter((v) => v.always || flags[v.when]), baas = liveOf("baa");
      const have = (v) => baas.some((e) => v.match.test(`${e.title} ${e.party}`) && (e.status === "signed" || e.status === "not-needed"));
      const missing = need.filter((v) => !have(v));
      add("baa", "§164.504(e), §164.314(a)", "Business associate agreements", missing.length ? "action" : "met", missing.length ? `Not recorded for: ${missing.map((v) => v.name).join("; ")}.` : `Recorded for all ${need.length} vendors in use.`,
        missing.length ? "Get each agreement signed (or record why one is not needed) and add it to the register." : "", "registers:baa"); }
    { const am = store.read("amendments", []).filter((a) => a.status === "pending"), late = am.filter((a) => a.dueAt < today());
      add("rights", "§164.522–528", "Patient rights: copy of record, corrections, disclosure accounting, contact restrictions", late.length ? "action" : "met",
        `Live. ${am.length} correction request${am.length === 1 ? "" : "s"} open${late.length ? `, ${late.length} past the 60-day deadline` : ""}; ${store.read("disclosures", []).length} disclosures on the accounting.`, late.length ? "Answer the overdue correction requests." : "", "requests"); }
    { const pts = people.filter((c) => c.patient && c.patient.status === "active"), missing = pts.filter((c) => !hipaa.nppStatus(c).acknowledged);
      const ok = !!S.nppVersion && !missing.length;
      add("npp", "§164.520", "Notice of Privacy Practices", ok ? "met" : "action", `${S.nppVersion ? `Notice version ${S.nppVersion}.` : "No notice version is recorded."} ${pts.length - missing.length} of ${pts.length} active patients have acknowledged it.`,
        ok ? "" : !S.nppVersion ? "Record the version and date of your Notice of Privacy Practices." : "Collect the acknowledgment from the patients listed.", S.nppVersion ? "requests:npp" : "settings"); }
    { const open = store.read("incidents", []).filter((i) => i.status !== "closed");
      add("breach", "§164.400–414, §164.308(a)(6), Fla. §501.171", "Breach and incident procedure", open.length ? "action" : "met", `Incident log is live; it works out the HIPAA 60-day and Florida 30-day deadlines. ${open.length} open.`, open.length ? "Finish the risk assessment and notifications for each open incident." : "", "incidents"); }
    add("access", "§164.312(a)(1), §164.502(b)", "Unique sign-ins and role-based access", "met", `${staff.listFor().filter((s) => s.active).length} staff account(s), each with its own sign-in. Manager and Developer roles cannot be given patient data.`, "", "team");
    add("logoff", "§164.312(a)(2)(iii)", "Automatic logoff", idleMinutes > 0 ? "met" : "notmet", idleMinutes > 0 ? `The server ends a staff session after ${idleMinutes} minutes without activity, and at sign-out.` : "Server-side logoff is switched off.", idleMinutes > 0 ? "" : "Remove STAFF_IDLE_MINUTES=0 from the server settings.");
    add("auth", "§164.312(d)", "Person authentication", mfaOn() ? "met" : "action", `Passwords of 12+ characters, lockout after ${lockout} wrong tries. Two-step sign-in is ${mfaOn() ? "on" : "off"}.`, mfaOn() ? "" : "Turn on two-step sign-in (Security screen). The current rule does not require it; the proposed 2025 rule does.", "security");
    add("encrypt", "§164.312(a)(2)(iv), §164.312(e)", "Encryption at rest and in transit", cfg.dataKey ? "met" : "notmet", cfg.dataKey ? "Every stored file is encrypted (AES-256-GCM); clinical text is encrypted a second time; HTTPS only." : "DATA_ENC_KEY is not set: names and contact details are readable on the server's disk (clinical text is still encrypted).",
      cfg.dataKey ? "" : "Set DATA_ENC_KEY on the server.");
    { const chain = audit ? audit.verify() : { ok: false }, d = latest("review"), fresh = d && daysSince(d) <= 31;
      add("audit", "§164.312(b), §164.308(a)(1)(ii)(D)", "Audit controls and regular review", !chain.ok ? "notmet" : fresh ? "met" : "action", `${chain.ok ? "The audit ledger is intact" : "THE AUDIT LEDGER FAILED VERIFICATION"} (${chain.entries || 0} entries). ${d ? `Last reviewed ${d}.` : "It has never been reviewed."}`,
        chain.ok && fresh ? "" : "Read the audit review and sign it off (monthly).", "review"); }
    { const why = backupBlocked(), st = backupState() || {}, d = latest("restore"), okRestore = d && !yearOld(d);
      add("backup", "§164.308(a)(7)", "Backup and recovery", why ? "notmet" : okRestore ? "met" : "action", `${why ? `The weekly encrypted backup is NOT running: ${why}` : `Weekly encrypted backup is set up${st.okAt ? ` (last sent ${String(st.okAt).slice(0, 10)})` : " (none sent yet)"}.`} ${d ? `Last restore test ${d}.` : "No restore test is on record."}`,
        why ? "Set a backup passphrase of 12+ characters on the server." : okRestore ? "" : "Open one backup file with the passphrase, confirm the records are there, and record the test.", "registers:restore"); }
    { const active = [{ email: String(cfg.adminEmail || "").toLowerCase() }, ...staff.listFor().filter((s) => s.active)], tr = liveOf("training");
      const missing = active.filter((s) => !tr.some((e) => String(e.party || "").toLowerCase().includes(String(s.email).toLowerCase()) && !yearOld(e.date)));
      add("training", "§164.308(a)(5), §164.530(b)", "Workforce training", missing.length ? "action" : "met", missing.length ? `${missing.length} of ${active.length} people have no training recorded in the last year.` : `All ${active.length} people have training recorded in the last year.`,
        missing.length ? "Train each person and record it against their sign-in email." : "", "registers:training"); }
    { const dv = liveOf("device"), bad = dv.filter((e) => e.status !== "secured");
      add("devices", "§164.310", "Devices and workstations", !dv.length || bad.length ? "action" : "met", !dv.length ? "No devices are on the inventory." : `${dv.length} device(s) listed${bad.length ? `, ${bad.length} needing attention` : ", all marked secured"}.`,
        !dv.length ? "List every computer, tablet and phone that opens the EMR, with disk encryption and screen lock confirmed." : bad.length ? "Fix and re-mark the devices needing attention." : "", "registers:device"); }
    { const pol = liveOf("policy").filter((e) => e.status === "adopted"), due = pol.filter((e) => e.reviewBy && e.reviewBy < today());
      add("policies", "§164.316, §164.530(i)–(j)", "Written policies, kept six years", pol.length >= POLICIES.length && !due.length ? "met" : "action", `${pol.length} adopted polic${pol.length === 1 ? "y" : "ies"} on the register (${POLICIES.length} expected)${due.length ? `, ${due.length} past review` : ""}. Entries are retired, never deleted.`,
        pol.length >= POLICIES.length && !due.length ? "" : "Adopt and record each expected policy; review yearly.", "registers:policy"); }
    add("retention", "§164.530(j), Florida board rules", "Record retention", "met", `Clinical records kept ${S.retentionYears} years, audit log ${S.auditRetentionYears} years. Nothing is purged automatically; a deleted client's chart is kept.`, "", "settings");
    const count = (s) => rows.filter((r) => r.status === s).length;
    return { generatedAt: nowIso(), rows, summary: { met: count("met"), action: count("action"), notmet: count("notmet"), total: rows.length } };
  }
  admin.get("/compliance/checklist", (req, res) => res.json(checklist()));

  return { checklist, auditSummary, TYPES };
}

module.exports = { mountCompliance, TYPES, VENDORS, POLICIES };
