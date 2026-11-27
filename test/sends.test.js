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
    // The sender's words never travel: names come from MD Fit (or are left for the app to look up by id)
    assert.equal(inbox.find((x) => x.kind === "video").title, require("../lib/exercises.json").exercises[0].name);
    assert.equal(inbox.find((x) => x.kind === "program").title, "PSG — State of Perpetual Growth");
    assert.equal(inbox.find((x) => x.kind === "track").title, ""); assert.equal(inbox.find((x) => x.kind === "protocol").title, "");
    assert.ok(!JSON.stringify(inbox).includes("A tip"));
    assert.ok(!JSON.stringify(inbox).includes("@example.com") && !JSON.stringify(inbox).includes(a.client.id));
    // Nobody else sees them, and only the recipient can open or dismiss
    assert.equal((await call("GET", "/api/me/sends", undefined, c.token)).body.inbox.length, 0);
    const prog = inbox.find((x) => x.kind === "program"), video = inbox.find((x) => x.kind === "video"), track = inbox.find((x) => x.kind === "track");
    assert.equal((await call("POST", `/api/me/sends/${prog.id}/open`, undefined, c.token)).status, 404);
    assert.equal((await call("POST", `/api/me/sends/${prog.id}/open`, undefined, b.token)).status, 200);
    assert.equal((await call("POST", `/api/me/sends/${video.id}/open`, undefined, b.token)).status, 200);
    // A session of the program after it was sent shows as started; the sender sees one word, nothing else
    await call("POST", "/api/me/workouts", { title: "PSG day 1", minutes: 40, exercises: 3, key: "prog-hypertrophy-12-d0" }, b.token);
    const proto = inbox.find((x) => x.kind === "protocol");
    await call("POST", `/api/me/sends/${proto.id}/open`, undefined, b.token);
    await call("POST", "/api/me/workouts", { title: "Upper trap", minutes: 10, exercises: 3, key: "painproto-upper-trap" }, b.token); // pain rehab never shows as started
    await call("DELETE", `/api/me/sends/${track.id}`, undefined, b.token);
    const sent = (await call("GET", "/api/me/sends", undefined, a.token)).body.sent;
    const st = Object.fromEntries(sent.map((x) => [x.kind, x.status]));
    assert.deepEqual(st, { video: "opened", page: "waiting", program: "started", track: "dismissed", protocol: "opened" });
    assert.deepEqual(Object.keys(sent[0]).sort(), ["from", "id", "incoming", "kind", "ref", "sentOn", "status", "title", "to"]);
    assert.equal((await call("GET", "/api/me/sends", undefined, b.token)).body.inbox.length, 4); // the dismissed one is gone
  } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---- Debug of Nov 26 2026: what a status tells the sender, who can be sent to, and what is left when an account goes.
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-sends-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  let n = 0;
  const member = async (name) => (await call("POST", "/api/clients/signup", { name, email: `p${++n}@example.com`, phone: "941-555-0100", password: "pass-word-123" })).body;
  const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const file = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const put = (name, data) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  const pause = () => new Promise((r) => setTimeout(r, 5)); // so two timestamps taken one after the other are never the same millisecond
  return { call, member, admin, file, put, pause, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const VIDS = require("../lib/exercises.json").exercises.map((e) => e.id);

test("status: 'started' only after the recipient opened the send, and never for a rehabilitation or assigned program", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await s.member("Ann Lee"), b = await s.member("Bo Kim");
  const statusOf = async (ref, token = a.token) => { const r = (await s.call("GET", "/api/me/sends", undefined, token)).body; return (token === a.token ? r.sent : r.inbox).find((x) => x.ref === ref).status; };
  const send = (ref) => s.call("POST", "/api/me/sends", { toId: b.client.id, kind: "program", ref }, a.token);
  const open = async (ref) => { const id = (await s.call("GET", "/api/me/sends", undefined, b.token)).body.inbox.find((x) => x.ref === ref).id; return s.call("POST", `/api/me/sends/${id}/open`, undefined, b.token); };
  const session = (ref) => s.call("POST", "/api/me/workouts", { title: "Session", minutes: 20, exercises: 3, key: `prog-${ref}-d0` }, b.token);

  // An unopened send says nothing about what the recipient does, even when they do that very program
  assert.equal((await send("hypertrophy-12")).status, 201);
  await s.pause(); assert.equal((await session("hypertrophy-12")).status, 201);
  assert.equal(await statusOf("hypertrophy-12"), "waiting", "the recipient never opened it");
  // Opening it does not turn what they did before into 'started'
  await s.pause(); assert.equal((await open("hypertrophy-12")).status, 200);
  assert.equal(await statusOf("hypertrophy-12"), "opened");
  // A session after opening does
  await s.pause(); await session("hypertrophy-12");
  assert.equal(await statusOf("hypertrophy-12"), "started");

  // A rehabilitation program stops at opened, like the pain tracks and protocols
  await send("shoulder-6"); await open("shoulder-6"); await s.pause(); await session("shoulder-6");
  assert.equal(await statusOf("shoulder-6"), "opened", "whether someone is doing rehab is theirs to tell");

  // So does a program Dr. Jared assigned to the recipient, while it is assigned and after it is taken off
  assert.equal((await s.call("PUT", `/api/admin/clients/${b.client.id}/programs`, { programs: [{ id: "dream-lean-12" }] }, s.admin)).status, 200);
  await send("dream-lean-12"); await open("dream-lean-12"); await s.pause(); await session("dream-lean-12");
  assert.equal(await statusOf("dream-lean-12"), "opened", "a prescribed program is not the sender's to know about");
  await s.call("PUT", `/api/admin/clients/${b.client.id}/programs`, { programs: [] }, s.admin);
  assert.equal(await statusOf("dream-lean-12"), "opened", "still not shown once it is in their program history");
  // The words stay within the four the sender may see, and the answer keeps its shape
  const sent = (await s.call("GET", "/api/me/sends", undefined, a.token)).body.sent;
  assert.deepEqual(sent.map((x) => x.status).sort(), ["opened", "opened", "started"]);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["from", "id", "incoming", "kind", "ref", "sentOn", "status", "title", "to"]);
});

