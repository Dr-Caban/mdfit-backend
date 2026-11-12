// Sharing a saved program or a saved workout by link.
//
//   - A member shares one of their own saved items (a generator program from c.programs, or a built workout from
//     c.customWorkouts). They get a link carrying a random key: /api/shares/<key> reads it, signed in or not.
//   - What the link shows is a snapshot taken at share time: the item's name and its exercises, and the sharer's short
//     display name ("Pat D.") only. Never an email, an id, a phone number, or anything about the sharer's health,
//     chart, pain, membership or progress — the same rule the challenge copy follows in lib/custom-workouts.js.
//     Because it is a snapshot, later edits by the owner don't silently change what someone already opened.
//   - Any signed-in member may save a copy, free membership included: it lands in "Shared with me" (c.sharedWithMe),
//     never in c.customWorkouts or c.programs, so receiving a share buys none of the paid builder (owner: building
//     workouts and sending challenges takes a membership; receiving and doing one does not).
//   - Nothing is deleted. Revoking a link sets revokedAt and the link then 404s; copies already saved keep working.
//   - The key is the only thing protecting a shared item, so it is kept out of the request log (lib/logger.js) and
//     the public read is rate limited so keys can't be guessed in bulk.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { shortName } = require("./custom-workouts");

const KEY = "shares";
const KINDS = ["program", "workout"];
const SHARES_MAX = 20000;        // the whole store: nothing is deleted, so new shares are refused once it's full
const PER_MEMBER = 200;          // live shares one member may hold
const SAVED_MAX = 100;           // entries in one member's "Shared with me"
const READS = 60, READ_WINDOW_MS = 15 * 60 * 1000;
const GONE = { error: "This link no longer works." };
const NOT_YOURS = { error: "That isn't in your library." };

const fail = (msg) => { throw new ValidationError(msg); };
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
// Older built workouts saved a hold in seconds; they are shown as reps (about one rep per 3 seconds), the same way
// lib/custom-workouts.js shows them, so a shared copy never carries a time.
const repsOnly = (exercises) => (Array.isArray(exercises) ? exercises : []).map(({ id, sets, reps, seconds }) =>
  ({ id, sets, reps: reps || Math.max(5, Math.min(100, Math.round((seconds || 30) / 3))) }));

