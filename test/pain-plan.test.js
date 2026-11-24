// Chart → Plans & protocols: Dr. Jared prescribes pain tracks and Pain Tool protocols, and sees the pain rehab already on
// the client's dashboard (tracks on their road, tracks and protocols they've done) with sessions and last date.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

test("prescribe pain tracks and protocols from the chart; see what's on the client's dashboard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-painplan-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const m = (await call("POST", "/api/clients/signup", { name: "Jabari Cole", email: "j@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    // What he did on his own in the app: put a track on his road, did a session of it and of a Pain Tool protocol
    await call("PUT", "/api/me/about/tracks/levator", undefined, m.token);
    await call("POST", "/api/me/workouts", { title: "Levator pain track", minutes: 15, exercises: 4, key: "track-levator" }, m.token);
    await call("POST", "/api/me/workouts", { title: "Suboccipitals protocol", minutes: 10, exercises: 3, key: "painproto-suboccipitals" }, m.token);
    let chart = (await call("GET", `/api/admin/clients/${m.client.id}`, undefined, admin)).body;
    const by = (pw) => Object.fromEntries(pw.items.map((x) => [`${x.kind}:${x.id}`, x]));
    let w = by(chart.painWork);
    assert.equal(w["track:levator"].onRoad, true, JSON.stringify(chart.painWork));
    assert.equal(w["track:levator"].sessions, 1);
    assert.equal(w["protocol:suboccipitals"].sessions, 1);
    assert.equal(w["track:levator"].prescribed, false);

    // Prescribe: only tracks and protocols that exist in the app
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "made-up" }] }, admin)).status, 400);
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "video", id: "levator" }] }, admin)).status, 400);
    const r = await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "scalenes", note: "Twice a day" }, { kind: "protocol", id: "upper-trap" }, { kind: "track", id: "levator" }] }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    w = by(r.body.painWork);
    assert.equal(w["track:scalenes"].prescribed, true); assert.equal(w["track:scalenes"].note, "Twice a day");
    assert.equal(w["track:levator"].prescribed, true); assert.equal(w["track:levator"].sessions, 1);  // his history stays
    assert.equal(w["protocol:upper-trap"].prescribed, true);
    // Members can't prescribe to themselves; the client sees the prescription on their own account, and the new track on their road
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [] }, m.token)).status, 401);
    const me = (await call("GET", "/api/me", undefined, m.token)).body;
    const mine = (me.client || me).assignedPain;
    assert.deepEqual(mine.map((x) => `${x.kind}:${x.id}`).sort(), ["protocol:upper-trap", "track:levator", "track:scalenes"]);
    const road = (await call("GET", "/api/me/about", undefined, m.token)).body.tracks;
    assert.ok(road.includes("scalenes") && road.includes("levator"), JSON.stringify(road));
    // Taking a prescription away keeps his own road and history
    const r2 = await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "scalenes" }] }, admin);
    w = by(r2.body.painWork);
    assert.equal(w["track:levator"].prescribed, false); assert.equal(w["track:levator"].onRoad, true); assert.equal(w["track:levator"].sessions, 1);
    assert.equal(w["track:scalenes"].note, "Twice a day"); // the note is kept when left out
    // Removing from the chart: a track off their road (one they added themselves); history stays
    const rm = await call("DELETE", `/api/admin/clients/${m.client.id}/road-tracks/levator`, undefined, admin);
    assert.equal(rm.status, 200); w = by(rm.body.painWork);
    assert.equal(w["track:levator"].onRoad, false); assert.equal(w["track:levator"].sessions, 1);
    assert.ok(!(await call("GET", "/api/me/about", undefined, m.token)).body.tracks.includes("levator"));
    assert.equal((await call("DELETE", `/api/admin/clients/${m.client.id}/road-tracks/levator`, undefined, admin)).status, 404);
    assert.equal((await call("DELETE", `/api/admin/clients/${m.client.id}/road-tracks/scalenes`, undefined, m.token)).status, 401);
  } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("a prescription emails the client: what was prescribed, the note, where to find it", async () => {
  const http = require("http"), mails = [];
  const mailer = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const j = JSON.parse(b); (Array.isArray(j) ? j : [j]).forEach((m) => mails.push(m)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mailer.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-painmail-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com",
    resendKey: "test-key", notifyFrom: "MD Fit <hello@example.com>", resendUrl: `http://127.0.0.1:${mailer.address().port}`, notifyGapMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const wait = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); };
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const m = (await call("POST", "/api/clients/signup", { name: "Jabari Cole", email: "jabari@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    const toHim = () => mails.filter((x) => [].concat(x.to).includes("jabari@example.com") && /prescribed/i.test(x.subject || ""));
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator", title: "Levator scapulae → upper shoulder blade", note: "Twice a day" }] }, admin);
    await wait(() => toHim().length === 1);
    let e = toHim();
    assert.equal(e.length, 1, JSON.stringify(mails.map((x) => x.subject)));
    assert.equal(e[0].subject, "Dr. Jared prescribed: Levator scapulae → upper shoulder blade");
    assert.match(e[0].text, /Levator scapulae → upper shoulder blade \(pain track\)/);
    assert.match(e[0].text, /Dr\. Jared's note: Twice a day/);
    assert.match(e[0].text, /https:\/\/mdfit\.example\.com\/account/);
    // Saving again with nothing new sends nothing; adding one more sends one more email, about the new one only
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator", note: "Three times a day" }] }, admin);
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator" }, { kind: "protocol", id: "upper-trap", title: "Upper trapezius protocol" }] }, admin);
    await wait(() => toHim().length === 2);
    e = toHim();
    assert.equal(e.length, 2);
    assert.equal(e[1].subject, "Dr. Jared prescribed: Upper trapezius protocol");
    assert.ok(!/Levator/.test(e[1].text));
  } finally { server.close(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
