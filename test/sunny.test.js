// Sunny (MD Fit Intelligence): suggestions from the practice's own catalog kept on the member's Home, tokens instead of
// answers, full access (membership, active treatment plan, in-clinic patient), the Expert Advice tier and who may
// message Dr. Jared. A stand-in plays the model. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const content = require("../lib/content");
const EX = require("../lib/exercises.json").exercises;

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function model(reply) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push(JSON.parse(b)); const r = reply(seen.length, seen[seen.length - 1]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: r.content } }], ...(r.usage === null ? {} : { usage: r.usage || { prompt_tokens: 2400, completion_tokens: 150, total_tokens: 2550 } }) }));
  }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

// Three programs: free, members, and 1-on-1 (premium)
const PROGRAMS = [
  { id: "knee-free", title: "Knee Mobility Basics", category: "Mobility", level: "beginner", access: "free", weeks: 2, days: [] },
  { id: "knee-rehab", title: "Knee Rehab Protocol", category: "Rehabilitation", level: "beginner", access: "member", weeks: 6, days: [] },
  { id: "elite-plan", title: "Elite Performance", category: "Performance", level: "advanced", access: "premium", weeks: 8, days: [] }
];

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-sunny-"));
  fs.writeFileSync(path.join(dataDir, "content.json"), JSON.stringify({ contentVersion: 5, programs: PROGRAMS, knownDefaults: content.defaultContent().programs.map((p) => p.id) }));
  const clock = { now: new Date("2026-11-12T15:00:00Z") };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date(clock.now), calWatchMs: 0, siteUrl: "https://site.example.com", ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let b = null; try { b = await res.json(); } catch {} return { status: res.status, body: b }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name + ".json"), "utf8"));
  const writeJson = (name, data) => fs.writeFileSync(path.join(dataDir, name + ".json"), JSON.stringify(data));
  const editClient = (id, fn) => { const list = readJson("clients"); fn(list.find((c) => c.id === id)); writeJson("clients", list); };
  const everything = () => { const out = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } }; walk(dataDir); return out.join("\n"); };
  return { app, call, adminToken, signup, readJson, writeJson, editClient, everything, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const KV = EX.filter((v) => v.region === "Knees" || v.region === "Legs").slice(0, 10), V = KV.map((v) => v.id); // videos sent for a knee question
const reply = (o) => ({ content: "<reasoning>pick from the catalog</reasoning>" + JSON.stringify({ say: "Sorry your knee is bothering you. Here's where to start.", places: ["pain", "book"], area: "knee", programs: [], guides: [], videos: [], tip: "", ...o }) });

test("Sunny: suggestions come from the catalog, are kept on Home newest first without repeats, capped, and can be dismissed; locked shows what needs a membership", async (t) => {
  const TIP = "In general, a light snack with some carbs an hour before a run helps most people feel energetic.";
  const answers = [
    reply({ programs: ["knee-rehab", "knee-free", "made-up", "elite-plan"], videos: [V[0], V[1], "nope"], tip: TIP }),
    reply({ programs: ["knee-free"], videos: [V[1], V[2], V[3], V[4]], tip: TIP }),
    reply({ videos: [V[5], V[6], V[7], V[8], V[9]], tip: "Sleep is when most recovery happens." }),
    reply({ tip: "Drink water through the day." }), reply({ tip: "A short walk after meals helps." })
  ];
  const m = await model((n) => answers[Math.min(n, answers.length) - 1]); t.after(m.close);
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "openai.gpt-oss-120b-1:0" } }); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free"), ask = (text, tok = fay.token) => s.call("POST", "/api/me/guide/ask", { text }, tok);
  await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);

  const MARK = "ZZTYPEDMARK";
  const r = (await ask(`${MARK} my knee hurts when I squat`)).body;
  assert.equal(r.ok, true);
  // only real ids, at most three programs and four videos; the members-only and 1-on-1 programs are locked for a free account
  assert.deepEqual(r.suggested, { programs: [{ id: "knee-rehab", title: "Knee Rehab Protocol", locked: true }, { id: "knee-free", title: "Knee Mobility Basics", locked: false }, { id: "elite-plan", title: "Elite Performance", locked: true }],
    videos: [{ id: V[0], name: KV[0].name }, { id: V[1], name: KV[1].name }], guides: [], tip: TIP });
  assert.equal(r.tokens, 2550); assert.equal(r.used, 2550, "the tokens the service counted");
  // the model was told who it is and what it may suggest
  const sys = m.seen[0].messages[0].content;
  assert.match(sys, /^Reasoning: low\nYou are Sunny, MD Fit Intelligence/); assert.match(sys, /knee-rehab: Knee Rehab Protocol \[Rehabilitation, beginner\]/);
  assert.match(sys, /elite-plan: Elite Performance/, "every program, so a locked one can be suggested as a teaser");
  assert.ok(sys.includes(`${V[0]}: ${KV[0].name}`)); assert.match(sys, /never diagnose/); assert.match(sys, /Never invent sets, reps/);

  // kept on the member's record and in their account, newest first
  let me = (await s.call("GET", "/api/me", undefined, fay.token)).body.client;
  assert.deepEqual(me.suggested.programs.map((x) => x.id), ["knee-rehab", "knee-free", "elite-plan"]);
  assert.deepEqual(me.suggested.videos.map((x) => x.id), [V[0], V[1]]);
  assert.deepEqual(me.suggested.tips.map((x) => x.text), [TIP]);
  await ask("more for my knee");
  me = (await s.call("GET", "/api/me", undefined, fay.token)).body.client;
  assert.deepEqual(me.suggested.programs.map((x) => x.id), ["knee-free", "knee-rehab", "elite-plan"], "a repeat moves to the front, not in twice");
  assert.deepEqual(me.suggested.videos.map((x) => x.id), [V[1], V[2], V[3], V[4], V[0]]);
  assert.equal(me.suggested.tips.length, 1, "the same tip is not kept twice");
  await ask("what else for my knee"); await ask("water? my knee"); await ask("walks for my knee?");
  me = (await s.call("GET", "/api/me", undefined, fay.token)).body.client;
  assert.equal(me.suggested.videos.length, 8, "eight videos at most"); assert.equal(me.suggested.videos[0].id, V[5]);
  assert.deepEqual(me.suggested.tips.map((x) => x.text), ["A short walk after meals helps.", "Drink water through the day.", "Sleep is when most recovery happens."], "three tips at most");

  // what was typed never reaches the disk; a tip is encrypted in the file
  const all = s.everything();
  assert.ok(all.includes("knee-rehab"), "the ids are readable here, so the searches below mean something");
  assert.equal(all.includes(MARK), false, "nothing typed"); assert.equal(all.includes("Drink water through the day"), false, "the tip text is encrypted");
  assert.equal(all.includes("Sorry your knee is bothering you"), false, "nor what Sunny said");

  // dismiss one; unknown ones and other kinds are not found
  const tipId = me.suggested.tips[1].id;
  let d = await s.call("DELETE", `/api/me/suggested/tips/${tipId}`, undefined, fay.token);
  assert.equal(d.status, 200); assert.deepEqual(d.body.suggested.tips.map((x) => x.text), ["A short walk after meals helps.", "Sleep is when most recovery happens."]);
  d = await s.call("DELETE", "/api/me/suggested/programs/knee-free", undefined, fay.token);
  assert.deepEqual(d.body.suggested.programs.map((x) => x.id), ["knee-rehab", "elite-plan"]);
  assert.equal((await s.call("DELETE", "/api/me/suggested/programs/knee-free", undefined, fay.token)).status, 404);
  assert.equal((await s.call("DELETE", "/api/me/suggested/lectures/x", undefined, fay.token)).status, 404);
  const gus = await s.signup("Gus Guest");
  assert.equal((await s.call("DELETE", "/api/me/suggested/programs/knee-rehab", undefined, gus.token)).status, 404, "someone else's is not found");
  assert.deepEqual((await s.call("GET", "/api/me", undefined, gus.token)).body.client.suggested, { programs: [], videos: [], guides: [], tips: [] });
  assert.equal((await s.call("DELETE", "/api/me/suggested/programs/knee-rehab")).status, 401);

  // a member: nothing below their tier is locked; a 1-on-1 program still is
  await s.call("PUT", `/api/admin/clients/${gus.client.id}/membership`, { tier: "member" }, A);
  answers.push(reply({ programs: ["knee-rehab", "elite-plan"] }));
  const g = (await ask("knee", gus.token)).body;
  assert.equal(g.left, null);
  assert.deepEqual(g.suggested.programs, [{ id: "knee-rehab", title: "Knee Rehab Protocol", locked: false }, { id: "elite-plan", title: "Elite Performance", locked: true }]);

  // an emergency is never sent and suggests nothing
  const before = m.seen.length;
  assert.deepEqual((await ask("I have chest pain and can't breathe")).body, { ok: true, urgent: true });
  assert.equal(m.seen.length, before);
});

