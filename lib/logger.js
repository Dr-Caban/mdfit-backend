// Structured JSON logs (one line per event). Railway shows these under Deployments → Logs.
// Never pass secrets in here; emails are masked with mask().
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const logger = {
  level: LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info,
  sink: (line) => process.stdout.write(line + "\n"),
  log(level, msg, fields = {}) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    this.sink(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  },
  debug(m, f) { this.log("debug", m, f); },
  info(m, f) { this.log("info", m, f); },
  warn(m, f) { this.log("warn", m, f); },
  error(m, f) { this.log("error", m, f); }
};

// fan@example.com -> f**@example.com
const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, (_, a, b) => a + "**" + b);

// Express middleware: one line per request with method, path (no query string), status, duration
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger.log(level, "request", { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10 });
  });
  next();
}

module.exports = { logger, mask, requestLogger, LEVELS };
