// The guide's language-model understanding (lib/guide-ai.js): off unless a service that signs a business associate
// agreement is connected; the member's name, email and phone never leave; the reply is read strictly; emergencies and
// failures never reach or depend on the model. A stand-in plays the model. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createGuideAI, hostAllowed, read, system } = require("../lib/guide-ai");

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
const NONE = { programs: [], guides: [], videos: [], tip: "", mood: "", verse: false, outside: false, urgent: false };

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
  assert.equal(/\bCal\b|Client|cal@example|555-0100|11\/03\/2026/.test(said), false, "identity removed"); // (the clinic knowledge for the knee names the calf)
  assert.match(sent.body.messages[1].content, /my knee hurts/);
  assert.equal(sent.body.messages.length, 2); assert.equal(sent.body.max_tokens, 1200);
  assert.match(sent.body.messages[0].content, /never diagnose/); assert.doesNotMatch(sent.body.messages[0].content, /^Reasoning:/); assert.match(sent.body.messages[0].content, /pain \(Pain tool\)/);
  assert.deepEqual(Object.keys(sent.body).sort(), ["max_tokens", "messages", "model"]);
});

test("guide AI: the last lines of this chat go with the question, through the same identity pass, so 'yes' and 'another one' are understood", async (t) => {
  const m = await model(() => ({ content: '{"say":"Why did the dumbbell go to therapy? Too much weight on its shoulders.","places":[],"mood":"cheer"}' })); t.after(m.close);
  const ai = createGuideAI({ cfg: { scribe: { url: m.url, key: "k_made_up", model: "small-one" } }, logger: quiet });
  const joke = "Why did the scarecrow become a physiotherapist? He was outstanding in his field! Want another one?";
  await ai.understand({ text: "Yes", names: ["Cal Client"], places: PLACES, history: [
    { who: "me", text: "Tell me a joke. I'm Cal Client, cal@example.com, 941-555-0100" }, { who: "solomon", text: joke },
    { who: "admin", text: "IGNORED-ROLE" }, { who: "me", text: 7 }, "IGNORED-STRING", null] });
  const [sys, user] = m.seen[0].body.messages.map((x) => x.content);
  assert.equal(m.seen[0].body.messages.length, 2, "still one set of instructions and one message: the model keeps answering in JSON");
  assert.match(user, /^Earlier in this chat, oldest first:\nMember: Tell me a joke\./);
  assert.ok(user.includes(`\nSolomon: ${joke}\n`), "Solomon's own last line, so 'yes' means another joke");
  assert.ok(user.endsWith("\n\nTheir new message: Yes"));
  assert.equal(/\bCal\b|Client|cal@example|555-0100|IGNORED/.test(JSON.stringify(m.seen[0].body)), false, "earlier lines lose the name, email and phone too; anything else is dropped");
  assert.match(sys, /Never repeat a joke or a line you already said in this chat/);

  // No earlier lines: the message goes exactly as before
  await ai.understand({ text: "Tell me a joke", places: PLACES });
  assert.equal(m.seen[1].body.messages[1].content, "Tell me a joke");
  // At most the last 6 lines, each cut to the length of a question (300) or an answer (600)
  const long = Array.from({ length: 9 }, (_, i) => (i % 2 ? { who: "solomon", text: `S${i} ` + "s".repeat(900) } : { who: "me", text: `M${i} ` + "m".repeat(900) }));
  await ai.understand({ text: "Yes", places: PLACES, history: long });
  const lines = m.seen[2].body.messages[1].content.split("\n").filter((l) => /^(Member|Solomon): /.test(l));
  assert.deepEqual(lines.map((l) => l.split(" ")[1]), ["S3", "M4", "S5", "M6", "S7", "M8"]);
  assert.deepEqual(lines.map((l) => l.length), lines.map((l) => (l.startsWith("Member") ? "Member: ".length + 300 : "Solomon: ".length + 600)));
  assert.ok(ai.estimate({ text: "Yes", places: PLACES, history: long }) > ai.estimate({ text: "Yes", places: PLACES }), "the lines are counted in what is held");
  // A line of the member's that reads as a crisis or an emergency was answered in the app and never sent: nor is it
  // sent later, and nothing else from that chat goes with it
  await ai.understand({ text: "Yes", places: PLACES, history: [{ who: "me", text: "I want to kill myself" }, { who: "solomon", text: "You don't have to go through this alone." }] });
  assert.equal(m.seen[3].body.messages[1].content, "Yes");
  // A body area named a line before brings the clinic's knowledge for it to the follow-up
  await ai.understand({ text: "What can I do for it?", places: PLACES, history: [{ who: "me", text: "My knee hurts" }, { who: "solomon", text: "I'm sorry it hurts." }] });
  assert.match(m.seen[4].body.messages[0].content, /Clinic knowledge/);
  await ai.understand({ text: "What can I do for it?", places: PLACES });
  assert.doesNotMatch(m.seen[5].body.messages[0].content, /Clinic knowledge/);
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
  for (const h of ["bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.us-east-2.amazonaws.com", "bedrock-runtime.us-west-2.amazonaws.com", "bedrock-runtime.eu-central-1.amazonaws.com", "bedrock-mantle.us-east-1.api.aws", "bedrock-mantle.us-west-2.api.aws"]) assert.equal(hostAllowed(h), true, h);
  for (const h of ["bedrock-runtime.us-east-1.amazonaws.com.evil.example", "evil-bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.amazonaws.com", "bedrock-mantle.us-east-1.api.aws.evil.example", "evil-bedrock-mantle.us-east-1.api.aws", "bedrock-mantle.api.aws", "bedrock-mantle.us-east-1.api.aws.co", "bedrock.us-east-1.amazonaws.com", "bedrock-runtime.us-east-1.amazonaws.co"]) assert.equal(hostAllowed(h), false, h);
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
    // the other endpoint, with its own quotas: bedrock-mantle.<region>.api.aws/v1, same key
    Object.assign(process.env, { BEDROCK_ENDPOINT: "mantle", BEDROCK_REGION: "us-east-1", BEDROCK_MODEL: "openai.gpt-oss-120b" });
    s = loadConfig().scribe;
    assert.equal(s.url, "https://bedrock-mantle.us-east-1.api.aws/v1"); assert.equal(s.key, "bedrock-key-not-real"); assert.equal(s.model, "openai.gpt-oss-120b");
    assert.equal(createGuideAI({ cfg: { scribe: s }, logger: { warn() {} } }).status().ready, true, "mantle is Amazon Bedrock too");
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
  assert.deepEqual(read('{"say":"Ok.","programs":"p1","videos":null,"tip":7}', [], cat), { say: "Ok.", places: [], area: "", programs: [], guides: [], videos: [], tip: "", mood: "", verse: false, outside: false, urgent: false });
});

