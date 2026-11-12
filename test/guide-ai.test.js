// The guide's language-model understanding (lib/guide-ai.js): off unless a service that signs a business associate
// agreement is connected; the member's name, email and phone never leave; the reply is read strictly; emergencies and
// failures never reach or depend on the model. A stand-in plays the model. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createGuideAI, hostAllowed, read } = require("../lib/guide-ai");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
const PLACES = [{ id: "pain", label: "Pain tool" }, { id: "book", label: "Schedule an appointment" }, { id: "programs", label: "Programs" }, { id: "premium", label: "Membership" }];

async function model(reply) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); const r = reply(seen.length); if (r.wait) return; res.writeHead(r.status || 200, { "content-type": "application/json" }); res.end(JSON.stringify(r.status && r.status !== 200 ? { error: { message: "no" } } : { choices: [{ message: { content: r.content } }] })); }); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const quiet = { warn() {} };

test("guide AI: only a service that signs a business associate agreement is ever used", () => {
  assert.equal(hostAllowed("api.openai.com"), true);
  assert.equal(hostAllowed("localhost:11434"), true);
  for (const h of ["openrouter.ai", "api.moonshot.ai", "api.openai.com.evil.example", "evil-api.openai.com", ""]) assert.equal(hostAllowed(h), false, h);
  const off = createGuideAI({ cfg: {}, logger: quiet });
  assert.deepEqual(off.status(), { ready: false, host: "", model: "", why: "No AI service is connected on the server yet." });
  const router = createGuideAI({ cfg: { scribe: { url: "https://openrouter.ai/api/v1", key: "k_made_up", model: "any" } }, logger: quiet });
  assert.equal(router.status().ready, false); assert.match(router.status().why, /does not sign a business associate agreement/);
});

test("guide AI: a refused service is not called at all", async () => {
  let called = 0;
  const ai = createGuideAI({ cfg: { scribe: { url: "https://openrouter.ai/api/v1", key: "k_made_up", model: "any" } }, logger: quiet, fetchImpl: async () => { called++; throw new Error("should not be called"); } });
  assert.deepEqual(await ai.understand({ text: "my knee hurts", places: PLACES }), { error: "off" });
  assert.equal(called, 0);
});

test("guide AI: the sentence goes without the member's name, email or phone, and nothing about them is added", async (t) => {
  const m = await model(() => ({ content: '{"say":"I understand, that can be frustrating. Here is where I can take you.","places":["pain","book","nowhere"],"area":"Knee"}' })); t.after(m.close);
  const ai = createGuideAI({ cfg: { scribe: { url: m.url, key: "k_made_up", model: "small-one" } }, logger: quiet });
  assert.equal(ai.status().ready, true);
  const out = await ai.understand({ text: "Hi I'm Cal Client, cal@example.com, 941-555-0100. Cal's knee hurts since 11/03/2026", names: ["Cal Client"], places: PLACES });
  assert.deepEqual(out, { say: "I understand, that can be frustrating. Here is where I can take you.", places: ["pain", "book"], area: "knee", model: "small-one" });
  const sent = m.seen[0]; assert.equal(sent.url, "/v1/chat/completions"); assert.equal(sent.auth, "Bearer k_made_up");
  const said = JSON.stringify(sent.body);
  assert.equal(/Cal|Client|cal@example|555-0100|11\/03\/2026/.test(said), false, "identity removed");
  assert.match(sent.body.messages[1].content, /my knee hurts/);
  assert.equal(sent.body.messages.length, 2); assert.equal(sent.body.max_tokens, 300);
  assert.match(sent.body.messages[0].content, /never diagnose/); assert.match(sent.body.messages[0].content, /pain \(Pain tool\)/);
  assert.deepEqual(Object.keys(sent.body).sort(), ["max_tokens", "messages", "model"]);
});

test("guide AI: an emergency is never sent; a refusal, nonsense or silence each come back as an error, not a made-up answer", async (t) => {
  const m = await model((n) => (n === 1 ? { status: 429 } : n === 2 ? { content: "Sure! Here you go." } : n === 3 ? { content: '{"say":"","places":["pain"]}' } : { content: 'Here: {"say":"**Programs** are here.","places":["programs"],"area":"spleen"} hope that helps' })); t.after(m.close);
  const ai = createGuideAI({ cfg: { scribe: { url: m.url, key: "k_made_up", model: "small-one" } }, logger: quiet });
  assert.deepEqual(await ai.understand({ text: "I have chest pain and can't breathe", places: PLACES }), { error: "urgent" });
  assert.equal(m.seen.length, 0, "not sent");
  assert.equal(ai.urgent("call 911"), true); assert.equal(ai.urgent("my knee hurts"), false);
  assert.deepEqual(await ai.understand({ text: "where are programs", places: PLACES }), { error: "refused" });
  assert.deepEqual(await ai.understand({ text: "where are programs", places: PLACES }), { error: "unreadable" });
  assert.deepEqual(await ai.understand({ text: "where are programs", places: PLACES }), { error: "unreadable" });
  assert.deepEqual(await ai.understand({ text: "where are programs", places: PLACES }), { say: "Programs are here.", places: ["programs"], area: "", model: "small-one" });
  assert.deepEqual(await ai.understand({ text: "   ", places: PLACES }), { error: "empty" });
  const long = "x".repeat(900); await ai.understand({ text: long, places: PLACES });
  assert.equal(m.seen[m.seen.length - 1].body.messages[1].content.length, 300, "capped");
});

test("guide AI: the reply is read strictly", () => {
  assert.equal(read("[1,2]", ["a"]), null); assert.equal(read("", ["a"]), null); assert.equal(read('{"places":["a"]}', ["a"]), null);
  assert.deepEqual(read('{"say":" Hi  there ","places":["a","a","b","c","d","e","zz"],"area":"BACK"}', ["a", "b", "c", "d", "e"]), { say: "Hi there", places: ["a", "b", "c", "d"], area: "back" });
});
