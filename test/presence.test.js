// Time in app (lib/presence.js): asking about many members with one read of the store, and what is kept of an
// account that no longer exists. Made-up ids only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mountPresence, readPresence } = require("../lib/presence");

function harness({ clients = [{ id: "c1" }, { id: "c2" }], trash = [], presence = {} } = {}) {
  const data = { clients, "clients-trash": trash, presence };
  const reads = {};
  const store = { read: (k, d) => { reads[k] = (reads[k] || 0) + 1; return k in data ? JSON.parse(JSON.stringify(data[k])) : d; }, write: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
  const routes = {}, settings = {};
  const api = mountPresence({ app: { set: (k, v) => { settings[k] = v; } }, me: { post: (p, fn) => { routes[p] = fn; } }, store, today: () => "2026-11-26", cfg: { now: () => new Date("2026-11-26T17:00:00Z") }, clients: () => store.read("clients", []) });
  const beat = (id, body = { seconds: 60, view: "home", platform: "web" }) => { let out; routes["/presence"]({ client: { id }, body }, { json: (b) => { out = b; } }); return out; };
  return { api, data, reads, beat, settings };
}
const day = (seconds) => ({ seconds, sessions: 1, views: { home: seconds }, platforms: { web: seconds } });

test("presence: all() reads the store once and every per-member question can be answered from that copy", () => {
  const presence = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`c${i}`, { lastAt: 1764000000000, lastView: "home", lastPlatform: "web", device: { app: false, os: "mac", browser: "safari", media: true }, days: { "2026-11-20": day(600 + i * 60), "2026-11-26": day(120), "2026-09-01": day(6000) } }]));
  const h = harness({ clients: Object.keys(presence).map((id) => ({ id })), presence });
  assert.equal(h.settings.presenceApi, h.api);
  // One member at a time, as before: one read each
  const each = Object.keys(presence).map((id) => h.api.minutesIn(id, "2026-11-26", 30));
  assert.equal(h.reads.presence, 50);
  // Many members: one read for all of them, and the same answers
  h.reads.presence = 0;
  const all = h.api.all();
  assert.deepEqual(Object.keys(presence).map((id) => h.api.minutesIn(id, "2026-11-26", 30, all)), each);
  assert.deepEqual(h.api.summary("c7", "2026-11-26", 30, all), h.api.summary("c7", "2026-11-26", 30));
  assert.deepEqual(h.api.minutesByDay("c7", all), h.api.minutesByDay("c7"));
  assert.deepEqual(h.api.device("c7", all), h.api.device("c7"));
  assert.equal(h.api.minutesIn("nobody", "2026-11-26", 30, all), 0);
  assert.equal(h.reads.presence, 1 + 3, "all() once; the three calls made without the copy read it themselves");
  assert.equal(each[7], Math.round((600 + 7 * 60 + 120) / 60), "30 days ending today: Nov 20 and Nov 26, not Sep 1");
  // A store that is not the shape it should be reads as empty
  for (const odd of [null, [], "x", 5]) assert.deepEqual(readPresence({ read: () => odd }), {});
});

test("presence: an erased account's row is left out and dropped on the next write; the trash and a closed account keep theirs", () => {
  const h = harness({
    clients: [{ id: "c1" }, { id: "closed1", deletedAt: "2026-11-01T00:00:00.000Z" }],
    trash: [{ id: "trashed1", client: { id: "trashed1" } }],
    presence: Object.fromEntries(["c1", "closed1", "trashed1", "erased1"].map((id) => [id, { lastAt: 1, device: { app: true, os: "ios", browser: "other", media: false }, days: { "2026-11-20": day(60) } }]))
  });
  // What staff are shown (the telehealth device list) leaves the erased id out at once, without writing anything
  assert.deepEqual(Object.keys(h.api.devices()).sort(), ["c1", "closed1", "trashed1"]);
  assert.ok(h.data.presence.erased1, "reading does not write");
  // The next heartbeat from anyone writes the store without it
  assert.equal(h.beat("c1").ok, true);
  assert.deepEqual(Object.keys(h.data.presence).sort(), ["c1", "closed1", "trashed1"], "kept: the client list and the 30-day trash");
  assert.equal(h.data.presence.c1.days["2026-11-26"].seconds, 60);
  assert.equal(h.data.presence.trashed1.days["2026-11-20"].seconds, 60, "a Restore brings their minutes back");
});
