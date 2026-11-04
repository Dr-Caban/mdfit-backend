// API hardening: edge gate, real client IP, security headers, global rate limits, bot/scraper filter.
//
// Edge gate: when EDGE_SECRET is set, the API only answers requests that came through the site's own edge
// (Vercel middleware adds the secret, checks the visitor is in the US and filters bots). Anyone calling the
// Railway URL directly gets a 403. Webhooks are exempt: Stripe and Cal.com sign their requests, and those
// signatures are checked in their own handlers.
"use strict";
const crypto = require("crypto");

const EXEMPT = [/^\/api\/stripe\/webhook$/, /^\/api\/cal\/webhook$/, /^\/api\/health$/, /^\/$/];
// Automated clients and scrapers. Real browsers and the iOS app never send these.
const BAD_UA = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|libwww|scrapy|httpclient|node-fetch|axios|postman|insomnia|headless|phantomjs|selenium|puppeteer|playwright|crawler|spider|scraper|gptbot|chatgpt-user|ccbot|claudebot|anthropic-ai|bytespider|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|dataforseo|amazonbot|perplexitybot|facebookexternalhit|zgrab|masscan|nmap|nikto|sqlmap)/i;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createSecurity({ edgeSecret = "", allowUa = null, logger } = {}) {
  const viaEdge = (req) => !!edgeSecret && safeEq(req.get("x-mdfit-edge"), edgeSecret);

  // 1. Real client IP: trust the edge's header only when the edge secret matches
  function clientIp(req, res, next) {
    const fwd = viaEdge(req) && req.get("x-mdfit-client-ip");
    if (fwd && /^[0-9a-fA-F:.]{3,45}$/.test(fwd)) Object.defineProperty(req, "ip", { value: fwd, configurable: true });
    next();
  }

  // 2. Edge gate
  function edgeGate(req, res, next) {
    if (!edgeSecret || EXEMPT.some((r) => r.test(req.path)) || req.method === "OPTIONS") return next();
    if (viaEdge(req)) return next();
    logger && logger.warn("edge_blocked", { path: req.path, ua: String(req.get("user-agent") || "").slice(0, 80) });
    return res.status(403).json({ error: "Forbidden." });
  }

  // 3. Bot / scraper filter (webhooks exempt; their senders use server user agents)
  function botFilter(req, res, next) {
    if (EXEMPT.some((r) => r.test(req.path))) return next();
    const ua = String(req.get("user-agent") || "");
    if (allowUa && allowUa.test(ua)) return next();
    if (!ua || BAD_UA.test(ua)) return res.status(403).json({ error: "Automated access isn't allowed." });
    next();
  }

  // 4. Security headers for every API response
  function headers(req, res, next) {
    res.set({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-site",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Robots-Tag": "noindex, nofollow, noarchive"
    });
    if (req.path.startsWith("/api/me") || req.path.startsWith("/api/admin") || req.path.startsWith("/api/clients")) res.set("Cache-Control", "no-store");
    res.removeHeader("X-Powered-By");
    next();
  }

  // 5. Global rate limits per IP: a steady ceiling plus a burst ceiling. Old entries are pruned.
  // keyOf(req) -> { key, max } lets signed-in accounts be limited per account (shared gym / clinic Wi-Fi isn't punished)
  // while anonymous traffic is limited per IP.
  function rateLimit({ max, windowMs, name, keyOf }) {
    const hits = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, Math.max(windowMs, 60000)).unref();
    return (req, res, next) => {
      if (EXEMPT.some((r) => r.test(req.path))) return next();
      const now = Date.now();
      const k = keyOf ? keyOf(req) : { key: req.ip, max };
      let r = hits.get(k.key);
      if (!r || now > r.reset) { r = { n: 0, reset: now + windowMs }; hits.set(k.key, r); }
      if (++r.n > k.max) {
        res.set("Retry-After", String(Math.ceil((r.reset - now) / 1000)));
        if (r.n === k.max + 1) logger && logger.warn("rate_limited", { limiter: name, path: req.path });
        return res.status(429).json({ error: "Too many requests. Slow down and try again shortly." });
      }
      next();
    };
  }

  return { clientIp, edgeGate, botFilter, headers, rateLimit, viaEdge, BAD_UA };
}

module.exports = { createSecurity, BAD_UA };
