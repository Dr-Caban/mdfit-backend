// The developer console (/dev on the site): what a person doing code and content work needs to see, and nothing
// about any patient. Owner, Nov 2026.
//
// One read-only answer, totals only:
//   system    what is running: the deployed commit, when it started, memory
//   usage     site visits by day and the most-read pages; how many accounts exist, joined lately, signed in lately
//   activity  how many of each kind of event the server recorded, by day and by kind (the 90-day activity log)
//   spending  what the software costs to run each month: the lines the owner keeps under System economics that are
//             marked as system costs. The practice's other expenses (rent, payroll) are not shown here.
//
// Nothing here is a name, an email, an id or a chart: every figure is a count or a sum. Open to the owner and to
// staff holding the Developer role.
"use strict";

const STARTED = new Date();
const day = (iso) => String(iso || "").slice(0, 10);

function mountDevConsole({ admin, store, clients, cfg }) {
  const now = () => (cfg && typeof cfg.now === "function" ? cfg.now() : new Date());
  const allowed = (a) => !!a && (a.isOwner || (a.roles || [a.role]).includes("developer"));

  admin.get("/dev/overview", (req, res) => {
    if (!allowed(req.account)) return res.status(403).json({ error: "The developer console is for the owner and staff with the Developer role.", need: "developer" });
    const n = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30)));
    const t = now(), since = day(new Date(t.getTime() - (n - 1) * 864e5).toISOString());

    // usage: visits
    const an = store.read("analytics", { days: {}, pages: {} }) || {};
    const visits = Object.entries(an.days || {}).filter(([d]) => d >= since)
      .map(([date, v]) => ({ date, views: v.views || 0, unique: v.unique || (v._visitors || []).length || 0 }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const pages = Object.entries(an.pages || {}).map(([page, views]) => ({ page, views })).sort((a, b) => b.views - a.views).slice(0, 12);

    // usage: accounts, as counts
    const list = clients();
    const accounts = { total: list.length, joined: list.filter((c) => day(c.createdAt) >= since).length,
      signedIn: list.filter((c) => day(c.lastLoginAt) >= since).length, members: list.filter((c) => !!c.membership).length };

    // activity: counts by kind and by day, never the detail of an event
    const events = (store.read("activity", []) || []).filter((e) => day(e.time) >= since);
    const byType = new Map(), byDay = new Map();
    for (const e of events) { byType.set(e.type, (byType.get(e.type) || 0) + 1); byDay.set(day(e.time), (byDay.get(day(e.time)) || 0) + 1); }

    // spending: the software's own running costs
    const costs = ((store.read("economics", { costs: [] }) || {}).costs || []).filter((x) => x.kind !== "expense")
      .map((x) => ({ name: x.name, monthly: x.monthly || 0 })).sort((a, b) => b.monthly - a.monthly);

    const mem = process.memoryUsage();
    res.set("Cache-Control", "no-store");
    res.json({
      days: n, since,
      system: { commit: String(process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || null, startedAt: STARTED.toISOString(),
        uptimeMinutes: Math.round((Date.now() - STARTED.getTime()) / 60000), node: process.version, memoryMb: Math.round(mem.rss / 1048576) },
      usage: { visits, views: visits.reduce((s, d) => s + d.views, 0), unique: visits.reduce((s, d) => s + d.unique, 0), pages, accounts },
      activity: { total: events.length,
        byType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 40),
        byDay: [...byDay].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1)) },
      spending: { lines: costs, monthly: costs.reduce((s, x) => s + x.monthly, 0) }
    });
  });
}

module.exports = { mountDevConsole };