test("Sunny: an AI answer counts at least 300 tokens; full access is unlimited: membership, an active treatment plan, or the in-clinic toggle, and switching back brings the limit back", async (t) => {
  const m = await model(() => ({ ...reply({}), usage: { total_tokens: 40 } })); t.after(m.close);
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "small-one" } }); t.after(s.close);
  const A = await s.adminToken(), fay = await s.signup("Fay Free"), pat = await s.signup("Pat Plan"), ida = await s.signup("Ida Inpatient");
  await s.call("PUT", "/api/admin/guide/settings", { ai: true, freeTokensPerDay: 1000 }, A);
  const ask = (tok) => s.call("POST", "/api/me/guide/ask", { text: "my knee hurts" }, tok);
  const r = (await ask(fay.token)).body;
  assert.equal(r.tokens, 300, "a tiny count is raised to the minimum"); assert.equal(r.used, 300); assert.equal(r.left, 700);

  // an active treatment plan (protocol paid monthly)
  s.editClient(pat.client.id, (c) => { c.protocols = [{ id: "p1", status: "active" }]; });
  for (let i = 0; i < 5; i++) assert.equal((await ask(pat.token)).body.left, null);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, pat.token)).body.plan, "member");
  s.editClient(pat.client.id, (c) => { c.protocols = [{ id: "p1", status: "paid" }]; });
  assert.equal((await s.call("GET", "/api/me/guide", undefined, pat.token)).body.plan, "free", "a finished plan is not full access");
  assert.equal((await ask(pat.token)).body.limited, true);

  // the in-clinic toggle in the workspace
  const type = (tp) => s.call("PUT", `/api/admin/clients/${ida.client.id}/type`, { type: tp }, A);
  assert.equal((await type("inpatient")).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await ask(ida.token)).body.left, null);
  assert.equal((await s.call("GET", "/api/me/content", undefined, ida.token)).body.access, "premium", "the whole app, 1-on-1 content included");
  assert.equal((await s.call("GET", "/api/me/messages", undefined, ida.token)).body.canSend, true);
  assert.equal((await s.call("POST", "/api/me/messages", { body: "Quick question about my knee." }, ida.token)).status, 201);
  // and back to outpatient: the limit and the locks return at once
  assert.equal((await type("outpatient")).status, 200);
  assert.equal((await s.call("GET", "/api/me/guide", undefined, ida.token)).body.plan, "free");
  assert.equal((await ask(ida.token)).body.limited, true);
  assert.equal((await s.call("GET", "/api/me/content", undefined, ida.token)).body.access, "free");
});

