// Workout builder ("My workouts") and member-to-member challenges.
//
//   - Members build their own workouts from the exercise library (ids, sets, reps or time, in order) and keep them on
//     their account (client.customWorkouts). Finishing one in the player logs it with key "custom-<id>" → 35 XP.
//   - "Send as challenge": a copy of the workout (name + exercises only; never anything about the sender's health) goes
//     to another member from the ranking pool. Members who hid themselves from the leaderboard can't be picked or sent to.
//     The sender earns +5 (once a day). The recipient sees it on Home, plays it (key "challenge-<id>") and earns 30 + 10.
//   - classifyWorkout() is called by POST /api/me/workouts to stamp kind/ref on the logged workout from facts the server
//     can check (the custom workout exists on this account, the challenge was sent to this member, the program exists).
//     XP is then recomputed from that history by lib/rewards.js; there is no counter to inflate.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { XP } = require("./rewards");

const fail = (msg) => { throw new ValidationError(msg); };
const id = () => crypto.randomBytes(6).toString("hex");
const EX_ID = /^[A-Za-z0-9_-]{6,64}$/;
const CUSTOM_MAX = 50, EXERCISES_MAX = 30, SENDS_PER_DAY = 10, CHALLENGES_KEEP = 5000;
const shortName = (name) => { const p = String(name || "Member").trim().split(/\s+/); return p[0] + (p.length > 1 ? ` ${p[p.length - 1][0]}.` : ""); };

function customInput(b) {
  if (!b || typeof b !== "object") fail("Workout is missing.");
  const name = String(b.name ?? "").trim();
  if (!name) fail("Give your workout a name."); if (name.length > 60) fail("Workout name is too long (max 60 characters).");
  if (!Array.isArray(b.exercises) || !b.exercises.length) fail("Add at least one exercise.");
  if (b.exercises.length > EXERCISES_MAX) fail(`Up to ${EXERCISES_MAX} exercises.`);
  const int = (v, label, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${label} must be ${lo} to ${hi}.`); return n; };
  const exercises = b.exercises.map((e, i) => {
    if (!e || !EX_ID.test(String(e.id || ""))) fail(`Exercise ${i + 1} isn't in the library.`);
    const sets = int(e.sets ?? 1, `Exercise ${i + 1} sets`, 1, 10);
    const timed = e.seconds !== undefined && e.seconds !== null && e.seconds !== "";
    return timed ? { id: e.id, sets, seconds: int(e.seconds, `Exercise ${i + 1} time (seconds)`, 5, 600) } : { id: e.id, sets, reps: int(e.reps ?? 10, `Exercise ${i + 1} reps`, 1, 100) };
  });
  return { name, exercises };
}

// Decide what kind of workout was just logged, from facts on the server. Marks a challenge done the first time.
function classifyWorkout(store, c, key, today) {
  const k = String(key || "");
  let m = k.match(/^custom-([a-f0-9]{12})$/);
  if (m && (c.customWorkouts || []).some((w) => w.id === m[1])) return { kind: "custom", ref: m[1] };
  m = k.match(/^challenge-([a-f0-9]{12})$/);
  if (m) {
    const list = store.read("challenges", []), ch = list.find((x) => x.id === m[1] && x.toId === c.id);
    if (ch) {
      if (ch.status !== "done") { ch.status = "done"; ch.doneAt = new Date().toISOString(); ch.doneDate = today; store.write("challenges", list); }
      return { kind: "challenge", ref: ch.id };
    }
  }
  // MD Fit pain tracks and Pain Tool muscle protocols are Dr. Jared's programs too (owner): 50 XP
  if (/^(track|painproto)-[a-z0-9][a-z0-9-]{0,60}$/.test(k)) return { kind: "program", ref: k };
  if (k.startsWith("prog-")) {
    const programs = require("./content").programsOf(store.read("content", {}));
    const p = programs.find((x) => k.startsWith(`prog-${x.id}-`));
    if (p) return { kind: "program", ref: p.id };
  }
  return { kind: "normal" };
}

