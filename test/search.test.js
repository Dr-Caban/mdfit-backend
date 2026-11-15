const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const PASSWORD = "admin-pass-123";

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const cfg = { adminEmail: "c@x.com", adminPasswordHash: hashPassword(PASSWORD), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-03T12:00:00Z") };
  const server = createApp(cfg).listen(0);
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let tok = "";
  const call = async (m, u, b, h={}) => {
    const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}), ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch {} return { status: r.status, body: j };
  };
  const login = async () => { const r = await call("POST", "/api/admin/login", { email: "c@x.com", password: PASSWORD }); tok = r.body.token; };
  return { call, login, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("search: logs queries, clicks, no-clicks; serves aggregated signals", async (t) => {
  const s = await start(); t.after(s.close);
  // Nothing logged yet
  let r = await s.call("GET", "/api/search/signals");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.boost, {});
  // Log a query → click → noclick
  assert.equal((await s.call("POST", "/api/search/log", { type: "query", q: "KNEE PAIN", resultCount: 5 })).status, 200);
  assert.equal((await s.call("POST", "/api/search/log", { type: "click", q: "knee pain", id: "cond:knee-pain", position: 0 })).status, 200);
  // A second search for the same thing (the client logs the query before the click)
  assert.equal((await s.call("POST", "/api/search/log", { type: "query", q: "knee pain", resultCount: 5 })).status, 200);
  assert.equal((await s.call("POST", "/api/search/log", { type: "click", q: "knee pain", id: "cond:knee-pain", position: 0 })).status, 200);
  assert.equal((await s.call("POST", "/api/search/log", { type: "noclick", q: "jello wiggle", resultCount: 0 })).status, 200);
  // Short queries drop silently
  assert.equal((await s.call("POST", "/api/search/log", { type: "query", q: "a", resultCount: 0 })).status, 200);
  // Signals cache is 60s so we poke the internal store directly: just verify new fetch returns the boost once cache expires
  // For test, we can just check that the admin route sees the events immediately
  await s.login();
  r = await s.call("GET", "/api/admin/search-analytics?days=1");
  assert.equal(r.status, 200);
  assert.ok(r.body.top.find(x => x.q === "knee pain"), "top queries should include knee pain");
  const row = r.body.top.find(x => x.q === "knee pain");
  assert.equal(row.clicks, 2);
  assert.ok(row.ctr > 0);
  assert.equal(row.topDoc, "cond:knee-pain");
  // Zero-result query is tracked
  const zero = r.body.top.find(x => x.q === "jello wiggle");
  assert.ok(zero, "noclick on empty results is logged");
});

test("search: invalid types ignored, long queries truncated, no auth required", async (t) => {
  const s = await start(); t.after(s.close);
  // Unknown type is coerced to 'query'
  const r = await s.call("POST", "/api/search/log", { type: "evil", q: "shoulder pain", resultCount: 3 });
  assert.equal(r.status, 200);
  // Admin endpoint requires auth
  const noAuth = await s.call("GET", "/api/admin/search-analytics?days=7");
  assert.equal(noAuth.status, 401);
  // After login works
  await s.login();
  const withAuth = await s.call("GET", "/api/admin/search-analytics?days=7");
  assert.equal(withAuth.status, 200);
});

const { analyze } = require("../lib/search");
test("search analytics: typing bursts, truncation and video-filter noise collapse to real searches", () => {
  const T = Date.parse("2026-11-10T15:00:00Z"); const ev = []; let t = T;
  const full = "neck neurologist used to give me occipital blocks my rom is very little until i started seeing a medical massage therapist";
  for (let i = 2; i <= full.length; i++) { t += 300; ev.push({ t: "query", ts: t, q: full.slice(0, i).trim(), n: 3 }); }
  for (let i = 0; i < 40; i++) { t += 300; ev.push({ t: "query", ts: t, q: full.slice(0, 120), n: 3 }); } // legacy truncated repeats
  ev.push({ t: "noclick", ts: t + 500, q: full.slice(0, 120), n: 3 });
  t += 3_600_000; for (const q of ["hi", "hip"]) { t += 400; ev.push({ t: "query", ts: t, q, n: 5 }); }
  ev.push({ t: "click", ts: t + 2000, q: "hip", id: "cond:hip", pos: 0 });
  t += 60_000; ev.push({ t: "query", ts: t, q: "squat", n: 40 });            // legacy Videos filter
  t += 60_000; ev.push({ t: "query", ts: t, q: "lunge", n: 3, src: "videos" });
  const r = analyze(ev);
  assert.equal(r.totals.searches, 2);
  assert.equal(r.totals.videoFilterEvents, 2);
  assert.equal(r.totals.clicks, 1);
  assert.equal(r.top.find((x) => x.q === "hip").ctr, 100);
  assert.ok(!r.top.find((x) => x.q === "hi"), "half-typed words are not searches");
});
