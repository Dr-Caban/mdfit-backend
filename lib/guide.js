// Sunny, MD Fit Intelligence (the cloud in the member app): what the server keeps for it.
//
// The guide reads what a member types ON THE DEVICE and offers places in the app. What was typed never comes here:
// these routes take a category from a fixed list, or nothing, and anything else in the request is ignored.
//
// What this does:
//   - Counts tokens per member per clinic day, on the server, so a reinstall or a second device does not reset it.
//     Free accounts get `freeTokensPerDay` (owner's setting, default 50,000). An AI answer costs what the model used
//     (its own count, at least 300); an answer found on the device costs 300. Unlimited for anyone with full access:
//     an active membership, an active paid treatment plan, or an in-clinic patient (fullAccess() in lib/clients.js).
//   - Counts what the owner needs to judge it: opens, answers, limit hits, upgrade taps, and how many of the people
//     who hit the limit went on to hold a membership that started on or after their first hit.
//   - Reminders a member asks the guide to save ("remind me tomorrow at 7"): a title, a date and a time, pushed to
//     their phone once when the time comes.
//   - How the member likes the app to look (white or black, comfortable or compact).
//   - AI answers, when the owner has switched them on AND a service that signs a business associate agreement is
//     connected (lib/guide-ai.js decides that). Then, and only then, POST /guide/ask takes the sentence, passes it
//     through with the member's identity removed, together with the practice's catalog (programs, Dr. Jared's guides,
//     the videos for the body area asked about), the clinic's own referral knowledge for that area, and an
//     identity-free summary of the member (about() below: access, titles of recommended and saved programs, pain
//     check-in areas with level and trend, workout count and streak, ids already suggested, time of day; never a name,
//     email, phone, id, free-text note, appointment or invoice). It hands back what the model said. The sentence and
//     the reply text are never stored, logged or put in the audit ledger. What stays: the tokens counted, and the
//     suggestions (program, guide and video ids and the tip) on the member's own record under `suggested`
//     (lib/suggested.js; the tip encrypted by lib/phi.js), shown on their Home as Suggested.
//
// Storage:
//   - `guide` collection (small, written on every counted answer): the setting, per-day totals for the last 100
//     days, and per member only { day, used (tokens), firstHit, lastHit, lastOpen }. Dates, counts and ids; no text.
//   - Reminders and looks live on the member's own record (`reminders`, `appPrefs`), so they leave with the account.
//     A reminder's title is encrypted in the file like the other free text on a member (lib/phi.js).
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const fail = (msg) => { throw new ValidationError(msg); };
const KINDS = ["pain", "book", "programs", "workout", "videos", "messages", "progress", "learn", "membership", "profile", "visit", "looks", "reminder", "other"];
const EVENTS = ["open", "upgrade", "tomorrow"];
const THEMES = ["white", "black"], LAYOUTS = ["comfortable", "compact"];
const DEFAULT_FREE = 50000, FREE_MIN = 1000, FREE_MAX = 1000000; // tokens a day for a free account
const DEVICE_COST = 300, MIN_AI_COST = 300;                       // an answer found on the device; the least an AI answer counts
const FREE_ERR = "Free tokens a day must be a whole number from 1,000 to 1,000,000.";
const EXERCISES = (() => { try { return require("./exercises.json").exercises || []; } catch { return []; } })();
// The exercise-library regions sent for each body area (first = closest); a question about no area gets a general slice
const VIDEO_REGIONS = { knee: ["Knees", "Legs", "Hips"], back: ["Spine", "Core", "Hips"], shoulder: ["Shoulders", "Upper body", "Neck"], hip: ["Hips", "Legs", "Core"],
  neck: ["Neck", "Desk & posture", "Spine"], ankle: ["Ankles", "Legs"], foot: ["Ankles", "Legs"], elbow: ["Arms", "Wrists"], wrist: ["Wrists", "Arms"] };
