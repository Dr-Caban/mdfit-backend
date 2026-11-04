// Client accounts: sign up / log in, client dashboard API (appointments, plan, pain log), and admin client management.
// Client sessions are signed tokens with role "client"; they can never pass the admin check (which needs sub = ADMIN_EMAIL).
const express = require("express");
const crypto = require("crypto");
const { hashPassword, verifyPassword, signToken, verifyToken } = require("./auth");
const { ValidationError, EMAIL_RE, AREAS } = require("./validate");
const { rewards, ACTIONS, levelStart, repairsFrom } = require("./rewards");

const SESSION_DAYS = 30;
const RESET_HOURS = 24;
const GUIDE_IDS = ["posterior-neck", "scalenes", "rotator-cuff", "iliopsoas", "lateral-hip", "quads", "calf"];
const PAIN_LOG_MAX = 1000;
const WORKOUT_LOG_MAX = 2000;
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
  const today = () => nowParts(cfg.tz, cfg.now()).date;
  const ready = cfg.sessionSecret.length >= 32;
  const signupLimit = limiter(10, 60 * 60 * 1000);
  const resetLimit = limiter(6, 60 * 60 * 1000);
  const loginFails = limiter(10, 15 * 60 * 1000);

  const activeMembership = (c) => (c.membership && (!c.membership.until || c.membership.until >= today()) ? c.membership : null);
  const genReferralCode = () => "MDFIT-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  const referralCode = (c) => { if (!c.referralCode) c.referralCode = genReferralCode(); return c.referralCode; };
  const generateReferralCode = () => genReferralCode();
  const referrals = () => store.read("referrals", []);
  const saveReferrals = (list) => store.write("referrals", list.slice(-5000));
  function applyReferral(newClient, code, list) {
    if (!code) return;
    const referrer = list.find((x) => x.referralCode === code && x.id !== newClient.id);
    if (!referrer) return;
    newClient.referredBy = referrer.id;
    referrer.referrals = (referrer.referrals || 0) + 1;
    const now = new Date();
    const referrerBase = referrer.membership && referrer.membership.until && referrer.membership.until >= today() ? new Date(referrer.membership.until) : now;
    const referrerUntil = new Date(referrerBase.getTime() + 30 * 864e5).toISOString().slice(0, 10);
    referrer.membership = { tier: "member", until: referrerUntil, via: referrer.membership?.via || "referral-reward" };
  }
  const pub = (c) => ({ id: c.id, email: c.email, name: c.name, firstName: c.firstName || String(c.name || "").split(" ")[0], lastName: c.lastName || String(c.name || "").split(" ").slice(1).join(" "), phone: c.phone, createdAt: c.createdAt, plan: c.plan || emptyPlan(), membership: activeMembership(c), referralCode: referralCode(c), hasPassword: !!c.passwordHash, google: !!c.googleSub });
  const session = (c) => {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    return { token: signToken({ sub: c.id, role: "client", pwv: c.pwv || 0, exp }, cfg.sessionSecret), expiresAt: new Date(exp).toISOString(), client: pub(c) };
  };
  const resetToken = (c) => signToken({ sub: c.id, role: "reset", pwv: c.pwv || 0, exp: Date.now() + RESET_HOURS * 3600e3 }, cfg.sessionSecret);
  const resetUrl = (c) => `${cfg.siteUrl || ""}/login?reset=${encodeURIComponent(resetToken(c))}`;
  const myAppointments = (c) => appointments().filter((a) => a.email === c.email).map(({ cancelToken, adminNotes, ...a }) => a);
  const notReady = (res) => res.status(503).json({ error: "Accounts aren't set up on the server (SESSION_SECRET)." });

  function requireClient(req, res, next) {
    if (!ready) return notReady(res);
    const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const payload = m && verifyToken(m[1], cfg.sessionSecret);
    const c = payload && payload.role === "client" && clients().find((x) => x.id === payload.sub);
    if (!c || (c.pwv || 0) !== payload.pwv) return res.status(401).json({ error: "Please log in again." });
    req.client = c;
    next();
  }

  // ================= Public: sign up, log in, password reset =================
  app.post("/api/clients/signup", signupLimit.mw, (req, res) => {
    if (!ready) return notReady(res);
    const b = req.body || {};
    if (b.company) return res.status(201).json({ ok: true });
    const email = emailOf(b.email);
    const name = text(b.name, "Name", { min: 2, max: 100 });
    const list = clients();
    if (list.some((x) => x.email === email)) return res.status(409).json({ error: "There's already an account with that email. Log in instead." });
    const c = {
      id: id(), email, name, phone: phoneOf(b.phone),
      passwordHash: hashPassword(passwordOf(b.password)), pwv: 0, plan: emptyPlan(), painLog: [],
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    c.referralCode = genReferralCode();
    applyReferral(c, b.referralCode, list);
    list.push(c);
    save(list);
    activity("client_signup", { email });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n${c.phone || "(no phone)"}${b.referralCode ? `\nReferred with code: ${b.referralCode}` : ""}`);

    res.status(201).json(session(c));
  });

  app.post("/api/clients/login", (req, res) => {
    if (!ready) return notReady(res);
    if (loginFails.blocked(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Email is not valid." });
    const password = String((req.body && req.body.password) || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const list = clients();
    let c = list.find((x) => x.email === email);

    if (c) {
      if (!verifyPassword(password, c.passwordHash)) {
        loginFails.hit(req.ip);
        logger.warn("client_login_failed", { email: mask(email) });
        return res.status(401).json({ error: "Wrong email or password." });
      }
      loginFails.reset(req.ip);
      c.lastLoginAt = new Date().toISOString();
      save(list);
      return res.json(session(c));
    }

    // Auto-create account when email not found
    loginFails.reset(req.ip);
    const rawName = text((req.body && req.body.name) || "", "Name", { max: 100 });
    const name = rawName || email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    let code = generateReferralCode(name);
    while (list.some((x) => x.referralCode === code)) code = generateReferralCode(name);

    c = {
      id: id(), email, name, phone: "",
      passwordHash: hashPassword(password), pwv: 0, plan: emptyPlan(), painLog: [],
      referralCode: code, referredBy: null, freeUntil: null,
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    list.push(c);
    save(list);
    activity("client_signup", { email, via: "auto_login" });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n(auto-created from login)`);
    res.status(201).json(session(c));
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

  app.post("/api/clients/google", signupLimit.mw, async (req, res) => {
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
      if (!c.googleSub) c.googleSub = payload.sub;
      if (!c.firstName && firstName) c.firstName = firstName;
      if (!c.lastName && lastName) c.lastName = lastName;
      if ((!c.name || c.name === email.split("@")[0]) && fullName) c.name = fullName;
      save(list);
      return res.json(session(c));
    }
    const refCode = String((req.body && req.body.referralCode) || "");
    c = {
      id: id(), email, name: text(fullName, "Name", { min: 1, max: 100 }), firstName, lastName, phone: "",
      passwordHash: null,
      pwv: 0, plan: emptyPlan(), painLog: [], googleSub: payload.sub,
      referralCode: genReferralCode(),
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    applyReferral(c, refCode, list);
    list.push(c);
    save(list);
    activity("client_signup", { email, via: "google" });
    notify.owner(`New client account: ${c.name}`, `${c.name}\n${c.email}\n(signed up with Google)${refCode ? `\nReferred with code: ${refCode}` : ""}`);
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
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    resetCodes.set(c.id, { code, exp: Date.now() + RESET_CODE_TTL, tries: 0 });
    if (!notify.enabled) return null;
    notify.client(c.email, `${code} is your MD Fit code`,
      `Hi ${c.name.split(" ")[0]},\n\nYour MD Fit code is:\n\n${code}\n\nUse it to set or reset your password. It expires in 10 minutes. If you didn't ask for this, ignore this email.\n\nMD Fit`);
    return { via: "email", to: maskEmail(c.email) };
  }
  function checkCode(c, code) {
    const entry = resetCodes.get(c.id);
    if (!entry || Date.now() > entry.exp) { resetCodes.delete(c.id); return "Code expired. Request a new one."; }
    if (entry.tries >= RESET_CODE_MAX_TRIES) { resetCodes.delete(c.id); return "Too many attempts. Request a new code."; }
    if (entry.code !== String(code || "").trim()) { entry.tries++; return `Wrong code. ${RESET_CODE_MAX_TRIES - entry.tries} attempts left.`; }
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
    res.json({ resetToken: resetToken(c) });
  });

  app.post("/api/clients/reset", (req, res) => {
    if (!ready) return notReady(res);
    const payload = verifyToken(String((req.body && req.body.token) || ""), cfg.sessionSecret);
    const list = clients();
    const c = payload && payload.role === "reset" && list.find((x) => x.id === payload.sub);
    if (!c || (c.pwv || 0) !== payload.pwv) return res.status(400).json({ error: "This reset code has expired or was already used. Request a new one." });
    c.passwordHash = hashPassword(passwordOf(req.body.password));
    c.pwv = (c.pwv || 0) + 1;
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
    if (b.name !== undefined) c.name = text(b.name, "Name", { min: 2, max: 100 });
    if (b.phone !== undefined) c.phone = phoneOf(b.phone);
    save(list);
    res.json({ client: pub(c) });
  });

  // Send a code to the signed-in member (needed to set a first password, or to change it without the current one)
  me.post("/password/code", resetLimit.mw, async (req, res) => {
    const sent = await sendCode(req.client).catch(() => null);
    if (!sent) return res.status(503).json({ error: "We can't send codes right now. Call or text us at 941-313-0562." });
    res.json({ ok: true, ...sent });
  });
  me.put("/password", (req, res) => {
    const b = req.body || {};
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    if (b.code) { const err = checkCode(c, b.code); if (err) return res.status(400).json({ error: err }); }
    else if (!c.passwordHash) return res.status(400).json({ error: "Enter the code we sent you to set your password." });
    else if (!verifyPassword(String(b.current || ""), c.passwordHash)) return res.status(400).json({ error: "Current password is wrong." });
    c.passwordHash = hashPassword(passwordOf(b.password, "New password"));
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
    const list = appointments();
    const a = list.find((x) => x.id === req.params.id && x.email === req.client.email);
    if (!a) return res.status(404).json({ error: "Appointment not found." });
    if (a.status !== "booked" || a.date < today()) return res.status(400).json({ error: "This appointment can't be cancelled online." });
    if (a.source === "cal") {
      try { await cal.cancel(a.calUid, "Cancelled by client in MD Fit account"); }
      catch (err) { return res.status(502).json({ error: "Couldn't cancel right now. Please call us." }); }
    }
    a.status = "cancelled";
    a.cancelledAt = new Date().toISOString();
    store.write("appointments", list);
    if (onCancel) onCancel(a);
    activity("appointment_cancelled", { email: a.email, date: a.date, via: "account" });
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) fail("Date must be today or earlier.");
    const entry = { id: id(), date, area: b.area, level, note: text(b.note, "Note", { max: 500 }), createdAt: new Date().toISOString() };
    const list = clients();
    const c = list.find((x) => x.id === req.client.id);
    c.painLog = [...(c.painLog || []), entry].slice(-PAIN_LOG_MAX);
    save(list);
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
  function metricsOf(b) {
    const m = {
      seconds: optNum(b.seconds, "Duration", 1, 18000), hrAvg: optNum(b.hrAvg, "Average heart rate", 30, 230), hrMax: optNum(b.hrMax, "Max heart rate", 30, 240),
      hrv: optNum(b.hrv, "HRV", 5, 300), vo2max: optNum(b.vo2max, "VO2 max", 10, 95, 1), rpe: optNum(b.rpe, "Effort (RPE)", 1, 10), calories: optNum(b.calories, "Calories", 1, 5000),
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
    c.workouts = [...(c.workouts || []), entry].slice(-WORKOUT_LOG_MAX);
    save(list);
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
    const date = b.date === undefined ? today() : String(b.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) fail("Date must be today or earlier (YYYY-MM-DD).");
    const v = { restingHr: optNum(b.restingHr, "Resting heart rate", 25, 150), hrv: optNum(b.hrv, "HRV", 5, 300), vo2max: optNum(b.vo2max, "VO2 max", 10, 95, 1),
      weight: optNum(b.weight, "Body weight", 50, 800, 1), sleep: optNum(b.sleep, "Sleep hours", 0, 24, 1) };
    Object.keys(v).forEach((k) => v[k] === undefined && delete v[k]);
    return { date, v };
  }
  function mergeVitals(c, rows, source) {
    const byDate = new Map((c.vitals || []).map((x) => [x.date, x]));
    rows.forEach(({ date, v }) => byDate.set(date, { ...(byDate.get(date) || {}), ...v, date, source }));
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
    res.json({ code: c.referralCode, freeUntil: c.freeUntil || null, referrals: Math.max(refs.length, c.referrals || 0), freeMonths: FREE_MONTHS });
  });

  me.get("/stats", (req, res) => {
    const log = req.client.workouts || [];
    res.json({ ...workoutStats(log, today()), recent: log.slice(-10).reverse() });
  });

  // Full log, for the calendar
  me.get("/workouts", (req, res) => res.json(req.client.workouts || []));

  // XP, level, badges and daily goal, recomputed from history every time
  const visitsOf = (c) => appointments().filter((a) => a.email === c.email && a.status === "completed");
  const rewardsOf = (c, appts = appointments()) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], visits: appts.filter((a) => a.email === c.email && a.status === "completed"), vitals: c.vitals || [], actions: c.xpLog || [],
    bookings: appts.filter((a) => a.email === c.email && a.status !== "cancelled").map((a) => ({ id: a.id, date: String(a.createdAt || a.date || "").slice(0, 10) })) }, today());
  // Ranking pool: anyone with XP, unless they hid themselves. Shows first name + last initial and XP only. Cached a minute.
  const OLYMPIC_LEVEL = 5;
  const leagueOf = (level) => (level >= OLYMPIC_LEVEL ? "olympic" : "pro");
  let board = { at: 0, rows: [] };
  // Pacers: labeled practice competitors that fill a league until 9 real members join. Turn off with LEADERBOARD_PACERS=off.
  const PACER_NAMES = ["Sarah K.", "Mike R.", "Jess T.", "Carlos M.", "Ashley W.", "Dan P.", "Megan L.", "Chris B.", "Nina S.", "Tyler H.", "Rachel D.", "Marcus J.", "Lauren G.", "Kevin O.", "Brittany F.", "Jason C.", "Amanda V.", "Ryan N.", "Olivia E.", "Derek A."];
  const seeded = (str) => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; };
  const pacers = (league, realCount) => {
    if (String(process.env.LEADERBOARD_PACERS || "on").toLowerCase() === "off") return [];
    const n = Math.max(0, 9 - realCount); if (!n) return [];
    const d = today(), dow = (new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7, monday = new Date(Date.parse(d + "T12:00:00Z") - dow * 864e5).toISOString().slice(0, 10);
    const hour = Number(nowParts(cfg.tz, cfg.now()).time?.slice(0, 2)) || 12;
    const progress = Math.min(1, (dow + hour / 24) / 7);
    const names = PACER_NAMES.slice(league === "olympic" ? 10 : 0).concat(PACER_NAMES.slice(0, league === "olympic" ? 10 : 0));
    return names.slice(0, n).map((name, i) => {
      const r = seeded(`${league}|${monday}|${name}`), base = seeded(`${league}|${name}`);
      const weekTarget = league === "olympic" ? 150 + r() * 450 : 40 + r() * 220;
      const curve = Math.pow(progress, 0.8 + r() * 0.6);
      const week = Math.round(weekTarget * curve);
      const level = league === "olympic" ? 5 + Math.floor(base() * 4) : 1 + Math.floor(base() * 4);
      const xp = Math.max(week, levelStart(level) + Math.round(base() * (levelStart(level + 1) - levelStart(level) - 1)));
      return { id: `pacer-${league}-${i}`, name, xp, week, level, league, pacer: true };
    });
  };
  const boardRows = () => {
    if (Date.now() - board.at < 60000) return board.rows;
    const appts = appointments();
    const rows = clients().filter((c) => !c.hideRank).map((c) => {
      const r = rewardsOf(c, appts), parts = String(c.name || "Member").trim().split(/\s+/);
      return { id: c.id, name: parts[0] + (parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : ""), xp: r.xp, week: r.week.reduce((n, d) => n + d.xp, 0), level: r.level, league: leagueOf(r.level) };
    }).filter((x) => x.xp > 0);
    for (const lg of ["pro", "olympic"]) rows.push(...pacers(lg, rows.filter((x) => x.league === lg).length));
    board = { at: Date.now(), rows };
    return rows;
  };
  me.get("/leaderboard", (req, res) => {
    const by = req.query.period === "all" ? "xp" : "week";
    const mine = leagueOf(rewardsOf(req.client).level);
    const league = ["pro", "olympic"].includes(req.query.league) ? req.query.league : mine;
    const rows = boardRows().filter((x) => x.league === league && x[by] > 0).sort((a, b) => b[by] - a[by] || b.xp - a.xp);
    const top = rows.slice(0, 10).map((x, i) => ({ rank: i + 1, name: x.name, score: x[by], level: x.level, me: x.id === req.client.id }));
    const i = rows.findIndex((x) => x.id === req.client.id);
    res.json({ league, myLeague: mine, olympicLevel: OLYMPIC_LEVEL, period: by === "xp" ? "all" : "week", total: rows.length, top, me: i < 0 ? null : { rank: i + 1, score: rows[i][by] }, hidden: !!req.client.hideRank });
  });
  me.put("/leaderboard/visibility", (req, res) => {
    const list = clients(), c = list.find((x) => x.id === req.client.id);
    c.hideRank = !!(req.body && req.body.hidden); save(list); board.at = 0;
    res.json({ hidden: c.hideRank });
  });
  me.post("/xp", (req, res) => {
    const kind = String((req.body || {}).kind || ""), ref = String((req.body || {}).ref || "").slice(0, 80);
    if (!ACTIONS[kind] || kind === "booking") return res.status(400).json({ error: "Unknown action." });
    const list = clients(), c = list.find((x) => x.id === req.client.id), d = today();
    const log = c.xpLog || [];
    if (log.filter((x) => x.date === d && x.kind === kind).length < ACTIONS[kind].cap * 3) { log.push({ date: d, kind, ref }); c.xpLog = log.slice(-3000); save(list); }
    res.json({ ok: true });
  });
  me.get("/rewards", (req, res) => {
    const c = req.client;
    const r = rewardsOf(c);
    const rep = repairsFrom(c.workouts || [], c.repairsUsed || []);
    res.json({ ...r, repairs: rep });
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
        return { id: e.id, sets: text(e.sets, "Sets", { max: 30 }) };
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
    res.json({ member: true, tier: m ? m.tier : null, freeUsed: false, freeLeft: null, reviewCode: c.reviewCode || null });
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

  app.use("/api/me", me);

  // ================= Admin: clients =================
  admin.get("/clients", (req, res) => {
    const t = today(), appts = appointments();
    res.json(clients().map((c) => {
      const mine = appts.filter((a) => a.email === c.email);
      const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
      const last = (c.painLog || []).slice(-1)[0];
      return { id: c.id, name: c.name, email: c.email, phone: c.phone, createdAt: c.createdAt, lastLoginAt: c.lastLoginAt,
        visits: mine.filter((a) => a.status === "completed").length, next: next ? { date: next.date, time: next.time, typeName: next.typeName } : null,
        lastPain: last ? { date: last.date, area: last.area, level: last.level } : null, hasPlan: Boolean(c.plan && (c.plan.guides.length || c.plan.exercises.length || c.plan.notes)), membership: activeMembership(c) };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });

  admin.get("/clients/:id", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json({ ...pub(c), lastLoginAt: c.lastLoginAt, painLog: c.painLog || [],
      workouts: (c.workouts || []).slice(-50).reverse(), stats: workoutStats(c.workouts || [], today()),
      rewards: (({ xp, level, title, badges }) => ({ xp, level, title, badges: badges.filter((b) => b.earned).map((b) => b.title) }))(rewardsOf(c)),
      appointments: appointments().filter((a) => a.email === c.email).map(({ cancelToken, ...a }) => a).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)) });
  });

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
      detail: text(e && e.detail, `Exercise ${i + 1} details`, { max: 300 })
    }));
    c.plan = { guides, exercises, notes: text(b.notes, "Notes", { max: 3000 }), updatedAt: new Date().toISOString() };
    save(list);
    activity("client_plan", { email: c.email });
    if (notify.enabled && cfg.siteUrl) notify.client(c.email, "Your MD Fit plan was updated", `Hi ${c.name.split(" ")[0]},\n\nDr. Jared updated your plan. See it here:\n${cfg.siteUrl}/account\n\nMD Fit`);
    res.json(c.plan);
  });

  admin.post("/clients/:id/reset-link", (req, res) => {
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

  admin.delete("/clients/:id", (req, res) => {
    const list = clients();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "Client not found." });
    save(next);
    activity("client_deleted", { id: req.params.id });
    res.json({ ok: true });
  });
  return { me, clients, save, today };
}

module.exports = { mountClients, GUIDE_IDS, workoutStats };