test("Sunny: the in-clinic toggle unlocks every suggested program, 1-on-1 included", async (t) => {
  const m = await model(() => reply({ programs: ["knee-rehab", "elite-plan", "knee-free"] })); t.after(m.close);
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "small-one" } }); t.after(s.close);
  const A = await s.adminToken(), ida = await s.signup("Ida Inpatient");
  await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);
  const ask = async () => (await s.call("POST", "/api/me/guide/ask", { text: "knee" }, ida.token)).body.suggested.programs.map((p) => p.locked);
  assert.deepEqual(await ask(), [true, true, false]);
  await s.call("PUT", `/api/admin/clients/${ida.client.id}/type`, { type: "inpatient" }, A);
  assert.deepEqual(await ask(), [false, false, false]);
  await s.call("PUT", `/api/admin/clients/${ida.client.id}/type`, { type: "outpatient" }, A);
  assert.deepEqual(await ask(), [true, true, false]);
});

test("tiers: Expert Advice ($50) is offered by default and added to tiers saved before it existed; 1-on-1 tiers include messaging", async (t) => {
  const d = content.defaultContent().tiers;
  assert.deepEqual(d.map((x) => [x.id, x.price, !!x.directMessages]), [["member", 19.95, false], ["accountability", 29.95, false], ["expert", 50, true], ["premium", 200, true], ["premium-plus", 349, true]]);
  assert.ok(d.find((x) => x.id === "member").perks.includes("Unlimited Sunny (MD Fit Intelligence)"));
  assert.ok(d.find((x) => x.id === "expert").perks.includes("Message Dr. Jared directly for expert advice"));
  // saved before Expert Advice existed: added after Accountability; a saved 1-on-1 tier gets messaging
  const old = [{ id: "member", name: "Membership", price: 19.95, meetings: 0, perks: [] }, { id: "accountability", name: "Acc", price: 29.95, meetings: 0, perks: [] }, { id: "vip", name: "VIP", price: 500, meetings: 4, perks: [] }];
  const got = content.tiersOf({ tiers: old });
  assert.deepEqual(got.map((x) => x.id), ["member", "accountability", "expert", "vip"]);
  assert.equal(got.find((x) => x.id === "vip").directMessages, true);
  assert.equal(got.find((x) => x.id === "member").directMessages, undefined);
  // an owner who has saved tiers since keeps their choice: a removed Expert Advice stays removed
  assert.deepEqual(content.tiersOf({ tiers: old.slice(0, 2), knownTiers: ["expert"] }).map((x) => x.id), ["member", "accountability"]);
  assert.equal(content.tiersOf({ tiers: [{ ...old[2], directMessages: false }] }).find((x) => x.id === "vip").directMessages, false, "an explicit no is kept");

  // through the workspace: the switch is saved, and the app sees Expert Advice
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  let tiers = (await s.call("GET", "/api/content")).body.tiers;
  assert.ok(tiers.some((x) => x.id === "expert" && x.directMessages === true));
  const edited = tiers.filter((x) => x.id !== "expert").map((x) => (x.id === "member" ? { ...x, directMessages: true } : x));
  assert.equal((await s.call("PUT", "/api/admin/content", { tiers: edited }, A)).status, 200);
  tiers = (await s.call("GET", "/api/content")).body.tiers;
  assert.equal(tiers.some((x) => x.id === "expert"), false, "removed in the workspace: stays removed");
  assert.equal(tiers.find((x) => x.id === "member").directMessages, true);
});