test("status: a session of a program whose id merely starts the same way does not count as the one sent", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await s.member("Ann Lee"), b = await s.member("Bo Kim");
  const statusOf = async (ref) => (await s.call("GET", "/api/me/sends", undefined, a.token)).body.sent.find((x) => x.ref === ref).status;
  const session = (key) => s.call("POST", "/api/me/workouts", { title: "Session", minutes: 20, exercises: 3, key }, b.token);
  assert.equal((await s.call("POST", "/api/me/sends", { toId: b.client.id, kind: "program", ref: "golf" }, a.token)).status, 201);
  const id = (await s.call("GET", "/api/me/sends", undefined, b.token)).body.inbox.find((x) => x.ref === "golf").id;
  await s.pause(); assert.equal((await s.call("POST", `/api/me/sends/${id}/open`, undefined, b.token)).status, 200);
  // golf-intermediate and golf-advanced are other programs: their sessions say nothing about "golf"
  await s.pause(); await session("prog-golf-intermediate-d0"); await session("prog-golf-advanced-d1");
  assert.equal(await statusOf("golf"), "opened");
  // a session of golf itself does
  await session("prog-golf-d0");
  assert.equal(await statusOf("golf"), "started");
});

test("only someone with an open app account they have signed in to can be listed, sent to or challenged", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await s.member("Ann Lee"), b = await s.member("Bo Kim"), hid = await s.member("Hida Den"), clo = await s.member("Clovis Shutt");
  await s.call("PUT", `/api/admin/clients/${a.client.id}/membership`, { tier: "member", until: "2099-12-31" }, s.admin);
  const workout = (await s.call("POST", "/api/me/custom-workouts", { name: "Circuit", exercises: [{ id: VIDS[0], sets: 2, reps: 8 }] }, a.token)).body.saved;
  await s.call("PUT", "/api/me/leaderboard/visibility", { hidden: true }, hid.token);
  // A member with a chart closes their account: the record stays as "Closed account"
  const area = (await s.call("GET", "/api/site")).body.options.areas[0];
  await s.call("POST", "/api/me/pain", { area, level: 2 }, clo.token);
  assert.equal((await s.call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pass-word-123" }, clo.token)).body.mode, "close");
  // A patient the office added by hand, and one written the way an import writes it: neither has ever signed in
  const office = (await s.call("POST", "/api/admin/clients", { name: "Handel Addison", email: "handel@example.com" }, s.admin)).body.client;
  const at = new Date().toISOString(), list = s.file("clients");
  list.push({ id: "imp000000001", email: "", name: "Imogen Portwood", firstName: "Imogen", lastName: "Portwood", phone: "", passwordHash: null, pwv: 0, plan: { guides: [], exercises: [], notes: "", updatedAt: null }, painLog: [], createdAt: at, lastLoginAt: null, addedBy: "coach@example.com", imported: { source: "simplepractice", at, batch: "b1" } });
  s.put("clients", list);

  // The picker behind Send and Challenges names only the one real member
  assert.deepEqual((await s.call("GET", "/api/me/challenges/members", undefined, a.token)).body.members.map((m) => m.name), ["Bo K."]);
  // Sending or challenging any of the others answers exactly like an id nobody has
  const nobody = { unknown: "nope-nope-nope", hidden: hid.client.id, closed: clo.client.id, office: office.id, imported: "imp000000001", self: a.client.id };
  for (const [what, toId] of Object.entries(nobody)) {
    const r = await s.call("POST", "/api/me/sends", { toId, kind: "video", ref: VIDS[0] }, a.token);
    assert.equal(r.status, 404, `send to ${what}`); assert.deepEqual(r.body, { error: "That member isn't available." }, `send to ${what}`);
    const c = await s.call("POST", "/api/me/challenges", { workoutId: workout.id, toId }, a.token);
    assert.equal(c.status, 404, `challenge ${what}`); assert.deepEqual(c.body, { error: "That member isn't available for challenges." }, `challenge ${what}`);
  }
  assert.ok(!fs.existsSync(path.join(s.dataDir, "sends.json")), "nothing was left waiting for a first sign-in");
  assert.equal((await s.call("POST", "/api/me/sends", { toId: b.client.id, kind: "video", ref: VIDS[0] }, a.token)).status, 201);
  assert.equal((await s.call("POST", "/api/me/challenges", { workoutId: workout.id, toId: b.client.id }, a.token)).status, 201);

  // A field sent as an object or a list is refused (400), not "Something went wrong" (500)
  const odd = { toString: 1 };
  for (const body of [{ kind: odd, ref: VIDS[1], toId: b.client.id }, { kind: "video", ref: odd, toId: b.client.id }, { kind: "video", ref: VIDS[1], toId: odd }, { kind: ["video"], ref: [VIDS[1]], toId: [b.client.id] }])
    assert.equal((await s.call("POST", "/api/me/sends", body, a.token)).status, 400, JSON.stringify(Object.keys(body).filter((k) => typeof body[k] === "object")));
  for (const body of [{ workoutId: odd, toId: b.client.id }, { workoutId: workout.id, toId: odd }])
    assert.equal((await s.call("POST", "/api/me/challenges", body, a.token)).status, 400);
  for (const ex of [{ id: odd, sets: 2, reps: 8 }, { id: VIDS[0], sets: odd, reps: 8 }, { id: VIDS[0], sets: 2, reps: odd }, { id: VIDS[0], sets: 2, reps: 8, repsBySet: [odd, 8] }])
    assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: "X", exercises: [ex] }, a.token)).status, 400);
  assert.equal((await s.call("POST", "/api/me/custom-workouts", { name: odd, exercises: [{ id: VIDS[0], sets: 2, reps: 8 }] }, a.token)).status, 400);
  assert.equal((await s.call("PUT", `/api/me/custom-workouts/${workout.id}`, { name: odd, exercises: [{ id: VIDS[0], sets: 2, reps: 8 }] }, a.token)).status, 400);
  // A missing recipient still answers as it did
  assert.equal((await s.call("POST", "/api/me/sends", { kind: "video", ref: VIDS[1] }, a.token)).status, 404);
});

