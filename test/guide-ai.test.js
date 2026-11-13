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
// The parts of an answer most tests look at (suggestions and tokens have their own tests below)
const core = (o) => (o && o.say ? { say: o.say, places: o.places, area: o.area, model: o.model } : o);
const NONE = { programs: [], videos: [], tip: "" };

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
  assert.deepEqual(core(out), { say: "I understand, that can be frustrating. Here is where I can take you.", places: ["pain", "book"], area: "knee", model: "small-one" });
  const sent = m.seen[0]; assert.equal(sent.url, "/v1/chat/completions"); assert.equal(sent.auth, "Bearer k_made_up");
  const said = JSON.stringify(sent.body);
  assert.equal(/Cal|Client|cal@example|555-0100|11\/03\/2026/.test(said), false, "identity removed");
  assert.match(sent.body.messages[1].content, /my knee hurts/);
  assert.equal(sent.body.messages.length, 2); assert.equal(sent.body.max_tokens, 1200);
  assert.match(sent.body.messages[0].content, /never diagnose/); assert.doesNotMatch(sent.body.messages[0].content, /^Reasoning:/); assert.match(sent.body.messages[0].content, /pain \(Pain tool\)/);
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
  assert.deepEqual(core(await ai.understand({ text: "where are programs", places: PLACES })), { say: "Programs are here.", places: ["programs"], area: "", model: "small-one" });
  assert.deepEqual(await ai.understand({ text: "   ", places: PLACES }), { error: "empty" });
  const long = "x".repeat(900); await ai.understand({ text: long, places: PLACES });
  assert.equal(m.seen[m.seen.length - 1].body.messages[1].content.length, 300, "capped");
});

test("guide AI: the reply is read strictly", () => {
  assert.equal(read("[1,2]", ["a"]), null); assert.equal(read("", ["a"]), null); assert.equal(read('{"places":["a"]}', ["a"]), null);
  assert.deepEqual(read('{"say":" Hi  there ","places":["a","a","b","c","d","e","zz"],"area":"BACK"}', ["a", "b", "c", "d", "e"]), { say: "Hi there", places: ["a", "b", "c", "d"], area: "back", ...NONE });
});

test("guide AI: Amazon Bedrock's OpenAI-compatible endpoint is accepted in every region, and look-alikes are not", () => {
  for (const h of ["bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.us-east-2.amazonaws.com", "bedrock-runtime.us-west-2.amazonaws.com", "bedrock-runtime.eu-central-1.amazonaws.com"]) assert.equal(hostAllowed(h), true, h);
  for (const h of ["bedrock-runtime.us-east-1.amazonaws.com.evil.example", "evil-bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.amazonaws.com", "bedrock.us-east-1.amazonaws.com", "bedrock-runtime.us-east-1.amazonaws.co"]) assert.equal(hostAllowed(h), false, h);
});

test("config: AI_PROVIDER=bedrock points at the region's OpenAI-compatible endpoint with the Bedrock key and model", () => {
  const { loadConfig } = require("../server");
  const keep = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(AI_|SCRIBE_|BEDROCK_|OPENAI_|OPENROUTER_|MOONSHOT_)/.test(k)) delete process.env[k];
    Object.assign(process.env, { AI_PROVIDER: "bedrock", BEDROCK_API_KEY: "bedrock-key-not-real", BEDROCK_MODEL: "made-up.model-v1" });
    let s = loadConfig().scribe;
    assert.equal(s.url, "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
    assert.equal(s.key, "bedrock-key-not-real"); assert.equal(s.model, "made-up.model-v1");
    process.env.BEDROCK_REGION = "us-east-2";
    s = loadConfig().scribe;
    assert.equal(s.url, "https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1");
    const ai = createGuideAI({ cfg: { scribe: s }, logger: { warn() {} } });
    assert.equal(ai.status().ready, true, "a Bedrock connection may carry members' messages once AI answers are switched on");
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

test("guide AI: a model's written-out thinking is dropped and only the answer is read; gpt-oss is asked to think briefly", async (t) => {
  const { stripThinking } = require("../lib/scribe");
  assert.equal(stripThinking('<reasoning>They mention {knee}. Pick pain.</reasoning>{"say":"Ok."}'), '{"say":"Ok."}');
  assert.equal(stripThinking("<think>hmm {x}</think>\nAnswer"), "Answer");
  assert.equal(stripThinking("<reasoning>cut off mid {thought"), "", "no answer, nothing to read");
  assert.equal(stripThinking("Plain answer"), "Plain answer"); assert.equal(stripThinking(null), "");
  assert.deepEqual(read('<reasoning>Use {"say":"wrong"} maybe</reasoning>{"say":"Here is the pain tool.","places":["pain"],"area":"knee"}', ["pain"]), { say: "Here is the pain tool.", places: ["pain"], area: "knee", ...NONE });
  const m = await model(() => ({ content: '<reasoning>knee pain: pain + book</reasoning>{"say":"Sorry your knee hurts. Start here.","places":["pain","book"],"area":"knee"}' })); t.after(m.close);
  const ai = createGuideAI({ cfg: { scribe: { url: m.url, key: "k_made_up", model: "openai.gpt-oss-120b-1:0" } }, logger: quiet });
  assert.deepEqual(core(await ai.understand({ text: "my knee hurts", places: PLACES })), { say: "Sorry your knee hurts. Start here.", places: ["pain", "book"], area: "knee", model: "openai.gpt-oss-120b-1:0" });
  assert.match(m.seen[0].body.messages[0].content, /^Reasoning: low\n/);
});

test("guide AI: suggestions are read strictly too: catalog ids only, three programs, four videos, a short plain tip", () => {
  const cat = { programs: ["p1", "p2", "p3", "p4"].map((id) => ({ id, title: id })), videos: ["v1", "v2", "v3", "v4", "v5"].map((id) => ({ id, name: id })) };
  const got = read(JSON.stringify({ say: "Ok.", places: ["pain"], area: "", programs: ["p1", "x", "p1", "p2", "p3", "p4"], videos: ["v5", "v1", "zz", "v2", "v3", "v4"], tip: "**Drink** water  through the day." + " more".repeat(100) }), ["pain"], cat);
  assert.deepEqual(got.programs, ["p1", "p2", "p3"]); assert.deepEqual(got.videos, ["v5", "v1", "v2", "v3"]);
  assert.match(got.tip, /^Drink water through the day\. more/); assert.ok(got.tip.length <= 300);
  assert.deepEqual(read('{"say":"Ok.","programs":"p1","videos":null,"tip":7}', [], cat), { say: "Ok.", places: [], area: "", programs: [], videos: [], tip: "" });
});
