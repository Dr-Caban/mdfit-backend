// MD Fit as an online gym: members train on their own, or with a trainer, or with a clinician (owner, Nov 2026).
//
//   - Pros are members. A trainer or clinician applies from their own MD Fit member account (POST /api/me/pro/apply)
//     and the owner approves each one in the workspace. A pro is never staff: no workspace, no staff role, and nothing
//     from the practice's EMR (lib/emr.js, chart, intake, notes, billing) is ever read here. The pro portal is /pro.
//   - Members choose at sign-up or later (PUT /api/me/coach): independent, a trainer, or a clinician. Dr. Caban's
//     practice is listed first among clinicians (proId "practice"); choosing it changes nothing the practice can see.
//   - What a pro sees about their members follows the minimum-necessary rule (45 CFR 164.502(b)):
//       trainer    the member's name, what the trainer assigned and whether it was done (session counts and dates).
//       clinician  the same, plus the member's pain check-ins, only while the member has said yes to sharing them
//                  (an authorization the member gives and can take back at any time; it is recorded with its time).
//     Every time a clinician opens a member's pain check-ins it is written to the audit ledger (lib/audit.js).
//   - Clinicians accept the business associate agreement when they apply (MD Fit holds the check-ins they see on their
//     behalf); trainers accept the trainer terms (they are not health care providers and give no medical advice).
//   - Pros can only assign MD Fit's own content: Dr. Jared's programs, the Pain Tool protocols, and exercises from the
//     video library, by id. Nothing else can be sent. A short note may go with an assignment.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { PAIN_PROTOCOLS, customInput } = require("./custom-workouts");
const { programsOf, defaultContent } = require("./content");
const LIB = new Map((require("./exercises.json").exercises || []).map((e) => [e.id, e]));

const TYPES = ["trainer", "clinician"];
const MODES = ["independent", "trainer", "clinician"];
const PRACTICE = "practice";
const BAA_VERSION = "pro-baa-2026-11", TERMS_VERSION = "pro-terms-2026-11";
const ASSIGN_MAX = 200, NOTE_MAX = 300, PAIN_DAYS = 90;

const fail = (msg) => { throw new ValidationError(msg); };
const newId = () => crypto.randomBytes(6).toString("hex");
const str = (v, label, { max = 120, min = 0 } = {}) => {
  const s = String(v ?? "").trim();
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};

