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

test("a prescription emails the client that something was added, never what it is or the note", async () => {
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
    const toHim = () => mails.filter((x) => [].concat(x.to).includes("jabari@example.com") && /care plan/i.test(x.subject || ""));
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator", title: "Levator scapulae → upper shoulder blade", note: "Twice a day, left side hurts most" }] }, admin);
    await wait(() => toHim().length === 1);
    let e = toHim();
    assert.equal(e.length, 1, JSON.stringify(mails.map((x) => x.subject)));
    assert.equal(e[0].subject, "Dr. Jared added to your care plan");
    assert.match(e[0].text, /something new/); assert.match(e[0].text, /For privacy it isn't in this email/); assert.match(e[0].text, /https:\/\/mdfit\.example\.com\/account/);
    assert.ok(!/Levator|scapulae|Twice a day|left side|pain track/i.test(e[0].subject + e[0].text + (e[0].html || "")), "no treatment name or note in the email");
    // Saving with nothing new sends nothing; adding one more sends one more
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator", note: "Three times a day" }] }, admin);
    await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator" }, { kind: "protocol", id: "upper-trap" }] }, admin);
    await wait(() => toHim().length === 2);
    assert.equal(toHim().length, 2);
  } finally { server.close(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("anything added from the chart emails the client once, the same private message; removing sends nothing", async () => {
  const http = require("http"), mails = [];
  const mailer = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const j = JSON.parse(b); (Array.isArray(j) ? j : [j]).forEach((m) => mails.push(m)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mailer.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-caremail-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com",
    resendKey: "test-key", notifyFrom: "MD Fit <hello@example.com>", resendUrl: `http://127.0.0.1:${mailer.address().port}`, notifyGapMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const pause = () => new Promise((r) => setTimeout(r, 400));
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const m = (await call("POST", "/api/clients/signup", { name: "Jabari Cole", email: "jabari@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    const care = () => mails.filter((x) => [].concat(x.to).includes("jabari@example.com") && x.subject === "Dr. Jared added to your care plan");
    const step = async (label, fn, expect) => { const n = care().length; await fn(); await pause(); assert.equal(care().length - n, expect, `${label}: ${care().length - n} emails, expected ${expect}`); };
    const id = m.client.id;
    await step("program added", () => call("PUT", `/api/admin/clients/${id}/programs`, { programs: [{ id: "hypertrophy-12" }] }, admin), 1);
    await step("same programs saved again", () => call("PUT", `/api/admin/clients/${id}/programs`, { programs: [{ id: "hypertrophy-12" }] }, admin), 0);
    await step("program removed", () => call("PUT", `/api/admin/clients/${id}/programs`, { programs: [] }, admin), 0);
    await step("written protocol added", () => call("PUT", `/api/admin/clients/${id}/plan`, { guides: [], exercises: [{ name: "Cold shower", detail: "2 min" }], notes: "" }, admin), 1);
    await step("plan saved with nothing new", () => call("PUT", `/api/admin/clients/${id}/plan`, { guides: [], exercises: [{ name: "Cold shower", detail: "2 min" }], notes: "" }, admin), 0);
    await step("written protocol removed", () => call("PUT", `/api/admin/clients/${id}/plan`, { guides: [], exercises: [], notes: "" }, admin), 0);
    await step("treatment plan written", () => call("PUT", `/api/admin/clients/${id}/plan`, { guides: [], exercises: [], notes: "Twice a week for 6 weeks" }, admin), 1);
    await step("pain track prescribed", () => call("PUT", `/api/admin/clients/${id}/pain-plan`, { items: [{ kind: "track", id: "levator" }] }, admin), 1);
    await step("movement added (chart)", () => call("POST", `/api/admin/emr/${id}/movements`, { videoId: require("../lib/exercises.json").exercises[0].id, name: "Ankle circles", dose: "2 × 10" }, admin), 1);
    await step("note to the patient (chart)", () => call("POST", `/api/admin/emr/${id}/notes`, { text: "Keep going" }, admin), 1);
    // None of them names a treatment or carries the note
    for (const e of care()) assert.ok(!/PSG|Perpetual|Cold shower|levator|Ankle circles|Twice a week|Keep going/i.test(e.text + (e.html || "")), e.text);
  } finally { server.close(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("start over keeps a pain track Dr. Jared prescribed on the road; the member's own tracks leave it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-painstart-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const m = (await call("POST", "/api/clients/signup", { name: "Jabari Cole", email: "j@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    await call("PUT", "/api/me/about/tracks/scalenes", undefined, m.token);                                       // his own
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator" }, { kind: "track", id: "supraspinatus" }] }, admin)).status, 200);
    await call("DELETE", "/api/me/about/tracks/supraspinatus", undefined, m.token);                                // he took this one off himself
    assert.deepEqual((await call("GET", "/api/me/about", undefined, m.token)).body.tracks.sort(), ["levator", "scalenes"]);
    assert.equal((await call("POST", "/api/me/start-over", { password: "pass-word-123" }, m.token)).status, 200);
    assert.deepEqual((await call("GET", "/api/me/about", undefined, m.token)).body.tracks, ["levator"], "the prescribed track he kept stays; his own goes; one he took off stays off");
    const chart = (await call("GET", `/api/admin/clients/${m.client.id}`, undefined, admin)).body;
    const lev = chart.painWork.items.find((x) => x.kind === "track" && x.id === "levator");
    assert.equal(lev.prescribed, true); assert.equal(lev.onRoad, true, "the chart still shows it on his road");
  } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("pain plan: an object for a kind or id answers 400; a closed account is sent no care-plan email", async () => {
  const http = require("http"), mails = [];
  const mailer = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const j = JSON.parse(b); (Array.isArray(j) ? j : [j]).forEach((m) => mails.push(m)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise((r) => mailer.once("listening", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-painclosed-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com",
    resendKey: "test-key", notifyFrom: "MD Fit <hello@example.com>", resendUrl: `http://127.0.0.1:${mailer.address().port}`, notifyGapMs: 0 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const pause = () => new Promise((r) => setTimeout(r, 400));
  try {
    const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
    const m = (await call("POST", "/api/clients/signup", { name: "Cleo Closed", email: "cleo@example.com", phone: "941-555-0100", password: "pass-word-123" })).body;
    for (const item of [{ kind: { toString: "x" }, id: "levator" }, { kind: "track", id: { toString: "x" } }, { kind: ["track"], id: "levator" }, null]) {
      const r = await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [item] }, admin);
      assert.equal(r.status, 400, JSON.stringify(item)); assert.equal(r.body.error, "That pain track or protocol isn't in MD Fit.");
    }
    // a check-in makes it a chart, so closing the account keeps the record ("Closed account")
    await call("POST", "/api/me/pain", { area: "Knee", level: 3 }, m.token);
    assert.equal((await call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pass-word-123" }, m.token)).body.mode, "close");
    await pause();
    const n = mails.length;
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/pain-plan`, { items: [{ kind: "track", id: "levator" }] }, admin)).status, 200);
    assert.equal((await call("PUT", `/api/admin/clients/${m.client.id}/programs`, { programs: [{ id: "hypertrophy-12" }] }, admin)).status, 200);
    await pause();
    assert.deepEqual(mails.slice(n).map((x) => [].concat(x.to)[0] + " / " + x.subject), [], "nothing to the placeholder address");
  } finally { server.close(); mailer.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
