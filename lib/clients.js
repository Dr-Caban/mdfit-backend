// Client accounts: sign up / log in, client dashboard API (appointments, plan, pain log), and admin client management.
// Client sessions are signed tokens with role "client"; they can never pass the admin check (which needs sub = ADMIN_EMAIL).
const express = require("express");
const crypto = require("crypto");
const { hashPassword, verifyPassword, signToken, verifyToken } = require("./auth");
const { ValidationError, EMAIL_RE, AREAS } = require("./validate");
const { rewards, ACTIONS, GEMS, levelStart, gemstoneOf, repairsFrom, workoutKind } = require("./rewards");
const { classifyWorkout } = require("./custom-workouts");
const { patientStatus, visitDocs } = require("./intake");

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
  const markVerified = (c) => { if (!c.emailVerifiedAt) c.emailVerifiedAt = new Date().toISOString(); };
  // First time Google or Apple vouches for an address whose account was never verified: whoever set its password
  // never proved they own the address, so that password and every session made with it end here.
  const claimVerified = (c) => {
    if (!verified(c) && c.passwordHash) { c.passwordHash = null; c.pwv = (c.pwv || 0) + 1; }
    markVerified(c);
  };

  const activeMembership = (c) => (c.membership && (!c.membership.until || c.membership.until >= today()) ? c.membership : null);
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
  const pub = (c) => ({ id: c.id, email: c.email, name: c.name, firstName: c.firstName || String(c.name || "").split(" ")[0], lastName: c.lastName || String(c.name || "").split(" ").slice(1).join(" "), phone: c.phone, emailVerified: verified(c), createdAt: c.createdAt, plan: c.plan || emptyPlan(), membership: activeMembership(c), referralCode: referralCode(c), hasPassword: !!c.passwordHash, google: !!c.googleSub, apple: !!c.appleSub,
    clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient", assignedPrograms: c.assignedPrograms || [], pinnedPrograms: c.pinnedPrograms || [] });
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
    c.referralCode = genReferralCode();
    applyReferral(c, b.referralCode, list);
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
      // Google has checked the address (email_verified above). A first link to a never-verified account drops its password.
      if (!c.googleSub) claimVerified(c); else markVerified(c);
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
      pwv: 0, plan: emptyPlan(), painLog: [], googleSub: payload.sub, emailVerifiedAt: new Date().toISOString(),
      referralCode: genReferralCode(),
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    applyReferral(c, refCode, list);
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
  app.post("/api/clients/handoff/exchange", signupLimit.mw, (req, res) => {
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
  app.post("/api/clients/apple", signupLimit.mw, async (req, res) => {
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
      if (email && appleVerified && c.email === email) { if (!c.appleSub) claimVerified(c); else markVerified(c); }
      if (!c.appleSub) c.appleSub = sub;
      if (!c.firstName && firstName) c.firstName = firstName;
      if (!c.lastName && lastName) c.lastName = lastName;
      const full = clean([firstName, lastName].filter(Boolean).join(" "));
      if ((!c.name || c.name === c.email.split("@")[0]) && full) c.name = full;
      save(list);
      return res.json(session(c));
    }
    if (!email) return res.status(400).json({ error: "Apple didn't share an email for this account. In Settings → Apple Account → Sign in with Apple, remove MD Fit and try again, or create an account with your email." });
    const fullName = clean([firstName, lastName].filter(Boolean).join(" ")) || email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    c = {
      id: id(), email, name: text(fullName, "Name", { min: 1, max: 100 }), firstName, lastName, phone: "",
      passwordHash: null, pwv: 0, plan: emptyPlan(), painLog: [], appleSub: sub, ...(appleVerified ? { emailVerifiedAt: new Date().toISOString() } : {}),
      referralCode: genReferralCode(),
      createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
    };
    applyReferral(c, String((req.body && req.body.referralCode) || ""), list);
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
    if (payload.ev) markVerified(c); // the token came from a code we emailed to this address
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
      markVerified(c);
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
    if (b.code) { const err = checkCode(c, b.code); if (err) return res.status(400).json({ error: err }); markVerified(c); }
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
  const visitsOf = (c) => appointments().filter((a) => owns(c, a) && a.status === "completed");
  // Daily activity checks (lib/habits.js) and challenges sent (lib/custom-workouts.js) count toward XP too
  const xpExtras = () => ({ habits: store.read("habits", []), challenges: store.read("challenges", []) });
  const rewardsOf = (c, appts = appointments(), ex = xpExtras()) => rewards({ workouts: c.workouts || [], painLog: c.painLog || [], visits: appts.filter((a) => owns(c, a) && a.status === "completed"), vitals: c.vitals || [], actions: c.xpLog || [],
    bookings: appts.filter((a) => owns(c, a) && a.status !== "cancelled").map((a) => ({ id: a.id, date: String(a.createdAt || a.date || "").slice(0, 10) })),
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
    const hour = Number(nowParts(cfg.tz, cfg.now()).time?.slice(0, 2)) || 12;
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
    const stamp = [list.length, sum((c) => (c.workouts || []).length), sum((c) => (c.painLog || []).length), sum((c) => (c.vitals || []).length), sum((c) => (c.xpLog || []).length),
      ex.habits.reduce((n, d) => n + (d.checks || []).length, 0), ex.challenges.length, appts.length, today()].join("|");
    if (!fresh && board.stamp === stamp && Date.now() - board.at < 60000) return board.rows;
    const rows = clients().filter((c) => !c.hideRank).map((c) => {
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

  app.use("/api/me", me);

  // ================= Admin: clients =================
  admin.get("/clients", (req, res) => {
    const t = today(), appts = appointments();
    // Activity in the last 30 days: distinct days with a workout, a pain check-in or a daily activity check-in
    const habitDocs = new Map(store.read("habits", []).map((d) => [d.clientId, d]));
    const since = new Date(Date.parse(t + "T12:00:00Z") - 29 * 864e5).toISOString().slice(0, 10);
    const active30 = (c) => new Set([...(c.workouts || []), ...(c.painLog || []), ...(((habitDocs.get(c.id) || {}).checks) || [])].map((x) => x && x.date).filter((d) => d && d >= since && d <= t)).size;
    const pres = req.app.get("presenceApi");
    res.json(clients().map((c) => {
      const mine = appts.filter((a) => a.email === c.email);
      const next = mine.filter((a) => a.status === "booked" && a.date >= t).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))[0];
      const last = (c.painLog || []).slice(-1)[0];
      return { id: c.id, name: c.name, email: c.email, emailVerified: verified(c), phone: c.phone, createdAt: c.createdAt, lastLoginAt: c.lastLoginAt, active30: active30(c), minutes30: pres ? pres.minutesIn(c.id, t, 30) : 0,
        visits: mine.filter((a) => a.status === "completed").length, next: next ? { date: next.date, time: next.time, typeName: next.typeName } : null,
        lastPain: last ? { date: last.date, area: last.area, level: last.level } : null, hasPlan: Boolean(c.plan && ((c.plan.guides || []).length || (c.plan.exercises || []).length || c.plan.notes)), membership: activeMembership(c), requestedTier: (c.membershipRequest && c.membershipRequest.tier) || "", clientType: c.clientType === "inpatient" ? "inpatient" : "outpatient",
        documents: (({ total, done, complete }) => ({ total, done, complete }))(patientStatus(c, visitDocs(c, appts))) };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });

  admin.get("/clients/:id", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    res.json({ ...pub(c), lastLoginAt: c.lastLoginAt, painLog: c.painLog || [], documents: patientStatus(c, visitDocs(c, appointments())),
      programProgress: programProgress(c.assignedPrograms, c.workouts), programHistory: c.programHistory || [],
      workouts: (c.workouts || []).slice(-50).reverse(), stats: workoutStats(c.workouts || [], today()),
      rewards: (({ xp, level, title, badges, rank }) => ({ xp, level, title, gem: { name: rank.current.name, color: rank.current.color }, overall: overallOf(c, xp), badges: badges.filter((b) => b.earned).map((b) => b.title) }))(rewardsOf(c)),
      appointments: appointments().filter((a) => a.email === c.email).map(({ cancelToken, ...a }) => a).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)) });
  });

  // Admin → Clients → tap a client: everything about them in one response for the overview pop-up
  // (data-collection month, owner): identity, membership, XP, streaks, daily activities, workouts by kind, programs,
  // challenges, favorites, pain log, visits, documents and the day-by-day activity series.
  admin.get("/clients/:id/overview", (req, res) => {
    const c = clients().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const t = today(), appts = appointments(), hab = req.app.get("habitsApi"), pres = req.app.get("presenceApi"), ex = xpExtras();
    const rw = rewardsOf(c, appts, ex), m = activeMembership(c);
    const mine = appts.filter((a) => a.email === c.email).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
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
    c.plan = { guides, exercises, notes: text(b.notes, "Notes", { max: 3000 }), updatedAt: new Date().toISOString() };
    save(list);
    activity("client_plan", { email: c.email });
    { const push = app.get("push"); if (push) push.toClient(c.id, { title: "Your plan was updated", body: "Dr. Jared updated your plan. Tap to see it.", route: "programs" }); }
    if (notify.enabled && cfg.siteUrl) notify.client(c.email, "Your MD Fit plan was updated", `Hi ${c.name.split(" ")[0]},\n\nDr. Jared updated your plan. See it here:\n${cfg.siteUrl}/account\n\nMD Fit`);
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
    if (added) { const push = app.get("push"); if (push) push.toClient(c.id, { title: "New program for you", body: "Dr. Jared added a program to your account.", route: "programs" }); }
    if (added && notify.enabled && cfg.siteUrl) notify.client(c.email, "Dr. Jared added a program for you",
      `Hi ${c.name.split(" ")[0]},\n\nDr. Jared added ${added === 1 ? "a program" : `${added} programs`} to your MD Fit dashboard. Open it here:\n${cfg.siteUrl}/account\n\nMD Fit`);
    res.json({ assignedPrograms: c.assignedPrograms, programHistory: c.programHistory, programProgress: programProgress(c.assignedPrograms, c.workouts) });
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
    return intakes || visits || paid || chart;
  };

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
    const mode = clinicalFootprint(c) ? "close" : "erase";

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
      save(list.filter((x) => x.id !== c.id));
      activity("client_deleted", { id: c.id, by: "member", mode });
      notify.owner("A member deleted their account", `${c.name} (${c.email}) deleted their account. They had no chart, so the account and its data were removed.`);
    } else {
      const was = { name: c.name, email: c.email };
      c.deletedAt = new Date().toISOString();
      c.deletedBy = "member";
      c.name = "Closed account";
      c.firstName = "Closed"; c.lastName = "account";
      c.email = `deleted+${c.id}@mdfit.invalid`;
      c.phone = ""; c.passwordHash = null; c.pwv = (c.pwv || 0) + 1;   // every existing session stops working
      delete c.googleSub; delete c.appleSub; delete c.referralCode; delete c.reviewCode;
      save(list);
      activity("client_deleted", { id: c.id, by: "member", mode });
      notify.owner("A member closed their account", `${was.name} (${was.email}) closed their account.\nTheir chart is kept under "Closed account" for the practice's record-retention period. Their login, name, email, phone, devices and messages were removed.`);
    }
    res.json({ ok: true, mode, billing });
  });

  admin.delete("/clients/:id", (req, res) => {
    const list = clients();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "Client not found." });
    save(next);
    // Their private message thread goes with the account (it would otherwise linger as an unopenable "Former client" thread).
    const msgs = store.read("messages", []);
    const kept = msgs.filter((m) => m.clientId !== req.params.id);
    if (kept.length !== msgs.length) store.write("messages", kept);
    activity("client_deleted", { id: req.params.id });
    { const push = app.get("push"); if (push) push.forgetClient(req.params.id); }
    { const guide = app.get("guideApi"); if (guide) guide.forget(req.params.id); }
    res.json({ ok: true });
  });
  return { me, clients, save, today, boardRows, rewardsOf, activeMembership, setReconcile };
}

module.exports = { mountClients, GUIDE_IDS, workoutStats, programProgress };
