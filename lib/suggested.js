// What Sunny (MD Fit Intelligence) suggested, kept on the member's own record and shown on their Home under
// "Suggested for you", apart from what Dr. Jared recommends (assignedPrograms).
//
//   c.suggested = { programs: [{ id, at }], videos: [{ id, at }], guides: [{ id, at }], tips: [{ id, text, at }] }   newest first
//
// Program ids are content program ids, video ids are exercise ids (lib/exercises.json), guide ids are Dr. Jared's
// guides (content recommendations). A tip's text is encrypted in
// the file (lib/phi.js). Nothing the member typed is ever here: only what was suggested back, by id.
"use strict";
const crypto = require("crypto");

const CAPS = { programs: 6, videos: 8, guides: 4, tips: 3 };
const KINDS = Object.keys(CAPS);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// The stored shape, tidied: known kinds only, well-formed entries only, newest first, within the caps
function suggestedOf(c) {
  const s = (c && c.suggested) || {};
  const clean = (list, n, ok) => (Array.isArray(list) ? list.filter((x) => x && typeof x === "object" && ok(x)) : []).slice(0, n);
  return {
    programs: clean(s.programs, CAPS.programs, (x) => ID_RE.test(String(x.id || ""))).map((x) => ({ id: x.id, at: x.at || null })),
    videos: clean(s.videos, CAPS.videos, (x) => ID_RE.test(String(x.id || ""))).map((x) => ({ id: x.id, at: x.at || null })),
    guides: clean(s.guides, CAPS.guides, (x) => ID_RE.test(String(x.id || ""))).map((x) => ({ id: x.id, at: x.at || null })),
    tips: clean(s.tips, CAPS.tips, (x) => ID_RE.test(String(x.id || "")) && typeof x.text === "string" && x.text).map((x) => ({ id: x.id, text: x.text, at: x.at || null }))
  };
}

// Put new suggestions in front: one already there moves to the front instead of appearing twice
function addSuggested(c, { programs = [], videos = [], guides = [], tip = "" }, at) {
  const s = suggestedOf(c);
  const front = (list, ids, n) => [...ids.map((id) => ({ id, at })), ...list.filter((x) => !ids.includes(x.id))].slice(0, n);
  s.programs = front(s.programs, [...new Set(programs)], CAPS.programs);
  s.videos = front(s.videos, [...new Set(videos)], CAPS.videos);
  s.guides = front(s.guides, [...new Set(guides)], CAPS.guides);
  const t = String(tip || "").trim();
  if (t) s.tips = [{ id: crypto.randomBytes(6).toString("hex"), text: t, at }, ...s.tips.filter((x) => x.text !== t)].slice(0, CAPS.tips);
  c.suggested = s;
  return s;
}

// Dismiss one. Returns false when it was not there.
function removeSuggested(c, kind, id) {
  if (!KINDS.includes(kind)) return false;
  const s = suggestedOf(c), before = s[kind].length;
  s[kind] = s[kind].filter((x) => x.id !== id);
  if (s[kind].length === before) return false;
  c.suggested = s;
  return true;
}

module.exports = { suggestedOf, addSuggested, removeSuggested, CAPS, KINDS };
