// The words that stop a message before it reaches the assistant and give the crisis or emergency answer instead
// (lib/crisis.js). The app checks the same words first (mdfit-frontend/mdfit-guide.js holds a copy).
// When in doubt a message counts: a crisis answer to an ordinary sentence costs a moment, a missed crisis does not.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isUrgent, isCrisis } = require("../lib/crisis");
const guideAI = require("../lib/guide-ai");

const S = JSON.parse(fs.readFileSync(path.join(__dirname, "crisis-sentences.json"), "utf8"));

test("crisis words: every crisis and emergency sentence counts, in any case and spacing", () => {
  assert.ok(S.urgent.length > 300);
  for (const t of S.urgent) {
    assert.equal(isUrgent(t), true, t);
    assert.equal(isUrgent(t.toUpperCase()), true, t.toUpperCase());
    assert.equal(isUrgent(t.toLowerCase()), true, t.toLowerCase());
    assert.equal(isUrgent(`  ${t.replace(/ /g, "  ")}\n`), true, "extra spaces: " + t);
  }
});

test("crisis words: ordinary sentences and injuries do not count", () => {
  assert.ok(S.ordinary.length > 100);
  for (const t of S.ordinary) assert.equal(isUrgent(t), false, t);
});

test("crisis words: sentences the words cannot tell from a crisis lean to safety", () => {
  for (const t of S.cautious) assert.equal(isUrgent(t), true, t);
});

test("crisis words: intent always counts, even beside an activity or a body part", () => {
  for (const t of ["I want to hurt myself at the gym", "I'll hurt myself, I can't take my knee pain", "My shoulder hurts so much I want to hurt myself",
    "I'm going to cut myself in the kitchen", "I cut myself on my wrist again", "how can I hurt myself without anyone noticing", "help me stop hurting myself",
    "I hurt myself lifting on purpose", "I don't want to hurt myself anymore but I can't stop"]) assert.equal(isUrgent(t), true, t);
  for (const t of ["I hurt myself lifting yesterday", "I cut myself shaving", "will I hurt myself if I run", "How do I avoid hurting myself", "I fell and hurt myself",
    "I don't want to hurt myself doing this exercise", "I squat without hurting myself"]) assert.equal(isUrgent(t), false, t);
});

test("crisis words: a crisis is told from a medical emergency, so the app can offer the crisis line", () => {
  for (const t of ["I want to die", "I want to hurt myself", "I self harm", "I don't want to be here anymore", "kms", "I hurt myself"]) assert.equal(isCrisis(t), true, t);
  for (const t of ["chest pain", "I can't breathe", "she fainted", "call 911", "I think I'm having a stroke"]) { assert.equal(isCrisis(t), false, t); assert.equal(isUrgent(t), true, t); }
});

test("crisis words: the assistant module uses this same check", () => {
  assert.equal(guideAI.isUrgent, isUrgent);
  // the copy in the app must run on older iPhones too: no regex lookbehind anywhere in the shared code
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "crisis.js"), "utf8");
  const shared = src.slice(src.indexOf("// ---- crisis words (start"), src.indexOf("// ---- crisis words (end"));
  assert.ok(shared.length > 1000);
  assert.equal(/\(\?<[=!]/.test(shared), false, "no lookbehind");
});