function mountShares({ app, me, store, clients, save, limiter }) {
  const all = () => { const l = store.read(KEY, []); return Array.isArray(l) ? l : []; };
  const write = (list) => store.write(KEY, list);
  const live = (s) => !!s && !s.revokedAt;
  const update = (req, fn) => { const list = clients(), c = list.find((x) => x.id === req.client.id), out = fn(c); save(list); return out; };

  // What the owner sees about their own link. No snapshot here: they already have the item.
  const mine = (s) => ({ key: s.key, kind: s.kind, itemId: s.itemId, title: s.title, by: s.by, createdAt: s.createdAt });
  // What anyone holding the link sees. Nothing else may be added to this.
  const publicView = (s) => ({ kind: s.kind, title: s.title, by: s.by, snapshot: clone(s.snapshot), createdAt: s.createdAt });

  // The item the caller owns, and the snapshot taken from it
  function snapshotOf(c, kind, id) {
    if (kind === "workout") {
      const w = (c.customWorkouts || []).find((x) => x.id === id);
      return w && { title: w.name, snapshot: { name: w.name, exercises: repsOnly(w.exercises) } };
    }
    const p = (c.programs || []).find((x) => x.id === id);
    return p && { title: p.name, snapshot: { name: p.name, workout: clone(p.workout) } };
  }

  // ---- Member: my links ----
  me.post("/shares", (req, res) => {
    const b = req.body || {}, c = req.client;
    const kind = String(b.kind || "");
    if (!KINDS.includes(kind)) fail('Say what you\'re sharing: "program" or "workout".');
    const itemId = String(b.id || "");
    const item = itemId && snapshotOf(c, kind, itemId);
    if (!item) return res.status(404).json(NOT_YOURS);
    const list = all();
    // Sharing the same item again hands back the link that already exists, so a member can copy it twice
    const already = list.find((s) => live(s) && s.ownerId === c.id && s.kind === kind && s.itemId === itemId);
    if (already) return res.json({ share: mine(already) });
    if (list.filter((s) => live(s) && s.ownerId === c.id).length >= PER_MEMBER)
      fail(`You can have up to ${PER_MEMBER} share links at a time. Turn one off first.`);
    if (list.length >= SHARES_MAX) fail("Sharing is full on the server. Nothing is deleted from it, so ask the practice to make room.");
    const s = { key: crypto.randomBytes(18).toString("base64url"), kind, ownerId: c.id, itemId, title: item.title,
      by: shortName(c.name), snapshot: item.snapshot, createdAt: new Date().toISOString(), revokedAt: null };
    list.push(s); write(list);
    res.status(201).json({ share: mine(s) });
  });

  me.get("/shares", (req, res) => res.json({
    shares: all().filter((s) => live(s) && s.ownerId === req.client.id).map(mine).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }));

  // Revoking never deletes: the row stays with revokedAt set. Someone else's link is not found, and keeps working.
  me.delete("/shares/:key", (req, res) => {
    const list = all(), s = list.find((x) => x.key === req.params.key && x.ownerId === req.client.id && live(x));
    if (!s) return res.status(404).json({ error: "That isn't one of your share links." });
    s.revokedAt = new Date().toISOString();
    write(list);
    res.json({ ok: true });
  });

  // ---- Member: save a copy of someone's share ----
  // Open to every signed-in member, free membership included: this is the point of the feature.
  me.post("/shares/:key/save", (req, res) => {
    const s = all().find((x) => x.key === req.params.key && live(x));
    if (!s || !clients().some((c) => c.id === s.ownerId)) return res.status(404).json(GONE);
    if (s.ownerId === req.client.id) fail("This is your own share. It's already in your library.");
    res.status(201).json(update(req, (c) => {
      const list = (c.sharedWithMe = Array.isArray(c.sharedWithMe) ? c.sharedWithMe : []);
      const had = list.find((x) => x.fromKey === s.key);
      if (had) return { saved: clone(had) };
      if (list.length >= SAVED_MAX) fail(`You can keep up to ${SAVED_MAX} shared items. Remove one first.`);
      const saved = { id: crypto.randomBytes(6).toString("hex"), kind: s.kind, title: s.title, by: s.by,
        snapshot: clone(s.snapshot), fromKey: s.key, savedAt: new Date().toISOString() };
      list.unshift(saved);
      return { saved: clone(saved) };
    }));
  });

  const sharedWithMe = (c) => ({ items: (Array.isArray(c.sharedWithMe) ? c.sharedWithMe : []).map(clone) });
  me.get("/shared-with-me", (req, res) => res.json(sharedWithMe(req.client)));
  me.delete("/shared-with-me/:id", (req, res) => res.json(update(req, (c) => {
    const before = (c.sharedWithMe || []).length;
    c.sharedWithMe = (c.sharedWithMe || []).filter((x) => x.id !== req.params.id);
    if (c.sharedWithMe.length === before) fail("That isn't in your shared items.");
    return sharedWithMe(c);
  })));

  // ---- Public: read a link. No token, no membership, nothing about the sharer but their short name. ----
  const reads = limiter(READS, READ_WINDOW_MS);
  app.get("/api/shares/:key", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (reads.blocked(req.ip)) return res.status(429).json({ error: "Too many requests. Try again later." });
    reads.hit(req.ip);
    const key = String(req.params.key || "");
    const s = key.length >= 22 && all().find((x) => x.key === key && live(x));
    // Unknown, revoked, or the sharer's account is gone: all the same answer
    if (!s || !clients().some((c) => c.id === s.ownerId)) return res.status(404).json(GONE);
    res.json({ share: publicView(s) });
  });
}

module.exports = { mountShares, SHARES_MAX, PER_MEMBER, SAVED_MAX };
