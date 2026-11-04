// Search feedback loop: logs query → click → position; aggregates click-through signals and serves them back
// to the client to re-rank; exposes admin analytics (top queries, zero-result queries, best/worst CTR per query).
// Keeps everything anonymous — raw queries are stored with no user identifier.
"use strict";
const crypto = require("crypto");

const MAX_EVENTS = 50000;      // ring buffer: oldest events age out
const MAX_Q_LEN = 120;
const SIGNAL_DECAY_DAYS = 30;  // events older than this are weighted toward zero
const SIGNAL_CACHE_MS = 60_000;

function mountSearch({ app, admin, store, limiter, logger }) {
  const readEvents = () => store.read("search-events", []);
  const writeEvents = (list) => store.write("search-events", list.slice(-MAX_EVENTS));
  const normQ = (q) => String(q || "").toLowerCase().replace(/[^a-z0-9 '\-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_Q_LEN);
  const qHash = (q) => crypto.createHash("sha256").update(q).digest("hex").slice(0, 10);
  const ev = (type, body) => ({ t: type, ts: Date.now(), ...body });

  const logLimit = limiter(600, 60_000); // 10/sec sustained per IP

  // Client fires one of these per keystroke pause (query), per tap (click), or when nothing was clicked (noclick).
  app.post("/api/search/log", logLimit.mw, (req, res) => {
    const b = req.body || {};
    const type = b.type === "click" ? "click" : b.type === "noclick" ? "noclick" : "query";
    const q = normQ(b.q);
    if (!q || q.length < 2) return res.json({ ok: true });
    const list = readEvents();
    const base = { q, qh: qHash(q), n: Math.max(0, Math.min(500, Number(b.resultCount) || 0)) };
    if (type === "click") list.push(ev("click", { ...base, id: String(b.id || "").slice(0, 80), pos: Math.max(0, Math.min(99, Number(b.position) || 0)) }));
    else if (type === "noclick") list.push(ev("noclick", base));
    else list.push(ev("query", base));
    writeEvents(list);
    res.json({ ok: true });
  });

  // Aggregated signals the client folds into its ranking. Small (< a few KB) and cached a minute.
  let signalsCache = { at: 0, body: null };
  app.get("/api/search/signals", (req, res) => {
    if (Date.now() - signalsCache.at < SIGNAL_CACHE_MS && signalsCache.body) {
      res.set("Cache-Control", "public, max-age=60"); return res.json(signalsCache.body);
    }
    const events = readEvents(), now = Date.now(), msPerDay = 86_400_000;
    const weight = (ts) => Math.max(0, 1 - (now - ts) / (SIGNAL_DECAY_DAYS * msPerDay));
    // (q, docId) → weighted click score with position discount (position-aware CTR)
    const boost = {}, queryTotal = {};
    for (const e of events) {
      const w = weight(e.ts); if (!w) continue;
      queryTotal[e.q] = (queryTotal[e.q] || 0) + w;
      if (e.t === "click") {
        const posDiscount = 1 / Math.log2(2 + e.pos); // position 0 → 1.0, 1 → 0.63, 2 → 0.5, …
        const key = `${e.q}|${e.id}`;
        boost[key] = (boost[key] || 0) + w * posDiscount;
      }
    }
    // Normalize per-query so a hot query does not dominate the whole index.
    const boostOut = {};
    for (const [key, raw] of Object.entries(boost)) {
      const [q] = key.split("|"); const total = queryTotal[q] || 1;
      const norm = raw / total; if (norm > 0.02) boostOut[key] = Math.round(norm * 1000) / 1000;
    }
    signalsCache = { at: Date.now(), body: { generatedAt: new Date().toISOString(), boost: boostOut } };
    res.set("Cache-Control", "public, max-age=60");
    res.json(signalsCache.body);
  });

  // Admin dashboard: top queries, zero-result (nothing shown / nothing clicked), best-clicked documents
  admin.get("/search-analytics", (req, res) => {
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    const since = Date.now() - days * 86_400_000;
    const events = readEvents().filter((e) => e.ts >= since);
    const byQ = {}; // q → { queries, clicks, noclicks, zeroResult, positions, topDocs }
    for (const e of events) {
      const b = (byQ[e.q] = byQ[e.q] || { q: e.q, queries: 0, clicks: 0, noclicks: 0, zeroResult: 0, positionSum: 0, topDocs: {} });
      if (e.t === "query") { b.queries++; if (e.n === 0) b.zeroResult++; }
      if (e.t === "noclick") b.noclicks++;
      if (e.t === "click") { b.clicks++; b.positionSum += e.pos || 0; b.topDocs[e.id] = (b.topDocs[e.id] || 0) + 1; }
    }
    const rows = Object.values(byQ).map((r) => {
      const impressions = Math.max(r.queries, r.clicks + r.noclicks);
      const topDoc = Object.entries(r.topDocs).sort((a, b) => b[1] - a[1])[0];
      return { q: r.q, impressions, clicks: r.clicks, ctr: impressions ? Math.round(r.clicks / impressions * 1000) / 10 : 0,
        zeroResultRate: impressions ? Math.round(r.zeroResult / impressions * 1000) / 10 : 0,
        meanPosition: r.clicks ? Math.round(r.positionSum / r.clicks * 10) / 10 : null,
        topDoc: topDoc ? topDoc[0] : null, topDocClicks: topDoc ? topDoc[1] : 0 };
    });
    rows.sort((a, b) => b.impressions - a.impressions);
    const zeroResult = rows.filter((r) => r.zeroResultRate >= 50 && r.impressions >= 3).sort((a, b) => b.impressions - a.impressions);
    const topCtr = rows.filter((r) => r.impressions >= 5).sort((a, b) => b.ctr - a.ctr).slice(0, 20);
    const bottomCtr = rows.filter((r) => r.impressions >= 5).sort((a, b) => a.ctr - b.ctr).slice(0, 20);
    res.json({ days, totals: { events: events.length, uniqueQueries: rows.length }, top: rows.slice(0, 40), zeroResult: zeroResult.slice(0, 40), topCtr, bottomCtr });
  });
}

module.exports = { mountSearch };