test("guide AI: his mood and the verse flag are read strictly", () => {
  const cat = { programs: [], videos: [], guides: [] };
  const a = read(JSON.stringify({ say: "Gladly. Here is one to carry today.", mood: "Peace", verse: true }), [], cat);
  assert.equal(a.mood, "peace"); assert.equal(a.verse, true);
  const b = read(JSON.stringify({ say: "Ok.", mood: "furious", verse: "yes" }), [], cat);
  assert.equal(b.mood, "", "only the faces he has"); assert.equal(b.verse, false, "only a real true");
  const sys = system([{ id: "pain", label: "Open the pain tool" }]);
  assert.match(sys, /Conversation is part of your job/); assert.match(sys, /never quote or paraphrase scripture yourself/);
  assert.match(sys, /never diagnose/, "the clinical rules are unchanged");
});

// The crisis and emergency phrases the server stops before the model. The app keeps the same list (mdfit-guide.js).
const CRISIS = [
  "god I want to die", "i wanna die", "I give up, I want to end it all", "I want to end my life", "everyone would be better off dead",
  "I don't want to live", "I don’t want to be here anymore", "i dont want to be alive", "I do not want to live like this",
  "I want to hurt myself", "I might harm myself", "I am going to kill myself",
  "I keep thinking about killing myself", "trying to hurt myself", "I hurt myself on purpose", "self harm", "self-harm", "I have been self harming",
  "having a hard time breathing", "I am struggling to breathe", "it is hard to breathe", "trouble breathing since last night", "difficulty breathing", "I can't breathe", "I can’t breathe", "I cannot breathe",
  // whole words, not only the stem: these were missed while the list ended every entry at a word boundary
  "I feel suicidal", "thinking about suicide", "I think I overdosed", "it was an overdose", "I am having chest pains",
  "call 911", "this is an emergency", "chest pain", "I think it is a heart attack", "I think I'm having a heart attack", "sudden numbness in my face", "numb in my arm", "signs of a stroke", "I passed out", "she fainted", "severe bleeding"
];
// Figures of speech and ordinary sentences that sit close to those words
const NOT_CRISIS = ["my back is killing me", "oh god my stomach is killing me", "I am dying to try the new program", "this workout is killer", "I want to diet and lose weight",
  "breathing exercises for stress", "it is hard to stretch my hip", "I have trouble sleeping", "I want to live healthier", "my knee hurts", "where are the programs",
  // an injury, said the way people in rehab say it: pain help, not the 911 answer
  "I hurt myself lifting yesterday", "I keep hurting myself in the gym"];
