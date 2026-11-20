// PSG — State of Perpetual Growth. The shape the owner specified (Nov 2026): two heavy Break Days open the
// program and set every weight after them, the week that repeats is three upper and three lower at 30-40% less,
// mobility is a substitution rather than a scheduled day, and a Break Day only ever comes round again once
// soreness has gone completely.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultContent, programsOf, recommendationsOf } = require("../lib/content");

const d = defaultContent();
const psg = () => d.programs.find((p) => p.id === "hypertrophy-12");
const brk = () => d.programs.find((p) => p.id === "psg-break");
const article = () => d.recommendations.find((r) => r.id === "psg-protocol");
const OLD_SUMMARY_START = "A continuous progression program for strength, size and mobility. 7-day cycle:";

test("the week that repeats is three upper and three lower, with no scheduled mobility day", () => {
  const p = psg();
  assert.equal(p.days.length, 7);
  assert.equal(p.days.filter((x) => x.goal === "upper").length, 3);
  assert.equal(p.days.filter((x) => x.goal === "lower").length, 3);
  // upper and lower alternate across the six strength days
  assert.deepEqual(p.days.slice(0, 6).map((x) => x.goal), ["upper", "lower", "upper", "lower", "upper", "lower"]);
  // the seventh is Sunday: rest, or mobility only if soreness is very low
  assert.match(p.days[6].name, /Sunday/);
  // mobility is never one of the six working days -- it replaces one when soreness is over 7/10
  assert.equal(p.days.slice(0, 6).some((x) => /mobility/i.test(x.name)), false);
  assert.match(p.summary + p.notes, /over 7 out of 10|over 7\/10/);
});

test("every working day is the lighter version, measured off the Break Day weight", () => {
  for (const day of psg().days.slice(0, 6)) {
    for (const ex of day.circuit) {
      if (/sit-up/i.test(ex.ex)) { assert.match(ex.sets, /light/i); continue; }
      assert.match(ex.sets, /50, 40, 30, 20, 10/);
      assert.match(ex.sets, /30-40% lighter/);
      assert.match(ex.sets, /Break Day/);
    }
  }
});

test("the Break Days are their own program: heavy, two sessions, loaded off the one-rep max", () => {
  const b = brk();
  assert.ok(b, "psg-break exists");
  assert.equal(b.days.length, 2);
  assert.deepEqual(b.days.map((x) => x.goal), ["upper", "lower"]);
  assert.ok(b.days.every((x) => x.length === 90), "they are the long days");
  assert.ok(b.days.every((x) => /Break Day/.test(x.name)));
  for (const day of b.days) {
    for (const ex of day.circuit) {
      if (/sit-up/i.test(ex.ex)) continue;
      assert.match(ex.sets, /50 reps at 50% of your 1RM/);
      assert.match(ex.sets, /add 5-10% each set/);
      assert.match(ex.sets, /[Dd]escending only/);
    }
  }
  // and they must say they are only repeated once soreness has gone
  assert.match(b.notes, /no soreness|nothing lingering/i);
});

test("no ladder comes back up, anywhere", () => {
  const everything = JSON.stringify([psg(), brk(), article()]);
  assert.equal(/20, 30, 40, 50/.test(everything), false, "the return pyramid is gone");
  assert.equal(/back down to 50|reverse the pyramid/i.test(everything), false);
  // and it says so in words, rather than just omitting it
  assert.match(everything, /[Dd]escending only|none of them come back up/);
});

test("the article carries the loading, the schedule and a safety line", () => {
  const text = JSON.stringify(article().sections);
  assert.match(text, /50% of your one-rep max/);
  assert.match(text, /5-10%/);
  assert.match(text, /30-40%/);
  assert.match(text, /rest-pause/i, "the set of 50 is past failure on purpose, and says so");
  assert.match(text, /dark urine|swelling/i, "high-volume work carries a warning");
  // the old blurb called PSG a recovery protocol; it is a training program
  assert.equal(/recovery protocol/i.test(article().body), false);
});

test("content limits the admin validator enforces are respected", () => {
  for (const p of [psg(), brk()]) {
    assert.ok(p.summary.length <= 400, `${p.id} summary ${p.summary.length}`);
    assert.ok(p.notes.length <= 1000, `${p.id} notes ${p.notes.length}`);
    for (const day of p.days) {
      assert.ok(day.name.length <= 40, `day name too long: ${day.name}`);
      assert.ok([15, 20, 25, 30, 45, 60, 90].includes(day.length), `bad length ${day.length}`);
      for (const ex of day.circuit) {
        assert.ok(ex.ex.length <= 80, `exercise name too long: ${ex.ex}`);
        assert.ok(ex.sets.length <= 120, `sets too long (${ex.sets.length}): ${ex.sets}`);
      }
    }
  }
});

test("a practice that saved the old PSG and never touched it gets the new one", () => {
  const savedSummary = OLD_SUMMARY_START + " upper, mobility, lower, mobility, upper, lower, then Sunday mobility if soreness is low (otherwise rest). Every strength day runs the same 50-40-30-20-10 movements at lighter weight; the heavy Long days are break cycles — rare and far apart.";
  const saved = { contentVersion: 5, knownDefaults: ["hypertrophy-12"], programs: [{ id: "hypertrophy-12", summary: savedSummary, days: [] }] };
  const out = programsOf(saved, d);
  const got = out.find((p) => p.id === "hypertrophy-12");
  assert.equal(got.days.length, 7, "their stale copy was replaced");
  assert.notEqual(got.summary, savedSummary);
  assert.ok(out.some((p) => p.id === "psg-break"), "and the Break Days arrive as a new program");
});

test("a PSG the practice actually edited is never overwritten", () => {
  const saved = { contentVersion: 5, knownDefaults: ["hypertrophy-12"],
    programs: [{ id: "hypertrophy-12", summary: "Our own PSG", days: [{ name: "Ours" }] }] };
  const got = programsOf(saved, d).find((p) => p.id === "hypertrophy-12");
  assert.equal(got.summary, "Our own PSG");
  assert.equal(got.days.length, 1);
});

test("the old article is replaced; a rewritten one is kept", () => {
  const old = { recommendations: [{ id: "psg-protocol", title: "t", body: "b",
    sections: [{ type: "table", rows: [["B. Dumbbell bench press", "Chest", "50, 40, 30, 20, 10, 20, 30, 40, 50 (back down to 50)"]] }] }] };
  const fixed = recommendationsOf(old, d).find((r) => r.id === "psg-protocol");
  assert.equal(/20, 30, 40, 50/.test(JSON.stringify(fixed.sections)), false);

  const theirs = { recommendations: [{ id: "psg-protocol", title: "t", body: "b", sections: [{ type: "text", text: "our own words" }] }] };
  const kept = recommendationsOf(theirs, d).find((r) => r.id === "psg-protocol");
  assert.match(JSON.stringify(kept.sections), /our own words/);
});
