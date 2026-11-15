// Search feedback loop: logs query → click → position; aggregates click-through signals and serves them back
// to the client to re-rank; exposes admin analytics (top queries, zero-result queries, best/worst CTR per query).
// Keeps everything anonymous — raw queries are stored with no user identifier.
"use strict";
const crypto = require("crypto");

const MAX_EVENTS = 50000;      // ring buffer: oldest events age out
const MAX_Q_LEN = 400;      // was 120: longer queries were cut off and all merged into one row
const BURST_GAP_MS = 120_000; // query events this close together, each a prefix of the next, are one search being typed
                              // (production logs show people pausing 20-35 s mid-sentence while typing a long query)
const QUICK_LIMIT = 12;       // the account quick-search shows at most 12 hits; legacy events with more came from the Videos filter
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
    const src = b.src === "videos" ? "videos" : "quick";
    const base = { q, qh: qHash(q), n: Math.max(0, Math.min(500, Number(b.resultCount) || 0)), src };
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

  // Admin dashboard. Rebuilt from the raw event log on every read so historical data is corrected too:
  //  1. Video-tab filter events are separated out (they are a list filter, not a site search, and never log clicks).
  //  2. Typing bursts collapse to one search: consecutive query events within BURST_GAP_MS where each is a prefix of,
  //     extension of, or identical to the previous ("k" → "kn" → "knee pain") count once, under the final text.
  //  3. Clicks and no-clicks attach to the burst they belong to, so CTR = searches with a click / searches.
  admin.get("/search-analytics", (req, res) => {
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    const since = Date.now() - days * 86_400_000;
    res.json({ days, ...analyze(readEvents().filter((e) => e.ts >= since)) });
  });
}

const related = (a, b) => a === b || a.startsWith(b) || b.startsWith(a);
const isVideoFilter = (e) => e.src === "videos" || (!e.src && e.t === "query" && e.n > QUICK_LIMIT);

function analyze(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const videoFilter = sorted.filter(isVideoFilter).length;
  const quick = sorted.filter((e) => !isVideoFilter(e));
  const bursts = [];
  let rawQueries = 0, queryBursts = 0;
  for (const e of quick) {
    if (e.t === "query") rawQueries++;
    // Most recent burst this event continues. Typing must be within BURST_GAP_MS of the last keystroke;
    // a click or no-click can come up to 5 minutes after the results appeared.
    let b = null;
    const windowMs = e.t === "query" ? BURST_GAP_MS : 300_000;
    for (let i = bursts.length - 1; i >= Math.max(0, bursts.length - 50); i--) {
      const c = bursts[i];
      if (e.ts - c.last <= windowMs && related(e.q, c.q)) { b = c; break; }
    }
    if (e.t === "query") {
      if (!b || b.closed) { b = { q: e.q, first: e.ts, last: e.ts, n: e.n, clicked: false, abandoned: false, clickPos: [], docs: {}, closed: false }; bursts.push(b); queryBursts++; }
      else { b.q = e.q; b.last = e.ts; b.n = e.n; }
    } else if (b) {
      if (e.t === "click") { b.clicked = true; b.clickPos.push(e.pos || 0); b.docs[e.id] = (b.docs[e.id] || 0) + 1; }
      else b.abandoned = true;
      b.closed = true; // a click or blur ends the search; typing after it is a new one
    } else {
      // click/noclick with no query event in range (query aged out of the window): count it as its own search
      bursts.push({ q: e.q, first: e.ts, last: e.ts, n: e.n, clicked: e.t === "click", abandoned: e.t === "noclick", clickPos: e.t === "click" ? [e.pos || 0] : [], docs: e.t === "click" ? { [e.id]: 1 } : {}, closed: true });
    }
  }
  const byQ = {};
  for (const b of bursts) {
    const r = (byQ[b.q] = byQ[b.q] || { q: b.q, searches: 0, clicks: 0, zero: 0, posSum: 0, posN: 0, docs: {} });
    r.searches++;
    if (b.clicked) r.clicks++;
    if (b.n === 0) r.zero++;
    for (const p of b.clickPos) { r.posSum += p; r.posN++; }
    for (const [d, c] of Object.entries(b.docs)) r.docs[d] = (r.docs[d] || 0) + c;
  }
  const rows = Object.values(byQ).map((r) => {
    const topDoc = Object.entries(r.docs).sort((a, b) => b[1] - a[1])[0];
    return { q: r.q, impressions: r.searches, searches: r.searches, clicks: r.clicks,
      ctr: r.searches ? Math.round(r.clicks / r.searches * 1000) / 10 : 0,
      zeroResultRate: r.searches ? Math.round(r.zero / r.searches * 1000) / 10 : 0,
      meanPosition: r.posN ? Math.round(r.posSum / r.posN * 10) / 10 : null,
      topDoc: topDoc ? topDoc[0] : null, topDocClicks: topDoc ? topDoc[1] : 0 };
  });
  rows.sort((a, b) => b.searches - a.searches || a.q.localeCompare(b.q));
  const zeroResult = rows.filter((r) => r.zeroResultRate >= 50).slice(0, 40);
  const topCtr = rows.filter((r) => r.searches >= 3).sort((a, b) => b.ctr - a.ctr).slice(0, 20);
  const bottomCtr = rows.filter((r) => r.searches >= 3).sort((a, b) => a.ctr - b.ctr).slice(0, 20);
  const searches = bursts.length, withClick = bursts.filter((b) => b.clicked).length;
  return {
    totals: { events: events.length, searches, uniqueQueries: rows.length, clicks: withClick,
      ctr: searches ? Math.round(withClick / searches * 1000) / 10 : 0,
      typingEventsCollapsed: rawQueries - queryBursts, videoFilterEvents: videoFilter },
    top: rows.slice(0, 40), zeroResult, topCtr, bottomCtr
  };
}

module.exports = { mountSearch, analyze };