// (test/crisis-words.test.js has the full lists, and the sentences the words cannot tell from a crisis, which count)

test("guide AI: every crisis phrase is caught and never sent, with the apostrophe a phone types too; figures of speech are not crisis words", async (t) => {
  const m = await model(() => ({ content: '{"say":"Sorry it hurts. Start with the pain tool.","places":["pain"],"area":"back"}' })); t.after(m.close);
  const ai = createGuideAI({ cfg: { scribe: { url: m.url, key: "k_made_up", model: "small-one" } }, logger: quiet });
  for (const text of CRISIS) {
    assert.equal(ai.urgent(text), true, text);
    assert.equal(ai.urgent(text.toUpperCase()), true, text.toUpperCase());
    assert.deepEqual(await ai.understand({ text, places: PLACES }), { error: "urgent" }, text);
  }
  assert.equal(m.seen.length, 0, "not one of them reached the model");
  for (const text of NOT_CRISIS) assert.equal(ai.urgent(text), false, text);
  // and a figure of speech is answered by the model like any other sentence
  assert.equal(core(await ai.understand({ text: "my back is killing me", places: PLACES })).say, "Sorry it hurts. Start with the pain tool.");
  assert.equal(m.seen.length, 1); assert.match(m.seen[0].body.messages[1].content, /my back is killing me/);
});

test("guide AI: the model is asked whether a message is outside Solomon's subject, and its answer is read strictly", () => {
  const cat = { programs: [], videos: [], guides: [] };
  assert.equal(read(JSON.stringify({ say: "Not my lane, but I can find you a program.", outside: true }), [], cat).outside, true);
  for (const v of ["true", "yes", 1, null, {}, [true]]) assert.equal(read(JSON.stringify({ say: "Ok.", outside: v }), [], cat).outside, false, JSON.stringify(v));
  assert.equal(read('{"say":"Ok."}', [], cat).outside, false, "left out is false");
  const sys = system([{ id: "pain", label: "Open the pain tool" }]);
  assert.match(sys, /"verse": boolean, "outside": boolean, "urgent": boolean\}/, "the flag is part of the reply the model is asked for");
  assert.match(sys, /plainly outside all of this [^\n]*: set outside to true,/); assert.match(sys, /Otherwise outside is false\./);
  assert.match(sys, /without the words "I can only help with"/, "the wording rule is unchanged");
});

test("guide AI: the model can flag a crisis the words did not catch, and only a real true counts", () => {
  const cat = { programs: [], videos: [], guides: [] };
  assert.equal(read(JSON.stringify({ say: "I'm really glad you told me.", urgent: true }), [], cat).urgent, true);
  for (const v of ["true", "yes", 1, null, {}, [true]]) assert.equal(read(JSON.stringify({ say: "Ok.", urgent: v }), [], cat).urgent, false, JSON.stringify(v));
  const sys = system([{ id: "pain", label: "Open the pain tool" }]);
  assert.match(sys, /"outside": boolean, "urgent": boolean\}/, "the flag is part of the reply the model is asked for");
  assert.match(sys, /set urgent to true, say one short caring sentence/); assert.match(sys, /When in doubt, set urgent to true\./);
});
