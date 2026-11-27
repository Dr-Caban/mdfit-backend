// Send something in MD Fit to another member (owner, Nov 2026): a video, a health or nutrition page, a program, a pain
// track or a Pain Tool protocol. (A workout a member built is sent as a challenge: lib/custom-workouts.js.)
//
//   - Only things MD Fit has: the id is checked against the video library, the programs, the tips, the pain tracks and
//     the Pain Tool protocols. Nothing else can be sent, and no words of the sender's travel with it: the name shown
//     is looked up here (videos, programs, pages) or by the recipient's app from the id (tracks, protocols).
//   - To any other member except those who hid themselves from the leaderboard (the same pool as challenges: someone
//     who has signed in to an app account that is still open).
//   - The recipient sees it on Home with the sender's short name ("Pat D.") and nothing else about them; the push says
//     only that something arrived. They can open it or dismiss it.
//   - The sender sees one word of status: waiting, opened, or (programs only) started. No counts, dates or anything
//     else from the recipient's account, and nothing at all about what they do until they have opened it.
//   - When an account goes away, what it sent and was sent goes with it (see people() below).
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { shortName, available, textOf, PAIN_TRACKS, PAIN_PROTOCOLS } = require("./custom-workouts");
const { programsOf, recommendationsOf, defaultContent } = require("./content");
const LIB = new Map((require("./exercises.json").exercises || []).map((e) => [e.id, e.name]));

const KINDS = ["video", "page", "program", "track", "protocol"];
const PER_DAY = 20, KEEP = 10000;
const fail = (msg) => { throw new ValidationError(msg); };