test("messaging: Expert Advice, 1-on-1 tiers, active plans, clinic patients and replies to Dr. Jared may write; everyone else is offered Expert Advice", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const send = (tok) => s.call("POST", "/api/me/messages", { body: "Is it ok to train today?" }, tok);
  const can = async (tok) => (await s.call("GET", "/api/me/messages", undefined, tok)).body;
  const [fay, mel, exa, pre, pat, cli, asg, bro, old] = await Promise.all(["Fay Free", "Mel Member", "Exa Expert", "Pre Premium", "Pat Plan", "Cli Clinic", "Asg Assigned", "Bro Broadcast", "Old Broadcast"].map((n) => s.signup(n)));

  // a free account and the $19.95 membership: read-only, with the reason
  let v = await can(fay.token);
  assert.equal(v.canSend, false); assert.equal(v.why, "Messaging Dr. Jared directly is part of Expert Advice ($50/mo) and the 1-on-1 tiers.");
  let r = await send(fay.token);
  assert.equal(r.status, 403); assert.deepEqual(r.body, { error: "Messaging Dr. Jared directly is part of Expert Advice ($50/mo) and the 1-on-1 tiers.", upgrade: true });
  await s.call("PUT", `/api/admin/clients/${mel.client.id}/membership`, { tier: "member" }, A);
  assert.equal((await send(mel.token)).status, 403);

  // Expert Advice and the 1-on-1 tiers
  await s.call("PUT", `/api/admin/clients/${exa.client.id}/membership`, { tier: "expert" }, A);
  await s.call("PUT", `/api/admin/clients/${pre.client.id}/membership`, { tier: "premium" }, A);
  assert.equal((await can(exa.token)).canSend, true); assert.equal((await can(exa.token)).why, "");
  assert.equal((await send(exa.token)).status, 201); assert.equal((await send(pre.token)).status, 201);
  // an expired Expert Advice membership: back to read-only
  await s.call("PUT", `/api/admin/clients/${exa.client.id}/membership`, { tier: "expert", until: "2026-11-01" }, A);
  assert.equal((await send(exa.token)).status, 403);

  // an active treatment plan; a clinic patient with a visit on record; a program from Dr. Jared
  s.editClient(pat.client.id, (c) => { c.protocols = [{ id: "p1", status: "active" }]; });
  assert.equal((await send(pat.token)).status, 201);
  s.writeJson("appointments", [{ id: "a1", clientId: cli.client.id, email: "cli.clinic@example.com", status: "completed", date: "2026-10-01", time: "09:00" },
    { id: "a2", clientId: fay.client.id, email: "fay.free@example.com", status: "cancelled", date: "2026-10-02", time: "09:00" }]);
  assert.equal((await send(cli.token)).status, 201);
  assert.equal((await send(fay.token)).status, 403, "a cancelled booking alone is not a clinic patient");
  s.editClient(asg.client.id, (c) => { c.assignedPrograms = [{ id: "knee-rehab", assignedAt: "2026-11-01" }]; });
  assert.equal((await send(asg.token)).status, 201);

  // Dr. Jared wrote (a broadcast): they may reply for two weeks
  assert.equal((await s.call("POST", "/api/admin/messages/broadcast", { to: "selected", clientIds: [bro.client.id, old.client.id], body: "Clinic closed Friday." }, A)).status < 300, true);
  assert.equal((await can(bro.token)).canSend, true); assert.equal((await send(bro.token)).status, 201);
  const list = s.readJson("messages"); for (const x of list) if (x.clientId === old.client.id) x.at = new Date(Date.now() - 20 * 864e5).toISOString();
  s.writeJson("messages", list);
  assert.equal((await send(old.token)).status, 403, "three weeks later the window has closed");
  // still reads the thread
  assert.equal((await can(old.token)).messages.length, 1);
});

