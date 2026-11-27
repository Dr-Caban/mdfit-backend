// Client accounts: sign up / log in, client dashboard API (appointments, plan, pain log), and admin client management.
// Client sessions are signed tokens with role "client"; they can never pass the admin check (which needs sub = ADMIN_EMAIL).
const express = require("express");
const crypto = require("crypto");
const { hashPassword, verifyPassword, signToken, verifyToken } = require("./auth");
const { ValidationError, EMAIL_RE, AREAS } = require("./validate");
const { rewards, ACTIONS, GEMS, levelStart, gemstoneOf, repairsFrom, workoutKind, actionLedger } = require("./rewards");
const { classifyWorkout, PAIN_TRACKS, PAIN_PROTOCOLS } = require("./custom-workouts");
const { patientStatus, visitDocs } = require("./intake");
const { suggestedOf } = require("./suggested");

const SESSION_DAYS = 30;
const RESET_HOURS = 24;
const GUIDE_IDS = ["posterior-neck", "scalenes", "rotator-cuff", "iliopsoas", "lateral-hip", "quads", "calf"];
const PAIN_LOG_MAX = 1000;
const WORKOUT_LOG_MAX = 2000;

// Progress on each assigned program, worked out from the workouts the app already logs. A program session is saved
// with key "prog-<program id>-w<week key>" (week-by-week protocols) or "prog-<program id>-d<day index>" (day programs).
function programProgress(assigned, workouts) {
  const out = {};
  for (const a of assigned || []) {
    const re = new RegExp(`^prog-${String(a.id).replace(/[^a-z0-9-]/g, "")}-(?:w(.+)|d(\\d+))$`);
    const mine = (workouts || []).map((w) => [w, re.exec(String(w.key || ""))]).filter(([, m]) => m)
      .sort(([x], [y]) => (String(x.completedAt || x.date) < String(y.completedAt || y.date) ? -1 : 1));
    const weeks = [...new Set(mine.map(([, m]) => m[1]).filter(Boolean))], days = [...new Set(mine.map(([, m]) => m[2]).filter(Boolean))].map(Number);
    const since = String(a.assignedAt || "").slice(0, 10), last = mine[mine.length - 1];
    out[a.id] = { sessions: mine.length, sinceAssigned: mine.filter(([w]) => !since || w.date >= since).length, weeksStarted: weeks, daysDone: days.sort((x, y) => x - y),
      lastWeek: last && last[1][1] ? last[1][1] : "", firstDate: mine.length ? mine[0][0].date : "", lastDate: last ? last[0].date : "" };
  }
  return out;
}
const FREE_MONTHS = 3;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/tokeninfo";

