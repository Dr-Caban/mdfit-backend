// Build lib/sunny-knowledge.json from the clinic's own published pain data in the frontend (the pain tool's muscle
// referral map, painmuscles.js, and Dr. Jared's pain-relief tracks, paintracks.js), so Sunny answers from the
// practice's clinical library rather than a model's general knowledge. Per body area: the spots a member might mean
// with the muscles that most often refer pain there (first = most common), and the matching pain-relief tracks.
// Usage: node scripts/sync-sunny-knowledge.js [path/to/mdfit-frontend]
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = process.argv[2] || path.join(__dirname, "../../mdfit-frontend");
const box = { window: {} }; vm.createContext(box);
for (const f of ["painmuscles.js", "paintracks.js"]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), box);
const { MUSCLES, SPOTS, BODY_REGIONS } = box.window.MDFitMuscles;
const TRACKS = (box.window.MDFitTracks && (box.window.MDFitTracks.TRACKS || box.window.MDFitTracks.tracks)) || [];
if (!MUSCLES || !SPOTS || !TRACKS.length) throw new Error("Pain data not found in " + root);

// Sunny's areas (lib/guide-ai.js AREAS) -> the pain tool's spot groups ("group" or "group|Spot label")
const AREAS = {
  knee: ["knee", "calf|Back of the knee", "hamstring|Back of the knee"],
  back: ["low-back", "upper-back"],
  shoulder: ["shoulder", "shoulder-b"],
  hip: ["hip", "glute"],
  neck: ["neck", "neck-b"],
  ankle: ["ankle", "heel|Achilles tendon"],
  foot: ["heel", "ankle|Sole of the foot", "ankle|Inner ankle and arch"],
  elbow: ["elbow"],
  wrist: ["wrist"]
};
const nameOf = (id) => (MUSCLES[id] ? MUSCLES[id].name.replace(/\s*\(.*\)$/, "") : id);
const spotsOf = (keys) => keys.flatMap((k) => { const [g, label] = k.split("|"); return (SPOTS[g] || []).filter((s) => !label || s[0] === label).map((s) => ({ key: `${g}|${s[0]}`, label: s[0], ids: s[1] })); });
const trackById = new Map(TRACKS.map((t) => [t.id, t]));

const out = {};
for (const [area, keys] of Object.entries(AREAS)) {
  const spots = spotsOf(keys), want = new Set(spots.map((s) => s.key));
  // Tracks the pain tool offers for these spots (BODY_REGIONS list the tracks for each region's spots), most-linked first
  const count = new Map();
  for (const r of BODY_REGIONS || []) if ((r.spots || []).some((k) => want.has(k))) for (const id of r.tracks || []) count.set(id, (count.get(id) || 0) + 1);
  const tracks = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => trackById.get(id)).filter(Boolean).slice(0, 5).map((t) => ({ id: t.id, title: t.title }));
  // One line per spot (a spot listed under two groups, e.g. "Back of the knee", is merged); each muscle named once
  const bySpot = new Map();
  for (const s of spots) bySpot.set(s.label, [...(bySpot.get(s.label) || []), ...s.ids]);
  const names = (ids) => [...new Set(ids.map(nameOf))].filter((n, i, all) => !all.some((m, j) => j < i && (m.startsWith(n) || n.startsWith(m)))).slice(0, 4);
  out[area] = { spots: [...bySpot.entries()].map(([spot, ids]) => ({ spot, muscles: names(ids) })), tracks };
}
const file = path.join(__dirname, "../lib/sunny-knowledge.json");
fs.writeFileSync(file, JSON.stringify({
  _note: "Built by scripts/sync-sunny-knowledge.js from mdfit-frontend painmuscles.js (the pain tool's referral map) and paintracks.js (Dr. Jared's pain-relief tracks). Do not edit by hand.",
  approach: "Dr. Jared's approach: assess, release, correct, assign homework, strengthen. The source of pain is often not where it hurts: a muscle somewhere else commonly refers pain to that spot, so the pain tool checks the usual sources.",
  areas: out
}, null, 1) + "\n");
console.log(Object.entries(out).map(([a, v]) => `${a}: ${v.spots.length} spots, ${v.tracks.length} tracks`).join("\n") + "\n-> " + file);