test("Sunny personalizes from the member's record with no identity and no notes, grounds pain answers in the clinic's own library, and keeps the prompt small", async (t) => {
  const m = await model((n, body) => {
    const q = body.messages[1].content;
    if (/sleep/.test(q)) return reply({ area: "", places: ["learn"], guides: ["bath-accu-mat", "nope", "diet-health-shots", "fitness-erg"], tip: "Recovery work like an ice bath is covered step by step in Dr. Jared's guide." });
    if (/^hey/i.test(q)) return reply({ say: "Hi, I'm Sunny! What are you working on today?", area: "", places: ["pain", "programs", "workout"], programs: ["knee-rehab"] });
    return reply({ programs: ["knee-rehab"] });
  }); t.after(m.close);
  const s = await start({ scribe: { url: m.url, key: "k_made_up", model: "small-one" } }); t.after(s.close);
  const A = await s.adminToken(), q = await s.signup("Quinn Zebulon");
  await s.call("PUT", "/api/admin/guide/settings", { ai: true }, A);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 6, note: "PAINSECRETNOTE twisted it", date: "2026-11-01" }, q.token)).status, 201);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Knee", level: 3, note: "PAINSECRETNOTE better", date: "2026-11-10" }, q.token)).status, 201);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Lower back", level: 2, date: "2026-11-11" }, q.token)).status, 201);
  assert.equal((await s.call("POST", "/api/me/pain", { area: "Neck", level: 8, date: "2026-09-01" }, q.token)).status, 201, "older than 30 days: left out");
  s.editClient(q.client.id, (c) => {
    c.phone = "941-555-0199"; c.birthday = "1980-04-05"; c.address = "12 Palm Way";
    c.assignedPrograms = [{ id: "knee-rehab", assignedAt: "2026-11-01", note: "PROGSECRETNOTE go easy" }]; c.pinnedPrograms = ["knee-free"];
    c.plan = { guides: [], exercises: [], notes: "PLANSECRETNOTE", updatedAt: null };
    c.workouts = [{ date: "2026-11-10", title: "Knee day", minutes: 20 }, { date: "2026-11-11", title: "Walk", minutes: 30 }, { date: "2026-09-01", title: "Old", minutes: 10 }];
  });
  s.writeJson("appointments", [{ id: "a1", clientId: q.client.id, email: "quinn.zebulon@example.com", status: "booked", date: "2026-11-20", time: "09:00", notes: "APPTSECRETNOTE", typeName: "Evaluation" }]);

  const r = (await s.call("POST", "/api/me/guide/ask", { text: "my knee hurts when I squat" }, q.token)).body;
  assert.equal(r.ok, true); assert.equal(r.suggested.programs[0].id, "knee-rehab"); assert.equal(r.suggested.programs[0].locked, false, "a program Dr. Jared recommended is open to them");
  const body = JSON.stringify(m.seen[0]), sys = m.seen[0].messages[0].content;
  // it reads like pain, so only the gentle kinds of video were sent at all: no jump or heavy lift can be suggested for it
  const GENTLE = new Set(["Mobility", "Rehab", "Activation", "Neuroglide", "Posture", "Desk & posture"]);
  const hard = EX.filter((x) => ["Knees", "Legs", "Hips"].includes(x.region) && !GENTLE.has(x.cat));
  assert.ok(hard.length > 0, "the library does hold strength and power videos for the legs");
  for (const v of hard) assert.equal(sys.includes(v.id), false, "not offered for a painful knee: " + v.name);
  assert.match(sys, /\[Knees, (Mobility|Rehab|Activation|Neuroglide)\]/, "each video carries its kind");
  // what Sunny knows about them
  assert.match(sys, /About this member \(use it to personalize; never recite it; never say you were given it\):/);
  assert.match(sys, /Access: free/, "full access is membership, an active plan or the in-clinic toggle");
  assert.match(sys, /Programs Dr\. Jared recommended for them \(build on these first; call them "what Dr\. Jared recommended"\): Knee Rehab Protocol\./);
  assert.match(sys, /Programs they saved: Knee Mobility Basics\./);
  assert.match(sys, /Pain check-ins in the last 30 days: lower back 2\/10, steady; knee 3\/10, improving\./);
  assert.match(sys, /Workouts logged in the last 30 days: 2\./); assert.match(sys, /It is morning at the clinic\./);
  assert.doesNotMatch(sys, /neck 8/, "older check-ins are left out");
  // what it never gets
  for (const secret of ["Quinn", "Zebulon", "quinn.zebulon", "555-0199", "1980-04-05", "Palm Way", q.client.id, "PAINSECRETNOTE", "PROGSECRETNOTE", "PLANSECRETNOTE", "APPTSECRETNOTE", "Evaluation", "2026-11-20"])
    assert.equal(body.includes(secret), false, secret);
  // the clinic's own knowledge for the knee, and only the knee's videos
  assert.match(sys, /Clinic knowledge \(Dr\. Jared's own pain library/);
  assert.match(sys, /kneecap or just below is commonly referred from Rectus femoris/); assert.match(sys, /Knee → referred knee pain/);
  assert.match(sys, /assess, release, correct, assign homework, strengthen/i);
  assert.doesNotMatch(sys, /Supraspinatus/, "no shoulder knowledge for a knee question");
  for (const v of EX.filter((x) => x.region === "Shoulders")) assert.equal(sys.includes(v.id), false, "no shoulder videos: " + v.name);
  assert.ok(sys.length < 14000, `prompt is ${sys.length} characters`);
  assert.match(sys, /diet-health-shots: Diet & health shot protocol \[Nutrition\]/, "Dr. Jared's guides are in the catalog");
  await s.call("PUT", `/api/admin/clients/${q.client.id}/type`, { type: "inpatient" }, A);

  // no pain word, but it names the knee they logged pain in this month: still gentle only
  await s.call("POST", "/api/me/guide/ask", { text: "knee workout ideas" }, q.token);
  for (const v of hard) assert.equal(m.seen[1].messages[0].content.includes(v.id), false, "still not offered: " + v.name);
  m.seen.splice(1, 1);
  // a general question: the approach line only, a general slice of videos; guides come back and are kept
  const g = (await s.call("POST", "/api/me/guide/ask", { text: "how do I sleep better after training" }, q.token)).body;
  const sys2 = m.seen[1].messages[0].content;
  assert.doesNotMatch(sys2, /Clinic knowledge/); assert.match(sys2, /The source of pain is often not where it hurts/);
  assert.ok(m.seen[1].messages[0].content.split("Exercise videos")[1].split(";").length <= 41, "forty videos at most");
  assert.deepEqual(g.suggested.guides, [{ id: "bath-accu-mat", title: "Ice bath, acupressure mat & progress photo protocol" }, { id: "diet-health-shots", title: "Diet & health shot protocol" }], "two at most, real ones only");
  let me = (await s.call("GET", "/api/me", undefined, q.token)).body.client;
  assert.deepEqual(me.suggested.guides.map((x) => x.id), ["bath-accu-mat", "diet-health-shots"]);
  assert.equal((await s.call("DELETE", "/api/me/suggested/guides/bath-accu-mat", undefined, q.token)).body.suggested.guides.length, 1);
  assert.match(sys2, /Already suggested to them before \(prefer something new\): knee-rehab/);

  // a greeting
  const h = (await s.call("POST", "/api/me/guide/ask", { text: "hey" }, q.token)).body;
  assert.match(m.seen[2].messages[0].content, /This message is a greeting\./); assert.match(m.seen[2].messages[0].content, /introduce yourself as Sunny/);
  assert.equal(h.say, "Hi, I'm Sunny! What are you working on today?"); assert.deepEqual(h.places, ["pain", "programs", "workout"]);
});