function mountPros({ app, admin, me, store, clients, save, audit, notify, activity, today }) {
  const pros = () => { const l = store.read("pros", []); return Array.isArray(l) ? l : []; };
  const writePros = (l) => store.write("pros", l);
  const assigns = () => { const l = store.read("pro-assignments", []); return Array.isArray(l) ? l : []; };
  const writeAssigns = (l) => store.write("pro-assignments", l.slice(-20000));
  const programs = () => programsOf(store.read("content", {}), defaultContent());
  const proOfClient = (clientId) => pros().find((p) => p.clientId === clientId) || null;
  const approved = (p) => !!p && p.status === "approved";

  // ---- What a member sees of a pro (directory, their own coach). Never the pro's email, phone or license number.
  const card = (p) => ({ id: p.id, type: p.type, name: p.displayName, specialty: p.specialty || "", bio: p.bio || "", city: p.city || "" });
  const PRACTICE_CARD = { id: PRACTICE, type: "clinician", name: "Dr. Jared Caban, MD Fit", specialty: "Pain rehab and sports medicine", bio: "Dr. Caban's own practice in Sarasota, Florida: the programs in this app are his.", city: "Sarasota, FL", practice: true };

  // ---- Progress on one assignment, from the member's own workout log (the keys the app's player writes)
  function progress(c, a) {
    const since = a.createdAt, log = (c.workouts || []).filter((w) => String(w.completedAt || w.date || "") >= since);
    const keyOk = a.kind === "program" ? (k) => k.startsWith(`prog-${a.ref}-`) : a.kind === "protocol" ? (k) => k === `painproto-${a.ref}` : (k) => k === `assign-${a.id}`;
    const done = log.filter((w) => keyOk(String(w.key || "")));
    return { sessions: done.length, last: done.length ? done[done.length - 1].date : null };
  }
  const assignView = (c, a) => ({ id: a.id, kind: a.kind, ref: a.ref, title: a.title, note: a.note || "", workout: a.workout || null, assignedOn: a.createdAt.slice(0, 10), ...(c ? progress(c, a) : {}) });

  // ---- Member: the directory and their choice ------------------------------------------------------------------
  me.get("/pros", (req, res) => {
    const type = String(req.query.type || "");
    if (!TYPES.includes(type)) fail('Say which: "trainer" or "clinician".');
    const list = pros().filter((p) => approved(p) && p.type === type && p.clientId !== req.client.id).map(card).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ pros: type === "clinician" ? [PRACTICE_CARD, ...list] : list });
  });

  function coachOf(c) {
    const k = c.coach || { mode: null };
    const p = k.proId && k.proId !== PRACTICE ? pros().find((x) => x.id === k.proId) : null;
    const pro = k.proId === PRACTICE ? PRACTICE_CARD : p && approved(p) ? card(p) : null;
    const mine = assigns().filter((a) => a.clientId === c.id && !a.removedAt && (!p || a.proId === p.id)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { mode: k.mode || null, pro, shareHealth: !!k.shareHealth, sharedSince: k.shareHealth ? k.consentAt : null, chosenAt: k.chosenAt || null,
      assignments: pro && !pro.practice ? mine.map((a) => assignView(c, a)) : [] };
  }
  me.get("/coach", (req, res) => res.json({ coach: coachOf(req.client) }));

  me.put("/coach", (req, res) => {
    const b = req.body || {}, mode = String(b.mode || "");
    if (!MODES.includes(mode)) fail("Choose independent, a trainer or a clinician.");
    let proId = null;
    if (mode !== "independent" && b.proId) {
      proId = String(b.proId);
      if (proId !== PRACTICE) {
        const p = pros().find((x) => x.id === proId);
        if (!approved(p) || p.type !== mode) return res.status(404).json({ error: "That professional isn't available. Pick another." });
        if (p.clientId === req.client.id) fail("You can't choose yourself.");
      } else if (mode !== "clinician") fail("Dr. Caban's practice is a clinician choice.");
    }
    // Sharing pain check-ins is the member's own authorization: only for a clinician, only when they say yes, and
    // it ends the moment they change their mind or their clinician.
    const share = mode === "clinician" && !!proId && proId !== PRACTICE && b.shareHealth === true;
    const list = clients(), c = list.find((x) => x.id === req.client.id), was = c.coach || {};
    const same = was.proId === proId;
    c.coach = { mode, proId, chosenAt: same && was.chosenAt ? was.chosenAt : new Date().toISOString(),
      shareHealth: share, consentAt: share ? (same && was.shareHealth && was.consentAt ? was.consentAt : new Date().toISOString()) : null };
    save(list);
    if (audit && (share !== !!was.shareHealth || !same)) audit.record({ actor: `client:${c.id}`, action: share ? "pro.share_health_on" : "pro.share_health_off", subject: c.id, ip: req.ip, meta: { proId: proId || "" } });
    if (activity) activity("coach_chosen", { mode });
    res.json({ coach: coachOf(c) });
  });

  // ---- Pro: apply, and the portal -------------------------------------------------------------------------------
  const mineView = (p) => p && { id: p.id, type: p.type, status: p.status, displayName: p.displayName, specialty: p.specialty, bio: p.bio, city: p.city,
    license: p.license || "", licenseState: p.licenseState || "", appliedAt: p.createdAt, decidedAt: p.decidedAt || null, reason: p.reason || "" };
  me.get("/pro", (req, res) => res.json({ pro: mineView(proOfClient(req.client.id)) || null }));

  me.post("/pro/apply", (req, res) => {
    const b = req.body || {}, c = req.client;
    const type = String(b.type || "");
    if (!TYPES.includes(type)) fail("Apply as a trainer or a clinician.");
    const had = proOfClient(c.id);
    if (had && had.status === "approved") fail("You're already approved.");
    const f = { type, displayName: str(b.displayName || c.name, "Display name", { min: 2, max: 60 }), specialty: str(b.specialty, "Specialty", { max: 80 }),
      bio: str(b.bio, "About you", { max: 600 }), city: str(b.city, "City", { max: 60 }) };
    if (type === "clinician") {
      f.license = str(b.license, "License number", { min: 3, max: 40 });
      f.licenseState = str(b.licenseState, "License state", { min: 2, max: 20 });
      if (b.acceptBaa !== true) fail("Clinicians must accept the business associate agreement.");
    } else if (b.acceptTerms !== true) fail("Please accept the trainer terms.");
    const list = pros(), now = new Date().toISOString();
    const p = had || { id: newId(), clientId: c.id, createdAt: now };
    Object.assign(p, f, { status: "pending", reason: "", decidedAt: null, decidedBy: null,
      ...(type === "clinician" ? { baa: BAA_VERSION, baaAt: now, terms: null } : { terms: TERMS_VERSION, termsAt: now, baa: null, license: "", licenseState: "" }) });
    if (!had) list.push(p); else list[list.findIndex((x) => x.id === p.id)] = p;
    writePros(list);
    if (audit) audit.record({ actor: `client:${c.id}`, action: "pro.apply", subject: p.id, ip: req.ip, meta: { type, baa: p.baa || "", terms: p.terms || "" } });
    try { notify && notify.owner && notify.owner(`MD Fit: a ${type} applied`, `${f.displayName} applied to be listed as a ${type} on MD Fit.\n\nReview it in the workspace: Members, then Trainers & clinicians.`); } catch {}
    res.status(201).json({ pro: mineView(p) });
  });

  const requirePro = (req, res, next) => {
    const p = proOfClient(req.client.id);
    if (!approved(p)) return res.status(403).json({ error: "This is for approved trainers and clinicians.", notPro: true, pro: mineView(p) || null });
    req.pro = p; next();
  };
  const membersOf = (p) => clients().filter((c) => c.coach && c.coach.proId === p.id && c.coach.mode === p.type && !c.deletedAt);
  const canSeeHealth = (p, c) => p.type === "clinician" && !!(c.coach && c.coach.shareHealth && c.coach.proId === p.id);

  me.get("/pro/members", requirePro, (req, res) => {
    const p = req.pro, all = assigns().filter((a) => a.proId === p.id && !a.removedAt);
    res.json({ pro: mineView(p), members: membersOf(p).map((c) => ({ id: c.id, name: c.name, since: c.coach.chosenAt, sharesHealth: canSeeHealth(p, c),
      assignments: all.filter((a) => a.clientId === c.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((a) => assignView(c, a)) })) });
  });

  // A clinician's view of one member's pain check-ins: only with the member's yes, and every opening is audited
  me.get("/pro/members/:id/pain", requirePro, (req, res) => {
    const p = req.pro, c = membersOf(p).find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "That member isn't one of yours." });
    if (!canSeeHealth(p, c)) return res.status(403).json({ error: p.type === "clinician" ? "This member hasn't chosen to share their pain check-ins with you." : "Trainers don't see health information." });
    res.set("Cache-Control", "no-store");
    if (audit) audit.record({ actor: `pro:${p.id}`, action: "pro.view_pain", subject: c.id, ip: req.ip, meta: { clientOf: p.clientId } });
    const from = new Date(Date.now() - PAIN_DAYS * 864e5).toISOString().slice(0, 10);
    res.json({ pain: (c.painLog || []).filter((x) => x.date >= from).sort((a, b) => (a.date < b.date ? 1 : -1)).map((x) => ({ date: x.date, area: x.area, level: x.level, note: x.note || "" })) });
  });

  me.post("/pro/assignments", requirePro, (req, res) => {
    const p = req.pro, b = req.body || {};
    const c = membersOf(p).find((x) => x.id === String(b.clientId || ""));
    if (!c) return res.status(404).json({ error: "That member isn't one of yours." });
    const kind = String(b.kind || ""), note = str(b.note, "Note", { max: NOTE_MAX });
    let ref = "", title = "", workout = null;
    if (kind === "program") {
      const prog = programs().find((x) => x.id === String(b.ref || ""));
      if (!prog) fail("Pick one of Dr. Jared's programs.");
      ref = prog.id; title = prog.title;
    } else if (kind === "protocol") {
      ref = String(b.ref || "");
      if (!PAIN_PROTOCOLS.has(ref)) fail("Pick one of the Pain Tool protocols.");
      title = str(b.title || ref, "Title", { max: 80 });
    } else if (kind === "workout") {
      // Exercises from the MD Fit library only, with sets and reps (per set if wanted), checked like a built workout
      const w = customInput({ name: b.title, exercises: b.exercises });
      const off = w.exercises.find((x) => !LIB.has(x.id));
      if (off) fail("Every exercise must come from the MD Fit library.");
      title = w.name; workout = { exercises: w.exercises };
    } else fail("Assign a program, a protocol or a workout from MD Fit.");
    const list = assigns();
    if (list.filter((a) => a.proId === p.id && a.clientId === c.id && !a.removedAt).length >= ASSIGN_MAX) fail(`Up to ${ASSIGN_MAX} assignments per member.`);
    const a = { id: newId(), proId: p.id, clientId: c.id, kind, ref, title, note, workout, createdAt: new Date().toISOString() };
    list.push(a); writeAssigns(list);
    if (activity) activity("pro_assigned", { kind });
    res.status(201).json({ assignment: assignView(c, a) });
  });

  me.delete("/pro/assignments/:id", requirePro, (req, res) => {
    const list = assigns(), a = list.find((x) => x.id === req.params.id && x.proId === req.pro.id && !x.removedAt);
    if (!a) return res.status(404).json({ error: "That assignment isn't yours." });
    a.removedAt = new Date().toISOString(); writeAssigns(list);
    res.json({ ok: true });
  });

  // A pro can let a member go: the member becomes independent and stops sharing anything with them
  me.post("/pro/members/:id/release", requirePro, (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id && x.coach && x.coach.proId === req.pro.id);
    if (!c) return res.status(404).json({ error: "That member isn't one of yours." });
    c.coach = { mode: "independent", proId: null, chosenAt: new Date().toISOString(), shareHealth: false, consentAt: null };
    save(list);
    if (audit) audit.record({ actor: `pro:${req.pro.id}`, action: "pro.release", subject: c.id, ip: req.ip });
    res.json({ ok: true });
  });

  // ---- Owner: review applications (these routes are mapped to no staff permission, so only the owner reaches them)
  const adminView = (p) => {
    const c = clients().find((x) => x.id === p.clientId);
    return { ...mineView(p), account: c ? { name: c.name, email: c.email } : null, members: membersOf(p).length, baaAt: p.baaAt || null, termsAt: p.termsAt || null };
  };
  admin.get("/pros", (req, res) => res.json({ pros: pros().map(adminView).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || (a.appliedAt < b.appliedAt ? 1 : -1)) }));
  admin.post("/pros/:id/decision", (req, res) => {
    const b = req.body || {}, status = String(b.status || "");
    if (!["approved", "rejected", "suspended"].includes(status)) fail("Approve, decline or suspend.");
    const list = pros(), p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "Application not found." });
    p.status = status; p.reason = str(b.reason, "Reason", { max: 300 }); p.decidedAt = new Date().toISOString(); p.decidedBy = req.account ? req.account.email : "owner";
    writePros(list);
    res.json({ pro: adminView(p) });
  });

  return { coachOf };
}

module.exports = { mountPros, PRACTICE, BAA_VERSION, TERMS_VERSION };
