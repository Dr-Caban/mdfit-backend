// Notes board: a private board shared by two people, the site owner ("jared") and the developer ("dev"), with the
// same access for both. It sits behind one shared passcode (BOARD_PASSCODE), not the admin or member logins: a board
// token opens nothing else, and an admin or member token does not open the board.
//
// Entries are notes (which can be answered), objectives and "done" records. Nothing is ever deleted: there is no
// delete route, entries are archived instead, and once MAX_ITEMS is reached new entries are refused rather than old
// ones dropped. Entry and reply text is AES-256-GCM encrypted at rest (lib/messages cipher). Neither the passcode,
// a submitted code, nor any entry text is ever logged.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { ValidationError } = require("./validate");
const { signToken, verifyToken } = require("./auth");
const { cipher } = require("./messages");

const KEY = "board";
const WHO = ["jared", "dev"], KINDS = ["note", "objective", "done"];
const MAX_BODY = 4000, MAX_REPLY = 2000, MAX_ITEMS = 5000;
const SESSION_DAYS = 30, WINDOW_MS = 15 * 60 * 1000, MAX_TRIES = 8, MAX_SHARED_READS = 60;

const fail = (msg) => { throw new ValidationError(msg); };
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const whoOf = (v) => (WHO.includes(v) ? v : fail('Say who you are: "jared" or "dev".'));
const textOf = (v, max, what) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) fail(`Write ${what} first.`);
  if (s.length > max) fail(`That's too long: ${what} can be up to ${max} characters.`);
  return s;
};
const flagOf = (v, name) => (typeof v === "boolean" ? v : fail(`"${name}" must be true or false.`));

function mountBoard({ app, store, cfg, limiter, logger }) {
  const C = cipher([process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const passcode = () => String(cfg.boardPasscode !== undefined ? cfg.boardPasscode || "" : process.env.BOARD_PASSCODE || "").trim();
  const nowIso = () => (cfg.now ? cfg.now() : new Date()).toISOString();
  const all = () => { const l = store.read(KEY, []); return Array.isArray(l) ? l : []; };
  const save = (list) => store.write(KEY, list);

  const replies = (it) => (Array.isArray(it.replies) ? it.replies : []).map((r) => ({ by: r.by, at: r.at, body: C.dec(r.body) }));
  const view = (it) => ({
    id: it.id, kind: it.kind, by: it.by, at: it.at, body: C.dec(it.body), replies: replies(it),
    seen: { ...(it.seen || {}) }, doneAt: it.doneAt || null, doneBy: it.doneBy || null,
    archived: !!it.archived, shareKey: it.shareKey || null
  });
  const shared = (it) => ({ kind: it.kind, by: it.by, at: it.at, body: C.dec(it.body), replies: replies(it), doneAt: it.doneAt || null, doneBy: it.doneBy || null });

  const tries = limiter(MAX_TRIES, WINDOW_MS), sharedReads = limiter(MAX_SHARED_READS, WINDOW_MS);
  const r = express.Router();

  r.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!passcode() || !cfg.sessionSecret) return res.status(503).json({ error: "The notes board isn't set up yet." });
    next();
  });

  // Every attempt counts, right or wrong: 8 per 15 minutes per client
  r.post("/enter", (req, res) => {
    if (tries.blocked(req.ip)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    tries.hit(req.ip);
    const code = req.body && (typeof req.body.code === "string" || typeof req.body.code === "number") ? String(req.body.code).trim() : "";
    // Equal-length hashes, compared in constant time
    if (!code || !crypto.timingSafeEqual(sha(code), sha(passcode()))) {
      logger && logger.warn("board_enter_failed", {});
      return res.status(401).json({ error: "That passcode isn't right." });
    }
    const exp = Date.now() + SESSION_DAYS * 864e5;
    res.json({ token: signToken({ role: "board", exp }, cfg.sessionSecret), expiresAt: new Date(exp).toISOString() });
  });

  // Shared link: readable by anyone holding the key, signed in or not. Archived entries stay readable.
  r.get("/shared/:key", sharedReads.mw, (req, res) => {
    const key = String(req.params.key || "");
    const it = key.length >= 22 && all().find((x) => x.shareKey && x.shareKey === key);
    if (!it) return res.status(404).json({ error: "This link no longer works." });
    res.json({ item: shared(it) });
  });

  // Everything below needs a board token. Admin tokens carry no role and member tokens carry role "client".
  r.use((req, res, next) => {
    const m = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const p = m && verifyToken(m[1], cfg.sessionSecret);
    if (!p || p.role !== "board") return res.status(401).json({ error: "Enter the passcode again." });
    next();
  });

  r.get("/", (req, res) => {
    whoOf(req.query.who);
    // Newest first; entries made in the same millisecond keep the later one on top
    const items = all().map(view).reverse().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    res.json({ items, now: nowIso() });
  });

  r.post("/", (req, res) => {
    const b = req.body || {}, who = whoOf(b.who);
    if (!KINDS.includes(b.kind)) fail('Pick what this is: "note", "objective" or "done".');
    const body = textOf(b.body, MAX_BODY, "an entry");
    const list = all();
    if (list.length >= MAX_ITEMS) fail(`The board is full (${MAX_ITEMS} entries). Nothing is deleted from it, so ask the developer to make room.`);
    const at = nowIso();
    const it = { id: crypto.randomBytes(8).toString("hex"), kind: b.kind, by: who, at, body: C.enc(body), replies: [],
      seen: { [who]: at }, doneAt: null, doneBy: null, archived: false, shareKey: null };
    list.push(it); save(list);
    res.status(201).json({ item: view(it) });
  });

  // change(req, fn): validate who, find the entry, let fn(item, who, body, now) edit it, then save
  const change = (fn, out = (it) => ({ item: view(it) })) => (req, res) => {
    const b = req.body || {}, who = whoOf(b.who);
    const list = all(), it = list.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: "That entry isn't here any more." });
    if (fn(it, who, b, nowIso()) !== false) save(list);
    res.json(out(it));
  };

  // A reply makes the note new again for the other person. Replying to a finished note doesn't reopen it.
  r.post("/:id/reply", change((it, who, b, now) => {
    if (it.kind !== "note") fail("Only notes can be answered.");
    const body = textOf(b.body, MAX_REPLY, "a reply");
    it.replies = (Array.isArray(it.replies) ? it.replies : []).concat({ by: who, at: now, body: C.enc(body) });
    it.seen = { [who]: now };
  }));

  r.post("/:id/seen", change((it, who, b, now) => {
    if (it.seen && it.seen[who]) return false; // already seen: the first time stands
    it.seen = { ...(it.seen || {}), [who]: now };
  }));

  r.post("/:id/done", change((it, who, b, now) => {
    if (it.kind === "done") fail("This entry is already a record of something done.");
    const done = flagOf(b.done, "done");
    it.doneAt = done ? now : null; it.doneBy = done ? who : null;
  }));

  r.post("/:id/archive", change((it, who, b) => { it.archived = flagOf(b.archived, "archived"); }));

  r.post("/:id/share", change((it) => {
    if (it.shareKey) return false;
    it.shareKey = crypto.randomBytes(18).toString("base64url"); // 144 bits
  }, (it) => ({ key: it.shareKey })));

  app.use("/api/board", r);
}

module.exports = { mountBoard, MAX_ITEMS };
