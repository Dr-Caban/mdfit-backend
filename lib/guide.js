// The MD Fit guide (the cloud in the member app): what the server keeps for it.
//
// The guide reads what a member types ON THE DEVICE and offers places in the app. What was typed never comes here:
// these routes take a category from a fixed list, or nothing, and anything else in the request is ignored.
//
// What this does:
//   - Counts answers per member per clinic day, on the server, so a reinstall or a second device does not reset it.
//     Free accounts get `freePerDay` answers (owner's setting, default 25); a paid member is unlimited. "Paid" is
//     whatever activeMembership() says - the same rule the rest of the app uses.
//   - Counts what the owner needs to judge it: opens, answers, limit hits, upgrade taps, and how many of the people
//     who hit the limit went on to hold a membership that started on or after their first hit.
//   - Reminders a member asks the guide to save ("remind me tomorrow at 7"): a title, a date and a time, pushed to
//     their phone once when the time comes.
//   - How the member likes the app to look (white or black, comfortable or compact).
//
// Storage:
//   - `guide` collection (small, written on every counted answer): the setting, per-day totals for the last 100
//     days, and per member only { day, used, firstHit, lastHit, lastOpen }. Dates, counts and ids; no text.
//   - Reminders and looks live on the member's own record (`reminders`, `appPrefs`), so they leave with the account.
//     A reminder's title is encrypted in the file like the other free text on a member (lib/phi.js).
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (msg) => { throw new ValidationError(msg); };
const KINDS = ["pain", "book", "programs", "workout", "videos", "messages", "progress", "learn", "membership", "profile", "visit", "looks", "reminder", "other"];
const EVENTS = ["open", "upgrade", "tomorrow"];
const THEMES = ["white", "black"], LAYOUTS = ["comfortable", "compact"];
const DEFAULT_FREE = 25, FREE_MIN = 1, FREE_MAX = 500;
const KEEP_DAYS = 100;          // per-day totals kept (the longest report is 90 days)
const REMINDERS_MAX = 20;       // upcoming reminders one member may hold
const PAST_DAYS = 30;           // a past reminder stays on the calendar this long
const LATE_MS = 60 * 60 * 1000; // a reminder missed by more than an hour (server was down) is not sent late
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const realDate = (d) => DATE_RE.test(d) && !Number.isNaN(Date.parse(d + "T12:00:00Z")) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d;

