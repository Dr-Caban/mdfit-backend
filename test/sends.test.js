// Sending a video, page, program, pain track or Pain Tool protocol to another member (lib/sends.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

test("send MD Fit things to a member: inbox, status, limits, privacy", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-sends-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  let n = 0; const member = async (name) => (await call("POST", "/api/clients/signup", { name, email: `m${++n}@example.com`, phone: "941-555-0100", password: "pass-word-123" })).body;
  try {
    const a = await member("Ann Lee"), b = await member("Bo Kim"), c = await member("Cy Diaz");
    const vid = require("../lib/exercises.json").exercises[0].id;
    const tip = (await call("GET", "/api/content")).body.recommendations[0].id;
    const S = (body, t = a.token) => call("POST", "/api/me/sends", { toId: b.client.id, ...body }, t);
    // Only things MD Fit has
    assert.equal((await S({ kind: "video", ref: vid, title: "Ankle Circles" })).status, 201);
    assert.equal((await S({ kind: "page", ref: tip, title: "A tip" })).status, 201);
    assert.equal((await S({ kind: "program", ref: "hypertrophy-12", title: "PSG" })).status, 201);
    assert.equal((await S({ kind: "track", ref: "levator", title: "Levator" })).status, 201);
    assert.equal((await S({ kind: "protocol", ref: "upper-trap", title: "Upper trapezius protocol" })).status, 201);
    assert.equal((await S({ kind: "video", ref: "not-a-video", title: "x" })).status, 400);
    assert.equal((await S({ kind: "link", ref: "https://example.com", title: "x" })).status, 400);
    assert.equal((await S({ kind: "program", ref: "made-up", title: "x" })).status, 400);
    assert.equal((await S({ kind: "program", ref: "hypertrophy-12", title: "PSG" })).status, 409);     // already waiting
    assert.equal((await call("POST", "/api/me/sends", { toId: a.client.id, kind: "video", ref: vid, title: "x" }, a.token)).status, 404); // not to yourself
    assert.equal((await call("POST", "/api/me/sends", { kind: "video", ref: vid, title: "x" })).status, 401);

    // The recipient's inbox: the sender's short name only
    const inbox = (await call("GET", "/api/me/sends", undefined, b.token)).body.inbox;
    assert.equal(inbox.length, 5); assert.ok(inbox.every((x) => x.from === "Ann L." && x.status === "waiting"));
    assert.ok(!JSON.stringify(inbox).includes("@example.com") && !JSON.stringify(inbox).includes(a.client.id));
    // Nobody else sees them, and only the recipient can open or dismiss
    assert.equal((await call("GET", "/api/me/sends", undefined, c.token)).body.inbox.length, 0);
    const prog = inbox.find((x) => x.kind === "program"), video = inbox.find((x) => x.kind === "video"), track = inbox.find((x) => x.kind === "track");
    assert.equal((await call("POST", `/api/me/sends/${prog.id}/open`, undefined, c.token)).status, 404);
    assert.equal((await call("POST", `/api/me/sends/${prog.id}/open`, undefined, b.token)).status, 200);
    assert.equal((await call("POST", `/api/me/sends/${video.id}/open`, undefined, b.token)).status, 200);
    // A session of the program after it was sent shows as started; the sender sees one word, nothing else
    await call("POST", "/api/me/workouts", { title: "PSG day 1", minutes: 40, exercises: 3, key: "prog-hypertrophy-12-d0" }, b.token);
    await call("DELETE", `/api/me/sends/${track.id}`, undefined, b.token);
    const sent = (await call("GET", "/api/me/sends", undefined, a.token)).body.sent;
    const st = Object.fromEntries(sent.map((x) => [x.kind, x.status]));
    assert.deepEqual(st, { video: "opened", page: "waiting", program: "started", track: "dismissed", protocol: "waiting" });
    assert.deepEqual(Object.keys(sent[0]).sort(), ["from", "id", "incoming", "kind", "ref", "sentOn", "status", "title", "to"]);
    assert.equal((await call("GET", "/api/me/sends", undefined, b.token)).body.inbox.length, 4); // the dismissed one is gone
  } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
