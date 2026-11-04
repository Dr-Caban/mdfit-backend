"use strict";

const KEEP_DAYS = 90;

function mountAnalytics({ app, admin, store, limiter }) {
  const hit = limiter(60, 60 * 1000);
  const today = () => new Date().toISOString().slice(0, 10);

  function data() {
    const d = store.read("analytics", { days: {}, pages: {}, referrers: {} });
    if (!d.days) d.days = {};
    if (!d.pages) d.pages = {};
    if (!d.referrers) d.referrers = {};
    return d;
  }
  function save(d) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const k of Object.keys(d.days)) { if (k < cutoff) delete d.days[k]; }
    store.write("analytics", d);
  }

  const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  const device = (ua, w) => /ipad|tablet|kindle|silk|playbook/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua)) ? "Tablet"
    : /mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua) ? "Mobile" : w && w < 760 ? "Mobile" : "Desktop";
  const osOf = (ua) => /iphone|ipad|ipod/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /mac os x|macintosh/i.test(ua) ? "macOS" : /cros/i.test(ua) ? "ChromeOS" : /linux/i.test(ua) ? "Linux" : "Other";
  const browserOf = (ua) => /edg\//i.test(ua) ? "Edge" : /fbav|fban|instagram/i.test(ua) ? "In-app (Facebook/Instagram)" : /samsungbrowser/i.test(ua) ? "Samsung Internet" : /crios|chrome\//i.test(ua) ? "Chrome" : /fxios|firefox/i.test(ua) ? "Firefox" : /safari/i.test(ua) ? "Safari" : "Other";
  const SOURCES = [[/google\./, "Google"], [/bing\./, "Bing"], [/yahoo\./, "Yahoo"], [/duckduckgo/, "DuckDuckGo"], [/facebook\.|fb\.me|m\.facebook/, "Facebook"], [/instagram\./, "Instagram"],
    [/t\.co$|twitter\.|x\.com/, "X / Twitter"], [/linkedin\./, "LinkedIn"], [/tiktok\./, "TikTok"], [/youtube\.|youtu\.be/, "YouTube"], [/yelp\./, "Yelp"], [/chatgpt|openai|perplexity|claude\.ai|gemini/, "AI assistants"]];
  const sourceOf = (ref, utm, inApp) => {
    if (utm) return utm.slice(0, 40).replace(/^./, (c) => c.toUpperCase());
    const host = ref ? ref.replace(/https?:\/\//, "").split("/")[0].toLowerCase() : "";
    if (!host || /mymdfit\.com|mdfitsrq|vercel\.app/.test(host)) return inApp ? "Facebook/Instagram app" : "Direct / typed / bookmark";
    const hit = SOURCES.find(([re]) => re.test(host)); return hit ? hit[1] : host.replace(/^www\./, "");
  };
  const dec = (v) => { try { return decodeURIComponent(String(v || "")); } catch { return String(v || ""); } };

  app.post("/api/hit", hit.mw, (req, res) => {
    const b = req.body || {};
    const page = String(b.page || "/").slice(0, 200).replace(/[?#].*/, "");
    const ref = String(b.referrer || "").slice(0, 200);
    const day = today();
    const d = data();

    if (!d.days[day]) d.days[day] = { views: 0, visitors: new Set() };
    const dd = d.days[day];
    if (dd.visitors instanceof Set) {
      // noop
    } else if (Array.isArray(dd._visitors)) {
      dd.visitors = new Set(dd._visitors);
    } else {
      dd.visitors = new Set();
    }

    dd.views++;
    const ip = (req.headers["x-mdfit-client-ip"] || req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const ua = String(req.headers["user-agent"] || ""), w = Number(b.w) || 0;
    const mix = dd.mix || (dd.mix = { dev: {}, os: {}, br: {}, src: {}, geo: {}, country: {} });
    bump(mix.dev, device(ua, w)); bump(mix.os, osOf(ua)); bump(mix.br, browserOf(ua));
    bump(mix.src, sourceOf(ref, String(b.utm || ""), /fbav|fban|instagram/i.test(ua)));
    const country = dec(req.headers["x-vercel-ip-country"]), region = dec(req.headers["x-vercel-ip-country-region"]), city = dec(req.headers["x-vercel-ip-city"]);
    if (country) bump(mix.country, country);
    if (city || region) bump(mix.geo, [city, region].filter(Boolean).join(", "));
    const vid = ip ? require("crypto").createHash("sha256").update(ip + day).digest("hex").slice(0, 12) : "";
    if (vid) dd.visitors.add(vid);

    dd._visitors = [...dd.visitors];
    dd.unique = dd.visitors.size;
    delete dd.visitors;

    d.pages[page] = (d.pages[page] || 0) + 1;

    if (ref && !ref.includes("mymdfit.com") && !ref.includes("mdfitsrq")) {
      const host = ref.replace(/https?:\/\//, "").split("/")[0];
      if (host) d.referrers[host] = (d.referrers[host] || 0) + 1;
    }

    save(d);
    res.json({ ok: true });
  });

  function mixFor(d, n) {
    const since = new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10), out = {};
    for (const [day, v] of Object.entries(d.days)) {
      if (day < since || !v.mix) continue;
      for (const [k, o] of Object.entries(v.mix)) { out[k] = out[k] || {}; for (const [name, c] of Object.entries(o)) out[k][name] = (out[k][name] || 0) + c; }
    }
    const list = (o = {}, max = 12) => { const t = Object.values(o).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, max).map(([name, views]) => ({ name, views, pct: Math.round((views / t) * 1000) / 10 })); };
    return { days: n, devices: list(out.dev), os: list(out.os), browsers: list(out.br), sources: list(out.src, 15), places: list(out.geo, 15), countries: list(out.country) };
  }
  admin.get("/analytics", (req, res) => {
    const d = data();
    const days = Object.entries(d.days)
      .map(([date, v]) => ({ date, views: v.views || 0, unique: v.unique || (v._visitors || []).length || 0 }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30);

    const pages = Object.entries(d.pages)
      .map(([page, views]) => ({ page, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 30);

    const referrers = Object.entries(d.referrers)
      .map(([source, views]) => ({ source, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 20);

    const totalViews = days.reduce((s, d) => s + d.views, 0);
    const totalUnique = days.reduce((s, d) => s + d.unique, 0);
    const todayData = d.days[today()];

    res.json({
      summary: {
        totalViews,
        totalUnique,
        todayViews: todayData ? todayData.views || 0 : 0,
        todayUnique: todayData ? todayData.unique || (todayData._visitors || []).length || 0 : 0
      },
      days,
      pages,
      referrers,
      mix: mixFor(d, Number(req.query.days) || 30)
    });
  });
}

module.exports = { mountAnalytics };
