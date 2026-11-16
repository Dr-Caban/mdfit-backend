const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createActivityLog, summarize } = require("../lib/activity-log");

test("activity log: keeps lines per day, encrypted at rest, prunes past the window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-log-"));
  let now = new Date("2026-10-01T12:00:00Z");
  const log = createActivityLog({ dir, key: "k".repeat(32), keepDays: 21, now: () => now });
  log.append(JSON.stringify({ level: "info", msg: "listening" }));
  log.append(JSON.stringify({ level: "info", msg: "request", method: "POST", path: "/api/search/log", status: 200 }));
  log.append(JSON.stringify({ level: "error", msg: "request", method: "GET", path: "/api/admin/clients/abcdef123456", status: 500 }));
  const raw = fs.readFileSync(path.join(dir, "2026-10-01.log"), "utf8");
  assert.ok(!raw.includes("search"), "nothing readable on disk");
  const { entries, unreadable } = log.read("2026-10-01");
  assert.equal(entries.length, 3); assert.equal(unreadable, 0);
  const s = summarize(entries);
  assert.equal(s.requests, 2); assert.equal(s.s5xx, 1); assert.equal(s.restarts, 1);
  assert.equal(s.errorPaths[0].key, "GET /api/admin/clients/:id");
  // 22 days later the first day is pruned, the new day is kept
  now = new Date("2026-10-23T12:00:00Z");
  log.append(JSON.stringify({ level: "info", msg: "request", method: "GET", path: "/api/site", status: 200 }));
  assert.deepEqual(log.days().map((d) => d.date), ["2026-10-23"]);
  // a different key cannot read it, and says so instead of returning nothing silently
  const other = createActivityLog({ dir, key: "x".repeat(32) });
  assert.equal(other.read("2026-10-23").unreadable, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("activity log: never throws when the disk refuses a write", () => {
  // a directory path that runs through a regular file can never be created
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-log-")), "file");
  fs.writeFileSync(f, "x");
  const log = createActivityLog({ dir: path.join(f, "logs") });
  assert.doesNotThrow(() => log.append("{}"));
  assert.deepEqual(log.days(), []);
});