function mountCustomWorkouts({ me, store, clients, save, today, boardRows, activity }) {
  const challenges = () => store.read("challenges", []);
  const update = (req, fn) => { const list = clients(), c = list.find((x) => x.id === req.client.id), out = fn(c); save(list); return out; };
  const mine = (c) => ({ workouts: c.customWorkouts || [] });

  // ---- My workouts ----
  me.get("/custom-workouts", (req, res) => res.json(mine(req.client)));
  me.post("/custom-workouts", (req, res) => {
    const w = customInput(req.body);
    res.status(201).json(update(req, (c) => {
      if ((c.customWorkouts || []).length >= CUSTOM_MAX) fail(`You can keep up to ${CUSTOM_MAX} workouts. Delete one first.`);
      const now = new Date().toISOString();
      c.customWorkouts = [{ id: id(), ...w, createdAt: now, updatedAt: now }, ...(c.customWorkouts || [])];
      return { ...mine(c), saved: c.customWorkouts[0] };
    }));
  });
  me.put("/custom-workouts/:id", (req, res) => {
    const w = customInput(req.body);
    res.json(update(req, (c) => {
      const x = (c.customWorkouts || []).find((y) => y.id === req.params.id);
      if (!x) fail("Workout not found.");
      Object.assign(x, w, { updatedAt: new Date().toISOString() });
      return { ...mine(c), saved: x };
    }));
  });
  me.delete("/custom-workouts/:id", (req, res) => res.json(update(req, (c) => {
    const before = (c.customWorkouts || []).length;
    c.customWorkouts = (c.customWorkouts || []).filter((x) => x.id !== req.params.id);
    if (c.customWorkouts.length === before) fail("Workout not found.");
    return mine(c);
  })));

  // ---- Challenges ----
  // Who can be challenged: the leaderboard's pool (members with XP who did NOT hide themselves), never yourself.
  const pool = (selfId) => {
    const real = boardRows(true).filter((r) => !r.pacer && r.id !== selfId);
    const byId = new Map(clients().map((c) => [c.id, c]));
    return real.filter((r) => byId.has(r.id) && !byId.get(r.id).hideRank).map((r) => ({ id: r.id, name: r.name, gem: r.gem })).sort((a, b) => a.name.localeCompare(b.name));
  };
  me.get("/challenges/members", (req, res) => res.json({ members: pool(req.client.id) }));

  const view = (ch, selfId) => ({ id: ch.id, from: ch.fromName, to: ch.toName, incoming: ch.toId === selfId, workout: ch.workout, sentOn: ch.date, status: ch.status, doneOn: ch.doneDate || null });
  me.get("/challenges", (req, res) => {
    const all = challenges(), me_ = req.client.id;
    const inbox = all.filter((x) => x.toId === me_).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ open: inbox.filter((x) => x.status !== "done").slice(0, 20).map((x) => view(x, me_)), done: inbox.filter((x) => x.status === "done").slice(0, 10).map((x) => view(x, me_)),
      sent: all.filter((x) => x.fromId === me_).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20).map((x) => view(x, me_)),
      xp: { send: XP.challengeSent, done: XP.challengeDone } });
  });

  me.post("/challenges", (req, res) => {
    const b = req.body || {}, c = req.client, d = today();
    const w = (c.customWorkouts || []).find((x) => x.id === String(b.workoutId || ""));
    if (!w) fail("Pick one of your saved workouts.");
    const to = clients().find((x) => x.id === String(b.toId || ""));
    // Hidden members (and unknown ids) look the same: not available. Nobody learns whether a hidden member exists.
    if (!to || to.id === c.id || to.hideRank) return res.status(404).json({ error: "That member isn't available for challenges." });
    const list = challenges();
    if (list.filter((x) => x.fromId === c.id && x.date === d).length >= SENDS_PER_DAY) return res.status(429).json({ error: `You can send up to ${SENDS_PER_DAY} challenges a day.` });
    if (list.some((x) => x.fromId === c.id && x.toId === to.id && x.workoutId === w.id && x.status !== "done")) return res.status(409).json({ error: `${shortName(to.name)} already has this challenge waiting.` });
    const firstToday = !list.some((x) => x.fromId === c.id && x.date === d);
    const ch = { id: id(), fromId: c.id, fromName: shortName(c.name), toId: to.id, toName: shortName(to.name), workoutId: w.id,
      workout: { name: w.name, exercises: w.exercises.map((e) => ({ ...e })) }, date: d, createdAt: new Date().toISOString(), status: "open" };
    list.push(ch);
    store.write("challenges", list.slice(-CHALLENGES_KEEP));
    if (activity) activity("challenge_sent", {}); // no names, no workout details
    res.status(201).json({ challenge: view(ch, c.id), xpEarned: firstToday ? XP.challengeSent : 0 });
  });
}

module.exports = { mountCustomWorkouts, classifyWorkout, customInput, shortName };
