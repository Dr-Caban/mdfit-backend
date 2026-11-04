// MD Fit API: site content, evaluation intake, 1-on-1 appointment scheduling, newsletter, admin.
// Deploy on Railway with Root Directory = mdfit-srq/backend.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { logger, mask, requestLogger } = require("./lib/logger");
const { createStore } = require("./lib/store");
const { verifyPassword, isValidHash, signToken, verifyToken } = require("./lib/auth");
const { createNotifier } = require("./lib/notify");
const { createCal, verifySignature, normaliseBooking } = require("./lib/cal");
const { createPlaces } = require("./lib/google");
const { mountClients } = require("./lib/clients");
const { mountContent } = require("./lib/content");
const { mountMessages } = require("./lib/messages");
const { mountIntake, MASSAGE_TYPES } = require("./lib/intake");
const { mountFeedbackReports } = require("./lib/feedback-reports");
const { mountAnalytics } = require("./lib/analytics");
const { mountVideos } = require("./lib/videos");
const { mountSearch } = require("./lib/search");
const { createRealtime } = require("./lib/realtime");
const { mountPayments } = require("./lib/payments");
const { createSecurity } = require("./lib/security");
const { createCalSync } = require("./lib/calsync");
const { createAudit } = require("./lib/audit");
const {
  ValidationError, LEAD_STATUSES, APPT_STATUSES, GOALS, SERVICES, AREAS, DURATIONS, SURGERY, DAYS,
  defaultSettings, leadInput, bookingInput, appointmentInput, feedbackInput, classInput, mergeSettings, EMAIL_RE
} = require("./lib/validate");

const env = (k, d = "") => (process.env[k] || d).trim();

function loadConfig() {
  return {
    adminEmail: env("ADMIN_EMAIL").toLowerCase(),
    adminPasswordHash: env("ADMIN_PASSWORD_HASH"),
    sessionSecret: env("SESSION_SECRET"),
    dataDir: env("DATA_DIR", path.join(__dirname, "data")),
    origins: env("ALLOWED_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
    siteUrl: env("SITE_URL").replace(/\/+$/, ""),
    edgeSecret: env("EDGE_SECRET"),
    botFilter: env("BOT_FILTER", "on") !== "off",
    dataKey: env("DATA_ENC_KEY"),
    auditSigningKey: env("AUDIT_SIGNING_KEY"),
    mfaForceOff: env("ADMIN_MFA") === "off",
    tz: env("TZ_NAME", "America/New_York"),
    resendKey: env("RESEND_API_KEY"),
    resendUrl: env("RESEND_URL", "https://api.resend.com"),
    notifyFrom: env("NOTIFY_FROM"),
    notifyEmail: env("NOTIFY_EMAIL").toLowerCase(),
    calKey: env("CAL_API_KEY"),
    calUrl: env("CAL_API_URL", "https://api.cal.com/v2"),
    calWebhookSecret: env("CAL_WEBHOOK_SECRET"),
    googleKey: env("GOOGLE_PLACES_API_KEY"),
    googleServiceAccount: env("GOOGLE_SERVICE_ACCOUNT"),
    googleCalendarId: env("GOOGLE_CALENDAR_ID"),
    simplePracticeIcs: env("SIMPLEPRACTICE_ICS_URL"),
    googleUrl: env("GOOGLE_PLACES_URL", "https://places.googleapis.com/v1"),
    googleLegacyUrl: env("GOOGLE_PLACES_LEGACY_URL", "https://maps.googleapis.com/maps/api/place"),
    googlePlaceId: env("GOOGLE_PLACE_ID"),
    googleQuery: env("GOOGLE_PLACE_QUERY", "MD Fit, 3214 Clark Road, Sarasota, FL 34231"),
    now: () => new Date()
  };
}

const SESSION_HOURS = 12;
const CLASS_BOOK_AHEAD_DAYS = 14;
const CAL_CACHE_MS = 5 * 60 * 1000;
const REVIEWS_CACHE_MS = 6 * 60 * 60 * 1000;
const REVIEWS_RETRY_MS = 10 * 60 * 1000;
const ACTIVITY_MAX = 500;

// Starter group-class schedule, written on first boot only. Edit or delete in the admin portal.
const STARTER_CLASSES = [
  { title: "Mobility & Core", day: 2, time: "09:00", durationMin: 45, capacity: 8, coach: "Dr. Jared", location: "MD Fit, 3214 Clark Rd", description: "Joint mobility, core control and balance. Great for desk backs and stiff hips." },
  { title: "Strength Foundations", day: 4, time: "09:00", durationMin: 60, capacity: 8, coach: "Dr. Jared", location: "MD Fit, 3214 Clark Rd", description: "Learn to load the big movement patterns safely, coached rep by rep." }
];

// ---- Dates in the clinic's time zone. Dates are "YYYY-MM-DD" strings, times "HH:MM".
function nowParts(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// Wall-clock date + time in a time zone -> the real instant (handles daylight saving)
function zonedToUtc(date, time, tz = "America/New_York") {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (ms) => { const p = nowParts(tz, new Date(ms)); return Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), +p.time.slice(0, 2), +p.time.slice(3)) - ms; };
  let t = guess - off(guess); t = guess - off(t);
  return new Date(t);
}
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const prettyDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const prettyTime = (t) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

