// Send something in MD Fit to another member (owner, Nov 2026): a video, a health or nutrition page, a program, a pain
// track or a Pain Tool protocol. (A workout a member built is sent as a challenge: lib/custom-workouts.js.)
//
//   - Only things MD Fit has: the id is checked against the video library, the programs, the tips, the pain tracks and
//     the Pain Tool protocols. Nothing else, and no free text, can be sent.
//   - To any other member except those who hid themselves from the leaderboard (the same pool as challenges).
//   - The recipient sees it on Home with the sender's short name ("Pat D.") and nothing else about them; the push says
//     only that something arrived. They can open it or dismiss it.
//   - The sender sees one word of status: waiting, opened, or started (a program, track or protocol they have done a
//     session of since it was sent). No counts, dates or anything else from the recipient's account.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { shortName, PAIN_TRACKS, PAIN_PROTOCOLS } = require("./custom-workouts");
const { programsOf, recommendationsOf, defaultContent } = require("./content");
const LIB = new Set((require("./exercises.json").exercises || []).map((e) => e.id));

const KINDS = ["video", "page", "program", "track", "protocol"];
const PER_DAY = 20, KEEP = 10000;
const fail = (msg) => { throw new ValidationError(msg); };

function mountSends({ app, me, store, clients, today }) {
  const all = () => { const l = store.read("sends", []); return Array.isArray(l) ? l : []; };
  const write = (l) => store.write("sends", l.slice(-KEEP));
  const saved = () => store.read("content", {}) || {};
  const exists = (kind, ref) => kind === "video" ? LIB.has(ref)
    : kind === "page" ? recommendationsOf(saved(), defaultContent()).some((r) => r.id === ref)
    : kind === "program" ? programsOf(saved(), defaultContent()).some((p) => p.id === ref)
    : kind === "track" ? PAIN_TRACKS.has(ref) || (saved().tracks || []).some((t) => t && t.id === ref)
    : kind === "protocol" ? PAIN_PROTOCOLS.has(ref) : false;

  // Started = the recipient logged a session of it after it was sent (the keys the app's player writes)
  function status(s, to) {
    if (s.dismissedAt) return "dismissed";
    const key = s.kind === "program" ? (k) => k.startsWith(`prog-${s.ref}-`) : s.kind === "track" ? (k) => k === `track-${s.ref}` : s.kind === "protocol" ? (k) => k === `painproto-${s.ref}` : null;
    if (key && to && (to.workouts || []).some((w) => String(w.completedAt || w.date || "") >= s.createdAt && key(String(w.key || "")))) return "started";
    return s.openedAt ? "opened" : "waiting";
  }
  const view = (s, selfId, to) => ({ id: s.id, kind: s.kind, ref: s.ref, title: s.title, from: s.fromName, to: s.toName, incoming: s.toId === selfId, sentOn: s.date, status: status(s, to) });

  me.get("/sends", (req, res) => {
    const id = req.client.id, list = all(), byId = new Map(clients().map((c) => [c.id, c]));
    const newest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    res.json({ inbox: list.filter((s) => s.toId === id && !s.dismissedAt).sort(newest).slice(0, 30).map((s) => view(s, id, req.client)),
      sent: list.filter((s) => s.fromId === id).sort(newest).slice(0, 30).map((s) => view(s, id, byId.get(s.toId))) });
  });

  me.post("/sends", (req, res) => {
    const b = req.body || {}, c = req.client, d = today();
    const kind = String(b.kind || ""), ref = String(b.ref || "");
    if (!KINDS.includes(kind) || !ref || ref.length > 80 || !exists(kind, ref)) fail("That isn't something in MD Fit that can be sent.");
    const title = String(b.title || "").trim().slice(0, 80);
    if (!title) fail("Say what it's called.");
    const to = clients().find((x) => x.id === String(b.toId || ""));
    // Hidden members and unknown ids look the same: nobody learns whether a hidden member exists
    if (!to || to.id === c.id || to.hideRank || to.deletedAt) return res.status(404).json({ error: "That member isn't available." });
    const list = all();
    if (list.filter((s) => s.fromId === c.id && s.date === d).length >= PER_DAY) return res.status(429).json({ error: `You can send up to ${PER_DAY} things a day.` });
    if (list.some((s) => s.fromId === c.id && s.toId === to.id && s.kind === kind && s.ref === ref && !s.openedAt && !s.dismissedAt)) return res.status(409).json({ error: `${shortName(to.name)} already has this waiting.` });
    const s = { id: crypto.randomBytes(6).toString("hex"), fromId: c.id, fromName: shortName(c.name), toId: to.id, toName: shortName(to.name), kind, ref, title, date: d, createdAt: new Date().toISOString() };
    list.push(s); write(list);
    const push = app.get("push");
    if (push) push.toClient(to.id, { title: "Sent to you on MD Fit", body: `${s.fromName} sent you something. Open the app to see it.`, route: "home" });
    res.status(201).json({ send: view(s, c.id, to) });
  });

  const mineIn = (req, res) => { const list = all(), s = list.find((x) => x.id === req.params.id && x.toId === req.client.id); if (!s) { res.status(404).json({ error: "That wasn't sent to you." }); return []; } return [list, s]; };
  me.post("/sends/:id/open", (req, res) => { const [list, s] = mineIn(req, res); if (!s) return; if (!s.openedAt) { s.openedAt = new Date().toISOString(); write(list); } res.json({ ok: true }); });
  me.delete("/sends/:id", (req, res) => { const [list, s] = mineIn(req, res); if (!s) return; s.dismissedAt = new Date().toISOString(); write(list); res.json({ ok: true }); });
}

module.exports = { mountSends, KINDS };