const GENERAL_REGIONS = ["Full body", "Core", "Desk & posture", "Spine", "Hips", "Shoulders"];
const VIDEOS_MAX = 40;
const videosFor = (areas) => {
  const regions = areas.length ? [...new Set(areas.flatMap((a) => VIDEO_REGIONS[a] || []))] : GENERAL_REGIONS;
  return regions.flatMap((r) => EXERCISES.filter((v) => v.region === r)).slice(0, VIDEOS_MAX);
};
// Where the model may point (ids the app knows; "call" is the clinic's number)
const PLACES = [{ id: "pain", label: "Pain tool" }, { id: "book", label: "Schedule an appointment" }, { id: "programs", label: "Programs" }, { id: "workout", label: "Build a workout" },
  { id: "videos", label: "Video library" }, { id: "messages", label: "Message Dr. Jared" }, { id: "progress", label: "Progress and calendar" }, { id: "learn", label: "Lectures and live Q&A" },
  { id: "membership", label: "Membership and billing" }, { id: "profile", label: "My profile" }, { id: "visit", label: "Join a video visit" }, { id: "call", label: "Call the clinic" }];
const ASK_MAX = 300;
const KEEP_DAYS = 100;          // per-day totals kept (the longest report is 90 days)
const REMINDERS_MAX = 20;       // upcoming reminders one member may hold
const PAST_DAYS = 30;           // a past reminder stays on the calendar this long
const LATE_MS = 60 * 60 * 1000; // a reminder missed by more than an hour (server was down) is not sent late
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const addDay = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const realDate = (d) => DATE_RE.test(d) && !Number.isNaN(Date.parse(d + "T12:00:00Z")) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d;