function mountSends({ app, me, store, clients, today }) {
  // Who is still here. The other party of a row is one of three things:
  //   - a member with an open account: the row is shown;
  //   - set aside (in the 30-day trash, or a closed account): the row is kept, so a Restore brings it back, but it is
  //     not shown to anyone while they are away;
  //   - erased (in neither the client list nor the trash): the row is left out of everything here, and it is gone from
  //     the store the next time anything is written.
  // It is done here, on reading, because the code that ends an account (finalize in lib/clients.js) is a locked part.
  const people = () => {
    const open = new Map(), kept = new Set(), list = clients(), trash = store.read("clients-trash", []);
    for (const c of Array.isArray(list) ? list : []) if (c && c.id) { kept.add(c.id); if (!c.deletedAt) open.set(c.id, c); }
    for (const e of Array.isArray(trash) ? trash : []) if (e && e.id) kept.add(e.id);
    return { open, kept };
  };
  const all = (who) => { const l = store.read("sends", []); return (Array.isArray(l) ? l : []).filter((s) => s && who.kept.has(s.fromId) && who.kept.has(s.toId)); };
  const write = (l) => store.write("sends", l.slice(-KEEP));
  const saved = () => store.read("content", {}) || {};
  const exists = (kind, ref) => kind === "video" ? LIB.has(ref)
    : kind === "page" ? recommendationsOf(saved(), defaultContent()).some((r) => r.id === ref)
    : kind === "program" ? programsOf(saved(), defaultContent()).some((p) => p.id === ref)
    : kind === "track" ? PAIN_TRACKS.has(ref) || (saved().tracks || []).some((t) => t && t.id === ref)
    : kind === "protocol" ? PAIN_PROTOCOLS.has(ref) : false;

  const titleOf = (kind, ref) => kind === "video" ? LIB.get(ref) || ""
    : kind === "page" ? (recommendationsOf(saved(), defaultContent()).find((r) => r.id === ref) || {}).title || ""
    : kind === "program" ? (programsOf(saved(), defaultContent()).find((p) => p.id === ref) || {}).title || "" : "";
  // Started = the recipient opened the send and, after that, logged a session of the program. Until they open it the
  // sender is told nothing about what they do: an unopened send that turned to "started" told the sender what the
  // recipient was doing on their own. Pain tracks and protocols stop at "opened", and so does a rehabilitation
  // program or one Dr. Jared assigned to the recipient (now or earlier): whether someone is doing rehab or a
  // prescribed program is theirs to tell, not something the sender is shown.
  const prescribed = (to, ref) => [...(to.assignedPrograms || []), ...(to.programHistory || [])].some((p) => p && p.id === ref);
  // Each program's category, read at most once per request and only if a row gets as far as needing it
  const categories = () => {
    let m = null;
    const load = () => m || (m = new Map(programsOf(saved(), defaultContent()).map((p) => [p.id, p.category])));
    const of = (ref) => load().get(ref);
    of.ids = () => [...load().keys()];
    return of;
  };
  // A session of exactly this program: its key is "prog-<id>-w<week>" or "prog-<id>-d<day>" (lib/clients.js
  // programProgress), and it belongs to the longest program id it starts with. A plain prefix test took a
  // "golf-intermediate" session for "golf".
  const sessionOf = (key, ref, ids) => {
    const k = String(key || "");
    return k.startsWith(`prog-${ref}-`) && !ids.some((x) => x.length > ref.length && x.startsWith(ref + "-") && k.startsWith(`prog-${x}-`));
  };
  function status(s, to, categoryOf) {
    if (s.dismissedAt) return "dismissed";
    if (s.kind === "program" && s.openedAt && to && !prescribed(to, s.ref)
      && (to.workouts || []).some((w) => w && String(w.completedAt || w.date || "") >= s.openedAt && sessionOf(w.key, s.ref, categoryOf.ids()))) {
      const category = categoryOf(s.ref);   // none: the program is no longer listed, so it cannot be checked and is not shown either
      if (category && category !== "Rehabilitation") return "started";
    }
    return s.openedAt ? "opened" : "waiting";
  }
  const view = (s, selfId, to, categoryOf) => ({ id: s.id, kind: s.kind, ref: s.ref, title: s.title, from: s.fromName, to: s.toName, incoming: s.toId === selfId, sentOn: s.date, status: status(s, to, categoryOf) });

  me.get("/sends", (req, res) => {
    const id = req.client.id, who = people(), list = all(who), categoryOf = categories();
    const newest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    res.json({ inbox: list.filter((s) => s.toId === id && !s.dismissedAt && who.open.has(s.fromId)).sort(newest).slice(0, 30).map((s) => view(s, id, req.client, categoryOf)),
      sent: list.filter((s) => s.fromId === id && who.open.has(s.toId)).sort(newest).slice(0, 30).map((s) => view(s, id, who.open.get(s.toId), categoryOf)) });
  });

  me.post("/sends", (req, res) => {
    const b = req.body || {}, c = req.client, d = today();
    const NOT_MDFIT = "That isn't something in MD Fit that can be sent.";
    const kind = textOf(b.kind, NOT_MDFIT), ref = textOf(b.ref, NOT_MDFIT), toId = textOf(b.toId, "Pick a member to send it to.");
    if (!KINDS.includes(kind) || !ref || ref.length > 80 || !exists(kind, ref)) fail(NOT_MDFIT);
    const title = titleOf(kind, ref);
    const who = people(), to = who.open.get(toId);
    // Hidden members, unknown ids, closed accounts and records nobody has signed in to all look the same: nobody
    // learns whether any of them exists
    if (!to || to.id === c.id || !available(to)) return res.status(404).json({ error: "That member isn't available." });
    const list = all(who);
    if (list.filter((s) => s.fromId === c.id && s.date === d).length >= PER_DAY) return res.status(429).json({ error: `You can send up to ${PER_DAY} things a day.` });
    if (list.some((s) => s.fromId === c.id && s.toId === to.id && s.kind === kind && s.ref === ref && !s.openedAt && !s.dismissedAt)) return res.status(409).json({ error: `${shortName(to.name)} already has this waiting.` });
    const s = { id: crypto.randomBytes(6).toString("hex"), fromId: c.id, fromName: shortName(c.name), toId: to.id, toName: shortName(to.name), kind, ref, title, date: d, createdAt: new Date().toISOString() };
    list.push(s); write(list);
    const push = app.get("push");
    if (push) push.toClient(to.id, { title: "Sent to you on MD Fit", body: `${s.fromName} sent you something. Open the app to see it.`, route: "home" });
    res.status(201).json({ send: view(s, c.id, to, categories()) });
  });

  const mineIn = (req, res) => { const who = people(), list = all(who), s = list.find((x) => x.id === req.params.id && x.toId === req.client.id && who.open.has(x.fromId)); if (!s) { res.status(404).json({ error: "That wasn't sent to you." }); return []; } return [list, s]; };
  me.post("/sends/:id/open", (req, res) => { const [list, s] = mineIn(req, res); if (!s) return; if (!s.openedAt) { s.openedAt = new Date().toISOString(); write(list); } res.json({ ok: true }); });
  me.delete("/sends/:id", (req, res) => { const [list, s] = mineIn(req, res); if (!s) return; s.dismissedAt = new Date().toISOString(); write(list); res.json({ ok: true }); });
}

module.exports = { mountSends, KINDS };