function mountGuide({ app, admin, me, store, cfg, limiter, logger, push, clients, save, today, activeMembership, zonedToUtc }) {
  const KEY = "guide";
  const nowMs = () => cfg.now().getTime();
  const stamp = () => cfg.now().toISOString();

  // ---------- counters ----------
  const load = () => { const g = store.read(KEY, null) || {}; return { settings: g.settings || {}, days: g.days || {}, members: g.members || {} }; };
  const keep = (g) => { const floor = addDay(today(), -KEEP_DAYS); for (const d of Object.keys(g.days)) if (d < floor) delete g.days[d]; store.write(KEY, g); };
  const dayOf = (g, d) => g.days[d] || (g.days[d] = { opens: 0, answers: 0, upgradeTaps: 0, tomorrows: 0, who: [], hit: [], kinds: {} });
  const limitOf = (g) => { const n = Number(g.settings.freePerDay); return Number.isInteger(n) && n >= FREE_MIN && n <= FREE_MAX ? n : DEFAULT_FREE; };
  const usedToday = (g, id, d) => { const m = g.members[id]; return m && m.day === d ? m.used || 0 : 0; };

  // One member cannot hammer the store: counted per account, not per address (a clinic's wifi is one address)
  const guard = (lim) => (req, res, next) => {
    const k = req.client.id;
    if (lim.blocked(k)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
    lim.hit(k); next();
  };
  const answerLimit = limiter(90, 60 * 1000), eventLimit = limiter(60, 60 * 1000), writeLimit = limiter(30, 60 * 1000);

  // ---------- reminders and looks (on the member's record) ----------
  const at = (r) => zonedToUtc(r.date, r.time, cfg.tz).getTime();
  const order = (a, b) => { const x = a.date + a.time, y = b.date + b.time; return x < y ? -1 : x > y ? 1 : String(a.createdAt) < String(b.createdAt) ? -1 : 1; };
  const tidy = (list) => { const floor = addDay(today(), -PAST_DAYS); return (list || []).filter((r) => r && r.id && r.date >= floor).sort(order); };
  const shape = (r) => ({ id: r.id, title: r.title, date: r.date, time: r.time, createdAt: r.createdAt, sentAt: r.sentAt || null });
  const listOf = (c) => tidy(c.reminders).map(shape);
  const prefsOf = (c) => { const p = (c && c.appPrefs) || {}; return { theme: THEMES.includes(p.theme) ? p.theme : "white", layout: LAYOUTS.includes(p.layout) ? p.layout : "comfortable" }; };
  const change = (req, fn) => { const list = clients(), c = list.find((x) => x.id === req.client.id); const out = fn(c); save(list); return out; };

  // ================= Member =================
  me.get("/guide", (req, res) => {
    const g = load(), c = req.client, paid = !!activeMembership(c), limit = limitOf(g), used = usedToday(g, c.id, today());
    res.json({ plan: paid ? "member" : "free", limit, used, left: paid ? null : Math.max(0, limit - used), reminders: listOf(c), prefs: prefsOf(c) });
  });

  // One answer given. Always 200: { ok: true, ... } or, for a free account with none left today, { ok: false, limited: true }.
  // Only `kind` is read, and only if it is one of KINDS.
  me.post("/guide/answer", guard(answerLimit), (req, res) => {
    const raw = req.body && req.body.kind, kind = typeof raw === "string" && KINDS.includes(raw) ? raw : "other";
    const g = load(), d = today(), c = req.client, paid = !!activeMembership(c), limit = limitOf(g), day = dayOf(g, d);
    const m = g.members[c.id] || (g.members[c.id] = {});
    if (m.day !== d) { m.day = d; m.used = 0; }
    if (!paid && m.used >= limit) {
      if (!day.hit.includes(c.id)) { day.hit.push(c.id); if (!m.firstHit) m.firstHit = d; m.lastHit = d; keep(g); } // counted once a day per member
      return res.json({ ok: false, limited: true, used: m.used, limit, left: 0 });
    }
    m.used++; day.answers++; day.kinds[kind] = (day.kinds[kind] || 0) + 1;
    keep(g);
    res.json({ ok: true, used: m.used, limit, left: paid ? null : Math.max(0, limit - m.used) });
  });

  me.post("/guide/event", guard(eventLimit), (req, res) => {
    const type = req.body && req.body.type;
    if (typeof type !== "string" || !EVENTS.includes(type)) fail("Unknown guide event.");
    const g = load(), d = today(), day = dayOf(g, d), id = req.client.id;
    if (type === "open") { day.opens++; if (!day.who.includes(id)) day.who.push(id); (g.members[id] || (g.members[id] = {})).lastOpen = d; }
    else if (type === "upgrade") day.upgradeTaps++;
    else day.tomorrows++;
    keep(g);
    res.json({ ok: true });
  });

  me.get("/reminders", (req, res) => res.json({ reminders: listOf(req.client) }));
  me.post("/reminders", guard(writeLimit), (req, res) => {
    const b = req.body || {};
    const title = typeof b.title === "string" ? b.title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
    if (!title) fail("Give the reminder a name.");
    if (title.length > 80) fail("Keep the reminder's name to 80 characters.");
    const date = String(b.date || ""), time = String(b.time || ""), now = today();
    if (!realDate(date)) fail("Pick a day for the reminder.");
    if (!TIME_RE.test(time)) fail("Pick a time for the reminder.");
    if (date < now) fail("That day has already passed. Pick today or later.");
    if (date > addDay(now, 366)) fail("Reminders can be saved up to a year ahead.");
    const r = { id: crypto.randomBytes(8).toString("hex"), title, date, time, createdAt: stamp(), sentAt: null };
    if (at(r) < nowMs() - 60 * 1000) fail("That time has already passed. Pick a later time.");
    res.status(201).json(change(req, (c) => {
      const mine = tidy(c.reminders);
      if (mine.filter((x) => x.date >= now).length >= REMINDERS_MAX) fail(`You can keep up to ${REMINDERS_MAX} reminders. Delete one first.`);
      c.reminders = [...mine, r].sort(order);
      return { reminder: shape(r), reminders: c.reminders.map(shape) };
    }));
  });
  me.delete("/reminders/:id", guard(writeLimit), (req, res) => {
    if (!(req.client.reminders || []).some((r) => r.id === req.params.id)) return res.status(404).json({ error: "Reminder not found." });
    res.json(change(req, (c) => { c.reminders = tidy(c.reminders).filter((r) => r.id !== req.params.id); return { reminders: c.reminders.map(shape) }; }));
  });

  me.put("/prefs", guard(writeLimit), (req, res) => {
    const b = req.body || {};
    if (b.theme !== undefined && !THEMES.includes(b.theme)) fail("Theme must be white or black.");
    if (b.layout !== undefined && !LAYOUTS.includes(b.layout)) fail("Layout must be comfortable or compact.");
    if (b.theme === undefined && b.layout === undefined) return res.json({ prefs: prefsOf(req.client) });
    res.json(change(req, (c) => { c.appPrefs = { ...prefsOf(c), ...(b.theme !== undefined ? { theme: b.theme } : {}), ...(b.layout !== undefined ? { layout: b.layout } : {}) }; return { prefs: prefsOf(c) }; }));
  });

  // ================= Owner =================
  admin.get("/guide/stats", (req, res) => {
    const n = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const g = load(), end = today(), byDay = [], people = new Set(), limitPeople = new Set();
    const totals = { opens: 0, people: 0, answers: 0, limitHits: 0, limitPeople: 0, upgradeTaps: 0, upgraded: 0 };
    for (let i = n - 1; i >= 0; i--) {
      const date = addDay(end, -i), x = g.days[date] || {}, hit = x.hit || [];
      const row = { date, opens: x.opens || 0, answers: x.answers || 0, limitHits: hit.length, upgradeTaps: x.upgradeTaps || 0 };
      byDay.push(row);
      totals.opens += row.opens; totals.answers += row.answers; totals.limitHits += row.limitHits; totals.upgradeTaps += row.upgradeTaps;
      for (const id of x.who || []) people.add(id);
      for (const id of hit) limitPeople.add(id);
    }
    // Upgraded: hit the limit in this window and now holds a membership whose start (membership.since, a clinic date)
    // is on or after their first limit hit. A membership with no start date on record is not counted.
    const byId = new Map(clients().map((c) => [c.id, c]));
    for (const id of limitPeople) {
      const c = byId.get(id), m = c && activeMembership(c), first = (g.members[id] || {}).firstHit;
      if (m && m.since && first && m.since >= first) totals.upgraded++;
    }
    totals.people = people.size; totals.limitPeople = limitPeople.size;
    res.json({ days: n, settings: { freePerDay: limitOf(g) }, totals, rate: limitPeople.size ? Math.round((totals.upgraded / limitPeople.size) * 10000) / 10000 : null, byDay });
  });
  admin.put("/guide/settings", (req, res) => {
    const v = req.body && req.body.freePerDay;
    if (typeof v !== "number" || !Number.isInteger(v) || v < FREE_MIN || v > FREE_MAX) fail(`Free answers a day must be a whole number from ${FREE_MIN} to ${FREE_MAX}.`);
    const g = load(); g.settings = { ...g.settings, freePerDay: v }; keep(g);
    res.json({ settings: { freePerDay: v } });
  });

  // ================= Reminder pushes =================
  // Safe to call every minute: a reminder is marked the moment it is sent, so it never goes out twice. Without push
  // switched on, or for a member with no phone registered, the reminder simply stays on their calendar.
  function sweep(p = push) {
    if (!p || !p.enabled) return { sent: 0 };
    const list = clients();
    if (!list.some((c) => (c.reminders || []).some((r) => !r.sentAt))) return { sent: 0 };
    const now = nowMs(), withDevice = new Set(store.read("devices", []).map((d) => d.clientId).filter(Boolean));
    let sent = 0;
    for (const c of list) {
      if (!withDevice.has(c.id)) continue;
      for (const r of c.reminders || []) {
        if (r.sentAt || !DATE_RE.test(r.date || "") || !TIME_RE.test(r.time || "")) continue;
        const due = at(r);
        if (now < due || now > due + LATE_MS) continue;
        p.toClient(c.id, { title: "Reminder", body: r.title, route: "progress", thread: "reminders", collapseId: r.id });
        r.sentAt = stamp(); sent++;
      }
    }
    if (sent) save(list);
    return { sent };
  }
  // An account that is deleted takes its counters with it
  function forget(clientId) {
    const g = load(); let changed = false;
    if (g.members[clientId]) { delete g.members[clientId]; changed = true; }
    for (const d of Object.values(g.days)) for (const k of ["who", "hit"]) if ((d[k] || []).includes(clientId)) { d[k] = d[k].filter((x) => x !== clientId); changed = true; }
    if (changed) keep(g);
  }

  const api = { sweep, forget, KINDS, DEFAULT_FREE };
  app.set("guideApi", api);
  app.set("guideRemind", () => { try { return sweep(); } catch (err) { if (logger) logger.warn("guide_remind_failed", { error: err.message }); return { sent: 0 }; } });
  return api;
}

module.exports = { mountGuide, KINDS, DEFAULT_FREE };
