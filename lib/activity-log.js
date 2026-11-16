// Long-term activity log. Railway keeps service logs for 7 days only; this keeps every structured log line
// (requests, warnings, errors, restarts) on the data volume, one file per UTC day, for LOG_KEEP_DAYS (default 90).
// Lines are the same PHI-free JSON the logger already writes to stdout (paths without query strings, emails masked).
// With DATA_ENC_KEY set, each line is encrypted at rest (AES-256-GCM), like the rest of the store.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PREFIX = "enc:v1:";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function createActivityLog({ dir, key = "", keepDays = 90, now = () => new Date() }) {
  const K = key ? crypto.scryptSync(String(key), "mdfit-activity-log-v1", 32) : null;
  const seal = (text) => {
    if (!K) return text;
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", K, iv);
    const out = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
  };
  const open = (raw) => {
    if (!raw.startsWith(PREFIX)) return raw;
    if (!K) return null;
    try {
      const b = Buffer.from(raw.slice(PREFIX.length), "base64");
      const d = crypto.createDecipheriv("aes-256-gcm", K, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    } catch { return null; }
  };
  const file = (day) => path.join(dir, day + ".log");
  let ready = false, lastPrune = "";

  function prune(today) {
    if (lastPrune === today) return;
    lastPrune = today;
    const cutoff = new Date(Date.parse(today) - keepDays * 86_400_000).toISOString().slice(0, 10);
    for (const day of days().map((d) => d.date)) if (day < cutoff) { try { fs.unlinkSync(file(day)); } catch {} }
  }

  // Never throws: losing one archived line must not take a request down with it
  function append(line) {
    try {
      if (!ready) { fs.mkdirSync(dir, { recursive: true }); ready = true; }
      const today = now().toISOString().slice(0, 10);
      fs.appendFileSync(file(today), seal(String(line).replace(/\n/g, " ")) + "\n", { mode: 0o600 });
      prune(today);
    } catch {}
  }

  function days() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => n.endsWith(".log") && DAY_RE.test(n.slice(0, 10)))
      .map((n) => ({ date: n.slice(0, 10), bytes: fs.statSync(path.join(dir, n)).size }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Parsed entries for one day; lines that can't be decrypted or parsed are counted, not dropped silently
  function read(day) {
    if (!DAY_RE.test(day)) return { entries: [], unreadable: 0 };
    let raw = "";
    try { raw = fs.readFileSync(file(day), "utf8"); } catch { return { entries: [], unreadable: 0 }; }
    const entries = []; let unreadable = 0;
    for (const l of raw.split("\n")) {
      if (!l) continue;
      const t = open(l);
      let e = null;
      try { e = t == null ? null : JSON.parse(t); } catch {}
      if (e && typeof e === "object") entries.push(e); else unreadable++;
    }
    return { entries, unreadable };
  }

  return { dir, append, days, read, prune, encrypted: !!K };
}

function summarize(entries) {
  const s = { lines: entries.length, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, warn: 0, error: 0, restarts: 0, events: {}, paths: {}, errorPaths: {} };
  for (const e of entries) {
    if (e.level === "warn") s.warn++;
    if (e.level === "error") s.error++;
    if (e.msg === "listening") s.restarts++;
    if (e.msg === "request") {
      s.requests++;
      const k = e.status >= 500 ? "s5xx" : e.status >= 400 ? "s4xx" : e.status >= 300 ? "s3xx" : "s2xx";
      s[k]++;
      const p = `${e.method} ${String(e.path || "").replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/:id")}`;
      s.paths[p] = (s.paths[p] || 0) + 1;
      if (e.status >= 500) s.errorPaths[p] = (s.errorPaths[p] || 0) + 1;
    } else if (e.msg) s.events[e.msg] = (s.events[e.msg] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
  return { ...s, events: top(s.events, 30), paths: top(s.paths, 25), errorPaths: top(s.errorPaths, 15) };
}

function mountActivityLog({ admin, log, now = () => new Date() }) {
  admin.get("/logs/days", (req, res) => res.json({ keep: log.days(), encrypted: log.encrypted }));

  // One day's entries, newest first, optionally filtered by level, message or path text
  admin.get("/logs", (req, res) => {
    const day = String(req.query.date || now().toISOString().slice(0, 10));
    const level = String(req.query.level || ""), q = String(req.query.q || "").toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 500));
    const { entries, unreadable } = log.read(day);
    const out = entries.filter((e) => (!level || e.level === level) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
    res.json({ date: day, total: entries.length, matched: out.length, unreadable, entries: out.slice(-limit).reverse() });
  });

  // Day-by-day totals for the last N days (default 21): requests by status class, warnings, errors, restarts, top paths
  admin.get("/logs/summary", (req, res) => {
    const n = Math.max(1, Math.min(365, Number(req.query.days) || 21));
    const since = new Date(now().getTime() - (n - 1) * 86_400_000).toISOString().slice(0, 10);
    const daysOut = [], all = [];
    let unreadable = 0;
    for (const { date } of log.days()) {
      if (date < since) continue;
      const r = log.read(date); unreadable += r.unreadable;
      const s = summarize(r.entries);
      daysOut.push({ date, requests: s.requests, s2xx: s.s2xx, s4xx: s.s4xx, s5xx: s.s5xx, warn: s.warn, error: s.error, restarts: s.restarts });
      for (const e of r.entries) all.push(e);
    }
    res.json({ days: n, since, unreadable, perDay: daysOut, totals: summarize(all) });
  });

  // Raw JSON-lines download of one day (decrypted), for keeping or loading into another tool
  admin.get("/logs/download", (req, res) => {
    const day = String(req.query.date || "");
    if (!DAY_RE.test(day)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { entries } = log.read(day);
    res.set("Content-Type", "application/x-ndjson");
    res.set("Content-Disposition", `attachment; filename="mdfit-activity-${day}.jsonl"`);
    res.send(entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  });
}

module.exports = { createActivityLog, mountActivityLog, summarize };