function generateReferralCode(name) {
  const prefix = name.replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "MDFT";
  return prefix + crypto.randomBytes(3).toString("hex").toUpperCase();
}
const FAVORITES_MAX = 500;
const PROGRAMS_MAX = 50;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// A real calendar day written YYYY-MM-DD (2026-11-31 and 2025-13-45 are not)
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
// Streaks count calendar days (clinic time zone) with at least one completed workout.
function workoutStats(log, today) {
  const days = new Set(log.map((w) => w.date));
  let streak = 0;
  for (let d = days.has(today) ? today : addDay(today, -1); days.has(d); d = addDay(d, -1)) streak++;
  let best = 0, run = 0, prev = null;
  for (const d of [...days].sort()) { run = prev && addDay(prev, 1) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDay(today, -dow);
  const week = Array.from({ length: 7 }, (_, i) => days.has(addDay(monday, i)));
  const minutes = log.reduce((n, w) => n + (w.minutes || 0), 0);
  return { streak, bestStreak: best, workouts: log.length, hours: Math.round(minutes / 6) / 10, week, todayIndex: dow };
}

const fail = (msg) => { throw new ValidationError(msg); };
// A value that must be text, as it is: missing is "", and anything that is not text (an object, a list) is refused
// with msg. Turning an object into text can throw, which answered 500 instead of saying what was wrong.
const typed = (v, msg) => (v === undefined || v === null ? "" : typeof v === "string" ? v : fail(msg));
function text(v, field, { max = 200, min = 0 } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") fail(`${field} must be text.`);
  const s = v.trim();
  if (s.length < min) fail(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (s.length > max) fail(`${field} is too long (max ${max} characters).`);
  return s;
}
const emailOf = (v) => {
  const e = text(v, "Email", { min: 1, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(e)) fail("Email is not valid.");
  return e;
};
const phoneOf = (v) => {
  const p = text(v, "Phone", { max: 30 });
  if (p && !/^[0-9()+\-.\s]{7,30}$/.test(p)) fail("Phone number is not valid.");
  return p;
};
const passwordOf = (v, field = "Password") => {
  if (typeof v !== "string" || v.length < 8) fail(`${field} must be at least 8 characters.`);
  if (v.length > 200) fail(`${field} is too long.`);
  return v;
};
const emptyPlan = () => ({ guides: [], exercises: [], notes: "", updatedAt: null });
const id = () => crypto.randomBytes(6).toString("hex");

function mountClients(ctx) {
  const { app, admin, store, cfg, notify, cal, nowParts, activity, limiter, logger, mask, prettyDate, prettyTime, settings, onCancel } = ctx;
  const clients = () => store.read("clients", []);
  const save = (list) => store.write("clients", list);
  const appointments = () => store.read("appointments", []);
  const clock = () => (typeof cfg.now === "function" ? cfg.now() : new Date());
  const today = () => nowParts(cfg.tz, clock()).date;
  const ready = cfg.sessionSecret.length >= 32;
  const signupLimit = limiter(10, 60 * 60 * 1000);
  // Signing in (Google, Apple, the app's hand-off) is counted apart from signing up and forgotten passwords, and with
  // more room: a clinic or gym on one Wi-Fi address must not be locked out after ten of anything. An account made by a
  // Google or Apple sign-in still counts against signupLimit.
  const signinLimit = limiter(60, 60 * 60 * 1000);
  const signupsFull = (req, res) => { if (signupLimit.blocked(req.ip)) { res.status(429).json({ error: "Too many requests. Try again later." }); return true; } signupLimit.hit(req.ip); return false; };
  const resetLimit = limiter(6, 60 * 60 * 1000);
  const loginFails = limiter(10, 15 * 60 * 1000);
  // Wrong passwords are also counted per account, and only that account's own successful sign-in clears the count:
  // signing in to a different account from the same address must not buy more guesses at this one.
  const loginFailsByEmail = limiter(10, 15 * 60 * 1000);
  // One-time codes: how many may be sent to, and how many wrong tries may be made against, one account per hour
  const codeSends = limiter(6, 60 * 60 * 1000);
  const codeTries = limiter(15, 60 * 60 * 1000);

  // An account's email is "verified" once its owner has shown they receive mail there: by signing in with Google or
  // Apple (which vouch for the address) or by entering a code we emailed. Anyone can type someone else's email into
  // a sign-up form, so the address alone proves nothing. Visits booked as a guest are matched to an account by email
  // only after that proof; until then an account sees just the visits it booked itself while signed in.
  const verified = (c) => !!(c && c.emailVerifiedAt);
  const owns = (c, a) => a.clientId === c.id || (verified(c) && !!a.email && a.email === c.email);
  // list: the client list being saved, so a referrer's month that was waiting on this proof is granted with it (referralReward)
  const markVerified = (c, list) => { if (!c.emailVerifiedAt) c.emailVerifiedAt = new Date().toISOString(); if (list) referralReward(c, list); };
  // First time Google or Apple vouches for an address whose account was never verified: whoever set its password
  // never proved they own the address, so that password and every session made with it end here.
  const claimVerified = (c, list) => {
    if (!verified(c) && c.passwordHash) { c.passwordHash = null; c.pwv = (c.pwv || 0) + 1; }
    markVerified(c, list);
  };

  const activeMembership = (c) => (c.membership && (!c.membership.until || c.membership.until >= today()) ? c.membership : null);
  // A paid treatment plan (protocol) that is still being paid monthly
  const activePlan = (c) => !!(c && (c.protocols || []).some((p) => p && p.status === "active"));
  // Dr. Jared's in-clinic toggle (Workspace: outpatient -> inpatient). Read per request, so switching back takes effect at once.
  const isInpatient = (c) => !!(c && c.clientType === "inpatient");
  // The whole app with no limits: an active membership, an active treatment plan, or an in-clinic patient. Used for
  // unlimited Solomon (lib/guide.js); content access (lib/content.js) and messaging (lib/messages.js) build on the same parts.
  const fullAccess = (c) => !!(activeMembership(c) || activePlan(c) || isInpatient(c));
  const genReferralCode = () => "MDFIT-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  // An older account without a code gets one saved the first time it's shown (a new random one on every request
  // would be a code nobody can use)
  const referralCode = (c) => {
    if (c.referralCode) return c.referralCode;
    const list = clients(), x = list.find((y) => y.id === c.id);
    if (x && !x.referralCode) { x.referralCode = genReferralCode(); save(list); }
    c.referralCode = x ? x.referralCode : genReferralCode();
    return c.referralCode;
  };
  const generateReferralCode = () => genReferralCode();
  const referrals = () => store.read("referrals", []);
  const saveReferrals = (list) => store.write("referrals", list.slice(-5000));
  // Referral activity (owner, Nov 2026): link visits, Copy and Share presses, codes that matched nobody and late claims,
  // so a referral is never lost because it happened outside the sign-up form. Ids, codes and times only: no names,
  // emails or addresses. The latest 20,000 are kept.
  const REF_CODE = /^[A-Z0-9][A-Z0-9-]{3,19}$/i;
  const CLAIM_DAYS = 30;
  const refEvents = () => store.read("referral-events", []);
  const refEvent = (e) => { try { store.write("referral-events", [...refEvents(), { ts: new Date().toISOString(), ...e }].slice(-20000)); } catch (err) { logger.warn("referral_event_failed", { error: err.message }); } };
  const ownerOf = (code, list, notId) => { const k = String(code || "").trim().toUpperCase(); return k ? list.find((x) => x.referralCode && String(x.referralCode).toUpperCase() === k && x.id !== notId) : null; };
  // via: how the code arrived (email sign-up, google, apple, or claim: typed in the app after signing up)
  function applyReferral(newClient, code, list, via = "email") {
    code = String(code || "").trim();
    if (!code) return false;
    const referrer = ownerOf(code, list, newClient.id);
    // A partner's code (PATF, Exhibit D): the sign-up is the partner's, for their tracking and their commission
    if (!referrer) {
      const ps = app.get("partnerShare"), partner = ps && ps.partnerByCode(code);
      if (partner) {
        newClient.referredPartner = partner.id; newClient.referredVia = via;
        refEvent({ type: "partner_signup", partnerId: partner.id, clientId: newClient.id, via });
        logger.info("partner_signup", { clientId: newClient.id, partnerId: partner.id, via });
        return true;
      }
    }
    // A code nobody owns is worth seeing too: a mistyped or stale link is a sign-up the referrer never got credit for
    if (!referrer) { logger.warn("referral_code_unmatched", { clientId: newClient.id, via }); refEvent({ type: "unmatched", code: code.slice(0, 20), clientId: newClient.id, via }); return false; }
    newClient.referredBy = referrer.id;
    newClient.referredVia = via;
    referrer.referrals = (referrer.referrals || 0) + 1;
    // Ledger entry + log line (ids only, no names or emails), so referral sign-ups show in Railway's logs, in the
    // on-volume activity log and in Insights. A failure here must never block the sign-up itself.
    try {
      saveReferrals([...referrals(), { ts: new Date().toISOString(), clientId: newClient.id, referrerId: referrer.id, referredBy: referrer.id, via }]);
    } catch (e) { logger.warn("referral_ledger_failed", { error: e.message }); }
    logger.info("referral_signup", { clientId: newClient.id, referrerId: referrer.id, referrerTotal: referrer.referrals, via });
    // The referrer's free month is owed once per referred account, and only when that account's email is proven: anyone
    // can type made-up addresses into the sign-up form. Google and Apple sign-ups are proven at once; an email sign-up
    // is when its owner enters the code we send (markVerified).
    newClient.referralRewardDue = true;
    referralReward(newClient, list);
    return true;
  }
  function referralReward(c, list) {
    if (!c.referralRewardDue || !verified(c)) return;
    delete c.referralRewardDue;
    const referrer = list.find((x) => x.id === c.referredBy && !x.deletedAt);
    const now = new Date();
    // The reward is a month on whatever the referrer has. A member on a higher tier keeps that tier and everything else
    // on the record (the Stripe subscription id above all); only someone with no current plan gets Membership.
    // The owner can switch the free month off (Affiliates settings) once cash commissions pay for referrals instead.
    if (!referrer || (store.read("affiliates", {}) || {}).freeMonthReward === false) return;
    const m = referrer.membership || {}, live = !!(m.until && m.until >= today());
    // A membership with no end date (activeMembership: blank "until") already never runs out: a month added to it
    // would give it an end, and a lower tier. It is left exactly as it is.
    if (referrer.membership && !m.until) return;
    const referrerUntil = new Date((live ? new Date(m.until) : now).getTime() + 30 * 864e5).toISOString().slice(0, 10);
    referrer.membership = { ...m, tier: live && m.tier ? m.tier : "member", until: referrerUntil, via: m.via || "referral-reward" };
  }
  const pub = (c) => ({ id: c.id, email: c.email, name: c.name, firstName: c.firstName || String(c.name || "").split(" ")[0], lastName: c.lastName || String(c.name || "").split(" ").slice(1).join(" "), phone: c.phone, emailVerified: verified(c), createdAt: c.createdAt, plan: c.plan || emptyPlan(), membership: activeMembership(c), referralCode: referralCode(c), hasPassword: !!c.passwordHash, google: !!c.googleSub, apple: !!c.appleSub,
    clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient", assignedPrograms: c.assignedPrograms || [], assignedPain: assignedPain(c), pinnedPrograms: c.pinnedPrograms || [], suggested: suggestedOf(c),
    // The birthday is the member's: they see it here and change or remove it with PUT /api/me ("" when none is kept)
    dob: typeof c.dob === "string" && isDay(c.dob) ? c.dob : "" });
  // Welcome email for every new account (password, Google, or auto-created at login). Name and links only: no health details.
  const welcome = (c) => {
    if (!notify.enabled || !cfg.siteUrl) return;
    const first = String(c.name || "").split(" ")[0] || "there";
    notify.client(c.email, "Welcome to MD Fit",
      `Hi ${first},\n\nYour MD Fit account is ready. Here's where to start:\n\n` +
      `• Your dashboard: ${cfg.siteUrl}/account\n` +
      `• Generate a workout, build your own, or follow one of Dr. Jared's programs\n` +
      `• Check off your daily activities for XP, and watch your gem level climb\n` +
      `• New patient? Fill out your intake documents once, before your first visit: ${cfg.siteUrl}/intake?me=1\n` +
      `• Book a visit any time: ${cfg.siteUrl}/book\n\n` +
      `Questions? Reply to this email or call/text 941-313-0562.\n\nDr. Jared Caban\nMD Fit · Sarasota, FL`);
  };
  const session = (c) => {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    return { token: signToken({ sub: c.id, role: "client", pwv: c.pwv || 0, exp }, cfg.sessionSecret), expiresAt: new Date(exp).toISOString(), client: pub(c) };
  };
  // "ev" marks a reset token earned with an emailed code: using it also verifies the address. A reset link the
  // practice hands out from Admin carries no such proof.
  const resetToken = (c, emailed = false) => signToken({ sub: c.id, role: "reset", pwv: c.pwv || 0, ...(emailed ? { ev: 1 } : {}), exp: Date.now() + RESET_HOURS * 3600e3 }, cfg.sessionSecret);
  const resetUrl = (c) => `${cfg.siteUrl || ""}/login?reset=${encodeURIComponent(resetToken(c))}`;
  // Telehealth visits booked before the practice saved its video room link (or without one of their own) show the
  // current room link, so every video visit in the app has a way to join.
  const myAppointments = (c) => {
    const s = settings(), room = (s.booking && s.booking.telehealthUrl) || (cfg.siteUrl ? `${String(cfg.siteUrl).replace(/\/+$/, "")}/visit` : "");
    const remote = new Set((s.appointmentTypes || []).filter((t) => t.remote).map((t) => t.id));
    return appointments().filter((a) => owns(c, a)).map(({ cancelToken, adminNotes, ...a }) =>
      (!a.meetingLink && room && remote.has(a.typeId) ? { ...a, meetingLink: room } : a));
  };
  const notReady = (res) => res.status(503).json({ error: "Accounts aren't set up on the server (SESSION_SECRET)." });

  function requireClient(req, res, next) {
    if (!ready) return notReady(res);
    const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const payload = m && verifyToken(m[1], cfg.sessionSecret);
    const c = payload && payload.role === "client" && clients().find((x) => x.id === payload.sub);
    if (!c || (c.pwv || 0) !== payload.pwv) return res.status(401).json({ error: "Please log in again." });
    // Payments can ask to check Stripe first (a paying member whose webhook never arrived): only then is this async
    const pending = hooks.reconcile && hooks.reconcile(c);
    if (!pending) { req.client = c; return next(); }
    pending.then((changed) => { req.client = (changed && clients().find((x) => x.id === c.id)) || c; next(); }, () => { req.client = c; next(); });
  }
  const hooks = { reconcile: null };
  const setReconcile = (fn) => { hooks.reconcile = fn; };

  // A birthday as YYYY-MM-DD: a real date, not in the future, not before 1900. Empty is fine (it is optional).
  const BAD_BIRTHDAY = "That birthday isn't a date we can use. Leave it empty if you'd rather not say.";
  function birthdayOf(v) {
    // Only text can be a date; anything else (a number, a list, an object) gets the same answer as a wrong date
    if (v !== undefined && v !== null && typeof v !== "string") throw new ValidationError(BAD_BIRTHDAY);
    const d = String(v === undefined || v === null ? "" : v).trim();
    if (!d) return "";
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T12:00:00Z")) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d && d >= "1900-01-01" && d <= today();
    if (!ok) throw new ValidationError(BAD_BIRTHDAY);
    return d;
  }
  // The birthday email goes only to a member who has not asked us to keep away from their inbox: none when their
  // privacy record (Profile, Privacy) says to reach them some other way, or holds any restriction on how we contact them.
  const birthdayEmailOk = (c) => {
    const p = c.privacy && typeof c.privacy === "object" ? c.privacy : {};
    const by = typeof p.contactBy === "string" ? p.contactBy.trim().toLowerCase() : p.contactBy;
    const restricted = typeof p.restrictions === "string" ? p.restrictions.trim() !== "" : !!p.restrictions;
    return !(by && by !== "email") && !restricted;
  };
  // Happy birthday (owner, Nov 2026): one push and one email on the day, from 9 AM at the clinic, once a year, to
  // members who gave their birthday themselves. Someone born on Feb 29 is greeted on Feb 28 in other years. The
  // message says nothing of age or health. Called every minute from server.js. No push when the member has switched
  // reminders off in the app; no email when they asked not to be emailed (birthdayEmailOk).
  function birthdays() {
    const now = nowParts(cfg.tz, clock()), year = now.date.slice(0, 4), md = now.date.slice(5);
    if (now.time < "09:00") return 0;
    const leap = !Number.isNaN(Date.parse(`${year}-02-29T12:00:00Z`)) && new Date(`${year}-02-29T12:00:00Z`).getUTCMonth() === 1;
    // A damaged record (an empty slot in the list, a birthday that is not text) is passed over, so it can never stop
    // everyone else's greeting
    const list = clients(), due = (Array.isArray(list) ? list : []).filter((c) => c && typeof c === "object" && !c.deletedAt && c.dobBy === "member"
      && typeof c.dob === "string" && c.dob && c.birthdayGreeted !== year
      && (c.dob.slice(5) === md || (c.dob.slice(5) === "02-29" && !leap && md === "02-28")));
    if (!due.length) return 0;
    // The year is saved before anything goes out. If the save fails, nothing is sent and the next minute tries again;
    // sending first and saving after sent the same greeting again every minute for as long as the save kept failing.
    for (const c of due) c.birthdayGreeted = year;
    save(list);
    const push = app.get("push");
    for (const c of due) {
      // One member's greeting failing must not cost the rest of them theirs (they are already marked for the year)
      try {
        const first = (typeof c.name === "string" ? c.name : "").split(" ")[0] || "there";
        const nudgesOff = !!(c.appPrefs && c.appPrefs.nudges === "off");
        if (push && !nudgesOff) push.toClient(c.id, { title: `Happy birthday, ${first}!`, body: "From Dr. Jared and everyone at MD Fit. Have a great day.", route: "home" });
        if (notify.enabled && birthdayEmailOk(c)) notify.client(c.email, `Happy birthday, ${first}!`,
          `Hi ${first},\n\nHappy birthday from Dr. Jared and everyone at MD Fit. We hope it's a great one.\n\nMD Fit${cfg.siteUrl ? `\n${cfg.siteUrl}` : ""}`);
      } catch (err) { logger.warn("birthday_greeting_member_failed", { clientId: c.id, error: err.message }); }
    }
    return due.length;
  }
  app.set("birthdays", birthdays);

  // ================= Public: sign up, log in, password reset =================
  app.post("/api/clients/signup", signupLimit.mw, (req, res) => {
    if (!ready) return notReady(res);
    const b = req.body || {};
    if (b.mdfit_hp || b.company) return res.status(201).json({ ok: true });
    const email = emailOf(b.email);
    const name = text(b.name, "Name", { min: 2, max: 100 });
    const list = clients();
    if (list.some((x) => x.email === email)) return res.status(409).json({ error: "There's already an account with that email. Log in instead." });
    const c = {
      id: id(), email, name, phone: phoneOf(b.phone),
      passwordHash: hashPassword(passwordOf(b.password)), pwv: 0, plan: emptyPlan(), painLog: [],
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    // Birthday: optional. Kept only when the member typed it; dobBy marks it as theirs (the birthday greeting below
    // goes only to people who gave it themselves, never to a date that came in with imported records).
    const dob = birthdayOf(b.dob);
    if (dob) { c.dob = dob; c.dobBy = "member"; }
    c.referralCode = genReferralCode();
    applyReferral(c, b.referralCode, list, "email");
    list.push(c);
    save(list);
    activity("client_signup", { email });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n${c.phone || "(no phone)"}${b.referralCode ? `\nReferred with code: ${b.referralCode}` : ""}`);
    welcome(c);

    res.status(201).json(session(c));
  });

  app.post("/api/clients/login", (req, res) => {
    if (!ready) return notReady(res);
    if (loginFails.blocked(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Email is not valid." });
    if (loginFailsByEmail.blocked(email)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes, or reset your password." });
    const password = String((req.body && req.body.password) || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const list = clients();
    let c = list.find((x) => x.email === email);

    if (c) {
      if (!verifyPassword(password, c.passwordHash)) {
        loginFails.hit(req.ip); loginFailsByEmail.hit(email);
        logger.warn("client_login_failed", { email: mask(email) });
        return res.status(401).json({ error: "Wrong email or password." });
      }
      loginFails.reset(req.ip); loginFailsByEmail.reset(email);
      // A temporary password from the office is not a way in: it proves the address, and leads to choosing a real one
      if (c.tempPw) {
        if (!(c.tempPw.until > new Date().toISOString())) return res.status(401).json({ error: 'That temporary password has expired. Choose "Forgot password?" to set a new one.' });
        return res.status(403).json({ error: "That is your temporary password. Choose your own password at mymdfit.com/login to finish signing in.", mustChangePassword: true, resetToken: resetToken(c, true) });
      }
      c.lastLoginAt = new Date().toISOString();
      save(list);
      return res.json(session(c));
    }
    // No account with this email. Signing in never creates one: an account made here would belong to whoever typed
    // the address first, not to the person who owns it. The answer is the same as for a wrong password.
    loginFails.hit(req.ip);
    logger.warn("client_login_failed", { email: mask(email) });
    return res.status(401).json({ error: "Wrong email or password." });
  });

  // ================= Google Sign-In =================
  let _googleCerts = null, _googleCertsExp = 0;
  async function googleCerts() {
    if (_googleCerts && Date.now() < _googleCertsExp) return _googleCerts;
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!r.ok) throw new Error("Failed to fetch Google certs");
    const jwks = await r.json();
    _googleCerts = jwks.keys;
    _googleCertsExp = Date.now() + 3600e3;
    return _googleCerts;
  }
  function b64toBuf(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64");
  }
  async function verifyGoogleToken(idToken, clientId) {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const header = JSON.parse(b64toBuf(parts[0]).toString());
    const payload = JSON.parse(b64toBuf(parts[1]).toString());
    if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") throw new Error("Invalid issuer");
    if (payload.aud !== clientId) throw new Error("Invalid audience");
    if ((payload.exp || 0) * 1000 < Date.now()) throw new Error("Token expired");
    const certs = await googleCerts();
    const key = certs.find((k) => k.kid === header.kid);
    if (!key) throw new Error("Unknown signing key");
    const pubKey = crypto.createPublicKey({ key, format: "jwk" });
    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pubKey, b64toBuf(parts[2]));
    if (!ok) throw new Error("Invalid signature");
    return payload;
  }

  app.post("/api/clients/google", signinLimit.mw, async (req, res) => {
    if (!ready) return notReady(res);
    const gClientId = process.env.GOOGLE_CLIENT_ID;
    if (!gClientId) return res.status(501).json({ error: "Google sign-in is not configured." });
    const credential = String((req.body && req.body.credential) || "");
    if (!credential) return res.status(400).json({ error: "Missing credential." });
    let payload;
    try { payload = await verifyGoogleToken(credential, gClientId); } catch (e) {
      logger.warn("google_auth_failed", { error: e.message });
      return res.status(401).json({ error: "Google sign-in failed. Try again." });
    }
    const email = (payload.email || "").trim().toLowerCase();
    if (!email || !payload.email_verified) return res.status(400).json({ error: "Google account has no verified email." });
    // First and last name come from the Google profile; fill in only what the account is missing
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const firstName = clean(payload.given_name), lastName = clean(payload.family_name);
    const fullName = clean([firstName, lastName].filter(Boolean).join(" ")) || clean(payload.name) || email.split("@")[0];
    const list = clients();
    let c = list.find((x) => x.email === email);
    if (c) {
      c.lastLoginAt = new Date().toISOString();
      // Google has checked the address (email_verified above). A first link to a never-verified account drops its password.
      if (!c.googleSub) claimVerified(c, list); else markVerified(c, list);
      if (!c.googleSub) c.googleSub = payload.sub;
      if (!c.firstName && firstName) c.firstName = firstName;
      if (!c.lastName && lastName) c.lastName = lastName;
      if ((!c.name || c.name === email.split("@")[0]) && fullName) c.name = fullName;
      save(list);
      return res.json(session(c));
    }
    if (signupsFull(req, res)) return;
    const refCode = String((req.body && req.body.referralCode) || "");
    c = {
      id: id(), email, name: text(fullName, "Name", { min: 1, max: 100 }), firstName, lastName, phone: "",
      passwordHash: null,
      pwv: 0, plan: emptyPlan(), painLog: [], googleSub: payload.sub, emailVerifiedAt: new Date().toISOString(),
      referralCode: genReferralCode(),
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    applyReferral(c, refCode, list, "google");
    list.push(c);
    save(list);
    activity("client_signup", { email, via: "google" });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n(signed up with Google)${refCode ? `\nReferred with code: ${refCode}` : ""}`);
    welcome(c);
    res.status(201).json(session(c));
  });

  // ---- App sign-in hand-off. Google blocks its sign-in inside apps' web views, so the MD Fit app opens the login
  // page in the phone's real browser; once signed in, the page asks for a one-time code and sends the app back to
  // /login?handoff=<code>, which exchanges it for the session. Codes last 2 minutes and work once.
  const handoffs = new Map(); // code -> { clientId, pwv, exp }
  app.post("/api/clients/handoff", requireClient, (req, res) => {
    for (const [k, v] of handoffs) if (v.exp < Date.now()) handoffs.delete(k);
    const code = crypto.randomBytes(24).toString("hex");
    handoffs.set(code, { clientId: req.client.id, pwv: req.client.pwv || 0, exp: Date.now() + 2 * 60e3 });
    res.json({ code });
  });
  app.post("/api/clients/handoff/exchange", signinLimit.mw, (req, res) => {
    if (!ready) return notReady(res);
    const code = String((req.body && req.body.code) || "");
    const h = handoffs.get(code); handoffs.delete(code);
    const c = h && h.exp > Date.now() && clients().find((x) => x.id === h.clientId && (x.pwv || 0) === h.pwv);
    if (!c) return res.status(401).json({ error: "That sign-in link expired. Please try again." });
    res.json(session(c));
  });

  // ================= Sign in with Apple (the iOS app) =================
  // The app gets an identity token from Apple on the phone; we check its signature against Apple's public keys,
  // that it was issued for our app, and sign the member in (creating the account the first time).
  let _appleKeys = null, _appleKeysExp = 0;
  async function appleKeys() {
    if (_appleKeys && Date.now() < _appleKeysExp) return _appleKeys;
    const r = await fetch("https://appleid.apple.com/auth/keys");
    if (!r.ok) throw new Error("Failed to fetch Apple keys");
    _appleKeys = (await r.json()).keys; _appleKeysExp = Date.now() + 3600e3;
    return _appleKeys;
  }
  async function verifyAppleToken(idToken, audiences) {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const header = JSON.parse(b64toBuf(parts[0]).toString()), payload = JSON.parse(b64toBuf(parts[1]).toString());
    if (payload.iss !== "https://appleid.apple.com") throw new Error("Invalid issuer");
    if (!audiences.includes(payload.aud)) throw new Error("Invalid audience");
    if ((payload.exp || 0) * 1000 < Date.now()) throw new Error("Token expired");
    const key = (await appleKeys()).find((k) => k.kid === header.kid);
    if (!key) throw new Error("Unknown signing key");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key, format: "jwk" }), b64toBuf(parts[2]));
    if (!ok) throw new Error("Invalid signature");
    return payload;
  }
  app.post("/api/clients/apple", signinLimit.mw, async (req, res) => {
    if (!ready) return notReady(res);
    // The iPhone app's bundle id, plus the website's Services ID when Sign in with Apple is set up for the web
    const audiences = [...(process.env.APPLE_APP_IDS || "com.mdfitsrq.MDfit").split(","), process.env.APPLE_SERVICES_ID || ""].map((s) => s.trim()).filter(Boolean);
    const token = String((req.body && req.body.identityToken) || "");
    if (!token) return res.status(400).json({ error: "Missing Apple token." });
    let payload;
    try { payload = await verifyAppleToken(token, audiences); } catch (e) {
      logger.warn("apple_auth_failed", { error: e.message });
      return res.status(401).json({ error: "Apple sign-in failed. Try again." });
    }
    const sub = String(payload.sub || ""), email = String(payload.email || "").trim().toLowerCase();
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Apple sends the name only the very first time, from the phone, not inside the token
    const firstName = clean(req.body && req.body.firstName), lastName = clean(req.body && req.body.lastName);
    const list = clients();
    // Apple marks the address it shares as verified; an unverified one is never used to find or prove an account
    const appleVerified = payload.email_verified === true || payload.email_verified === "true";
    let c = list.find((x) => x.appleSub && x.appleSub === sub) || (email && appleVerified && list.find((x) => x.email === email));
    if (c) {
      c.lastLoginAt = new Date().toISOString();
      if (email && appleVerified && c.email === email) { if (!c.appleSub) claimVerified(c, list); else markVerified(c, list); }
      if (!c.appleSub) c.appleSub = sub;
      if (!c.firstName && firstName) c.firstName = firstName;
      if (!c.lastName && lastName) c.lastName = lastName;
      const full = clean([firstName, lastName].filter(Boolean).join(" "));
      if ((!c.name || c.name === c.email.split("@")[0]) && full) c.name = full;
      save(list);
      return res.json(session(c));
    }
    if (!email) return res.status(400).json({ error: "Apple didn't share an email for this account. In Settings → Apple Account → Sign in with Apple, remove MD Fit and try again, or create an account with your email." });
    if (signupsFull(req, res)) return;
    const fullName = clean([firstName, lastName].filter(Boolean).join(" ")) || email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    c = {
      id: id(), email, name: text(fullName, "Name", { min: 1, max: 100 }), firstName, lastName, phone: "",
      passwordHash: null, pwv: 0, plan: emptyPlan(), painLog: [], appleSub: sub, ...(appleVerified ? { emailVerifiedAt: new Date().toISOString() } : {}),
      referralCode: genReferralCode(),
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    applyReferral(c, String((req.body && req.body.referralCode) || ""), list, "apple");
    list.push(c);
    save(list);
    activity("client_signup", { email, via: "apple" });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n(signed up with Apple)`);
    welcome(c);
    res.status(201).json(session(c));
  });

  // Always answers the same way so it can't be used to find out who has an account.
  // One-time codes for first-time password setup, forgotten passwords and changes, sent by email (Resend).
  const resetCodes = new Map(); // clientId -> { code, exp, tries }
  const RESET_CODE_TTL = 10 * 60e3; // 10 minutes
  const RESET_CODE_MAX_TRIES = 5;
  const digits = (p) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const findByIdentifier = (list, ident) => {
    const v = String(ident || "").trim().toLowerCase();
    return v.includes("@") ? list.find((x) => x.email === v) || null : null;
  };
  const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => a + "•".repeat(Math.min(b.length, 6)) + c);
  async function sendCode(c) {
    if (codeSends.hit(c.id) > 6) return null; // at most six codes an hour to one account, whoever asks
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    resetCodes.set(c.id, { code, exp: Date.now() + RESET_CODE_TTL, tries: 0 });
    if (!notify.enabled) return null;
    notify.client(c.email, `${code} is your MD Fit code`,
      `Hi ${c.name.split(" ")[0]},\n\nYour MD Fit code is:\n\n${code}\n\nUse it to confirm your email, or to set or reset your password. It expires in 10 minutes. If you didn't ask for this, ignore this email.\n\nMD Fit`);
    return { via: "email", to: maskEmail(c.email) };
  }
  function checkCode(c, code) {
    // Wrong tries are also counted per account across codes, so asking for a fresh code does not buy fresh guesses
    if (codeTries.blocked(c.id)) return "Too many attempts. Try again in an hour.";
    const entry = resetCodes.get(c.id);
    if (!entry || Date.now() > entry.exp) { resetCodes.delete(c.id); return "Code expired. Request a new one."; }
    if (entry.tries >= RESET_CODE_MAX_TRIES) { resetCodes.delete(c.id); return "Too many attempts. Request a new code."; }
    if (entry.code !== String(code || "").trim()) { entry.tries++; codeTries.hit(c.id); return `Wrong code. ${RESET_CODE_MAX_TRIES - entry.tries} attempts left.`; }
    resetCodes.delete(c.id);
    return "";
  }

  app.post("/api/clients/forgot", signupLimit.mw, async (req, res) => {
    const b = req.body || {}, ident = b.identifier || b.email || b.phone || "";
    const c = findByIdentifier(clients(), ident);
    if (c) await sendCode(c).catch(() => null);
    res.json({ ok: true, emailed: notify.enabled, via: "email",
      message: notify.enabled ? "If that email has an account, a 6-digit code is on its way." : "Call or text us and we'll help you reset your password." });
  });

  app.post("/api/clients/verify-code", (req, res) => {
    if (!ready) return notReady(res);
    const b = req.body || {};
    const c = findByIdentifier(clients(), b.identifier || b.email || b.phone);
    if (!c) return res.status(400).json({ error: "Code expired. Request a new one." });
    const err = checkCode(c, b.code);
    if (err) return res.status(/Too many/.test(err) ? 429 : 400).json({ error: err });
    res.json({ resetToken: resetToken(c, true) });
  });

  app.post("/api/clients/reset", (req, res) => {
    if (!ready) return notReady(res);
    const payload = verifyToken(String((req.body && req.body.token) || ""), cfg.sessionSecret);
    const list = clients();
    const c = payload && payload.role === "reset" && list.find((x) => x.id === payload.sub);
    if (!c || (c.pwv || 0) !== payload.pwv) return res.status(400).json({ error: "This reset code has expired or was already used. Request a new one." });
    c.passwordHash = hashPassword(passwordOf(req.body.password));
    c.pwv = (c.pwv || 0) + 1;
    delete c.tempPw; // they have chosen their own: the temporary one is gone for good
    if (payload.ev) markVerified(c, list); // the token came from a code we emailed to this address
    c.lastLoginAt = new Date().toISOString();
    save(list);
    activity("client_password_reset", { email: c.email });
    res.json(session(c));
  });

  // Google sign-in
  // ================= Client dashboard =================
  const me = express.Router();
  me.use(requireClient);

  me.get("/", (req, res) => res.json({ client: pub(req.client) }));

  me.put("/", (req, res) => {
    const b = req.body || {};
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    if (b.name !== undefined) {
      const name = text(b.name, "Name", { min: 2, max: 100 });
      // First/last name saved from a Google sign-in would otherwise keep showing the old name
      if (name !== c.name) { delete c.firstName; delete c.lastName; }
      c.name = name;
    }
    if (b.phone !== undefined) c.phone = phoneOf(b.phone);
    // The birthday: a date keeps it as the member's own, an empty one removes it (and the record of this year's
    // greeting with it), anything else is refused. Left out of the body, nothing about it changes. A new date keeps
    // birthdayGreeted, so changing it never brings a second greeting in a year already greeted.
    if (b.dob !== undefined) {
      if (typeof b.dob !== "string") fail(BAD_BIRTHDAY);
      const dob = birthdayOf(b.dob);
      if (dob) { c.dob = dob; c.dobBy = "member"; }
      else { delete c.dob; delete c.dobBy; delete c.birthdayGreeted; }
    }
    save(list);
    res.json({ client: pub(c) });
  });

  // Send a code to the signed-in member (needed to set a first password, or to change it without the current one)
  me.post("/password/code", resetLimit.mw, async (req, res) => {
    const sent = await sendCode(req.client).catch(() => null);
    if (!sent) return res.status(503).json({ error: "We can't send codes right now. Call or text us at 941-313-0562." });
    res.json({ ok: true, ...sent });
  });
  // Confirm the account's email with a code sent to it. Until then, visits booked as a guest with this address
  // are not shown in the account.
  me.post("/email/code", resetLimit.mw, async (req, res) => {
    if (verified(req.client)) return res.json({ ok: true, verified: true });
    const sent = await sendCode(req.client).catch(() => null);
    if (!sent) return res.status(503).json({ error: "We can't send codes right now. Call or text us at 941-313-0562." });
    res.json({ ok: true, ...sent });
  });
  me.post("/email/verify", (req, res) => {
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    if (!verified(c)) {
      const err = checkCode(c, (req.body || {}).code);
      if (err) return res.status(/Too many/.test(err) ? 429 : 400).json({ error: err });
      markVerified(c, list);
      save(list);
      activity("client_email_verified", { email: c.email });
    }
    res.json({ ok: true, client: pub(c) });
  });
  me.put("/password", (req, res) => {
    const b = req.body || {};
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    const password = passwordOf(b.password, "New password"); // before the code is checked, so a too-short password doesn't use it up
    if (b.code) { const err = checkCode(c, b.code); if (err) return res.status(400).json({ error: err }); markVerified(c, list); }
    else if (!c.passwordHash) return res.status(400).json({ error: "Enter the code we sent you to set your password." });
    else if (!verifyPassword(String(b.current || ""), c.passwordHash)) return res.status(400).json({ error: "Current password is wrong." });
    c.passwordHash = hashPassword(password);
    c.pwv = (c.pwv || 0) + 1; // signs out other devices
    save(list);
    res.json(session(c));
  });

  me.get("/appointments", (req, res) => {
    const t = today();
    const mine = myAppointments(req.client).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
    res.json({
      upcoming: mine.filter((a) => a.status === "booked" && a.date >= t),
      past: mine.filter((a) => !(a.status === "booked" && a.date >= t)).reverse()
    });
  });

  me.post("/appointments/:id/cancel", async (req, res) => {
    let list = appointments();
    let a = list.find((x) => x.id === req.params.id && owns(req.client, x));
    if (!a) return res.status(404).json({ error: "Appointment not found." });
    if (a.status !== "booked" || a.date < today()) return res.status(400).json({ error: "This appointment can't be cancelled online." });
    if (a.source === "cal") {
      try { await cal.cancel(a.calUid, "Cancelled by client in MD Fit account"); }
      catch (err) { return res.status(502).json({ error: "Couldn't cancel right now. Please call us." }); }
      list = appointments(); a = list.find((x) => x.id === req.params.id); // fresh copy: bookings saved while Cal answered stay
      if (!a) return res.status(404).json({ error: "Appointment not found." });
    }
    a.status = "cancelled";
    a.cancelledAt = new Date().toISOString();
    store.write("appointments", list);
    if (onCancel) onCancel(a);
    activity("appointment_cancelled", { email: a.email, date: a.date, via: "account", typeName: a.typeName, when: `${prettyDate(a.date)} at ${prettyTime(a.time)}`, id: a.id });
    notify.owner(`Cancelled: ${a.typeName}, ${prettyDate(a.date)} at ${prettyTime(a.time)}`, `${a.name} (${a.email}) cancelled from their account.`);
    res.json({ ok: true });
  });

  me.get("/pain", (req, res) => res.json((req.client.painLog || []).slice().sort((a, b) => (a.date + a.createdAt < b.date + b.createdAt ? -1 : 1))));

  me.post("/pain", (req, res) => {
    const b = req.body || {};
    if (!AREAS.includes(b.area)) fail("Pick a body area from the list.");
    const level = Number(b.level);
    if (!Number.isInteger(level) || level < 0 || level > 10) fail("Pain level must be 0 to 10.");
    let date = b.date ? text(b.date, "Date", { max: 10 }) : today();
    if (!isDay(date) || date > today()) fail("Date must be today or earlier.");
    const entry = { id: id(), date, area: b.area, level, note: text(b.note, "Note", { max: 500 }), createdAt: new Date().toISOString() };
    // XP is for checking in on the day (or the morning after). An entry for an earlier day is kept in the diary and
    // marked late: lib/rewards.js gives it nothing, so back-filling the past can't be farmed.
    if (date < addDay(today(), -1)) entry.late = true;
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    c.painLog = [...(c.painLog || []), entry].slice(-PAIN_LOG_MAX);
    save(list);
    { const cc = app.get("calendarChanged"); if (cc) cc(c.id, "pain"); } // the member's other devices redraw their calendar
    res.status(201).json(entry);
  });

  me.delete("/pain/:id", (req, res) => {
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    const before = (c.painLog || []).length;
    c.painLog = (c.painLog || []).filter((e) => e.id !== req.params.id);
    if (c.painLog.length === before) return res.status(404).json({ error: "Entry not found." });
    save(list);
    res.json({ ok: true });
  });

  // Completed workouts (from the app's workout generator), with optional performance numbers for comparing sessions
  const optNum = (v, label, lo, hi, dp = 0) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) fail(`${label} must be between ${lo} and ${hi}.`);
    const f = 10 ** dp; return Math.round(n * f) / f;
  };
  // Readings from a watch or strap: one glitchy value (a 260 bpm spike) is dropped, never the whole workout
  const sensor = (v, lo, hi, dp = 0) => { try { return optNum(v, "", lo, hi, dp); } catch { return undefined; } };
  function metricsOf(b) {
    const m = {
      seconds: optNum(b.seconds, "Duration", 1, 18000), hrAvg: sensor(b.hrAvg, 30, 230), hrMax: sensor(b.hrMax, 30, 240),
      hrv: sensor(b.hrv, 5, 300), vo2max: sensor(b.vo2max, 10, 95, 1), rpe: optNum(b.rpe, "Effort (RPE)", 1, 10), calories: sensor(b.calories, 1, 5000),
      source: b.source === undefined ? undefined : text(b.source, "Source", { max: 40 })
    };
    if (b.lifts !== undefined) {
      if (!Array.isArray(b.lifts) || b.lifts.length > 40) fail("Lifts: up to 40.");
      m.lifts = b.lifts.map((l, i) => ({ name: text(l && l.name, `Lift ${i + 1} name`, { min: 1, max: 80 }), weight: optNum(l.weight, `Lift ${i + 1} weight`, 0, 2000, 1), reps: optNum(l.reps, `Lift ${i + 1} reps`, 0, 500) }))
        .filter((l) => l.weight !== undefined || l.reps !== undefined);
    }
    if (b.key !== undefined) m.key = text(b.key, "Workout key", { max: 80 });
    Object.keys(m).forEach((k) => m[k] === undefined && delete m[k]);
    return m;
  }
  me.post("/workouts", (req, res) => {
    const b = req.body || {};
    const minutes = Number(b.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 300) fail("Minutes must be 1 to 300.");
    const exercises = Number(b.exercises || 0);
    if (!Number.isInteger(exercises) || exercises < 0 || exercises > 50) fail("Exercise count is off.");
    const entry = { id: id(), title: text(b.title, "Workout name", { min: 1, max: 80 }), goal: text(b.goal, "Goal", { max: 40 }),
      minutes, exercises, date: today(), completedAt: new Date().toISOString(), ...metricsOf(b) };
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    // What kind of workout this was (custom / challenge / Dr. Jared program / normal) decides its XP; the server checks it
    const kind = classifyWorkout(store, c, entry.key, entry.date);
    entry.kind = kind.kind; if (kind.ref) entry.ref = kind.ref;
    c.workouts = [...(c.workouts || []), entry].slice(-WORKOUT_LOG_MAX);
    save(list);
    { const cc = app.get("calendarChanged"); if (cc) cc(c.id, "workout"); } // logged on the phone app: the open web app shows it too
    res.status(201).json({ workout: entry, stats: workoutStats(c.workouts, today()) });
  });
  // Add or correct numbers after the fact (heart rate from a watch, weights, effort)
  me.patch("/workouts/:id", (req, res) => {
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    const w = (c.workouts || []).find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: "Workout not found." });
    Object.assign(w, metricsOf(req.body || {}));
    save(list);
    res.json(w);
  });

  // Daily readings: resting heart rate, HRV, VO2 max, body weight (from a watch or entered by hand)
  const VITALS_MAX = 1500;
  me.get("/vitals", (req, res) => res.json(req.client.vitals || []));
  function vitalIn(b) {
    if (!b || typeof b !== "object") fail("Each reading needs a date and at least one number.");
    const date = b.date === undefined ? today() : String(b.date);
    if (!isDay(date) || date > today()) fail("Date must be today or earlier (YYYY-MM-DD).");
    const v = { restingHr: optNum(b.restingHr, "Resting heart rate", 25, 150), hrv: optNum(b.hrv, "HRV", 5, 300), vo2max: optNum(b.vo2max, "VO2 max", 10, 95, 1),
      weight: optNum(b.weight, "Body weight", 50, 800, 1), sleep: optNum(b.sleep, "Sleep hours", 0, 24, 1) };
    Object.keys(v).forEach((k) => v[k] === undefined && delete v[k]);
    return { date, v };
  }
  function mergeVitals(c, rows, source) {
    const byDate = new Map((c.vitals || []).map((x) => [x.date, x]));
    // XP is for readings logged on the day or the day after (lib/rewards.js). A day first filled in later than that
    // (a health-app import of past months) is kept and marked late: it earns nothing. Readings added later to a day
    // that was logged on time don't raise what that day already earned (credited = the readings it had by then).
    const floor = addDay(today(), -1), had = (x) => ["weight", "sleep", "restingHr", "hrv", "vo2max"].filter((k) => x[k] !== undefined && x[k] !== null).length;
    rows.forEach(({ date, v }) => {
      const old = byDate.get(date), row = { ...(old || {}), ...v, date, source };
      if (date < floor) { if (!old) row.late = true; else if (!old.late && old.credited === undefined) row.credited = Math.min(2, had(old)); }
      byDate.set(date, row);
    });
    c.vitals = [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1)).slice(-VITALS_MAX);
  }
  me.post("/vitals", (req, res) => {
    const b = req.body || {};
    const r = vitalIn(b);
    if (!Object.keys(r.v).length) fail("Enter at least one reading.");
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    const prev = (c.vitals || []).find((x) => x.date === r.date) || {};
    mergeVitals(c, [r], b.source ? text(b.source, "Source", { max: 40 }) : prev.source || "manual");
    save(list);
    res.status(201).json(c.vitals);
  });
  // Bulk upload from a phone's health store (Apple Health / HealthKit, Health Connect): one row per day, up to 400 days
  me.post("/vitals/batch", (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.readings) || !b.readings.length || b.readings.length > 400) fail("Send 1 to 400 daily readings.");
    const rows = b.readings.map(vitalIn).filter((r) => Object.keys(r.v).length);
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    mergeVitals(c, rows, text(b.source || "Health app", "Source", { max: 40 }));
    save(list);
    res.status(201).json({ saved: rows.length, total: c.vitals.length });
  });

  me.get("/referral", (req, res) => {
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    if (!c.referralCode) {
      let code = generateReferralCode(c.name);
      while (list.some((x) => x.referralCode === code)) code = generateReferralCode(c.name);
      c.referralCode = code;
      save(list);
    }
    const refs = referrals().filter((r) => r.referrerId === c.id);
    const fresh = c.createdAt && Date.now() - Date.parse(c.createdAt) < CLAIM_DAYS * 864e5;
    res.json({ code: c.referralCode, freeUntil: c.freeUntil || null, referrals: Math.max(refs.length, c.referrals || 0), freeMonths: FREE_MONTHS,
      referred: !!(c.referredBy || c.referredPartner), canClaim: !c.referredBy && !c.referredPartner && !!fresh });
  });
  // Someone who signed up without the code (Google, Apple, the app, a link opened in another browser) adds it here,
  // within 30 days of joining, once. The referrer gets the same reward as a sign-up with the code.
  const claimLimit = limiter(10, 60 * 60 * 1000);
  me.post("/referral/claim", (req, res) => {
    if (claimLimit.blocked(req.client.id)) return res.status(429).json({ error: "Too many tries. Try again later." });
    claimLimit.hit(req.client.id);
    const code = String((req.body && req.body.code) || "").trim();
    if (!REF_CODE.test(code)) fail("Enter the referral code you were given.");
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    if (c.referredBy || c.referredPartner) return res.status(409).json({ error: "A referral code is already on your account." });
    if (!c.createdAt || Date.now() - Date.parse(c.createdAt) >= CLAIM_DAYS * 864e5) return res.status(400).json({ error: `Referral codes can be added within ${CLAIM_DAYS} days of joining.` });
    if (!applyReferral(c, code, list, "claim")) return res.status(404).json({ error: "No member has that code. Check it and try again." });
    save(list);
    refEvent({ type: "claim", clientId: c.id, referrerId: c.referredBy });
    activity("referral_claim", { email: c.email });
    res.json({ ok: true, referred: true });
  });
  const pressLimit = limiter(60, 60 * 60 * 1000);
  me.post("/referral/event", (req, res) => {
    const type = req.body && req.body.type;
    // copy: the code itself; copy_link: the sign-up link, copied (computers, no share sheet); share: the phone's share sheet, with the link
    if (type !== "copy" && type !== "copy_link" && type !== "share") fail("Unknown referral event.");
    if (!pressLimit.blocked(req.client.id)) { pressLimit.hit(req.client.id); refEvent({ type, clientId: req.client.id }); }
    res.json({ ok: true });
  });

  me.get("/stats", (req, res) => {
    const log = req.client.workouts || [];
    res.json({ ...workoutStats(log, today()), recent: log.slice(-10).reverse() });
  });

  // Full log, for the calendar
  me.get("/workouts", (req, res) => res.json(req.client.workouts || []));

  // XP, level, badges and daily goal, recomputed from history every time
  const visitsOf = (c) => appointments().filter((a) => owns(c, a) && a.status === "completed");
  // Daily activity checks (lib/habits.js) and challenges sent (lib/custom-workouts.js) count toward XP too
  const xpExtras = () => ({ habits: store.read("habits", []), challenges: store.read("challenges", []) });
  // The clinic day a moment fell on (a visit booked at 8 PM in Sarasota is already tomorrow in UTC)
  const clinicDay = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? "" : nowParts(cfg.tz, new Date(t)).date; };
  const rewardsOf = (c, appts = appointments(), ex = xpExtras()) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], visits: appts.filter((a) => owns(c, a) && a.status === "completed"), vitals: c.vitals || [], actions: c.xpLog || [], banked: c.xpBanked || 0,
    bookings: appts.filter((a) => owns(c, a) && a.status !== "cancelled").map((a) => ({ id: a.id, date: clinicDay(a.createdAt) || String(a.date || "").slice(0, 10) })),
    activities: ((ex.habits.find((d) => d.clientId === c.id) || {}).checks) || [], challengesSent: ex.challenges.filter((x) => x.fromId === c.id).map((x) => ({ date: x.date })) }, today());
  // Ranking pool: anyone with XP, unless they hid themselves. Shows first name + last initial and XP only. Cached a minute.
  // Leagues: the Olympic League starts at 1,250 lifetime XP (owner); everyone below plays in the Pro League
  const OLYMPIC_LEVEL = 4, OLYMPIC_XP = levelStart(OLYMPIC_LEVEL); // Olympic League opens with the 4th gem (Emerald), wherever the owner's ladder puts it
  const leagueOf = (xp) => (xp >= OLYMPIC_XP ? "olympic" : "pro");
  let board = { at: 0, rows: [] };
  const gemOf = (xp) => { const g = gemstoneOf(xp).current; return { id: g.id, name: g.name, color: g.color }; };
  // "#N overall": rank by lifetime XP among real members who show on the leaderboard (practice pacers don't count).
  // Works for a hidden member too (their own rank, privately). The member's own XP is always fresh.
  const overallOf = (c, myXp) => {
    const others = boardRows().filter((x) => !x.pacer && x.id !== c.id);
    return { rank: 1 + others.filter((x) => x.xp > myXp).length, total: others.length + 1, hidden: !!c.hideRank };
  };
  // Pacers: labeled practice competitors that fill a league until 9 real members join. Turn off with LEADERBOARD_PACERS=off.
  const PACER_NAMES = ["Sarah K.", "Mike R.", "Jess T.", "Carlos M.", "Ashley W.", "Dan P.", "Megan L.", "Chris B.", "Nina S.", "Tyler H.", "Rachel D.", "Marcus J.", "Lauren G.", "Kevin O.", "Brittany F.", "Jason C.", "Amanda V.", "Ryan N.", "Olivia E.", "Derek A."];
  const seeded = (str) => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; };
  const pacers = (league, realCount) => {
    if (String(process.env.LEADERBOARD_PACERS || "on").toLowerCase() === "off") return [];
    const n = Math.max(0, 9 - realCount); if (!n) return [];
    const d = today(), dow = (new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7, monday = new Date(Date.parse(d + "T12:00:00Z") - dow * 864e5).toISOString().slice(0, 10);
    const hour = Number(nowParts(cfg.tz, clock()).time?.slice(0, 2)) || 12;
    const progress = Math.min(1, (dow + hour / 24) / 7);
    const names = PACER_NAMES.slice(league === "olympic" ? 10 : 0).concat(PACER_NAMES.slice(0, league === "olympic" ? 10 : 0));
    return names.slice(0, n).map((name, i) => {
      const r = seeded(`${league}|${monday}|${name}`), base = seeded(`${league}|${name}`);
      const weekTarget = league === "olympic" ? 150 + r() * 450 : 40 + r() * 220;
      const curve = Math.pow(progress, 0.8 + r() * 0.6);
      const week = Math.round(weekTarget * curve);
      const level = league === "olympic" ? OLYMPIC_LEVEL + Math.floor(base() * 3) : 1 + Math.floor(base() * (OLYMPIC_LEVEL - 1));
      const xp = Math.max(week, levelStart(level) + Math.round(base() * (levelStart(level + 1) - levelStart(level) - 1)));
      // Today and this month follow the same pace: a share of the week by the hour, and the month so far
      const dayOfMonth = Number(d.slice(8, 10));
      const rd = seeded(`${league}|${d}|${name}`), rm = seeded(`${league}|${d.slice(0, 7)}|${name}`);
      const day = Math.round((weekTarget / 7) * (0.4 + rd() * 1.2) * Math.min(1, hour / 20));
      const month = Math.round((weekTarget / 7) * (0.7 + rm() * 0.6) * (dayOfMonth - 1 + Math.min(1, hour / 20)));
      return { id: `pacer-${league}-${i}`, name, xp, week, day, month, level, gem: gemOf(xp), league, pacer: true };
    });
  };
  const boardRows = (fresh = false) => {
    // Cached a minute, but recomputed at once when anyone's history changes (a workout, an activity, a challenge...)
    const appts = appointments(), ex = xpExtras(), list = clients();
    const sum = (f) => list.reduce((n, c) => n + f(c), 0);
    // (closed accounts are counted too, so a member who closes their account leaves the board at once, not a minute later)
    const stamp = [list.length, sum((c) => (c.workouts || []).length), sum((c) => (c.painLog || []).length), sum((c) => (c.vitals || []).length), sum((c) => (c.xpLog || []).length),
      ex.habits.reduce((n, d) => n + (d.checks || []).length, 0), ex.challenges.length, appts.length, sum((c) => (c.deletedAt ? 1 : 0)), today()].join("|");
    if (!fresh && board.stamp === stamp && Date.now() - board.at < 60000) return board.rows;
    // A closed account keeps its record for the chart, but it is nobody's to rank: it is left off the board
    const rows = clients().filter((c) => !c.hideRank && !c.deletedAt).map((c) => {
      const r = rewardsOf(c, appts, ex), parts = String(c.name || "Member").trim().split(/\s+/);
      return { id: c.id, name: parts[0] + (parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : ""), xp: r.xp, week: r.week.reduce((n, d) => n + d.xp, 0), day: r.todayXp, month: r.monthXp, level: r.level, gem: gemOf(r.xp), league: leagueOf(r.xp) };
    }).filter((x) => x.xp > 0);
    for (const lg of ["pro", "olympic"]) rows.push(...pacers(lg, rows.filter((x) => x.league === lg).length));
    board = { at: Date.now(), rows, stamp };
    return rows;
  };
  me.get("/leaderboard", (req, res) => {
    // Periods: day (resets at midnight, clinic time), week (Monday), month (the 1st), all (lifetime XP)
    const PERIODS = { day: "day", week: "week", month: "month", all: "xp" };
    const period = PERIODS[req.query.period] ? req.query.period : "week", by = PERIODS[period];
    const mine = leagueOf(rewardsOf(req.client).xp);
    // league=all: the overall ranking across both leagues, real members only (what "#N overall" on Home refers to)
    const league = ["pro", "olympic", "all"].includes(req.query.league) ? req.query.league : mine;
    const rows = boardRows().filter((x) => (league === "all" ? !x.pacer : x.league === league) && x[by] > 0).sort((a, b) => b[by] - a[by] || b.xp - a.xp);
    const top = rows.slice(0, league === "all" ? 25 : 10).map((x, i) => ({ rank: i + 1, name: x.name, score: x[by], level: x.level, gem: x.gem, me: x.id === req.client.id }));
    const i = rows.findIndex((x) => x.id === req.client.id);
    const d = today(), y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
    const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
    const resetsOn = period === "day" ? addDays(d, 1) : period === "week" ? addDays(d, 7 - ((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7)) : period === "month" ? `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01` : null;
    res.json({ league, myLeague: mine, olympicLevel: OLYMPIC_LEVEL, olympicXp: OLYMPIC_XP, olympicGem: GEMS[OLYMPIC_LEVEL - 1].name, period, total: rows.length, top, me: i < 0 ? null : { rank: i + 1, score: rows[i][by] }, hidden: !!req.client.hideRank, resetsOn, tz: cfg.tz });
  });
  me.put("/leaderboard/visibility", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.hideRank = !!(req.body && req.body.hidden); save(list); board.at = 0;
    res.json({ hidden: c.hideRank });
  });
  // The first descent: a new member's tutorial, five stops worth 10 XP each, once ever. It is offered to someone with
  // no workouts yet (or who has started it, or asked to replay it) until they finish or skip it. Three of the stops are
  // things the server can see for itself, so those must be true before they pay out.
  // ---- "Let me get to know you" (owner, Nov 2026: "history v goal"): where the member has been and where they want to
  // go, told to Solomon in a few taps and kept on the account. Every answer is one of the listed choices (nothing typed
  // is stored), and each can be left out. Also kept here: the pain tracks the member put on their road.
  const KNOW = { athlete: ["comp", "fun", "no"], diet: ["none", "protein", "plant", "lowcarb", "mediterranean", "better"],
    aim: ["pain", "stronger", "weight", "move", "sport"] };
  // competitive: how competitive they rate themselves, 1 to 10 (0 = not said)
  const KNOW_MANY = { sports: ["football", "basketball", "baseball", "soccer", "tennis", "pickleball", "golf", "running", "swimming", "volleyball", "wrestling", "martial", "gymnastics", "cheer", "dance",
    "hockey", "lacrosse", "cycling", "rowing", "lifting", "skiing", "surfing", "climbing", "chess", "other"], foods: ["meat", "seafood", "pasta", "veg", "fruit", "sweets", "fastfood", "homecooked"], free: ["outdoors", "sports", "family", "friends", "games", "reading", "travel", "cooking", "music", "tv"] };
  const aboutOf = (c) => { const a = (c && c.about) || {}, o = {};
    for (const k of Object.keys(KNOW)) o[k] = KNOW[k].includes(a[k]) ? a[k] : "";
    for (const k of Object.keys(KNOW_MANY)) o[k] = (Array.isArray(a[k]) ? a[k] : []).filter((x) => KNOW_MANY[k].includes(x));
    const n = Math.round(Number(a.competitive)); o.competitive = n >= 1 && n <= 10 ? n : 0;
    return { ...o, at: a.at || "", known: !!a.at }; };
  const TRACK_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
  const roadTracks = (c) => (Array.isArray(c && c.roadTracks) ? c.roadTracks : []).filter((x) => TRACK_ID.test(String(x))).slice(-10);
  // Pain tracks (the app's paintracks.js, plus tracks the owner saved in the workspace) and Pain Tool protocols
  const painIds = () => ({ track: new Set([...PAIN_TRACKS, ...(((store.read("content", {}) || {}).tracks) || []).map((t) => t && t.id).filter(Boolean)]), protocol: PAIN_PROTOCOLS });
  const assignedPain = (c) => (Array.isArray(c && c.assignedPain) ? c.assignedPain : []).filter((x) => x && (x.kind === "track" || x.kind === "protocol") && TRACK_ID.test(String(x.id)));
  // Everything pain-rehab on the client's dashboard, for the chart: what Dr. Jared prescribed, the tracks they put on
  // their road themselves, and any track or protocol they have done, each with its sessions and last date.
  function painWork(c) {
    const items = new Map(), at = (kind, id) => { const k = `${kind}:${id}`; if (!items.has(k)) items.set(k, { kind, id, prescribed: false, onRoad: false, note: "", assignedAt: null, sessions: 0, last: null }); return items.get(k); };
    for (const x of assignedPain(c)) Object.assign(at(x.kind, x.id), { prescribed: true, note: x.note || "", assignedAt: x.assignedAt || null });
    for (const id of roadTracks(c)) at("track", id).onRoad = true;
    for (const w of c.workouts || []) {
      const m = String(w.key || "").match(/^(track|painproto)-([a-z0-9][a-z0-9-]{0,60})$/); if (!m) continue;
      const it = at(m[1] === "track" ? "track" : "protocol", m[2]); it.sessions++; if (!it.last || String(w.date) > it.last) it.last = w.date;
    }
    // Pain Tool protocols saved to My Programs keep only their name ("<Muscle> protocol")
    const saved = (c.programs || []).filter((p) => / protocol$/i.test(String(p.name || ""))).map((p) => ({ name: p.name, savedAt: p.createdAt || null }));
    return { items: [...items.values()].sort((a, b) => (b.prescribed - a.prescribed) || (b.onRoad - a.onRoad) || String(b.last || "").localeCompare(String(a.last || ""))), savedProtocols: saved };
  }
  // The program on the member's road and the day they chose to start it (the app lays its sessions on the calendar from there)
  const roadPlan = (c) => { const r = (c && c.roadPlan) || {}; return /^[a-z0-9][a-z0-9-]{0,79}$/.test(String(r.program || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.start || "")) ? { program: r.program, start: r.start } : null; };
  // Days the member skipped the session on their road (no XP; the session waits for the next training day). Two weeks kept.
  const roadSkips = (c) => (Array.isArray(c && c.roadSkips) ? c.roadSkips : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).slice(-14);
  const INTRO = ["solomon", "know", "pain", "program", "session", "friend"];
  // Start over (Profile, behind the password): the tutorial and the road begin again from that moment. What was done
  // before it (workouts, check-ins, XP) is kept but no longer ticks a stop; the stops are done again in introRedo,
  // and only a stop never paid before earns XP the second time round.
  const afterReset = (c, t) => !c.introResetAt || String(t || "") > c.introResetAt;
  const introOf = (c) => {
    const got = new Set(c.introResetAt ? (c.introRedo || []).filter((k) => INTRO.includes(k)) : (c.xpLog || []).filter((x) => x.kind === "intro").map((x) => x.ref));
    // A stop can be passed over (no XP) so nobody is held up by one they can't do yet; doing it later still pays
    const passed = new Set((c.introPassed || []).filter((k) => INTRO.includes(k)));
    const steps = Object.fromEntries(INTRO.map((k) => [k, got.has(k) ? true : passed.has(k) ? "skipped" : false])), done = INTRO.every((k) => got.has(k) || passed.has(k));
    return { steps, done, skipped: !!c.introSkipped, offered: !c.introSkipped && !done && (!(c.workouts || []).length || got.size > 0 || !!c.introReplay), ...(c.introResetAt ? { since: c.introResetAt } : {}) };
  };
  const introTrue = (c, ref) => (ref === "pain" ? (c.painLog || []).some((x) => afterReset(c, x.createdAt)) : ref === "session" ? (c.workouts || []).some((x) => afterReset(c, x.completedAt || x.date))
    : ref === "program" ? (c.assignedPrograms || []).length > 0 || (c.introResetAt ? !!roadPlan(c) : (c.pinnedPrograms || []).length > 0) : ref === "know" ? !!(c.about && c.about.at) : true);
  me.get("/about", (req, res) => { const c = clients().find((x) => x.id === req.client.id) || req.client; res.set("Cache-Control", "no-store"); res.json({ about: aboutOf(c), tracks: roadTracks(c), plan: roadPlan(c), skips: roadSkips(c) }); });
  // Only today can be skipped, and taken back
  me.put("/about/skip/:date", (req, res) => {
    if (String(req.params.date) !== today()) fail("Only today's session can be skipped.");
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.roadSkips = [...new Set([...roadSkips(c), today()])].slice(-14); save(list);
    res.json({ skips: roadSkips(c) });
  });
  me.delete("/about/skip/:date", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.roadSkips = roadSkips(c).filter((d) => d !== String(req.params.date)); save(list);
    res.json({ skips: roadSkips(c) });
  });
  me.put("/about/plan", (req, res) => {
    const b = req.body || {}, program = String(b.program || ""), start = String(b.start || ""), d = today();
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(program) || !programIds().has(program)) fail("Unknown program.");
    const far = new Date(Date.parse(d + "T12:00:00Z") + 60 * 864e5).toISOString().slice(0, 10), back = new Date(Date.parse(d + "T12:00:00Z") - 60 * 864e5).toISOString().slice(0, 10);
    if (!isDay(start) || start > far || start < back) fail("Pick a start date within the next two months.");
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.roadPlan = { program, start }; save(list);
    res.json({ plan: roadPlan(c) });
  });
  // The answers given so far (any subset); sending it marks the conversation as had, so the stop is credited even when
  // every question was skipped
  me.put("/about", (req, res) => {
    const b = req.body || {}, list = clients(), c = list.find((x) => x.id === req.client.id), a = { ...(c.about || {}) };
    for (const k of Object.keys(KNOW)) if (b[k] !== undefined) { if (b[k] !== "" && !KNOW[k].includes(b[k])) fail(`Pick one of the choices for ${k}.`); a[k] = b[k]; }
    for (const k of Object.keys(KNOW_MANY)) if (b[k] !== undefined) { if (!Array.isArray(b[k]) || b[k].some((x) => !KNOW_MANY[k].includes(x))) fail(`Pick from the choices for ${k}.`); a[k] = [...new Set(b[k])].slice(0, 6); }
    if (b.competitive !== undefined) { const n = Number(b.competitive); if (!Number.isInteger(n) || n < 0 || n > 10) fail("Competitiveness is a number from 1 to 10."); a.competitive = n; }
    a.at = new Date(clock()).toISOString(); c.about = a; save(list);
    res.json({ about: aboutOf(c), tracks: roadTracks(c), intro: introOf(c) });
  });
  me.put("/about/tracks/:id", (req, res) => {
    const id = String(req.params.id || ""); if (!TRACK_ID.test(id)) fail("Unknown track.");
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.roadTracks = [...roadTracks(c).filter((x) => x !== id), id].slice(-10); save(list);
    res.json({ tracks: roadTracks(c) });
  });
  me.delete("/about/tracks/:id", (req, res) => {
    const id = String(req.params.id || ""), list = clients(), c = list.find((x) => x.id === req.client.id);
    c.roadTracks = roadTracks(c).filter((x) => x !== id); save(list);
    res.json({ tracks: roadTracks(c) });
  });
  // Start over from the intro: the tutorial, the get-to-know-you answers and the road (program, its start date, pain
  // tracks, skipped days). History, XP, gems, streaks, badges, membership and care are kept. The member's password
  // confirms it; an account with no password (Google, Apple) types RESET.
  const startOverTries = limiter(10, 60 * 60 * 1000);
  me.post("/start-over", (req, res) => {
    const b = req.body || {}, list = clients(), c = list.find((x) => x.id === req.client.id);
    if (!c) return res.status(404).json({ error: "Account not found." });
    if (startOverTries.blocked(c.id)) return res.status(429).json({ error: "Too many tries. Try again in an hour." });
    if (c.passwordHash) { if (!verifyPassword(typed(b.password, "Type your password to confirm."), c.passwordHash)) { startOverTries.hit(c.id); return res.status(403).json({ error: "That password is not right." }); } } // (403, not 401: the app treats 401 as signed out)
    else if (typed(b.confirm, "Type RESET to confirm.").trim().toUpperCase() !== "RESET") return res.status(400).json({ error: "Type RESET to confirm." });
    // The member's own pain tracks leave the road; a track Dr. Jared prescribed stays on it, as his prescription does
    const prescribed = new Set(assignedPain(c).filter((x) => x.kind === "track").map((x) => x.id));
    delete c.about; delete c.roadPlan; c.roadTracks = roadTracks(c).filter((x) => prescribed.has(x)); c.roadSkips = [];
    c.introPassed = []; c.introSkipped = false; c.introReplay = true; c.introRedo = []; c.introResetAt = new Date().toISOString(); // (the same clock check-ins and workouts are stamped with)
    save(list);
    logger.info("start_over", { clientId: c.id });
    res.json({ ok: true, intro: introOf(c) });
  });
  me.get("/intro", (req, res) => res.json(introOf(clients().find((x) => x.id === req.client.id) || req.client)));
  me.post("/intro/skip", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    const one = String((req.body || {}).ref || "");
    if (one) { if (!INTRO.includes(one)) return res.status(400).json({ error: "Unknown stop." }); c.introPassed = [...new Set([...(c.introPassed || []), one])]; }
    else if ((req.body || {}).skip === false) { c.introSkipped = false; c.introReplay = true; c.introPassed = []; } else c.introSkipped = true;
    save(list); res.json(introOf(c));
  });
  // For Solomon's greeting on the first opening of a day ("missed you yesterday", "earlier than usual"): how many days
  // since the member was last here before today (a workout, a check-in, an app session or an opening), the hour they
  // usually train, and the hour it is now at the practice. Dates and hours only: nothing from their record.
  function arrival(c, d) {
    const hourAt = (when) => { const h = Number(String(nowParts(cfg.tz, new Date(when)).time || "").slice(0, 2)); return Number.isFinite(h) ? h : null; };
    let last = "";
    const seen = (x) => { if (x && x < d && x > last) last = x; };
    for (const w of c.workouts || []) seen(w && w.date);
    for (const q of c.painLog || []) seen(q && q.date);
    for (const x of c.xpLog || []) seen(x && x.date);
    for (const [k, v] of Object.entries((((store.read("presence", {}) || {})[c.id]) || {}).days || {})) if (v && v.sessions > 0) seen(k);
    const floor = new Date(Date.parse(d + "T12:00:00Z") - 30 * 864e5).toISOString().slice(0, 10), hours = [];
    for (const w of c.workouts || []) if (w && w.date >= floor && w.date < d && w.completedAt) hours.push(hourAt(w.completedAt));
    for (const q of c.painLog || []) if (q && q.date >= floor && q.date < d && q.createdAt) hours.push(hourAt(q.createdAt));
    const hs = hours.filter((h) => h !== null).sort((x, y) => x - y);
    return { away: last ? Math.round((Date.parse(d + "T12:00:00Z") - Date.parse(last + "T12:00:00Z")) / 864e5) : null,
      usual: hs.length >= 3 ? hs[Math.floor(hs.length / 2)] : null, hour: hourAt(clock()) };
  }
  // The action log holds about XP_LOG_MAX entries. Older days are dropped whole, and what they had earned is banked on
  // the account (xpBanked, added to lifetime XP by lib/rewards.js), so XP never goes down when the log is trimmed. The
  // first-descent stops are never dropped: each pays once ever, and the log is where "already paid" is read from.
  const XP_LOG_MAX = 3000;
  function logXp(c, entry) {
    const log = [...(c.xpLog || []), entry];
    if (log.length > XP_LOG_MAX) {
      const from = log.map((x) => String(x.date)).sort()[log.length - XP_LOG_MAX], old = (x) => x.kind !== "intro" && String(x.date) < from;
      const earn = actionLedger();
      c.xpBanked = (c.xpBanked || 0) + log.filter(old).reduce((n, x) => n + earn(x.date, x.kind, x.ref), 0);
      c.xpLog = log.filter((x) => !old(x));
    } else c.xpLog = log;
  }
  me.post("/xp", (req, res) => {
    const kind = String((req.body || {}).kind || ""), ref = String((req.body || {}).ref || "").slice(0, 80);
    if (!ACTIONS[kind] || kind === "booking") return res.status(400).json({ error: "Unknown action." });
    const list = clients(), c = list.find((x) => x.id === req.client.id), d = today();
    if (kind === "intro") {
      if (!INTRO.includes(ref)) return res.status(400).json({ error: "Unknown stop." });
      if (!introTrue(c, ref)) return res.status(409).json({ error: "That stop isn't done yet." });
      const paid = (c.xpLog || []).some((x) => x.kind === "intro" && x.ref === ref);
      if (c.introResetAt) { // the second time round: the stop is ticked again; XP only for one never paid before
        const again = (c.introRedo || []).includes(ref);
        if (!again) { c.introRedo = [...(c.introRedo || []), ref]; if (!paid) logXp(c, { date: d, kind, ref }); save(list); }
        return res.json({ ok: true, first: !again, xp: again || paid ? 0 : ACTIONS.intro.xp, intro: introOf(c) });
      }
      if (!paid) { logXp(c, { date: d, kind, ref }); save(list); }
      return res.json({ ok: true, first: !paid, xp: paid ? 0 : ACTIONS.intro.xp, intro: introOf(c) });
    }
    const mine = (c.xpLog || []).filter((x) => x.date === d && x.kind === kind), before = mine.length;
    // What this one earns is asked of the same ledger lib/rewards.js totals with (the day's cap; the same item again
    // counts once), so the answer here and the XP on the account always agree
    const earn = actionLedger(); for (const x of mine) earn(x.date, x.kind, x.ref);
    const xp = earn(d, kind, ref), again = !!ref && mine.some((x) => x.ref === ref);
    // The same item again today is not written down a second time: repeats must not use up the room the day's log has
    if (!again && before < ACTIONS[kind].cap * 3) { logXp(c, { date: d, kind, ref }); save(list); }
    // first: this is the first of its kind today, so the app celebrates it once ("Welcome back +5 XP"), on one device
    let arrive; if (kind === "open" && before === 0) { try { arrive = arrival(c, d); } catch { /* the greeting falls back to a plain one */ } }
    res.json({ ok: true, first: before === 0, xp, ...(arrive ? { arrive } : {}) });
  });
  me.get("/rewards", (req, res) => {
    const c = req.client;
    const r = rewardsOf(c);
    const rep = repairsFrom(c.workouts || [], c.repairsUsed || []);
    res.json({ ...r, repairs: rep, overall: overallOf(c, r.xp), olympicLevel: OLYMPIC_LEVEL });
  });

  // Streak repairs: 1 token earned per 3 consecutive qualifying days. Applying one to a missed
  // date keeps the visual streak intact without altering real activity history (actual workout
  // dates are preserved; the repair list is stored separately so the streak renderer can bridge gaps).
  me.post("/repair-streak", (req, res) => {
    const date = String((req.body && req.body.date) || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Which day would you like to repair?");
    if (date > today()) fail("You can only repair past days.");
    const list = clients(); const c = list.find((x) => x.id === req.client.id);
    const used = c.repairsUsed || [];
    if (used.includes(date)) fail("That day is already repaired.");
    const rep = repairsFrom(c.workouts || [], used);
    if (rep.available < 1) fail("You don't have any repair tokens available yet. Finish 3 days in a row to earn one.");
    c.repairsUsed = [...used, date].sort();
    save(list);
    res.json({ ok: true, repairs: repairsFrom(c.workouts || [], c.repairsUsed) });
  });

  // ---- Library (Spotify-style): favorite videos and saved programs, kept on the server so they follow the client
  const update = (req, fn) => { const list = clients(); const c = list.find((x) => x.id === req.client.id); const out = fn(c); save(list); return out; };
  const libraryOf = (c) => ({ favorites: c.favorites || [], programs: c.programs || [] });
  me.get("/library", (req, res) => res.json(libraryOf(req.client)));

  me.put("/favorites/:id", (req, res) => {
    if (!ID_RE.test(req.params.id)) fail("That video id isn't valid.");
    res.json(update(req, (c) => {
      const f = (c.favorites || []).filter((x) => x !== req.params.id);
      if (f.length >= FAVORITES_MAX) fail(`You can keep up to ${FAVORITES_MAX} favorites.`);
      c.favorites = [req.params.id, ...f];
      return libraryOf(c);
    }));
  });
  me.delete("/favorites/:id", (req, res) => res.json(update(req, (c) => { c.favorites = (c.favorites || []).filter((x) => x !== req.params.id); return libraryOf(c); })));

  // A program is a saved workout: name + the generator settings + the exact exercises (ids, prescriptions)
  function programInput(b) {
    if (!b || typeof b !== "object") fail("Program is missing.");
    const w = b.workout;
    if (!w || typeof w !== "object") fail("Workout is missing.");
    const ex = (arr, label) => {
      if (!Array.isArray(arr) || arr.length > 20) fail(`${label} list is off.`);
      return arr.map((e) => {
        if (!e || !ID_RE.test(e.id)) fail("Exercise id isn't valid.");
        return { id: e.id, sets: text(e.sets, "Sets", { max: 60 }) }; // the generator's own lines run past 30 ("3 × 10 slow reps (pause at the top)")
      });
    };
    const num = (v, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail("Workout settings are off."); return n; };
    return {
      name: text(b.name, "Program name", { min: 1, max: 60 }),
      workout: {
        title: text(w.title, "Title", { min: 1, max: 80 }), goal: text(w.goal, "Goal", { max: 40 }), goalId: text(w.goalId, "Goal", { max: 20 }),
        location: text(w.location, "Location", { max: 20 }), level: text(w.level, "Level", { max: 20 }), levelLabel: text(w.levelLabel, "Level", { max: 20 }),
        rounds: num(w.rounds, 1, 10), restEx: num(w.restEx, 0, 300), restRound: num(w.restRound, 0, 600), minutes: num(w.minutes, 1, 300),
        warmup: ex(w.warmup || [], "Warm-up"), circuit: ex(w.circuit || [], "Circuit"), cooldown: ex(w.cooldown || [], "Cool-down")
      }
    };
  }
  const isMember = (c) => !!activeMembership(c);
  me.get("/access", (req, res) => {
    const c = req.client, m = activeMembership(c);
    res.json({ member: true, tier: m ? m.tier : null, freeUsed: false, freeLeft: null, reviewCode: null });
  });
  me.post("/generations", (req, res) => {
    res.json({ member: true });
  });
  me.post("/programs", (req, res) => {
    const p = programInput(req.body);
    res.status(201).json(update(req, (c) => {
      if ((c.programs || []).length >= PROGRAMS_MAX) fail(`You can save up to ${PROGRAMS_MAX} programs. Delete one first.`);
      c.programs = [{ id: id(), ...p, createdAt: new Date().toISOString() }, ...(c.programs || [])];
      return libraryOf(c);
    }));
  });
  me.delete("/programs/:id", (req, res) => res.json(update(req, (c) => {
    const before = (c.programs || []).length;
    c.programs = (c.programs || []).filter((x) => x.id !== req.params.id);
    if (c.programs.length === before) fail("Program not found.");
    return libraryOf(c);
  })));

  // Save a program to the dashboard (Home shows saved programs next to the ones Dr. Jared assigned)
  const programIds = () => new Set(require("./content").programsOf(store.read("content", {})).map((p) => p.id)); // same list the app shows
  me.put("/pinned/:programId", (req, res) => res.json(update(req, (c) => {
    if (!programIds().has(req.params.programId)) fail("Program not found.");
    const list = (c.pinnedPrograms || []).filter((x) => x !== req.params.programId);
    if (list.length >= 12) fail("You can save up to 12 programs to your dashboard. Remove one first.");
    c.pinnedPrograms = [req.params.programId, ...list];
    return { pinnedPrograms: c.pinnedPrograms };
  })));
  me.delete("/pinned/:programId", (req, res) => res.json(update(req, (c) => {
    c.pinnedPrograms = (c.pinnedPrograms || []).filter((x) => x !== req.params.programId);
    return { pinnedPrograms: c.pinnedPrograms };
  })));

  const visitLimit = limiter(30, 60 * 60 * 1000);
  app.post("/api/referral/visit", (req, res) => {
    const code = String((req.body && req.body.code) || "").trim();
    if (REF_CODE.test(code) && !visitLimit.blocked(req.ip)) {
      visitLimit.hit(req.ip);
      const ps = app.get("partnerShare");
      refEvent({ type: "visit", code: code.toUpperCase(), matched: !!ownerOf(code, clients()) || !!(ps && ps.partnerByCode(code)) });
    }
    res.json({ ok: true });
  });
  app.use("/api/me", me);

  // ================= Admin: clients =================
  // Referral sign-ups for Insights. Rebuilt from the accounts themselves (referredBy + createdAt), so sign-ups from
  // before the ledger existed are counted too; nothing depends on a log that may have aged out.
  admin.get("/referrals", (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const since = new Date(clock().getTime() - days * 86_400_000).toISOString();
    const list = clients(), byId = new Map(list.map((c) => [c.id, c]));
    const short = (c) => c ? (c.name || "Member") : "Deleted account";
    const signups = list.filter((c) => c.referredBy).map((c) => ({ at: c.createdAt || null, clientId: c.id, name: short(c),
      referrerId: c.referredBy, referrer: short(byId.get(c.referredBy)), member: !!activeMembership(c), via: c.referredVia || "before tracking" }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const inRange = signups.filter((x) => x.at && x.at >= since);
    const perDay = {}, top = {};
    for (const x of inRange) perDay[x.at.slice(0, 10)] = (perDay[x.at.slice(0, 10)] || 0) + 1;
    for (const x of signups) { const r = (top[x.referrerId] = top[x.referrerId] || { referrerId: x.referrerId, referrer: x.referrer, total: 0, inRange: 0, lastAt: null }); r.total++; if (x.at && x.at >= since) r.inRange++; if (!r.lastAt || String(x.at) > r.lastAt) r.lastAt = x.at; }
    const newAccounts = list.filter((c) => c.createdAt && c.createdAt >= since).length;
    // What happened around the sign-ups: link visits per code, Copy and Share presses per member, codes that matched
    // nobody, and codes added after signing up. Recorded from Nov 2026; nothing earlier was ever recorded.
    const ev = refEvents(), evIn = ev.filter((e) => e.ts >= since);
    const byCode = new Map(list.filter((c) => c.referralCode).map((c) => [String(c.referralCode).toUpperCase(), c]));
    const presses = {};
    for (const e of ev) {
      const who = e.type === "visit" ? byCode.get(String(e.code || "").toUpperCase()) : (e.type === "copy" || e.type === "copy_link" || e.type === "share") ? byId.get(e.clientId) : null;
      if (!who) continue;
      const r = (presses[who.id] = presses[who.id] || { memberId: who.id, member: short(who), copies: 0, linkCopies: 0, shares: 0, linkVisits: 0, lastAt: null });
      if (e.type === "copy") r.copies++; else if (e.type === "copy_link") r.linkCopies++; else if (e.type === "share") r.shares++; else r.linkVisits++;
      if (!r.lastAt || e.ts > r.lastAt) r.lastAt = e.ts;
    }
    const count = (t) => evIn.filter((e) => e.type === t).length;
    const events = { since: ev.length ? ev[0].ts : null,
      totals: { copies: count("copy"), linkCopies: count("copy_link"), shares: count("share"), linkVisits: count("visit"), linkVisitsUnknownCode: evIn.filter((e) => e.type === "visit" && !e.matched).length, unmatchedCodes: count("unmatched"), claims: count("claim") },
      members: Object.values(presses).sort((a, b) => (b.copies + b.linkCopies + b.shares + b.linkVisits) - (a.copies + a.linkCopies + a.shares + a.linkVisits)),
      unmatched: ev.filter((e) => e.type === "unmatched").slice(-100).reverse().map((e) => ({ at: e.ts, code: e.code, via: e.via || "", name: short(byId.get(e.clientId)) })) };
    res.json({ days, events, totals: { referred: inRange.length, referredAllTime: signups.length, newAccounts,
        share: newAccounts ? Math.round(inRange.length / newAccounts * 1000) / 10 : 0, referrers: Object.keys(top).length,
        becameMembers: inRange.filter((x) => x.member).length },
      perDay: Object.entries(perDay).sort().map(([date, count]) => ({ date, count })),
      topReferrers: Object.values(top).sort((a, b) => b.total - a.total), recent: signups });
  });

  admin.get("/clients", (req, res) => {
    const t = today(), appts = appointments();
    // Activity in the last 30 days: distinct days with a workout, a pain check-in or a daily activity check-in
    const habitDocs = new Map(store.read("habits", []).map((d) => [d.clientId, d]));
    const since = new Date(Date.parse(t + "T12:00:00Z") - 29 * 864e5).toISOString().slice(0, 10);
    const active30 = (c) => new Set([...(c.workouts || []), ...(c.painLog || []), ...(((habitDocs.get(c.id) || {}).checks) || [])].map((x) => x && x.date).filter((d) => d && d >= since && d <= t)).size;
    // The time-in-app store is read once for the whole list and each client looked up in that copy: reading it again
    // for every client parsed the whole file once per row
    const pres = req.app.get("presenceApi"), presAll = pres ? pres.all() : null;
    res.json(clients().map((c) => {
      const mine = appts.filter((a) => !!c.email && a.email === c.email);
      const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
      const last = (c.painLog || []).slice(-1)[0];
      return { id: c.id, name: c.name, email: c.email, emailVerified: verified(c), phone: c.phone, createdAt: c.createdAt, lastLoginAt: c.lastLoginAt, active30: active30(c), minutes30: pres ? pres.minutesIn(c.id, t, 30, presAll) : 0,
        visits: mine.filter((a) => a.status === "completed").length, next: next ? { date: next.date, time: next.time, typeName: next.typeName } : null,
        lastPain: last ? { date: last.date, area: last.area, level: last.level } : null, hasPlan: Boolean(c.plan && ((c.plan.guides || []).length || (c.plan.exercises || []).length || c.plan.notes)), membership: activeMembership(c), requestedTier: (c.membershipRequest && c.membershipRequest.tier) || "", clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient",
        documents: (({ total, done, complete }) => ({ total, done, complete }))(patientStatus(c, visitDocs(c, appts))) };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });

  admin.get("/clients/:id", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json({ ...pub(c), lastLoginAt: c.lastLoginAt, painLog: c.painLog || [], documents: patientStatus(c, visitDocs(c, appointments())),
      programProgress: programProgress(c.assignedPrograms, c.workouts), programHistory: c.programHistory || [], painWork: painWork(c),
      workouts: (c.workouts || []).slice(-50).reverse(), stats: workoutStats(c.workouts || [], today()),
      rewards: (({ xp, level, title, badges, rank }) => ({ xp, level, title, gem: { name: rank.current.name, color: rank.current.color }, overall: overallOf(c, xp), badges: badges.filter((b) => b.earned).map((b) => b.title) }))(rewardsOf(c)),
      appointments: appointments().filter((a) => !!c.email && a.email === c.email).map(({ cancelToken, ...a }) => a).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)) });
  });

  // Admin → Clients → tap a client: everything about them in one response for the overview pop-up
  // (data-collection month, owner): identity, membership, XP, streaks, daily activities, workouts by kind, programs,
  // challenges, favorites, pain log, visits, documents and the day-by-day activity series.
  admin.get("/clients/:id/overview", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const t = today(), appts = appointments(), hab = req.app.get("habitsApi"), pres = req.app.get("presenceApi"), ex = xpExtras();
    const rw = rewardsOf(c, appts, ex), m = activeMembership(c);
    const mine = appts.filter((a) => !!c.email && a.email === c.email).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
    const nApp = (st) => mine.filter((a) => a.status === st).length;
    const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
    const ws = c.workouts || [], monthStart = t.slice(0, 8) + "01";
    const byKind = { program: 0, custom: 0, challenge: 0, normal: 0 };
    for (const w of ws) byKind[workoutKind(w)] = (byKind[workoutKind(w)] || 0) + 1;
    const programs = require("./content").programsOf(store.read("content", {})), pname = (id) => { const p = programs.find((x) => x.id === id); return p ? p.title : id; };
    const prog = programProgress(c.assignedPrograms, ws);
    const ch = ex.challenges, sent = ch.filter((x) => x.fromId === c.id), got = ch.filter((x) => x.toId === c.id);
    const pain = c.painLog || [], lastP = pain[pain.length - 1], prevP = pain[pain.length - 2];
    const docs = patientStatus(c, visitDocs(c, appts));
    let habits = null; try { habits = hab ? hab.summary(c.id) : null; } catch { habits = null; }
    res.json({
      client: { ...pub(c), lastLoginAt: c.lastLoginAt || null, hideRank: !!c.hideRank },
      membership: m ? { ...m, request: c.membershipRequest || null } : null, membershipRequest: !m ? (c.membershipRequest || null) : null, hasBilling: !!c.stripeCustomerId,
      rewards: { xp: rw.xp, level: rw.level, gem: { name: rw.rank.current.name, color: rw.rank.current.color }, next: rw.rank.next ? { name: rw.rank.next.name, xpToNext: rw.rank.xpToNext } : null,
        overall: overallOf(c, rw.xp), todayXp: rw.todayXp, badges: rw.badges.filter((b) => b.earned).map((b) => ({ id: b.id, title: b.title, earnedOn: b.earnedOn || null })), badgesTotal: rw.badges.length },
      habits: habits ? { goal: habits.goal, goalLevel: habits.goalLevel, todayPoints: habits.total, qualifyingToday: habits.qualifying, streak: habits.streak, repairs: { available: habits.repairs.available, earned: habits.repairs.earned, used: habits.repairs.used },
        top30: hab.topHabits(c.id, 30), doneToday: habits.habits.filter((h) => h.done).map((h) => h.name) } : null,
      activity: hab ? hab.series(c, 90) : null,
      workouts: { total: ws.length, thisMonth: ws.filter((w) => w.date >= monthStart).length, byKind, stats: workoutStats(ws, t),
        recent: ws.slice(-15).reverse().map((w) => ({ date: w.date, title: w.title, minutes: w.minutes, kind: workoutKind(w), exercises: w.exercises || 0 })) },
      programs: { assigned: (c.assignedPrograms || []).map((a) => ({ id: a.id, title: pname(a.id), assignedAt: a.assignedAt || null, progress: prog[a.id] || null })),
        saved: (c.pinnedPrograms || []).map((id) => ({ id, title: pname(id) })), history: (c.programHistory || []).slice(-10).reverse(), builtWorkouts: (c.customWorkouts || []).map((w) => ({ id: w.id, name: w.name, exercises: w.exercises.length, createdAt: w.createdAt })) },
      challenges: { sent: sent.length, sentDone: sent.filter((x) => x.status === "done").length, received: got.length, receivedDone: got.filter((x) => x.status === "done").length,
        recent: ch.filter((x) => x.fromId === c.id || x.toId === c.id).slice(-8).reverse().map((x) => ({ date: x.date, direction: x.fromId === c.id ? "sent" : "received", with: x.fromId === c.id ? x.toName : x.fromName, workout: x.workout.name, status: x.status })) },
      favorites: (c.favorites || []).length,
      pain: { entries: pain.length, last: lastP ? { date: lastP.date, area: lastP.area, level: lastP.level } : null, trend: lastP && prevP ? (lastP.level < prevP.level ? "improving" : lastP.level > prevP.level ? "worse" : "steady") : null,
        recent: pain.slice(-10).reverse().map((p) => ({ date: p.date, area: p.area, level: p.level })) },
      appointments: { completed: nApp("completed"), noShow: nApp("no-show"), cancelled: nApp("cancelled"), booked: nApp("booked"), next: next ? { date: next.date, time: next.time, typeName: next.typeName } : null,
        recent: mine.slice(0, 6).map((a) => ({ date: a.date, time: a.time, typeName: a.typeName, status: a.status })) },
      documents: { total: docs.total, done: docs.done, complete: docs.complete },
      time: pres ? { last30: pres.summary(c.id, t, 30), last90: pres.summary(c.id, t, 90) } : null,
      generatedAt: new Date().toISOString()
    });
  });

  // Anything added to a client's care from the chart (a program, a pain track or protocol, a written protocol, a guide,
  // a new treatment plan) sends this one push and one email. Like lib/emr.js ping (notes, movements), it never says
  // what was added: email and lock screens aren't private, and a treatment is health information. n = items added.
  function careAdded(c, n = 1) {
    // A closed account has nobody to tell: its address is a placeholder that cannot receive mail, and no device of its
    // is kept, so nothing is sent
    if (!n || c.deletedAt) return;
    const push = app.get("push");
    if (push) push.toClient(c.id, { title: "Dr. Jared added to your care plan", body: "Something new is waiting in MD Fit. Open the app to see what to do next.", route: "home" });
    if (notify.enabled && cfg.siteUrl) notify.client(c.email, "Dr. Jared added to your care plan",
      `Hi ${String(c.name || "").split(" ")[0] || "there"},\n\nDr. Jared added ${n === 1 ? "something new" : `${n} new items`} to your care plan. For privacy it isn't in this email. See it in the MD Fit app:\n${cfg.siteUrl}/account\n\nQuestions? Reply here or call 941-313-0562.\n\nMD Fit`);
  }

  admin.put("/clients/:id/plan", (req, res) => {
    const list = clients();
    const c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const b = req.body || {};
    const guides = Array.isArray(b.guides) ? [...new Set(b.guides)] : [];
    if (guides.some((g) => !GUIDE_IDS.includes(g))) fail("Unknown guide.");
    if (!Array.isArray(b.exercises || []) || (b.exercises || []).length > 30) fail("Up to 30 exercises.");
    const exercises = (b.exercises || []).map((e, i) => ({
      name: text(e && e.name, `Exercise ${i + 1} name`, { min: 1, max: 80 }),
      detail: text(e && e.detail, `Exercise ${i + 1} details`, { max: 1000 })
    }));
    const was = c.plan || { guides: [], exercises: [], notes: "" };
    c.plan = { guides, exercises, notes: text(b.notes, "Notes", { max: 3000 }), updatedAt: new Date().toISOString() };
    save(list);
    activity("client_plan", { email: c.email });
    const had = new Set((was.exercises || []).map((x) => `${x.name}\u0000${x.detail || ""}`));
    careAdded(c, exercises.filter((x) => !had.has(`${x.name}\u0000${x.detail || ""}`)).length + guides.filter((g) => !(was.guides || []).includes(g)).length
      + (c.plan.notes && c.plan.notes !== (was.notes || "") ? 1 : 0));
    res.json(c.plan);
  });

  // Client type: inpatient (in-clinic patient: consultations and video visits are never charged) or outpatient.
  // Every change is in the audit ledger (admin.change /clients/:id/type) and the activity feed.
  // Admin corrects a member's contact details (a typo in the email, a new address). Their appointments linked
  // to the account follow the new email so they still show under the member.
  admin.put("/clients/:id/contact", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const b = req.body || {};
    const email = b.email !== undefined ? emailOf(b.email) : c.email;
    const name = b.name !== undefined ? text(b.name, "Name", { min: 2, max: 100 }) : c.name;
    const phone = b.phone !== undefined ? phoneOf(b.phone) : (c.phone || "");
    if (email !== c.email && list.some((x) => x.id !== c.id && x.email === email)) return res.status(409).json({ error: "Another account already uses that email." });
    const oldEmail = c.email;
    c.email = email; c.name = name; c.phone = phone;
    if (email !== oldEmail) delete c.emailVerifiedAt; // a new address is unproven until its owner confirms it
    if (b.name !== undefined) { const parts = name.split(" "); c.firstName = parts[0]; c.lastName = parts.slice(1).join(" "); }
    save(list);
    if (email !== oldEmail) {
      const appts = store.read("appointments", []); let changed = false;
      appts.forEach((a) => { if (a.clientId === c.id && a.email === oldEmail) { a.email = email; changed = true; } });
      if (changed) store.write("appointments", appts);
      notify.client(oldEmail, "Your MD Fit account email was changed", `Hi ${name.split(" ")[0]},\n\nThe email on your MD Fit account was changed to ${email} by our office. If that wasn't expected, call ${cfg.phone || "941-313-0562"}.\n\nMD Fit`);
    }
    activity("client_contact", { email, previousEmail: oldEmail !== email ? oldEmail : undefined });
    res.json(pub(c));
  });

  admin.put("/clients/:id/type", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const type = req.body && req.body.type;
    if (!["inpatient", "outpatient"].includes(type)) fail("Client type is inpatient or outpatient.");
    c.clientType = type; c.clientTypeAt = new Date().toISOString();
    save(list);
    activity("client_type", { email: c.email, clientType: type });
    res.json({ clientType: type });
  });

  // Pain tracks and Pain Tool protocols Dr. Jared prescribes from the chart (Plans & protocols), like programs: they show
  // on the client's Home under "Recommended by Dr. Jared" and on their road. Route is under /clients (staff permission
  // "clients", the same as assigning a program); the audit middleware records it like every chart action.
  admin.put("/clients/:id/pain-plan", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const b = req.body || {}, ok = painIds();
    if (!Array.isArray(b.items) || b.items.length > 20) fail("Pick up to 20 pain tracks and protocols.");
    const prev = new Map(assignedPain(c).map((x) => [`${x.kind}:${x.id}`, x])), now = new Date().toISOString();
    c.assignedPain = [...new Map(b.items.map((x) => {
      const kind = typed(x && x.kind, "That pain track or protocol isn't in MD Fit."), id = typed(x && x.id, "That pain track or protocol isn't in MD Fit.");
      if (!(kind === "track" ? ok.track.has(id) : kind === "protocol" ? ok.protocol.has(id) : false)) fail("That pain track or protocol isn't in MD Fit.");
      const old = prev.get(`${kind}:${id}`) || {};
      const note = x.note === undefined || x.note === null ? (old.note || "") : text(x.note, "Note", { max: 300 });
      return [`${kind}:${id}`, { kind, id, note, assignedAt: old.assignedAt || now }];
    })).values()];
    // A prescribed track also goes on their road (the app's "Add to my road"), so today's stop can be it
    // (newly prescribed ones only; taking a prescription away leaves the member's own road alone)
    const fresh = c.assignedPain.filter((x) => x.kind === "track" && !prev.has(`track:${x.id}`)).map((x) => x.id);
    c.roadTracks = [...roadTracks(c).filter((x) => !fresh.includes(x)), ...fresh].slice(-10);
    save(list);
    const newItems = c.assignedPain.filter((x) => !prev.has(`${x.kind}:${x.id}`)), added = newItems.length;
    activity("client_pain_plan", { email: c.email, count: c.assignedPain.length });
    careAdded(c, added);
    res.json({ assignedPain: c.assignedPain, painWork: painWork(c) });
  });

  // Take a pain track off the client's road from the chart (one they added themselves, or one prescribed). Their past
  // sessions stay in their history.
  admin.delete("/clients/:id/road-tracks/:track", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const t = String(req.params.track || "");
    if (!roadTracks(c).includes(t)) return res.status(404).json({ error: "That track isn't on their road." });
    c.roadTracks = roadTracks(c).filter((x) => x !== t);
    save(list);
    activity("client_road_track_removed", { email: c.email });
    res.json({ assignedPain: assignedPain(c), painWork: painWork(c) });
  });

  // Programs Dr. Jared assigns: they show on the client's Home under "From Dr. Jared" (the client is emailed once)
  admin.put("/clients/:id/programs", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const b = req.body || {}, ids = programIds();
    if (!Array.isArray(b.programs) || b.programs.length > 12) fail("Pick up to 12 programs.");
    const before = new Set((c.assignedPrograms || []).map((x) => x.id));
    const prev = new Map((c.assignedPrograms || []).map((x) => [x.id, x]));
    // Unassigned programs keep their note here, so re-assigning one later brings the note back
    const hist = new Map((c.programHistory || []).map((x) => [x.id, x]));
    const now = new Date().toISOString();
    c.assignedPrograms = [...new Map(b.programs.map((x) => {
      const pid = String(x && x.id || "");
      if (!ids.has(pid)) fail("Program not found.");
      const old = prev.get(pid) || hist.get(pid) || {};
      // note left out = keep the one on file; an empty note clears it
      const note = x.note === undefined || x.note === null ? (old.note || "") : text(x.note, "Note", { max: 300 });
      return [pid, { id: pid, note, assignedAt: (prev.get(pid) || {}).assignedAt || now }];
    })).values()];
    const kept = new Set(c.assignedPrograms.map((x) => x.id));
    for (const x of c.assignedPrograms) hist.delete(x.id);
    for (const x of prev.values()) if (!kept.has(x.id)) hist.set(x.id, { id: x.id, note: x.note || "", assignedAt: x.assignedAt, removedAt: now });
    c.programHistory = [...hist.values()].slice(-40);
    save(list);
    const added = c.assignedPrograms.filter((x) => !before.has(x.id)).length;
    activity("client_programs", { email: c.email, count: c.assignedPrograms.length });
    careAdded(c, added);
    res.json({ assignedPrograms: c.assignedPrograms, programHistory: c.programHistory, programProgress: programProgress(c.assignedPrograms, c.workouts) });
  });

  // The link signs whoever opens it in as the member, chart and records included, so it is handed only to the practice
  // owner. Staff use send-reset-code below, which goes to the member's own inbox. Checked before the client is looked
  // up, so a refused account learns nothing about which ids exist.
  admin.post("/clients/:id/reset-link", (req, res) => {
    if (!(req.account && req.account.isOwner)) return res.status(403).json({ error: "Only the practice owner can do that.", need: "owner" });
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json({ url: resetUrl(c), hours: RESET_HOURS });
  });

  admin.post("/clients/:id/send-reset-code", async (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const sent = await sendCode(c).catch(() => null);
    if (!sent) return res.status(503).json({ error: "Email isn't configured (RESEND_API_KEY)." });
    activity("admin_sent_reset_code", { email: c.email });
    res.json({ ok: true, message: `Code emailed to ${sent.to}.` });
  });

  // ---------------- Close my account (App Store guideline 5.1.1(v)) ----------------
  // A member who was never a patient is erased outright. A member with a clinical record keeps the record,
  // because a practice may not destroy a chart on request, and loses everything that identifies or opens the
  // account: password, sessions, name, email, phone, push devices, private messages. The deletion is explained
  // in those terms before it happens, so nobody is told their chart is gone when it is not.
  const clinicalFootprint = (c) => {
    const intakes = store.read("intakes", []).some((r) => r.clientId === c.id);
    const visits = appointments().some((a) => a.clientId === c.id);
    const paid = !!(c.membership || (c.protocols || []).length || c.stripeCustomerId);
    const chart = !!(c.plan && (c.plan.notes || (c.plan.items || []).length)) || (c.painLog || []).length > 0;
    return intakes || visits || paid || chart || !!c.chart || !!c.patient;
  };

  // Ending an account for good. Used when a member closes their own account and when the trash is emptied.
  // Stops billing, removes what belongs to the account elsewhere, then either strips the record down to a
  // "Closed account" that keeps the chart (kept: true) or says it can be removed altogether (kept: false).
  // The caller saves the client list.
  async function finalize(c, by) {
    const mode = clinicalFootprint(c) ? "close" : "erase", was = { name: c.name, email: c.email };
    // Stop any Stripe subscription first, so a closed account is never billed again.
    let billing = null;
    const cancel = app.get("cancelSubscriptions");
    if (cancel) { try { billing = await cancel(c); } catch (e) { logger.warn("deletion_cancel_failed", { clientId: c.id, error: e.message }); } }
    const drop = (name, keep) => { const all = store.read(name, []); const next = all.filter(keep); if (next.length !== all.length) store.write(name, next); };
    drop("messages", (m) => m.clientId !== c.id);
    drop("challenges", (x) => x.fromId !== c.id && x.toId !== c.id);
    drop("habits", (x) => x.clientId !== c.id);
    { const push = app.get("push"); if (push) push.forgetClient(c.id); }
    { const guide = app.get("guideApi"); if (guide) guide.forget(c.id); }
    if (mode === "erase") {
      drop("intakes", (r) => r.clientId !== c.id);
      drop("referrals", (r) => r.clientId !== c.id && r.referredBy !== c.id);
    } else closeRecord(c, by, clock().toISOString());
    activity("client_deleted", { id: c.id, by, mode });
    return { mode, billing, kept: mode === "close", was };
  }
  // What "Closed account" means on a record: everything that identifies or opens the account is gone, the rest is kept
  function closeRecord(c, by, at) {
    c.deletedAt = at;
    c.deletedBy = by;
    c.name = "Closed account";
    c.firstName = "Closed"; c.lastName = "account";
    c.email = `deleted+${c.id}@mdfit.invalid`;
    c.phone = ""; c.passwordHash = null; c.pwv = (c.pwv || 0) + 1;   // every existing session stops working
    delete c.googleSub; delete c.appleSub; delete c.referralCode; delete c.reviewCode;
  }

  me.get("/account/deletion", (req, res) => {
    const c = req.client;
    res.json({
      mode: clinicalFootprint(c) ? "close" : "erase",
      needsPassword: !!c.passwordHash,
      membership: c.membership ? { tier: c.membership.tier, until: c.membership.until || null } : null
    });
  });

  me.post("/account/deletion", async (req, res) => {
    const b = req.body || {};
    if (String(b.confirm || "").trim().toUpperCase() !== "DELETE") fail('Type DELETE to confirm.');
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    if (!c) return res.status(404).json({ error: "Account not found." });
    if (c.passwordHash && !verifyPassword(String(b.password || ""), c.passwordHash)) {
      return res.status(401).json({ error: "That password is not right." });
    }
    const { mode, billing, kept, was } = await finalize(c, "member");
    // finalize waited on Stripe. Whatever other members saved meanwhile is in the list as it is now, not in the one read
    // above, so the change is made to a fresh copy: saving the earlier list would undo their sign-ups and entries.
    const now = clients(), cur = now.find((x) => x.id === c.id);
    if (cur && kept) closeRecord(cur, "member", clock().toISOString());
    if (cur) save(kept ? now : now.filter((x) => x.id !== c.id));
    if (kept) notify.owner("A member closed their account", `${was.name} (${was.email}) closed their account.\nTheir chart is kept under "Closed account" for the practice's record-retention period. Their login, name, email, phone, devices and messages were removed.`);
    else notify.owner("A member deleted their account", `${was.name} (${was.email}) deleted their account. They had no chart, so the account and its data were removed.`);
    res.json({ ok: true, mode, billing });
  });

  // ---------------- The trash ----------------
  // Delete, from either admin, puts a client in the trash: the whole record and their message thread are set
  // aside, so they vanish from every list, cannot sign in and get nothing sent to them, and Restore puts both back
  // exactly as they were. After TRASH_DAYS the trash empties itself the way a member closing their own account
  // does: a client with a chart becomes a "Closed account" that keeps the chart (a practice may not destroy one),
  // anyone else is removed. Billing is stopped when the trash empties, not before: nothing is undone-proof until then.
  const TRASH = "clients-trash", TRASH_DAYS = 30;
  const trash = () => { const t = store.read(TRASH, []); return Array.isArray(t) ? t : []; };
  const daysLeft = (e) => Math.max(0, TRASH_DAYS - Math.floor((clock().getTime() - Date.parse(e.trashedAt)) / 864e5));
  const trashRow = (e) => ({ id: e.id, name: e.client.name, email: e.client.email, trashedAt: e.trashedAt, trashedBy: e.trashedBy || "",
    daysLeft: daysLeft(e), emptiesOn: new Date(Date.parse(e.trashedAt) + TRASH_DAYS * 864e5).toISOString().slice(0, 10),
    keepsChart: clinicalFootprint(e.client), membership: e.client.membership ? e.client.membership.tier || true : null });

  // ---- Staff add a client by hand. The email address is required: it is how the person signs in. The account has
  // no password yet; they set one at /login ("Forgot password?" sends a 6-digit code) or use Sign in with Google.
  // The email carries the sign-in address and nothing about their care.
  const loginUrl = () => `${String(cfg.siteUrl || "https://www.mymdfit.com").replace(/\/+$/, "")}/login`;
  // A temporary password: random, good for TEMP_PW_HOURS, and it only ever opens the "choose your own password" step
  // (see /api/clients/login). It is emailed once and is never stored or logged in the clear.
  const TEMP_PW_HOURS = 72;
  const tempPassword = () => { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", b = crypto.randomBytes(12); return [...b].map((x) => a[x % a.length]).join(""); }; // one unbroken word, so a double-click or long-press selects all of it
  const giveTempPassword = (c) => { const pw = tempPassword(); c.passwordHash = hashPassword(pw); c.pwv = (c.pwv || 0) + 1; c.tempPw = { until: new Date(Date.now() + TEMP_PW_HOURS * 3600e3).toISOString() }; return pw; };
  const sendWelcomeWithPassword = (c, pw) => notify.client(c.email, "Your MD Fit account",
    `Hi ${String(c.name || "").split(" ")[0] || "there"},\n\nDr. Jared Caban's office created an MD Fit account for you.\n\nSign in here: ${loginUrl()}\nEmail: ${c.email}\n\nTemporary password (copy and paste it, no need to remember it):\n${pw}\n\n` +
    `The first time you sign in you will be asked to choose your own password. The temporary one stops working after ${TEMP_PW_HOURS / 24} days; if that happens, choose "Forgot password?" on the sign-in page.\n\nIf you were not expecting this, you can ignore this email.\n\nMD Fit`);
  const sendLoginLink = (c) => notify.client(c.email, "Your MD Fit sign-in",
    `Hi ${String(c.name || "").split(" ")[0] || "there"},\n\nYour MD Fit account is ready. Sign in here:\n${loginUrl()}\n\n` +
    `Use this email address (${c.email}). The first time, choose "Forgot password?" and we'll email you a 6-digit code to set your password, or use Sign in with Google.\n\nMD Fit`);
  admin.post("/clients", async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!String(b.email || "").trim()) fail("An email address is required: it is how the client signs in.");
      const email = emailOf(b.email), name = text(b.name, "Name", { min: 2, max: 100 });
      const list = clients();
      if (list.some((x) => x.email === email)) return res.status(409).json({ error: "There is already a client with that email address." });
      const c = { id: id(), email, name, phone: String(b.phone || "").trim() ? phoneOf(b.phone) : "", passwordHash: null, pwv: 0, plan: emptyPlan(), painLog: [],
        referralCode: genReferralCode(), createdAt: new Date().toISOString(), lastLoginAt: null, addedBy: req.admin };
      const pw = notify.enabled ? giveTempPassword(c) : ""; // with no email service there is nobody to give one to: they use "Forgot password?"
      list.push(c); save(list);
      activity("client_added", { email, by: "admin" });
      const emailed = pw ? !!(await sendWelcomeWithPassword(c, pw).catch(() => false)) : false;
      res.status(201).json({ client: pub(c), emailed, emailReady: !!notify.enabled });
    } catch (err) { next(err); }
  });
  // Email someone the sign-up address without making their account: they create it themselves at /login. An address
  // that already has an account gets the sign-in email instead, so nobody ends up with two.
  admin.post("/clients/invite", async (req, res, next) => {
    try {
      const email = emailOf((req.body || {}).email);
      if (!notify.enabled) return res.status(503).json({ error: "Email isn't connected on the server, so the link can't be sent." });
      const have = clients().find((x) => x.email === email);
      const emailed = have ? !!(await sendLoginLink(have).catch(() => false))
        : !!(await notify.client(email, "You're invited to MD Fit", `Hi,\n\nDr. Jared Caban invited you to MD Fit. Create your account here:\n${loginUrl()}\n\nChoose "Create account" and use this email address (${email}).\n\nMD Fit`).catch(() => false));
      if (!emailed) return res.status(502).json({ error: "The email could not be sent. Try again in a minute." });
      activity("client_invited", { email, by: "admin" });
      res.json({ emailed: true, to: email, existing: !!have });
    } catch (err) { next(err); }
  });
  admin.post("/clients/:id/login-link", async (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    if (!notify.enabled) return res.status(503).json({ error: "Email isn't connected on the server, so the link can't be sent." });
    // Someone who has never set their own password gets a fresh temporary one; everyone else just gets the address
    const list = clients(), cur = list.find((x) => x.id === c.id), fresh = !!(cur && (cur.tempPw || (!cur.passwordHash && !cur.googleSub && !cur.appleSub)));
    let emailed;
    if (fresh) { const pw = giveTempPassword(cur); save(list); emailed = !!(await sendWelcomeWithPassword(cur, pw).catch(() => false)); }
    else emailed = !!(await sendLoginLink(c).catch(() => false));
    if (!emailed) return res.status(502).json({ error: "The email could not be sent. Try again in a minute." });
    res.json({ emailed: true, to: c.email, temporaryPassword: fresh });
  });

  admin.delete("/clients/:id", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const msgs = store.read("messages", []);
    const entry = { id: c.id, trashedAt: clock().toISOString(), trashedBy: req.admin || "", client: c, messages: msgs.filter((m) => m.clientId === c.id) };
    store.write(TRASH, [...trash().filter((e) => e.id !== c.id), entry]);   // set aside first, then take out of the lists
    save(list.filter((x) => x.id !== c.id));
    if (entry.messages.length) store.write("messages", msgs.filter((m) => m.clientId !== c.id));
    { const push = app.get("push"); if (push) push.forgetClient(c.id); }   // nothing is sent to someone in the trash; they sign in again after a restore
    activity("client_trashed", { id: c.id });
    res.json({ ok: true, trashed: true, ...trashRow(entry) });
  });

  admin.get("/clients/trash/list", async (req, res) => { await emptyTrash(); res.json({ days: TRASH_DAYS, trash: trash().map(trashRow).sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : -1)) }); });

  admin.post("/clients/:id/restore", (req, res) => {
    const all = trash(), e = all.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "That client isn't in the trash. It may already have been emptied." });
    const list = clients();
    if (list.some((x) => x.id === e.id)) return res.status(409).json({ error: "That client is already back in the list." });
    if (e.client.email && list.some((x) => x.email === e.client.email)) return res.status(409).json({ error: `Someone has signed up with ${e.client.email} since this client was deleted. Change that account's email first, then restore.` });
    const back = { ...e.client, pwv: (e.client.pwv || 0) + 1 };   // old sessions stay dead: they sign in again
    save([...list, back]);
    if ((e.messages || []).length) store.write("messages", [...store.read("messages", []), ...e.messages]);
    store.write(TRASH, all.filter((x) => x.id !== e.id));
    activity("client_restored", { id: e.id });
    res.json({ ok: true, client: pub(back) });
  });

  // Entries past their 30 days. One at a time, each taken out of the trash only once it has been dealt with.
  let emptying = null;
  function emptyTrash() {
    if (emptying) return emptying;
    emptying = (async () => {
      for (const e of trash().filter((x) => daysLeft(x) <= 0)) {
        // Read before the awaits below: an entry restored while an earlier one was being dealt with is no longer trash
        if (!trash().some((x) => x.id === e.id)) continue;
        try {
          const c = e.client, r = await finalize(c, "trash");
          if (r.kept) { const list = clients(); if (!list.some((x) => x.id === c.id)) save([...list, c]); }
          store.write(TRASH, trash().filter((x) => x.id !== e.id));
          logger.info("trash_emptied", { clientId: c.id, mode: r.mode });
        } catch (err) { logger.warn("trash_empty_failed", { clientId: e.id, error: err.message }); }
      }
    })().finally(() => { emptying = null; });
    return emptying;
  }
  if (cfg.trashTimer !== false) {
    setTimeout(() => emptyTrash().catch(() => {}), 60e3).unref();
    setInterval(() => emptyTrash().catch(() => {}), 6 * 3600e3).unref();
  }
  return { me, clients, save, today, boardRows, rewardsOf, activeMembership, activePlan, isInpatient, fullAccess, owns, setReconcile, verifyGoogleToken };
}

module.exports = { mountClients, GUIDE_IDS, workoutStats, programProgress };