function mountGuide({ app, admin, me, store, cfg, limiter, logger, push, clients, save, today, activeMembership, activePlan = () => false, isInpatient = (c) => !!(c && c.clientType === "inpatient"),
  fullAccess = (c) => !!(activeMembership(c) || activePlan(c) || isInpatient(c)), zonedToUtc, guideAI, audit }) {
  const content = require("./content");
  const { addSuggested, removeSuggested, suggestedOf, KINDS: SUGGEST_KINDS } = require("./suggested");
  const { areasIn } = require("./guide-ai");
  const KEY = "guide";
  const nowMs = () => cfg.now().getTime();
  const stamp = () => cfg.now().toISOString();

  // ---------- counters ----------
  const load = () => { const g = store.read(KEY, null) || {}; return { settings: g.settings || {}, days: g.days || {}, members: g.members || {} }; };
  const keep = (g) => { const floor = addDay(today(), -KEEP_DAYS); for (const d of Object.keys(g.days)) if (d < floor) delete g.days[d]; store.write(KEY, g); };
  const dayOf = (g, d) => g.days[d] || (g.days[d] = { opens: 0, answers: 0, tokens: 0, upgradeTaps: 0, tomorrows: 0, who: [], hit: [], kinds: {} });
  const limitOf = (g) => { const n = Number(g.settings.freeTokensPerDay); return Number.isInteger(n) && n >= FREE_MIN && n <= FREE_MAX ? n : DEFAULT_FREE; };
  const usedToday = (g, id, d) => { const m = g.members[id]; return m && m.day === d ? m.used || 0 : 0; };
  const spot = (g, id, d) => { const m = g.members[id] || (g.members[id] = {}); if (m.day !== d) { m.day = d; m.used = 0; } return m; };
  // A free account with none left today: the reply that says so (the hit is counted once a day per member). Otherwise null.
  function atLimit(g, c, d, paid, limit) {
    const m = spot(g, c.id, d), day = dayOf(g, d);
    if (paid || m.used < limit) return null;
    if (!day.hit.includes(c.id)) { day.hit.push(c.id); if (!m.firstHit) m.firstHit = d; m.lastHit = d; keep(g); }
    return { ok: false, limited: true, used: m.used, limit, left: 0, unit: "tokens" };
  }
  function count(g, c, d, paid, limit, kind, byModel, cost) {
    const m = spot(g, c.id, d), day = dayOf(g, d);
    m.used += cost; day.answers++; day.tokens = (day.tokens || 0) + cost; day.kinds[kind] = (day.kinds[kind] || 0) + 1; if (byModel) day.ai = (day.ai || 0) + 1;
    keep(g);
    return { unit: "tokens", used: m.used, limit, left: paid ? null : Math.max(0, limit - m.used) };
  }
  // AI answers: the owner's switch, and whether the connected service may be used at all (lib/guide-ai.js)
  const aiStatus = () => (guideAI ? guideAI.status() : { ready: false, host: "", model: "", why: "No AI service is connected on the server yet." });
  const aiOn = (g) => g.settings.ai === true && aiStatus().ready;
  const settingsOut = (g) => { const s = aiStatus(); return { freeTokensPerDay: limitOf(g), ai: g.settings.ai === true, aiReady: !!s.ready, aiHost: s.host || "", aiModel: s.model || "", aiWhy: s.why || "" }; };

  // One member cannot hammer the store: counted per account, not per address (a clinic's wifi is one address)
  const guard = (lim) => (req, res, next) => {
    const k = req.client.id;
    if (lim.blocked(k)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
    lim.hit(k); next();
  };
  const answerLimit = limiter(90, 60 * 1000), eventLimit = limiter(60, 60 * 1000), writeLimit = limiter(60, 60 * 1000), askLimit = limiter(12, 60 * 1000);

  // ---------- reminders and looks (on the member's record) ----------
  const at = (r) => zonedToUtc(r.date, r.time, cfg.tz).getTime();
  const order = (a, b) => { const x = a.date + a.time, y = b.date + b.time; return x < y ? -1 : x > y ? 1 : String(a.createdAt) < String(b.createdAt) ? -1 : 1; };
  const tidy = (list) => { const floor = addDay(today(), -PAST_DAYS); return (list || []).filter((r) => r && r.id && r.date >= floor).sort(order); };
  const shape = (r) => ({ id: r.id, title: r.title, date: r.date, time: r.time, createdAt: r.createdAt, sentAt: r.sentAt || null });
  const listOf = (c) => tidy(c.reminders).map(shape);
  const prefsOf = (c) => { const p = (c && c.appPrefs) || {}; return { theme: THEMES.includes(p.theme) ? p.theme : "white", layout: LAYOUTS.includes(p.layout) ? p.layout : "comfortable" }; };
  const change = (req, fn) => { const list = clients(), c = list.find((x) => x.id === req.client.id); const out = fn(c); save(list); return out; };

  // ---------- what Sunny may suggest, and what this member can open ----------
  const saved = () => store.read("content", {});
  const programsNow = () => content.programsOf(saved());
  const levelOf = (c) => content.accessLevel(content.tiersOf(saved()), { membership: activeMembership(c), activePlan: activePlan(c), inpatient: isInpatient(c) });
  const lockedFor = (lvl) => (p) => (content.ACCESS_RANK[p.access || "free"] || 0) > lvl;
  // Every program (a members-only one reaches a free member locked, as a teaser) and the exercise video library
  const guidesNow = () => content.recommendationsOf(saved()).map((r) => ({ id: r.id, title: r.title, area: r.area || "" }));
  const catalog = (programs, guides, areas) => ({
    programs: programs.map((p) => ({ id: p.id, title: p.title, cat: p.category || p.cat || "", level: p.level || "" })),
    guides,
    videos: videosFor(areas).map((v) => ({ id: v.id, name: v.name, region: v.region || "" }))
  });

  // ---------- about this member, for Sunny to personalize: no identity, no free text ----------
  const hourAtClinic = () => { try { return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: cfg.tz }).format(cfg.now())); } catch { return 12; } };
  function about(c, programs) {
    const title = (id) => { const p = programs.find((x) => x.id === id); return p ? p.title : null; };
    const t = today(), from = addDay(t, -29);
    // pain check-ins in the last 30 days: per area (a fixed list), the latest level and how it moved since the first
    const byArea = new Map();
    for (const e of (c.painLog || []).filter((x) => x && x.date >= from && x.date <= t).sort((a, b) => (a.date + (a.createdAt || "") < b.date + (b.createdAt || "") ? -1 : 1))) {
      const a = byArea.get(e.area) || { area: String(e.area || "").toLowerCase(), first: e.level, level: e.level, last: e.date };
      a.level = e.level; a.last = e.date; byArea.set(e.area, a);
    }
    const pain = [...byArea.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 3)
      .map((a) => ({ area: a.area, level: a.level, trend: a.level < a.first ? "improving" : a.level > a.first ? "worse" : "steady" }));
    let streak = 0;
    try { const h = app.get("habitsApi"); streak = h ? Number(h.summary(c.id).streak.current) || 0 : 0; } catch { streak = 0; }
    const s = suggestedOf(c), hour = hourAtClinic();
    return {
      access: fullAccess(c) ? "full" : "free",
      recommended: (c.assignedPrograms || []).map((x) => title(x.id)).filter(Boolean).slice(0, 5),
      saved: (c.pinnedPrograms || []).map(title).filter(Boolean).slice(0, 5),
      pain,
      workouts30: (c.workouts || []).filter((w) => w && w.date >= from && w.date <= t).length,
      streak,
      suggested: [...s.programs, ...s.guides, ...s.videos].map((x) => x.id).slice(0, 20),
      timeOfDay: hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"
    };
  }
  // Suggestions as the app shows them: titles, names and whether each program is locked for this member
  const shown = (c, s, programs = programsNow(), guides = guidesNow()) => {
    const byId = new Map(programs.map((p) => [p.id, p])), vids = new Map(EXERCISES.map((v) => [v.id, v])), gs = new Map(guides.map((g) => [g.id, g]));
    // a program Dr. Jared recommended to them is never shown locked
    const mine = new Set((c.assignedPrograms || []).map((x) => x.id)), lvl = lockedFor(levelOf(c)), locked = (p) => !mine.has(p.id) && lvl(p);
    return {
      programs: s.programs.filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id).title, locked: locked(byId.get(id)) })),
      videos: s.videos.filter((id) => vids.has(id)).map((id) => ({ id, name: vids.get(id).name })),
      guides: (s.guides || []).filter((id) => gs.has(id)).map((id) => ({ id, title: gs.get(id).title })),
      tip: s.tip || ""
    };
  };

  // ================= Member =================
  me.get("/guide", (req, res) => {
    const g = load(), c = req.client, paid = fullAccess(c), limit = limitOf(g), used = usedToday(g, c.id, today());
    res.json({ plan: paid ? "member" : "free", unit: "tokens", limit, used, left: paid ? null : Math.max(0, limit - used), reminders: listOf(c), prefs: prefsOf(c), ai: aiOn(g) });
  });

  // One answer given. Always 200: { ok: true, ... } or, for a free account with none left today, { ok: false, limited: true }.
  // Only `kind` is read, and only if it is one of KINDS.
  me.post("/guide/answer", guard(answerLimit), (req, res) => {
    const raw = req.body && req.body.kind, kind = typeof raw === "string" && KINDS.includes(raw) ? raw : "other";
    const g = load(), d = today(), c = req.client, paid = fullAccess(c), limit = limitOf(g);
    res.json(atLimit(g, c, d, paid, limit) || { ok: true, ...count(g, c, d, paid, limit, kind, false, DEVICE_COST) });
  });

  // The sentence itself, for the model to read. Only when AI answers are on and allowed; otherwise { ok: false, ai: false }
  // and the app understands it on the device. Nothing typed here is kept anywhere; of the reply, only the suggestions
  // are kept (on the member's record, for their Home).
  me.post("/guide/ask", guard(askLimit), async (req, res) => {
    const text = typeof (req.body && req.body.text) === "string" ? req.body.text.trim() : "";
    if (!text || text.length > ASK_MAX) fail(`Write up to ${ASK_MAX} characters.`);
    const c = req.client, d = today();
    let g = load();
    if (!aiOn(g)) return res.json({ ok: false, ai: false });
    if (guideAI.urgent(text)) return res.json({ ok: true, urgent: true }); // answered in the app with 911 and the clinic's number; never sent, never counted
    const paid = fullAccess(c);
    const stop = atLimit(g, c, d, paid, limitOf(g));
    if (stop) return res.json(stop);
    const programs = programsNow(), guides = guidesNow();
    const out = await guideAI.understand({ text, names: [c.name, c.firstName, c.lastName].filter(Boolean), places: PLACES,
      catalog: catalog(programs, guides, areasIn(text)), about: about(c, programs) });
    if (!out || out.error) return res.json({ ok: false, ai: false });
    g = load(); // counted against what the store holds now, not what it held before the wait
    const kind = KINDS.includes(out.places[0]) ? out.places[0] : "other";
    const tokens = Math.max(MIN_AI_COST, Math.round(Number(out.tokens) || 0));
    const pick = { programs: out.programs || [], videos: out.videos || [], guides: out.guides || [], tip: out.tip || "" };
    if (pick.programs.length || pick.videos.length || pick.guides.length || pick.tip) change(req, (x) => addSuggested(x, pick, stamp()));
    res.json({ ok: true, say: out.say, places: out.places, area: out.area, suggested: shown(c, pick, programs, guides), tokens, ...count(g, c, d, paid, limitOf(g), kind, true, tokens) });
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

  // Dismiss one suggestion from Home
  me.delete("/suggested/:kind/:id", guard(writeLimit), (req, res) => {
    const { kind, id } = req.params;
    if (!SUGGEST_KINDS.includes(kind)) return res.status(404).json({ error: "Suggestion not found." });
    if (!suggestedOf(req.client)[kind].some((x) => x.id === id)) return res.status(404).json({ error: "Suggestion not found." });
    res.json(change(req, (c) => { removeSuggested(c, kind, id); return { suggested: suggestedOf(c) }; }));
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
    const totals = { opens: 0, people: 0, answers: 0, tokens: 0, limitHits: 0, limitPeople: 0, upgradeTaps: 0, upgraded: 0 };
    for (let i = n - 1; i >= 0; i--) {
      const date = addDay(end, -i), x = g.days[date] || {}, hit = x.hit || [];
      const row = { date, opens: x.opens || 0, answers: x.answers || 0, tokens: x.tokens || 0, limitHits: hit.length, upgradeTaps: x.upgradeTaps || 0 };
      byDay.push(row);
      totals.opens += row.opens; totals.answers += row.answers; totals.tokens += row.tokens; totals.limitHits += row.limitHits; totals.upgradeTaps += row.upgradeTaps;
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
    res.json({ days: n, settings: settingsOut(g), totals, rate: limitPeople.size ? Math.round((totals.upgraded / limitPeople.size) * 10000) / 10000 : null, byDay });
  });
  admin.put("/guide/settings", (req, res) => {
    const b = req.body || {}, v = b.freeTokensPerDay, ai = b.ai;
    if (b.freePerDay !== undefined) fail(FREE_ERR); // the old answer count: the allowance is in tokens now
    if (v === undefined && ai === undefined) fail("Nothing to change.");
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < FREE_MIN || v > FREE_MAX)) fail(FREE_ERR);
    if (ai !== undefined && typeof ai !== "boolean") fail("AI answers is either on or off.");
    const s = aiStatus();
    if (ai === true && !s.ready) fail(s.why || "AI answers cannot be switched on yet.");
    const g = load(), was = g.settings.ai === true;
    const { freePerDay, ...rest } = g.settings; // the old answer-count setting goes away on the first save
    g.settings = { ...rest, ...(v !== undefined ? { freeTokensPerDay: v } : {}), ...(ai !== undefined ? { ai } : {}) };
    keep(g);
    if (ai !== undefined && ai !== was && audit) audit.record({ actor: `admin:${req.admin}`, action: "guide.ai", ip: req.ip, meta: { on: ai, host: s.host || "", model: s.model || "" } });
    res.json({ settings: settingsOut(g) });
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

  const api = { sweep, forget, KINDS, PLACES, DEFAULT_FREE };
  app.set("guideApi", api);
  app.set("guideRemind", () => { try { return sweep(); } catch (err) { if (logger) logger.warn("guide_remind_failed", { error: err.message }); return { sent: 0 }; } });
  return api;
}

module.exports = { mountGuide, KINDS, PLACES, DEFAULT_FREE };
