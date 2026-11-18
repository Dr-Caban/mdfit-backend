// The valuation workbench: an appraiser's process, step by step, for the owner and the developer (an interactive page
// that works out what MD Fit is worth from the books). It sits behind a passcode, not the admin or member logins:
//   POST /api/valuation/enter { code }  -> a 12-hour token (8 tries per 15 minutes per client, right or wrong)
//   GET  /api/valuation/page            -> the page itself, only with that token
// The page is kept here in the API, not on the public website, so it can't be opened or found without the passcode.
// The passcode is VALUATION_PASSCODE on the server, or the notes board's BOARD_PASSCODE when that isn't set. A
// valuation token opens nothing else (it carries no account), and no other token opens this. Neither the passcode
// nor a submitted code is ever logged. Whatever figures someone types or uploads stay in their own browser.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { signToken, verifyToken } = require("./auth");

const HOURS = 12, WINDOW_MS = 15 * 60 * 1000, MAX_TRIES = 8;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const PAGE = path.join(__dirname, "valuation-workbench.html");

function mountValuation({ app, cfg, limiter, logger }) {
  const passcode = () => String(cfg.valuationPasscode !== undefined ? cfg.valuationPasscode || ""
    : process.env.VALUATION_PASSCODE || (cfg.boardPasscode !== undefined ? cfg.boardPasscode || "" : process.env.BOARD_PASSCODE || "")).trim();
  const tries = limiter(MAX_TRIES, WINDOW_MS);
  const r = express.Router();
  r.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!passcode() || !cfg.sessionSecret) return res.status(503).json({ error: "The valuation workbench isn't set up on the server yet (VALUATION_PASSCODE)." });
    next();
  });
  r.post("/enter", (req, res) => {
    if (tries.blocked(req.ip)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    tries.hit(req.ip);
    const code = req.body && (typeof req.body.code === "string" || typeof req.body.code === "number") ? String(req.body.code).trim() : "";
    if (!code || !crypto.timingSafeEqual(sha(code), sha(passcode()))) {
      logger && logger.warn("valuation_enter_failed", {});
      return res.status(401).json({ error: "That passcode isn't right." });
    }
    const exp = Date.now() + HOURS * 3600e3;
    logger && logger.info("valuation_opened", {});
    res.json({ token: signToken({ role: "valuation", exp }, cfg.sessionSecret), expiresAt: new Date(exp).toISOString() });
  });
  r.get("/page", (req, res) => {
    const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const p = m && verifyToken(m[1], cfg.sessionSecret);
    if (!p || p.role !== "valuation") return res.status(401).json({ error: "Enter the passcode again." });
    let html;
    try { html = fs.readFileSync(PAGE, "utf8"); } catch { return res.status(500).json({ error: "The workbench page is missing on the server." }); }
    res.json({ html });
  });
  app.use("/api/valuation", r);
}

module.exports = { mountValuation };
