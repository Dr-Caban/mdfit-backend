"use strict";
// The member app's Home layout (owner-edited in the workspace) and Solomon's tips without reworded repeats.
const test = require("node:test");
const assert = require("node:assert/strict");
const { homeOf, homeIn, layoutOf, layoutIn, memberLayoutIn, HOME_SECTIONS } = require("../lib/content");
const { addSuggested, suggestedOf } = require("../lib/suggested");

test("home layout: defaults, saved order, later cards and validation", () => {
  const d = homeOf({});
  assert.equal(d.sections.length, HOME_SECTIONS.length);
  assert.equal(d.suggestions, 3);
  assert.deepEqual(d.sections.slice(0, 3).map((x) => x.id), ["care", "fromJared", "today"], "what Dr. Jared left comes first");
  assert.ok(d.sections.every((x) => x.state !== "hidden" && x.show), "nothing hidden until the owner hides it");
  assert.equal(d.sections.find((x) => x.id === "events").state, "folded");
  // A full saved order is kept exactly, unknown ids dropped
  const saved = homeOf({ home: { sections: [...HOME_SECTIONS].reverse().map((x) => ({ id: x.id, show: x.id !== "activity" })).concat([{ id: "gone", show: true }]), suggestions: 0 } });
  assert.deepEqual(saved.sections.map((x) => x.id), [...HOME_SECTIONS].reverse().map((x) => x.id));
  assert.equal(saved.sections.find((x) => x.id === "activity").show, false);
  assert.equal(saved.suggestions, 0);
  // A card the app gained after the layout was saved joins it, after its neighbour in the default list
  const partial = homeOf({ home: { sections: HOME_SECTIONS.filter((x) => x.id !== "habits").map((x) => ({ id: x.id, show: true })) } });
  const ids = partial.sections.map((x) => x.id);
  const prev = HOME_SECTIONS[HOME_SECTIONS.findIndex((x) => x.id === "habits") - 1].id;
  assert.equal(ids.indexOf("habits"), ids.indexOf(prev) + 1, "after the card before it in the default list");
  // What the workspace may save
  assert.deepEqual(homeIn({ sections: [{ id: "today", show: 1 }], suggestions: 2 }), { sections: [{ id: "today", state: "open" }], suggestions: 2 });
  assert.deepEqual(homeIn({ sections: [{ id: "today", state: "folded" }] }), { sections: [{ id: "today", state: "folded" }], suggestions: 3 });
  assert.throws(() => homeIn({ sections: [{ id: "today", state: "huge" }] }), /open, folded or hidden/);
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

test("profile layout and a member's own arrangement inside the owner's", () => {
  const p = layoutOf("profile", {});
  assert.deepEqual(p.sections.filter((x) => x.state === "open").map((x) => x.id), ["care", "membership", "patient"]);
  assert.equal(p.suggestions, undefined, "suggestions are a Home setting");
  assert.deepEqual(layoutIn("profile", { sections: [{ id: "referral", state: "open" }], suggestions: 9 }), { sections: [{ id: "referral", state: "open" }] });
  assert.throws(() => layoutIn("profile", { sections: [{ id: "today" }] }), /Profile layout: unknown/);
  const owner = layoutOf("home", { home: { sections: [{ id: "gem", state: "hidden" }] } });
  const mine = memberLayoutIn("home", { sections: [{ id: "gem", state: "open" }, { id: "care", state: "hidden" }, { id: "events", state: "open" }] }, owner);
  assert.deepEqual(mine.sections, [{ id: "gem", state: "hidden" }, { id: "care", state: "folded" }, { id: "events", state: "open" }]);
  // Read back through today's card list: the rest of the cards follow in the owner's default order
  const read = layoutOf("home", { home: mine });
  const ids = read.sections.map((x) => x.id);
  assert.equal(ids[0], "gem"); assert.ok(ids.indexOf("care") < ids.indexOf("events"), "the member's own order is kept");
  assert.equal(read.sections.length, HOME_SECTIONS.length);
});
