// Structured JSON logs (one line per event). Railway shows these under Deployments → Logs.
// Never pass secrets in here; emails are masked with mask().
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const logger = {
  level: LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info,
  sink: (line) => process.stdout.write(line + "\n"),
  log(level, msg, fields = {}) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
    this.sink(line);
    // Extra destinations (the on-volume activity log). A failing tee must never break logging.
    if (this.tee) { try { this.tee(line); } catch {} }
  },
  tee: null,
  debug(m, f) { this.log("debug", m, f); },
  info(m, f) { this.log("info", m, f); },
  warn(m, f) { this.log("warn", m, f); },
  error(m, f) { this.log("error", m, f); }
};

// fan@example.com -> f**@example.com
const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, (_, a, b) => a + "**" + b);
// The same for a set of log fields, whatever each field is called: a client's earlier address is logged as
// "previousEmail", and only the field named "email" used to be masked. Every email address in a text value is masked.
const maskEmails = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, typeof v === "string" ? v.replace(/[^\s@]+@[^\s@]+/g, mask) : v]));

// The path as it goes in a log line: the whole path, never the query string, with whatever is private in it blanked.
// While a route under "/api/me" or "/api/admin" is answering, Express keeps that prefix in req.baseUrl and leaves
// req.path without it, so the two are put back together (the same route names exist under both). Not
// req.originalUrl: that is the address exactly as it was sent, private parts and query string included.
// Express matches a route whatever the letter case, so the blanking does too.
function logPath(req) {
  // A shared link's key (and a calendar feed's) is the only thing protecting the note or the shared program/workout
  // behind it; a subscriber's email and a device's push token are private too. The forms without "/api/..." in
  // front are what req.path holds once the mount point is stripped.
  const rest = String(req.path || "").replace(/^(\/api\/board\/shared\/)[^/]+/i, "$1[key]").replace(/^(\/shared\/)[^/]+(\/?)$/i, "$1[key]$2")
    .replace(/^((?:\/api(?:\/me)?)?\/shares\/)[^/]+/i, "$1[key]")
    .replace(/^((?:\/api)?\/calendar-feed\/)[^/]+/i, "$1[key]") // a member's private calendar link (lib/member-calendar.js)
    .replace(/^((?:\/api\/(?:admin|me))?\/(?:subscribers|devices)\/)[^/]+/i, "$1[hidden]");
  const base = req.baseUrl || "";
  return base && rest === "/" ? base : base + rest; // "/api/me", not "/api/me/"
}

// Express middleware: one line per request with method, path (no query string), status, duration
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger.log(level, "request", { method: req.method, path: logPath(req), status: res.statusCode, ms: Math.round(ms * 10) / 10 });
  });
  next();
}

module.exports = { logger, mask, maskEmails, logPath, requestLogger, LEVELS };
