// Refresh lib/exercises.json from the frontend's exercise list (mdfit-frontend/app/exercises.js), which is generated
// from Dr. Jared's video library. Sunny suggests videos by these ids. Usage: node scripts/sync-exercises.js [path/to/mdfit-frontend/app/exercises.js] (default: ../mdfit-frontend next to this repo)
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = process.argv[2] || path.join(__dirname, "../../mdfit-frontend/app/exercises.js");
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(src, "utf8"), box);
const L = (box.window.MDFIT_EXERCISES || []).map((e) => ({ id: e.id, name: e.name, region: e.region, cat: e.cat, level: e.level }));
if (!L.length) throw new Error("No exercises found in " + src);
const out = path.join(__dirname, "../lib/exercises.json");
fs.writeFileSync(out, JSON.stringify({ _note: "Copy of the exercise video list in mdfit-frontend/app/exercises.js (id = Drive file id, the catalog key). Sunny suggests videos from it. Refresh: node scripts/sync-exercises.js", exercises: L }) + "\n");
console.log(`${L.length} exercises -> ${out}`);