const id = () => crypto.randomBytes(6).toString("hex");
const PLAN_REVIEW = { id: "plan-review", name: "Free 30-Minute Plan Review", minutes: 30, description: "Your reward for leaving a review: go over your plan and progress with Dr. Jared, and get direction on which programs to use next." };
const newToken = () => crypto.randomBytes(16).toString("hex");
const tokenMatches = (given, expected) => {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

function toCsv(rows, cols) {
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

function createApp(cfg = loadConfig()) {
  const store = createStore(cfg.dataDir, { key: cfg.dataKey });
  const notify = createNotifier({ apiKey: cfg.resendKey, from: cfg.notifyFrom, ownerEmail: cfg.notifyEmail || cfg.adminEmail, apiUrl: cfg.resendUrl });
  const cal = createCal({ apiKey: cfg.calKey, apiUrl: cfg.calUrl });
  const places = createPlaces({ apiKey: cfg.googleKey, baseUrl: cfg.googleUrl, legacyUrl: cfg.googleLegacyUrl });

  // ---- Google reviews: refreshed every 6 hours, last good copy kept on disk so the site
  // still shows them if Google is briefly unreachable. Failed fetches are retried after 10 minutes.
  let reviewsMem = { at: 0, data: null, error: "" };
  let reviewsInflight = null;
  async function googleReviews({ fresh = false } = {}) {
    if (!places.enabled) return null;
    const age = Date.now() - reviewsMem.at;
    if (!fresh && reviewsMem.at && age < (reviewsMem.data ? REVIEWS_CACHE_MS : REVIEWS_RETRY_MS)) return reviewsMem.data || store.read("googleReviews", null);
    if (reviewsInflight) return reviewsInflight;
    reviewsInflight = (async () => {
      try {
        let placeId = cfg.googlePlaceId || store.read("googlePlace", {}).id;
        if (!placeId) {
          const found = await places.findPlaceId(cfg.googleQuery);
          store.write("googlePlace", found);
          logger.info("google_place_found", { name: found.name, address: found.address });
          placeId = found.id;
        }
        const data = { ...(await places.details(placeId)), fetchedAt: new Date().toISOString() };
        store.write("googleReviews", data);
        reviewsMem = { at: Date.now(), data, error: "" };
        return data;
      } catch (err) {
        logger.warn("google_reviews_failed", { error: err.message });
        reviewsMem = { at: Date.now(), data: null, error: err.message };
        if (fresh) throw err;
        return store.read("googleReviews", null);
      } finally { reviewsInflight = null; }
    })();
    return reviewsInflight;
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  const authReady = Boolean(cfg.adminEmail && isValidHash(cfg.adminPasswordHash) && cfg.sessionSecret.length >= 32);

  // One-time update of saved settings to the Nov 2026 services, prices, plans and booking rules.
  // Saved settings override the defaults, so without this the live site would keep the old prices.
  (function migrateSettings() {
    const s = store.read("settings", null);
    if (!s || s.version >= 3) return;
    const d = defaultSettings();
    s.services = d.services; // picks up telehealth types/prices
    s.appointmentTypes = d.appointmentTypes;
    s.plans = { ...(s.plans || {}), gold: d.plans.gold, silver: d.plans.silver, silverPayments: d.plans.silverPayments, ext12: d.plans.ext12, ext24: d.plans.ext24 };
    s.scheduling = { ...(s.scheduling || {}), hours: d.scheduling.hours, lastStart: d.scheduling.lastStart, minNoticeHours: d.scheduling.minNoticeHours };
    s.business = { ...(s.business || {}), hours: d.business.hours };
    s.coach = { ...(s.coach || {}), title: d.coach.title };
    s.version = 3;
    store.write("settings", s);
  })();

  const settings = () => {
    const d = defaultSettings(), s = store.read("settings", {});
    return {
      ...d, ...s,
      business: { ...d.business, ...s.business }, coach: { ...d.coach, ...s.coach },
      rating: { ...d.rating, ...s.rating }, scheduling: { ...d.scheduling, ...s.scheduling }, booking: { ...d.booking, ...s.booking },
      plans: { ...d.plans, ...s.plans },
      // Saved appointment types from before Medical Massage existed get it added once
      appointmentTypes: s.appointmentTypes && !s.massageAdded && !s.appointmentTypes.some((t) => t.id === "massage")
        ? [...s.appointmentTypes, d.appointmentTypes.find((t) => t.id === "massage")] : (s.appointmentTypes || d.appointmentTypes)
    };
  };
  const classes = () => {
    let list = store.read("classes", null);
    if (list === null) {
      list = STARTER_CLASSES.map((c) => ({ id: id(), active: true, ...c }));
      store.write("classes", list);
    }
    return list;
  };
  const bookings = () => store.read("bookings", []);
  const appointments = () => store.read("appointments", []);
  const feedback = () => store.read("feedback", []);
  const leads = () => store.read("leads", []);
  const subscribers = () => store.read("subscribers", []);
  const cancelLink = (kind, rec) => cfg.siteUrl ? `${cfg.siteUrl}/cancel?kind=${kind}&id=${rec.id}&token=${rec.cancelToken}` : "";

  function activity(type, detail = {}) {
    const list = store.read("activity", []);
    list.unshift({ time: new Date().toISOString(), type, ...detail });
    store.write("activity", list.slice(0, ACTIVITY_MAX));
    logger.info("activity", { type, ...detail, email: detail.email ? mask(detail.email) : undefined });
    const rt = app.get("rt");
    if (rt) rt.emitActivity(type, detail);
  }

  // ---- Cal.com: username + event types for the embed. Cached in memory, last good copy kept on disk
  // so the booking page keeps working if Cal's API is briefly down.
  let calMem = { at: 0, data: null };
  async function calInfo(s = settings(), { fresh = false } = {}) {
    const b = s.booking;
    if (!fresh && calMem.data && Date.now() - calMem.at < CAL_CACHE_MS) return pickEvents(calMem.data, b);
    let data = store.read("calCache", null);
    if (cal.enabled) {
      try {
        const me = await cal.me();
        const username = b.calUsername || me.username;
        const types = await cal.eventTypes(username);
        data = {
          username,
          eventTypes: (Array.isArray(types) ? types : []).filter((t) => !t.hidden).map((t) => ({
            id: t.id, slug: t.slug, title: t.title, minutes: t.lengthInMinutes ?? t.length ?? null, description: t.description || ""
          })),
          fetchedAt: new Date().toISOString()
        };
        store.write("calCache", data);
      } catch (err) {
        logger.warn("cal_fetch_failed", { error: err.message });
        if (fresh) throw err;
      }
    }
    if (!data && b.calUsername) data = { username: b.calUsername, eventTypes: [] };
    calMem = { at: Date.now(), data };
    return pickEvents(data, b);
  }
  function pickEvents(data, b) {
    if (!data) return null;
    const username = b.calUsername || data.username;
    let types = data.eventTypes;
    if (b.calEventSlugs.length) {
      const known = new Map(types.map((t) => [t.slug, t]));
      types = b.calEventSlugs.map((slug) => known.get(slug) || { slug, title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), minutes: null, description: "" });
    }
    return { origin: "https://cal.com", username, eventTypes: types };
  }

  // Store a Cal booking as an MD Fit appointment so the admin, dashboard and built-in slots all see it.
  function upsertCalBooking(raw, statusOverride) {
    const b = normaliseBooking(raw);
    if (!b.uid || !b.start) return null;
    const local = nowParts(cfg.tz, new Date(b.start));
    const list = appointments();
    let appt = list.find((a) => a.calUid === b.uid);
    const cancelled = statusOverride === "cancelled" || ["cancelled", "rejected"].includes(b.status);
    const fields = {
      source: "cal", calUid: b.uid, typeId: b.eventSlug || "cal", typeName: b.title, minutes: b.minutes || 60,
      date: local.date, time: local.time, name: b.name, email: b.email, phone: b.phone, notes: b.notes
    };
    if (!appt) {
      appt = { id: id(), ...fields, areas: [], painLevel: null, status: cancelled ? "cancelled" : "booked", adminNotes: "", cancelToken: newToken(), createdAt: new Date().toISOString() };
      list.push(appt);
    } else {
      Object.assign(appt, fields, { updatedAt: new Date().toISOString() });
      if (cancelled) appt.status = "cancelled";
      else if (appt.status === "cancelled") appt.status = "booked";
    }
    store.write("appointments", list);
    return appt;
  }

  // ---- Group classes: upcoming sessions for the next `days` days, with spots left.
  function schedule(days = 7) {
    const { date: today, time: nowTime } = nowParts(cfg.tz, cfg.now());
    const active = classes().filter((c) => c.active !== false);
    const counts = new Map();
    for (const b of bookings()) counts.set(b.classId + "|" + b.date, (counts.get(b.classId + "|" + b.date) || 0) + 1);
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      for (const c of active.filter((x) => x.day === weekday(date))) {
        if (i === 0 && c.time <= nowTime) continue;
        const booked = counts.get(c.id + "|" + date) || 0;
        out.push({
          classId: c.id, date, dayName: DAYS[c.day], time: c.time, durationMin: c.durationMin, title: c.title,
          coach: c.coach, location: c.location, description: c.description, capacity: c.capacity,
          spotsLeft: Math.max(0, c.capacity - booked)
        });
      }
    }
    return out.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  }

  // ---- 1-on-1 appointments: open start times for one appointment type on one date.
  // One practitioner, so any live appointment blocks the time for every type.
  // ---- Calendar sync (Google Calendar two-way, SimplePractice feed read-only)
  const calsync = cfg.calsync || createCalSync({ serviceAccount: cfg.googleServiceAccount, calendarId: cfg.googleCalendarId, icsUrl: "", tz: cfg.tz, zonedToUtc, logger });
  const spUrl = () => (store.read("calsync", {}).icsUrl || cfg.simplePracticeIcs || "");
  function syncBooking(appt) {
    if (!calsync.googleOn()) return;
    calsync.addBooking(appt).then((eventId) => {
      if (!eventId) return;
      const l = appointments(), x = l.find((y) => y.id === appt.id); if (x) { x.googleEventId = eventId; store.write("appointments", l); }
    }).catch((e) => logger.error("gcal_add_failed", { error: e.message }));
  }
  function unsyncBooking(appt) {
    if (appt.googleEventId) calsync.removeBooking(appt.googleEventId).catch((e) => logger.error("gcal_remove_failed", { error: e.message }));
  }

  // Busy times from Google Calendar / SimplePractice, as [startMin, endMin] on a clinic date
  function busyOn(date, busy) {
    const out = [];
    for (const b of busy || []) {
      if (b.allDay) { if (b.date === date) out.push([0, 24 * 60]); continue; }
      const s0 = nowParts(cfg.tz, b.start), e0 = nowParts(cfg.tz, b.end);
      if (s0.date > date || e0.date < date) continue;
      out.push([s0.date < date ? 0 : toMin(s0.time), e0.date > date ? 24 * 60 : toMin(e0.time)]);
    }
    return out;
  }
  function openSlots(type, date, s = settings(), busy = []) {
    const sch = s.scheduling;
    const { date: today } = nowParts(cfg.tz, cfg.now());
    if (date < today || date > addDays(today, sch.daysAhead) || sch.blockedDates.includes(date)) return [];
    const cutoff = nowParts(cfg.tz, new Date(cfg.now().getTime() + sch.minNoticeHours * 3600e3));
    const taken = appointments().filter((a) => a.date === date && a.status !== "cancelled")
      .map((a) => [toMin(a.time), toMin(a.time) + a.minutes]).concat(busyOn(date, busy));
    const slots = [];
    for (const [start, end] of sch.hours[weekday(date)] || []) {
      for (let m = toMin(start); m + type.minutes <= toMin(end); m += sch.slotStepMin) {
        if (sch.lastStart && m > toMin(sch.lastStart)) break; // nothing starts after the latest start time
        const t = toTime(m);
        if (date + t <= cutoff.date + cutoff.time) continue;
        if (taken.some(([a, z]) => m < z && m + type.minutes > a)) continue;
        slots.push(t);
      }
    }
    return slots;
  }

  // ---- Security: real client IP, security headers, edge gate, bot filter, global rate limits
  const sec = createSecurity({ edgeSecret: cfg.edgeSecret, logger });
  app.disable("x-powered-by");
  app.use(sec.clientIp);
  app.use(sec.headers);
  app.use(sec.edgeGate);
  if (cfg.botFilter) app.use(sec.botFilter);
  // Signed-in: per account (240 / 10 s, 3,000 / 10 min). Anonymous: per IP (120 / 10 s, 1,500 / 10 min).
  const who = (req) => { const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i); const p = m && verifyToken(m[1], cfg.sessionSecret); return p && p.sub ? "acct:" + p.sub : null; };
  const keyed = (acct, anon) => (req) => { const a = who(req); return a ? { key: a, max: acct } : { key: "ip:" + req.ip, max: anon }; };
  app.use("/api", sec.rateLimit({ name: "burst", windowMs: 10 * 1000, keyOf: keyed(240, 120) }));
  app.use("/api", sec.rateLimit({ name: "steady", windowMs: 10 * 60 * 1000, keyOf: keyed(3000, 1500) }));

  // ---- Audit ledger (hash-chained, Ed25519-signed): recorded after each response
  const audit = createAudit({ store, signingKey: cfg.auditSigningKey, ipSalt: cfg.sessionSecret, logger });
  const QUIET = new Set(["GET /api/admin/me", "GET /api/admin/messages", "GET /api/admin/calsync", "GET /api/admin/audit"]);
  app.use((req, res, next) => {
    res.on("finish", () => {
      const p = (req.originalUrl || req.url).split("?")[0], m = req.method;
      if (m === "OPTIONS" || !p.startsWith("/api/")) return;
      // Route pattern (e.g. /api/admin/clients/:id) so entries never contain raw ids in the action name
      const base = p.startsWith("/api/admin") ? "/api/admin" : p.startsWith("/api/me") ? "/api/me" : "";
      const route = req.route ? (base && !String(req.baseUrl || "").startsWith(base) ? base : (req.baseUrl || "")) + req.route.path : p;
      const key = `${m} ${route}`, ok = res.statusCode < 400;
      const params = req.params || {};
      const subject = params.clientId || (route.includes("/clients/:id") ? params.id : "") || (req.client && req.client.id) || "";
      let actor = "", action = "";
      if (p === "/api/admin/login") { actor = "admin"; action = ok ? "auth.admin.login" : "auth.admin.login_failed"; }
      else if (p === "/api/clients/login") { actor = ok ? "client" : "anonymous"; action = ok ? "auth.client.login" : "auth.client.login_failed"; }
      else if (p === "/api/clients/signup" && ok) { actor = "client"; action = "auth.client.signup"; }
      else if (p === "/api/clients/reset" && ok) { actor = "client"; action = "auth.client.password_reset"; }
      else if (p === "/api/stripe/webhook" && ok) { actor = "stripe"; action = "payments.webhook"; }
      else if (req.admin && ok && !QUIET.has(key)) { actor = `admin:${req.admin}`; action = `admin.${m === "GET" ? "view" : "change"} ${route.replace("/api/admin", "")}`; }
      else if (req.client && ok && m !== "GET") { actor = `client:${req.client.id}`; action = `client.${route.replace("/api/me", "") || "/"}`; }
      if (!action) return;
      audit.record({ actor, action, subject, ip: req.ip, meta: { method: m, status: res.statusCode } });
    });
    next();
  });

  // Daily anchor: email the owner the ledger head and log it, so history can't be rewritten unnoticed
  function publishAnchor() {
    const a = audit.anchor();
    if (!a) return;
    logger.info("audit_anchor", { seq: a.seq, head: a.head, kid: a.kid });
    notify.owner(`MD Fit audit anchor · entry #${a.seq}`, `Keep this email. It proves the state of your patient-access audit log on ${a.at.slice(0, 10)}.\n\nEntry: #${a.seq}\nHash: ${a.head}\nKey: ${a.kid}\n\nTo check the log hasn't been rewritten: Admin → Audit → paste these into "Check an anchor".`);
  }
  let anchoredOn = "";
  const anchorTimer = setInterval(() => {
    const n = nowParts(cfg.tz, new Date());
    if (n.time >= "23:45" && anchoredOn !== n.date) { anchoredOn = n.date; publishAnchor(); }
  }, 5 * 60 * 1000);
  anchorTimer.unref();

  // ---- Headers, CORS, request log
  app.use(requestLogger);
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    const origin = req.get("origin");
    if (origin && (cfg.origins.includes("*") || cfg.origins.includes(origin))) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // Keep the raw body: Cal.com webhook signatures are computed over the exact bytes sent.
  app.use(express.json({ limit: "200kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

  // ---- Rate limiting (in memory, per IP)
  function limiter(max, windowMs) {
    const hits = new Map();
    const get = (ip) => {
      const now = Date.now();
      let r = hits.get(ip);
      if (!r || now > r.reset) { r = { n: 0, reset: now + windowMs }; hits.set(ip, r); }
      return r;
    };
    return {
      hit: (ip) => ++get(ip).n,
      blocked: (ip) => get(ip).n >= max,
      reset: (ip) => hits.delete(ip),
      mw: (req, res, next) => (get(req.ip).n++ >= max ? res.status(429).json({ error: "Too many requests. Try again later." }) : next())
    };
  }
  const formLimit = limiter(20, 60 * 60 * 1000);
  const loginFails = limiter(10, 15 * 60 * 1000);

  // Bots fill the hidden "company" field; pretend success and drop it.
  const honeypot = (req, res, next) => (req.body && req.body.company ? res.status(201).json({ ok: true }) : next());

  // ---- Auth: "Authorization: Bearer <token>" from /api/admin/login
  const NOT_SET_UP = "Admin login isn't set up on the server (ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET).";
  function requireAdmin(req, res, next) {
    if (!authReady) return res.status(503).json({ error: NOT_SET_UP });
    const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const payload = m && verifyToken(m[1], cfg.sessionSecret);
    if (!payload || payload.sub !== cfg.adminEmail) return res.status(401).json({ error: "Please log in again." });
    req.admin = payload.sub;
    next();
  }

  // ================= Public =================
  app.get("/", (req, res) => res.json({ name: "MD Fit API", ok: true }));
  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.get("/api/reviews", async (req, res) => {
    const g = await googleReviews();
    res.set("Cache-Control", "public, max-age=300");
    if (!g) return res.json({ source: "none" });
    const { placeId, fetchedAt, ...pub } = g;
    res.json({ source: "google", ...pub });
  });

  app.get("/api/site", async (req, res) => {
    const s = settings();
    const { scheduling, booking, massageAdded, version, ...pub } = s;
    const calData = booking.provider === "cal" ? await calInfo(s) : null;
    res.set("Cache-Control", "no-cache");
    res.json({
      settings: pub, timeZone: cfg.tz, googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim() || null,
      booking: { provider: calData ? "cal" : "builtin", cal: calData },
      options: { goals: GOALS, services: SERVICES.filter((x) => x !== "Group classes"), areas: AREAS, durations: DURATIONS, surgery: SURGERY },
      // kept for older frontends
      goals: GOALS, services: SERVICES
    });
  });

  // Cal.com webhook: Settings → Developer → Webhooks → Subscriber URL = <API>/api/cal/webhook
  app.post("/api/cal/webhook", (req, res) => {
    if (!cfg.calWebhookSecret) return res.status(503).json({ error: "CAL_WEBHOOK_SECRET is not set on the server." });
    if (!verifySignature(req.rawBody, req.get("x-cal-signature-256"), cfg.calWebhookSecret)) {
      logger.warn("cal_webhook_bad_signature", {});
      return res.status(401).json({ error: "Bad signature." });
    }
    const event = String(req.body?.triggerEvent || "");
    const payload = req.body?.payload || {};
    if (event === "PING") return res.json({ ok: true });
    const handled = {
      BOOKING_CREATED: () => upsertCalBooking(payload, "booked"),
      BOOKING_RESCHEDULED: () => {
        // Cal issues a new uid on reschedule; retire the old one.
        if (payload.rescheduleUid || payload.fromReschedule) {
          const list = appointments(), old = list.find((a) => a.calUid === (payload.rescheduleUid || payload.fromReschedule));
          if (old) { old.status = "cancelled"; old.updatedAt = new Date().toISOString(); store.write("appointments", list); }
        }
        return upsertCalBooking(payload, "booked");
      },
      BOOKING_CANCELLED: () => upsertCalBooking(payload, "cancelled"),
      BOOKING_REJECTED: () => upsertCalBooking(payload, "cancelled")
    }[event];
    if (!handled) return res.json({ ok: true, ignored: event });
    const appt = handled();
    if (appt) activity("cal_" + event.toLowerCase(), { email: appt.email, date: appt.date });
    res.json({ ok: true });
  });

  // ---- On-site reviews. Every review, whatever the rating, earns a discount on the first month of membership.
  // (Google and the FTC don't allow rewards tied to public or positive reviews, so the reward is for honest feedback here.)
  const reviewPct = () => (settings().plans || {}).reviewDiscountPct ?? 30;
  app.post("/api/feedback", formLimit.mw, honeypot, (req, res) => {
    const f = feedbackInput(req.body);
    const list = feedback();
    const code = "MDFIT-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const pct = reviewPct();
    const entry = { id: id(), ...f, status: "pending", rewardCode: code, rewardPct: pct, createdAt: new Date().toISOString() };
    list.push(entry);
    store.write("feedback", list);
    // Link the code to their account so the app applies it automatically
    const cls = store.read("clients", []), cl = cls.find((c) => c.email === f.email.toLowerCase());
    if (cl && !cl.reviewCode) { cl.reviewCode = code; store.write("clients", cls); }
    activity("feedback", { email: f.email, rating: f.rating });
    const biz = settings().business;
    const subUrl = `${cfg.siteUrl}/account#premium`;
    notify.owner(`New review: ${f.rating}/5 from ${f.name}`, `${f.name} <${f.email}>\n${"★".repeat(f.rating)}${"☆".repeat(5 - f.rating)}\n\n${f.text}\n\n${f.publish ? "OK to publish (approve it in Admin → Reviews)." : "Private: do not publish."}\nReward code: ${code} (${pct}% off first month)`);
    notify.client(f.email, `Thank you! ${pct}% off your first month`, `Hi ${f.name.split(" ")[0]},\n\nThank you for your feedback. As promised, here's ${pct}% off your first month of MD Fit membership: unlimited workouts, every program, custom plans and messaging with Dr. Jared.\n\nYour code: ${code}\nUse it here: ${subUrl}\n\n${biz.name}\n${biz.phone}`);
    res.status(201).json({ ok: true, rewardCode: code, rewardPct: pct, subscribeUrl: subUrl, message: `Thank you! Here's ${pct}% off your first month.` });
  });
  app.get("/api/feedback", (req, res) => {
    const pub = feedback().filter((f) => f.status === "approved" && f.publish)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30)
      .map((f) => { const [first, last = ""] = f.name.split(/\s+/); return { name: first + (last ? ` ${last[0]}.` : ""), rating: f.rating, text: f.text, date: f.createdAt.slice(0, 10) }; });
    const n = pub.length;
    res.set("Cache-Control", "no-cache");
    res.json({ reviews: pub, count: n, average: n ? Math.round((pub.reduce((s, f) => s + f.rating, 0) / n) * 10) / 10 : null,
      reward: { pct: reviewPct(), title: `${reviewPct()}% off your first month` } });
  });
  app.get("/api/feedback/reward/:code", (req, res) => {
    const f = feedback().find((x) => x.rewardCode === String(req.params.code).toUpperCase());
    if (!f) return res.status(404).json({ error: "That reward code isn't valid." });
    res.json({ valid: !f.rewardUsedAt, used: !!f.rewardUsedAt, pct: f.rewardPct ?? reviewPct(), name: f.name, email: f.email, type: PLAN_REVIEW });
  });

  // Native apps check this on launch: API version, the oldest app build still supported, and which features are on
  app.get("/api/app/config", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({ apiVersion: 1, minIosBuild: Number(env("MIN_IOS_BUILD", "1")) || 1, timeZone: cfg.tz,
      features: { payments: !!((cfg.stripeClient || process.env.STRIPE_SECRET_KEY) && (cfg.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET)), healthSync: true, liveQa: true, bluetoothHeartRate: true, googleCalendar: false },
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      googleClientId: process.env.GOOGLE_CLIENT_ID || "" });
  });

  app.get("/api/availability", async (req, res) => {
    const s = settings();
    const type = s.appointmentTypes.find((t) => t.id === req.query.type) || (req.query.type === PLAN_REVIEW.id ? PLAN_REVIEW : s.appointmentTypes[0]);
    const { date: today } = nowParts(cfg.tz, cfg.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") && req.query.from > today ? req.query.from : today;
    const days = Math.min(31, Math.max(1, Number.parseInt(req.query.days, 10) || 14));
    const busy = await calsync.busy(from, addDays(from, days - 1), { icsUrl: spUrl() });
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i);
      out.push({ date, slots: openSlots(type, date, s, busy) });
    }
    res.set("Cache-Control", "no-cache");
    res.json({ timeZone: cfg.tz, type, lastDate: addDays(today, s.scheduling.daysAhead), days: out });
  });

  app.post("/api/appointments", formLimit.mw, honeypot, async (req, res) => {
    const a = appointmentInput(req.body);
    const s = settings();
    const type = s.appointmentTypes.find((t) => t.id === a.typeId) || (a.typeId === PLAN_REVIEW.id ? PLAN_REVIEW : null);
    if (!type) return res.status(400).json({ error: "Pick an appointment type." });
    // The free plan review is a reward: it needs an unused code from a submitted review
    let reward = null;
    const fb = type === PLAN_REVIEW ? feedback() : null;
    if (fb) {
      const code = String((req.body && req.body.rewardCode) || "").trim().toUpperCase();
      reward = fb.find((f) => f.rewardCode === code);
      if (!reward) return res.status(400).json({ error: "That reward code isn't valid. Check the email we sent you." });
      if (reward.rewardUsedAt) return res.status(409).json({ error: "That reward code has already been used." });
    }
    const busy = await calsync.busy(a.date, a.date, { icsUrl: spUrl() });
    if (!openSlots(type, a.date, s, busy).includes(a.time))
      return res.status(409).json({ error: "That time was just taken or isn't available. Pick another." });
    const appt = {
      id: id(), ...a, typeName: type.name, minutes: type.minutes, status: "booked", adminNotes: "",
      cancelToken: newToken(), createdAt: new Date().toISOString()
    };
    if (reward) { reward.rewardUsedAt = new Date().toISOString(); appt.rewardCode = reward.rewardCode; store.write("feedback", fb); }
    const list = appointments();
    list.push(appt);
    store.write("appointments", list);
    activity("appointment", { email: a.email, type: type.id, date: a.date });
    const rt = app.get("rt"); if (rt) rt.emitBookingUpdate(a.date);
    syncBooking(appt);

    const when = `${prettyDate(a.date)} at ${prettyTime(a.time)}`;
    const biz = s.business;
    const isMassage = MASSAGE_TYPES.includes(type.id);
    const intakeUrl = isMassage && cfg.siteUrl ? `${cfg.siteUrl}/intake?id=${appt.id}&token=${appt.cancelToken}` : "";
    // Health details (pain areas, pain level, notes) stay out of email; they're in Admin → Appointments.
    notify.owner(`New booking: ${type.name}, ${when}`,
      [`${a.name}\n${a.email}\n${a.phone}`, `${type.name} (${type.minutes} min)\n${when}`,
        `Details are in Admin → Appointments:\n${cfg.siteUrl || ""}/admin`].join("\n\n"));
    const link = cancelLink("appointment", appt);
    notify.client(a.email, `You're booked: ${type.name}, ${when}`,
      `Hi ${a.name.split(" ")[0]},\n\nYou're booked at ${biz.name} for ${type.name} (${type.minutes} min) on ${when}.\n\n` +
      `${biz.address}\n${biz.phone}\n\n` +
      (isMassage ? `Before your massage, please fill out the short intake form (about 3 minutes):\n${intakeUrl}`
        : type.remote ? `This visit is on video. Dr. Jared will send you a secure meeting link before your appointment. Please join from a quiet, private room so you can show the movements he asks about.`
        : `Please wear comfortable clothes you can move in.`) +
      (link ? `\n\nNeed to cancel? Please give at least 24 hours' notice: ${link}` : "") + `\n\n${biz.name}`);

    res.status(201).json({
      ok: true,
      appointment: { id: appt.id, typeId: type.id, typeName: type.name, minutes: type.minutes, date: a.date, time: a.time, cancelToken: appt.cancelToken, intake: isMassage },
      message: `You're booked: ${type.name}, ${when}.`
    });
  });

  app.post("/api/appointments/:id/cancel", formLimit.mw, (req, res) => {
    const list = appointments();
    const appt = list.find((x) => x.id === req.params.id);
    if (!appt || !tokenMatches(req.body && req.body.token, appt.cancelToken) || appt.status === "cancelled")
      return res.status(404).json({ error: "Appointment not found or already cancelled." });
    appt.status = "cancelled";
    appt.cancelledAt = new Date().toISOString();
    store.write("appointments", list);
    unsyncBooking(appt);
    activity("appointment_cancelled", { email: appt.email, date: appt.date });
    const rt = app.get("rt"); if (rt) rt.emitBookingUpdate(appt.date);
    notify.owner(`Cancelled: ${appt.typeName}, ${prettyDate(appt.date)} at ${prettyTime(appt.time)}`, `${appt.name} (${appt.email}) cancelled online.`);
    res.json({ ok: true });
  });

  app.get("/api/schedule", (req, res) => {
    const days = Math.min(CLASS_BOOK_AHEAD_DAYS, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
    res.set("Cache-Control", "no-cache");
    res.json({ timeZone: cfg.tz, sessions: schedule(days) });
  });

  app.post("/api/leads", formLimit.mw, honeypot, (req, res) => {
    const lead = { id: id(), ...leadInput(req.body), status: "new", notes: "", createdAt: new Date().toISOString() };
    const list = leads();
    list.unshift(lead);
    store.write("leads", list);
    activity("lead", { email: lead.email, service: lead.service });
    notify.owner(`New evaluation request: ${lead.name}`, [
      `${lead.name}\n${lead.email}\n${lead.phone || "(no phone)"}`,
      `Service: ${lead.service}\nGoal: ${lead.goal}`,
      lead.areas.length && `Where: ${lead.areas.join(", ")}`,
      lead.painLevel !== null && `Pain: ${lead.painLevel}/10`,
      lead.duration && `How long: ${lead.duration}`,
      lead.surgery && `Surgery: ${lead.surgery}`,
      lead.preferredTime && `Best time: ${lead.preferredTime}`,
      lead.message
    ].filter(Boolean).join("\n\n"));
    res.status(201).json({ ok: true, message: "Thanks! We'll call you within one business day to get you started." });
  });

  app.post("/api/bookings", formLimit.mw, honeypot, (req, res) => {
    const b = bookingInput(req.body);
    const session = schedule(CLASS_BOOK_AHEAD_DAYS).find((s) => s.classId === b.classId && s.date === b.date);
    if (!session) return res.status(404).json({ error: "That class isn't open for booking. Pick another time." });
    const list = bookings();
    if (list.some((x) => x.classId === b.classId && x.date === b.date && x.email === b.email))
      return res.status(409).json({ error: "You're already booked for this class." });
    if (session.spotsLeft <= 0) return res.status(409).json({ error: "This class is full. Pick another time." });
    const booking = { id: id(), ...b, title: session.title, time: session.time, cancelToken: newToken(), createdAt: new Date().toISOString() };
    list.push(booking);
    store.write("bookings", list);
    activity("booking", { email: b.email, classId: b.classId, date: b.date });
    const when = `${prettyDate(b.date)} at ${prettyTime(session.time)}`;
    const link = cancelLink("class", booking);
    notify.client(b.email, `You're in: ${session.title}, ${when}`,
      `Hi ${b.name.split(" ")[0]},\n\nYour spot in ${session.title} on ${when} is saved.` + (link ? `\n\nCan't make it? ${link}` : ""));
    res.status(201).json({
      ok: true,
      booking: { id: booking.id, title: booking.title, date: booking.date, time: booking.time, minutes: session.durationMin, cancelToken: booking.cancelToken },
      message: `You're in: ${session.title}, ${when}.`
    });
  });

  app.post("/api/bookings/:id/cancel", formLimit.mw, (req, res) => {
    const list = bookings();
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0 || !tokenMatches(req.body && req.body.token, list[i].cancelToken)) return res.status(404).json({ error: "Booking not found." });
    const [gone] = list.splice(i, 1);
    store.write("bookings", list);
    activity("booking_cancelled", { email: gone.email, classId: gone.classId, date: gone.date });
    res.json({ ok: true });
  });

  app.post("/api/subscribe", formLimit.mw, honeypot, (req, res) => {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email." });
    const list = subscribers();
    if (!list.some((s) => s.email === email)) {
      list.push({ email, createdAt: new Date().toISOString() });
      store.write("subscribers", list);
      activity("subscribe", { email });
    }
    res.status(201).json({ ok: true, message: "You're on the list." });
  });

  // ================= Admin =================
  // ---- Admin two-step login by EMAIL code (Resend). No authenticator app, no recovery codes.
  // A 6-digit code is emailed after the password checks out; it expires in 10 minutes, works once, 5 tries max.
  // Emergency switch: ADMIN_MFA=off in the host's variables turns it off (e.g. if email is down).
  const mfaState = () => store.read("admin-mfa", { enabled: false });
  const mfaOn = () => !cfg.mfaForceOff && notify.enabled && mfaState().enabled === true && mfaState().method === "email";
  const pendingCodes = new Map(); // purpose -> { hash, exp, tries, sentAt }
  const codeHash = (c) => crypto.createHash("sha256").update("mdfit-mfa:" + cfg.sessionSecret + ":" + c).digest("hex");
  async function emailCode(purpose) {
    const prev = pendingCodes.get(purpose);
    if (prev && Date.now() - prev.sentAt < 30000) return true; // don't resend within 30 s
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    pendingCodes.set(purpose, { hash: codeHash(code), exp: Date.now() + 10 * 60e3, tries: 0, sentAt: Date.now() });
    return notify.client(cfg.adminEmail, `${code} is your MD Fit admin code`, `Your MD Fit admin sign-in code is:\n\n${code}\n\nIt expires in 10 minutes. If you didn't try to sign in, someone has your password: change it right away.\n\nMD Fit`);
  }
  function checkCode(purpose, code) {
    const p = pendingCodes.get(purpose);
    if (!p || Date.now() > p.exp || p.tries >= 5) { pendingCodes.delete(purpose); return false; }
    p.tries++;
    const ok = crypto.timingSafeEqual(Buffer.from(p.hash), Buffer.from(codeHash(String(code || "").trim())));
    if (ok) pendingCodes.delete(purpose);
    return ok;
  }

  app.post("/api/admin/login", (req, res) => {
    if (!authReady) return res.status(503).json({ error: NOT_SET_UP });
    if (loginFails.blocked(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    const ok = email === cfg.adminEmail && verifyPassword(password, cfg.adminPasswordHash);
    if (!ok) {
      loginFails.hit(req.ip);
      logger.warn("login_failed", { email: mask(email || "-") });
      return res.status(401).json({ error: "Wrong email or password." });
    }
    if (mfaOn()) {
      if (!req.body.code) {
        emailCode("login");
        return res.status(401).json({ error: `We emailed a 6-digit code to ${mask(cfg.adminEmail)}. Enter it to finish signing in.`, mfaRequired: true });
      }
      if (!checkCode("login", req.body.code)) {
        loginFails.hit(req.ip);
        logger.warn("mfa_failed", { email: mask(email) });
        return res.status(401).json({ error: "That code didn't work or has expired. Leave the code blank and sign in again for a new one.", mfaRequired: true });
      }
    }
    loginFails.reset(req.ip);
    const exp = Date.now() + SESSION_HOURS * 3600e3;
    activity("login", { email });
    res.json({ token: signToken({ sub: email, exp }, cfg.sessionSecret), expiresAt: new Date(exp).toISOString() });
  });

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get("/me", (req, res) => res.json({ email: req.admin, emailNotifications: notify.enabled, mfa: mfaOn() }));
  admin.get("/online", (req, res) => { const rt = app.get("rt"); res.json(rt ? rt.onlineStats() : { members: [], memberCount: 0, visitorCount: 0 }); });
  admin.get("/mfa", (req, res) => res.json({ enabled: mfaOn(), method: "email", emailReady: notify.enabled, forcedOff: !!cfg.mfaForceOff, sendsTo: mask(cfg.adminEmail) }));
  admin.post("/mfa/start", async (req, res) => {
    if (!notify.enabled) return res.status(503).json({ error: "Email isn't connected yet (RESEND_API_KEY and NOTIFY_FROM)." });
    const sent = await emailCode("enable");
    if (!sent) return res.status(502).json({ error: "Couldn't send the email. Check the Resend settings." });
    res.json({ sent: true, to: mask(cfg.adminEmail) });
  });
  admin.post("/mfa/confirm", (req, res) => {
    if (!checkCode("enable", req.body && req.body.code)) return res.status(400).json({ error: "That code didn't match or has expired." });
    store.write("admin-mfa", { enabled: true, method: "email", enabledAt: new Date().toISOString() });
    res.json({ enabled: true });
  });
  admin.post("/mfa/disable", (req, res) => {
    if (!verifyPassword(String((req.body && req.body.password) || ""), cfg.adminPasswordHash)) return res.status(401).json({ error: "Password is wrong." });
    store.write("admin-mfa", { enabled: false });
    res.json({ enabled: false });
  });;

  admin.get("/stats", (req, res) => {
    const { date: today } = nowParts(cfg.tz, cfg.now());
    const weekEnd = addDays(today, 6);
    const l = leads(), up = schedule(7);
    const live = appointments().filter((a) => a.status === "booked" && a.date >= today)
      .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
    const monthAgo = addDays(today, -30);
    return res.json({
      leadsNew: l.filter((x) => x.status === "new").length,
      leadsTotal: l.length,
      leads30d: l.filter((x) => x.createdAt.slice(0, 10) >= monthAgo).length,
      appointmentsToday: live.filter((a) => a.date === today).length,
      appointmentsWeek: live.filter((a) => a.date <= weekEnd).length,
      subscribers: subscribers().length,
      bookingsThisWeek: up.reduce((n, s) => n + (s.capacity - s.spotsLeft), 0),
      sessionsThisWeek: up.length,
      today: live.filter((a) => a.date === today).map(({ cancelToken, ...a }) => a),
      nextAppointments: live.slice(0, 8).map(({ cancelToken, ...a }) => a),
      upcoming: up.slice(0, 10)
    });
  });

  admin.get("/settings", (req, res) => res.json(settings()));
  admin.put("/settings", (req, res) => {
    const s = mergeSettings(settings(), req.body);
    store.write("settings", s);
    activity("settings", { sections: Object.keys(req.body) });
    res.json(s);
  });

  // Google reviews
  admin.post("/reviews/refresh", async (req, res) => {
    if (!places.enabled) return res.status(503).json({ error: "Add GOOGLE_PLACES_API_KEY in Railway to show Google reviews." });
    try {
      const g = await googleReviews({ fresh: true });
      res.json({ ok: true, api: places.mode, name: g.name, rating: g.rating, count: g.count, reviews: g.reviews.length, fetchedAt: g.fetchedAt });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Cal.com
  admin.get("/cal/status", async (req, res) => {
    const s = settings();
    const out = { keySet: cal.enabled, webhookSecretSet: Boolean(cfg.calWebhookSecret), provider: s.booking.provider, connected: false };
    if (!cal.enabled) return res.json({ ...out, message: "Add CAL_API_KEY in Railway to connect Cal.com." });
    try {
      const me = await cal.me();
      const info = await calInfo(s, { fresh: true });
      res.json({ ...out, connected: true, username: me.username, name: me.name, timeZone: me.timeZone, eventTypes: info.eventTypes });
    } catch (err) {
      res.json({ ...out, message: err.message });
    }
  });
  admin.post("/cal/sync", async (req, res) => {
    let list;
    try { list = await cal.bookings("upcoming"); } catch (err) { return res.status(502).json({ error: err.message }); }
    const seen = (Array.isArray(list) ? list : []).map((b) => upsertCalBooking(b)).filter(Boolean);
    activity("cal_sync", { count: seen.length });
    res.json({ ok: true, synced: seen.length });
  });

  // Appointments
  admin.get("/appointments", (req, res) => {
    const { date: today } = nowParts(cfg.tz, cfg.now());
    const all = req.query.all === "1";
    res.json(appointments().filter((a) => all || (a.date >= today && a.status !== "cancelled"))
      .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1) * (all ? -1 : 1))
      .map(({ cancelToken, ...a }) => a));
  });
  admin.patch("/appointments/:id", async (req, res) => {
    const list = appointments();
    const appt = list.find((x) => x.id === req.params.id);
    if (!appt) return res.status(404).json({ error: "Appointment not found." });
    const b = req.body || {};
    if (b.status !== undefined) {
      if (!APPT_STATUSES.includes(b.status)) return res.status(400).json({ error: "Unknown status." });
      // Cancelling a Cal booking here cancels it in Cal too, so Cal emails the client and frees the slot.
      if (b.status === "cancelled" && appt.status !== "cancelled" && appt.source === "cal") {
        try { await cal.cancel(appt.calUid, "Cancelled by MD Fit"); } catch (err) { return res.status(502).json({ error: err.message }); }
      }
      if (b.status === "cancelled" && appt.status !== "cancelled") unsyncBooking(appt);
      appt.status = b.status;
    }
    if (b.adminNotes !== undefined) {
      if (typeof b.adminNotes !== "string" || b.adminNotes.length > 4000) return res.status(400).json({ error: "Notes must be text up to 4000 characters." });
      appt.adminNotes = b.adminNotes;
    }
    appt.updatedAt = new Date().toISOString();
    store.write("appointments", list);
    const { cancelToken, ...out } = appt;
    res.json(out);
  });
  admin.get("/appointments.csv", (req, res) => {
    res.type("text/csv").attachment("mdfit-appointments.csv")
      .send(toCsv(appointments(), ["date", "time", "typeName", "minutes", "name", "email", "phone", "areas", "painLevel", "notes", "status", "adminNotes", "createdAt"]));
  });

  // Audit ledger: recent entries, filters, and full chain verification
  admin.post("/audit/anchor", (req, res) => { publishAnchor(); res.json({ anchors: audit.anchors().slice(-5).reverse() }); });
  admin.get("/audit", (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    res.json({ entries: audit.list({ limit, subject: req.query.subject || undefined, action: req.query.action || undefined }), publicKey: audit.publicPem, fingerprint: audit.fingerprint });
  });
  admin.get("/audit/verify", (req, res) => {
    const v = audit.verify();
    if (req.query.seq && req.query.head) v.anchor = audit.checkAnchor(req.query.seq, req.query.head);
    res.json({ ...v, anchors: audit.anchors().slice(-30).reverse() });
  });

  // Calendar sync status + SimplePractice feed link (kept on the server, encrypted at rest, never sent to the public site)
  admin.get("/calsync", (req, res) => {
    const u = spUrl();
    res.json({ ...calsync.status(), simplepractice: u ? "configured" : "off", simplePracticeUrl: u ? u.replace(/(.{24}).+(.{6})$/, "$1…$2") : "" });
  });
  admin.put("/calsync", (req, res) => {
    const u = String((req.body && req.body.icsUrl) || "").trim();
    if (u && !/^(https|webcal):\/\/[^\s]+$/i.test(u)) return res.status(400).json({ error: "Paste the SimplePractice calendar link (starts with https:// or webcal://)." });
    store.write("calsync", { icsUrl: u.replace(/^webcal:/i, "https:") });
    calsync.clear();
    res.json({ ok: true, simplepractice: u ? "configured" : "off" });
  });
  admin.post("/calsync/test", async (req, res) => {
    const { date } = nowParts(cfg.tz, cfg.now());
    calsync.clear();
    const busy = await calsync.busy(date, addDays(date, 13), { icsUrl: spUrl() });
    res.json({ ...calsync.status(), busyNext14Days: busy.length, bySource: busy.reduce((m, b) => ((m[b.source] = (m[b.source] || 0) + 1), m), {}) });
  });

  // Reviews submitted on the site: approve to publish (only those who agreed), or hide
  admin.get("/feedback", (req, res) => res.json([...feedback()].reverse()));
  admin.patch("/feedback/:id", (req, res) => {
    const list = feedback();
    const f = list.find((x) => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: "Review not found." });
    const st = req.body && req.body.status;
    if (!["pending", "approved", "hidden"].includes(st)) return res.status(400).json({ error: "Status must be pending, approved or hidden." });
    if (st === "approved" && !f.publish) return res.status(400).json({ error: "This person asked to keep their review private." });
    f.status = st;
    store.write("feedback", list);
    res.json(f);
  });

  // Leads
  admin.get("/leads", (req, res) => {
    const status = req.query.status;
    res.json(status ? leads().filter((x) => x.status === status) : leads());
  });
  admin.patch("/leads/:id", (req, res) => {
    const list = leads();
    const lead = list.find((x) => x.id === req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    const b = req.body || {};
    if (b.status !== undefined) {
      if (!LEAD_STATUSES.includes(b.status)) return res.status(400).json({ error: "Unknown status." });
      lead.status = b.status;
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== "string" || b.notes.length > 4000) return res.status(400).json({ error: "Notes must be text up to 4000 characters." });
      lead.notes = b.notes;
    }
    lead.updatedAt = new Date().toISOString();
    store.write("leads", list);
    res.json(lead);
  });
  admin.delete("/leads/:id", (req, res) => {
    const list = leads();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "Lead not found." });
    store.write("leads", next);
    res.json({ ok: true });
  });
  admin.get("/leads.csv", (req, res) => {
    res.type("text/csv").attachment("mdfit-leads.csv").send(toCsv(leads(),
      ["createdAt", "name", "email", "phone", "service", "goal", "areas", "painLevel", "duration", "surgery", "preferredTime", "referral", "message", "status", "notes"]));
  });

  // Classes
  admin.get("/classes", (req, res) => res.json(classes()));
  admin.post("/classes", (req, res) => {
    const c = { id: id(), active: true, ...classInput(req.body) };
    const list = classes();
    list.push(c);
    store.write("classes", list);
    activity("class_created", { classId: c.id, title: c.title });
    res.status(201).json(c);
  });
  admin.put("/classes/:id", (req, res) => {
    const list = classes();
    const c = list.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Class not found." });
    Object.assign(c, classInput(req.body, { partial: true }));
    store.write("classes", list);
    res.json(c);
  });
  admin.delete("/classes/:id", (req, res) => {
    const list = classes();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "Class not found." });
    store.write("classes", next);
    store.write("bookings", bookings().filter((b) => b.classId !== req.params.id));
    activity("class_deleted", { classId: req.params.id });
    res.json({ ok: true });
  });

  // Class bookings
  admin.get("/bookings", (req, res) => {
    const { date: today } = nowParts(cfg.tz, cfg.now());
    const all = req.query.all === "1";
    res.json(bookings().filter((b) => all || b.date >= today)
      .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))
      .map(({ cancelToken, ...b }) => b));
  });
  admin.delete("/bookings/:id", (req, res) => {
    const list = bookings();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "Booking not found." });
    store.write("bookings", next);
    res.json({ ok: true });
  });

  // Subscribers
  admin.get("/subscribers", (req, res) => res.json(subscribers()));
  admin.delete("/subscribers/:email", (req, res) => {
    const email = req.params.email.toLowerCase();
    const list = subscribers();
    const next = list.filter((s) => s.email !== email);
    if (next.length === list.length) return res.status(404).json({ error: "Subscriber not found." });
    store.write("subscribers", next);
    res.json({ ok: true });
  });
  admin.get("/subscribers.csv", (req, res) => {
    res.type("text/csv").attachment("mdfit-subscribers.csv").send(toCsv(subscribers(), ["email", "createdAt"]));
  });

  admin.get("/activity", (req, res) => res.json(store.read("activity", []).slice(0, 200)));

  const cl = mountClients({ app, admin, store, cfg, notify, cal, nowParts, activity, limiter, logger, mask, prettyDate, prettyTime, settings, onCancel: (a) => unsyncBooking(a) });
  mountContent({ app, admin, store, notify, activity, ...cl });
  mountMessages({ app, admin, store, notify, activity, cfg, limiter, ...cl });
  mountIntake({ app, admin, store, cfg, notify, activity, limiter, appointments, tokenMatches, prettyDate, prettyTime });
  mountFeedbackReports({ app, admin, store, me: cl.me, cfg, notify, activity, limiter });
  mountAnalytics({ app, admin, store, limiter });
  mountVideos({ app, admin, store, cfg, logger: typeof logger !== "undefined" ? logger : null });
  mountSearch({ app, admin, store, limiter, logger: typeof logger !== "undefined" ? logger : null });
  const pay = mountPayments({ app, admin, store, notify, activity, cfg, settings, logger, ...cl });

  app.use("/api/admin", admin);

  // ---- 404 + errors
  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
    logger.error("server_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "Something went wrong. Try again." });
  });

  return app;
}

if (require.main === module) {
  const http = require("http");
  const cfg = loadConfig();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp(cfg);
  const server = http.createServer(app);
  const rt = createRealtime(server, cfg);
  app.set("rt", rt);
  server.listen(port, () => logger.info("listening", { port, dataDir: cfg.dataDir, tz: cfg.tz, origins: cfg.origins, email: Boolean(cfg.resendKey && cfg.notifyFrom) }));
}

module.exports = { createApp, loadConfig, nowParts, addDays, weekday, toCsv };
