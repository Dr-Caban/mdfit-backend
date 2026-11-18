"use strict";
// The member app's Home layout (owner-edited in the workspace) and Solomon's tips without reworded repeats.
const test = require("node:test");
const assert = require("node:assert/strict");
const { homeOf, homeIn, HOME_SECTIONS } = require("../lib/content");
const { addSuggested, suggestedOf } = require("../lib/suggested");

test("home layout: defaults, saved order, later cards and validation", () => {
  const d = homeOf({});
  assert.equal(d.sections.length, HOME_SECTIONS.length);
  assert.equal(d.suggestions, 3);
  assert.ok(d.sections.every((x) => x.show), "everything shows until the owner changes it");
  // A full saved order is kept exactly, unknown ids dropped
  const saved = homeOf({ home: { sections: [...HOME_SECTIONS].reverse().map((x) => ({ id: x.id, show: x.id !== "activity" })).concat([{ id: "gone", show: true }]), suggestions: 0 } });
  assert.deepEqual(saved.sections.map((x) => x.id), [...HOME_SECTIONS].reverse().map((x) => x.id));
  assert.equal(saved.sections.find((x) => x.id === "activity").show, false);
  assert.equal(saved.suggestions, 0);
  // A card the app gained after the layout was saved joins it, after its neighbour in the default list
  const partial = homeOf({ home: { sections: HOME_SECTIONS.filter((x) => x.id !== "habits").map((x) => ({ id: x.id, show: true })) } });
  const ids = partial.sections.map((x) => x.id);
  assert.equal(ids.indexOf("habits"), ids.indexOf("challenges") + 1);
  // What the workspace may save
  assert.deepEqual(homeIn({ sections: [{ id: "today", show: 1 }], suggestions: 2 }), { sections: [{ id: "today", show: true }], suggestions: 2 });
  assert.throws(() => homeIn({ sections: [{ id: "nope" }] }), /unknown or repeated/);
  assert.throws(() => homeIn({ sections: [{ id: "today" }, { id: "today" }] }), /unknown or repeated/);
  assert.throws(() => homeIn({ sections: [], suggestions: 99 }), /0 to 20/);
  assert.throws(() => homeIn(null), /list of sections/);
});

test("suggested tips: the same advice reworded is kept once, the newest", () => {
  const c = {};
  addSuggested(c, { tip: "Stay well-hydrated and aim for 7–8 hours of sleep each night to support recovery and growth." }, "2026-11-01");
  addSuggested(c, { tip: "Ice the knee for 15 minutes after a long run." }, "2026-11-02");
  addSuggested(c, { tip: "Stay hydrated and aim for 7-9 hours of sleep to support tissue recovery." }, "2026-11-03");
  const tips = suggestedOf(c).tips.map((x) => x.text);
  assert.deepEqual(tips, ["Stay hydrated and aim for 7-9 hours of sleep to support tissue recovery.", "Ice the knee for 15 minutes after a long run."]);
  // Repeats already saved before this change collapse when read
  const old = { suggested: { tips: [
    { id: "a1", text: "Stay hydrated and aim for 7-9 hours of sleep to support tissue recovery.", at: "3" },
    { id: "a2", text: "Stay hydrated and aim for 7–8 hours of sleep; gentle movement and a warm or cold pack can help soothe discomfort.", at: "2" },
    { id: "a3", text: "Stay well-hydrated and aim for 7–8 hours of sleep each night to support recovery and growth.", at: "1" }] } };
  assert.deepEqual(suggestedOf(old).tips.map((x) => x.id), ["a1"]);
});