test("when an account goes away, what it sent and was sent goes with it; the trash and a closed account only hide it", async (t) => {
  const s = await start(); t.after(s.close);
  const a = await s.member("Ann Lee");
  let k = 0;
  const beat = (m) => s.call("POST", "/api/me/presence", { seconds: 60, view: "home", platform: "web", device: { app: false, os: "mac", browser: "safari", media: true } }, m.token);
  // Each new member and Ann send each other a video, and the member opens the app once
  const pair = async (name) => { const m = await s.member(name); assert.equal((await s.call("POST", "/api/me/sends", { toId: m.client.id, kind: "video", ref: VIDS[k++] }, a.token)).status, 201); assert.equal((await s.call("POST", "/api/me/sends", { toId: a.client.id, kind: "video", ref: VIDS[k++] }, m.token)).status, 201); await beat(m); return m; };
  const lists = async () => { const r = (await s.call("GET", "/api/me/sends", undefined, a.token)).body; return { inbox: r.inbox.map((x) => x.from).sort(), sent: r.sent.map((x) => x.to).sort() }; };
  const rows = (m) => s.file("sends").filter((x) => x.fromId === m.client.id || x.toId === m.client.id).length;
  const minutes = (m) => !!s.file("presence")[m.client.id];
  const devices = async () => Object.keys((await s.call("GET", "/api/admin/telehealth/devices", undefined, s.admin)).body);

  // Erased: a member with no chart deletes their account
  const era = await pair("Era Sable");
  const eraRow = (await s.call("GET", "/api/me/sends", undefined, a.token)).body.inbox[0].id;
  assert.equal((await s.call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pass-word-123" }, era.token)).body.mode, "erase");
  assert.deepEqual(await lists(), { inbox: [], sent: [] }, "their short name is in nobody's lists");
  assert.equal((await s.call("POST", `/api/me/sends/${eraRow}/open`, undefined, a.token)).status, 404);
  assert.equal((await s.call("DELETE", `/api/me/sends/${eraRow}`, undefined, a.token)).status, 404);
  assert.ok(!(await devices()).includes(era.client.id), "and staff are not shown a device for them");
  const bo = await pair("Bo Kim");   // the next write to each store
  assert.equal(rows(era), 0, "their rows are gone from the sends store");
  assert.ok(!minutes(era) && minutes(bo), "and their time in the app from the presence store");
  for (const f of fs.readdirSync(s.dataDir).filter((x) => x.endsWith(".json") && !/^(audit|activity)/.test(x))) assert.ok(!fs.readFileSync(path.join(s.dataDir, f), "utf8").includes(era.client.id), `${f} still holds the erased id`);

  // In the 30-day trash: hidden, but kept, so a Restore brings it all back
  assert.equal((await s.call("DELETE", `/api/admin/clients/${bo.client.id}`, undefined, s.admin)).status, 200);
  assert.deepEqual(await lists(), { inbox: [], sent: [] });
  const cy = await pair("Cy Diaz");   // writes to both stores while Bo is in the trash
  assert.equal(rows(bo), 2); assert.ok(minutes(bo));
  assert.equal((await s.call("POST", `/api/admin/clients/${bo.client.id}/restore`, undefined, s.admin)).status, 200);
  assert.deepEqual(await lists(), { inbox: ["Bo K.", "Cy D."], sent: ["Bo K.", "Cy D."] });

  // The trash empties itself after 30 days: with no chart, that is an erase
  await s.call("DELETE", `/api/admin/clients/${bo.client.id}`, undefined, s.admin);
  const trash = s.file("clients-trash"); trash.find((e) => e.id === bo.client.id).trashedAt = new Date(Date.now() - 31 * 864e5).toISOString(); s.put("clients-trash", trash);
  await s.call("GET", "/api/admin/clients/trash/list", undefined, s.admin);
  const dee = await pair("Dee Elm");
  assert.equal(rows(bo), 0); assert.ok(!minutes(bo));

  // Closed: a member with a chart closes their account. The record is kept, so the rows are too, but nobody sees them
  const area = (await s.call("GET", "/api/site")).body.options.areas[0];
  await s.call("POST", "/api/me/pain", { area, level: 3 }, cy.token);
  assert.equal((await s.call("POST", "/api/me/account/deletion", { confirm: "DELETE", password: "pass-word-123" }, cy.token)).body.mode, "close");
  await beat(dee);
  assert.deepEqual(await lists(), { inbox: ["Dee E."], sent: ["Dee E."] });
  assert.equal(rows(cy), 2); assert.equal(rows(dee), 2);
  assert.deepEqual((await devices()).sort(), [cy.client.id, dee.client.id].sort(), "only ids that still have a record");
});
