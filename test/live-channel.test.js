// The live channel (lib/realtime.js) and video visits (lib/telehealth.js) take messages straight from browsers. A
// crafted one must never stop the server. These tests send them over a real connection to a server in this same
// process, so a throw that escaped would end the test run itself, not just fail an assertion.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { createRealtime, guard, RATE_MAX } = require("../lib/realtime");
const { createTelehealth } = require("../lib/telehealth");
const { signToken } = require("../lib/auth");

const SECRET = "made-up-session-secret-for-tests-only", OWNER = "owner@example.com";
const exp = () => Date.now() + 3600e3;
const people = { pat1: { id: "pat1", name: "Pat Doe", pwv: 0 }, lee2: { id: "lee2", name: "Lee Park", pwv: 0 } };
const staffRecs = { "desk@example.com": { email: "desk@example.com", active: true, permissions: ["clients", "scheduling", "messages", "reviews"] } };

async function server(t) {
  const srv = http.createServer((req, res) => res.end("ok"));
  const warns = [], describes = [];
  const logger = { warn: (e, d) => warns.push([e, d]), info() {}, error() {} };
  const rt = createRealtime(srv, { origins: ["*"], sessionSecret: SECRET, adminEmail: OWNER, rtRecheckMs: 0 },
    { findClient: (id) => people[id] || null, findStaff: (e) => staffRecs[e] || null, logger });
  const tele = createTelehealth({ logger, ownerEmail: OWNER, live: false,
    describe: (id) => { describes.push(id); return { name: (people[id] || {}).name }; },
    invite: async (id) => (people[id] ? { name: people[id].name } : null) });
  rt.adminNs.on("connection", (s) => tele.staffJoin(s));
  rt.memberNs.on("connection", (s) => tele.patientJoin(s));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => rt.io.close(() => r())));
  return { port: srv.address().port, rt, tele, warns, describes, failed: () => warns.filter(([e]) => /handler_failed/.test(e)) };
}

// A bare Engine.IO / Socket.IO connection, so any JSON at all can be sent, as a crafted page could
function connect(port, ns, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/?EIO=4&transport=websocket`);
    const got = [], acks = new Map();
    let ack = 0;
    const api = {
      got, last: (ev) => got.filter((x) => x.ev === ev).pop(),
      send: (event, ...data) => ws.send(`42${ns},` + JSON.stringify([event, ...data])),
      sendRaw: (json) => ws.send(`42${ns},` + json),
      // An "are you there?" with an answer: messages are handled in order, so once it is answered, all sent before it are
      ping: () => new Promise((r) => { const id = ++ack; acks.set(id, r); ws.send(`42${ns},${id}["rt_ping"]`); }),
      answered: () => [...acks.keys()].length,
      close: () => ws.close()
    };
    ws.on("message", (buf) => {
      const m = String(buf);
      if (m === "2") return ws.send("3");
      if (m[0] === "0") return ws.send(`40${ns},` + JSON.stringify(token ? { token } : {}));
      if (m.startsWith(`40${ns},`)) return resolve(api);
      if (m.startsWith(`44${ns},`)) return reject(new Error("refused: " + m));
      if (m.startsWith(`42${ns},`)) { const [ev, data] = JSON.parse(m.slice(ns.length + 3)); got.push({ ev, data }); return; }
      const a = m.match(new RegExp(`^43${ns.replace("/", "\\/")},(\\d+)`));
      if (a) { const r = acks.get(Number(a[1])); acks.delete(Number(a[1])); if (r) r(true); }
    });
    ws.on("error", reject);
  });
}
const member = (port, id) => connect(port, "/member", signToken({ sub: id, role: "client", pwv: 0, exp: exp() }, SECRET));
const owner = (port) => connect(port, "/admin", signToken({ sub: OWNER, exp: exp() }, SECRET));
const desk = (port) => connect(port, "/admin", signToken({ sub: "desk@example.com", role: "staff", exp: exp() }, SECRET));
const settle = () => new Promise((r) => setTimeout(r, 50));
const OBJ = '{"toString":1}';

test("a crafted 'viewing' message from any member leaves the server running and records nothing", async (t) => {
  const s = await server(t);
  const pat = await member(s.port, "pat1");
  pat.send("viewing", "home"); await pat.ping();
  assert.equal(s.rt.onlineStats().members[0].page, "home");
  for (const payload of [OBJ, `[${OBJ}]`, '{"valueOf":1,"toString":1}', "[".repeat(20000) + "]".repeat(20000), "12", "null"]) pat.sendRaw(`["viewing",${payload}]`);
  assert.equal(await pat.ping(), true, "the server still answers on the same connection");
  assert.equal(s.rt.onlineStats().members[0].page, "home", "only a page name is kept");
  assert.deepEqual(s.failed(), [], "nothing even had to be caught: anything but a string is ignored");
  const res = await fetch(`http://127.0.0.1:${s.port}/`); assert.equal(res.status, 200);
  pat.close();
});

test("video-visit messages from staff with an id sent as an object leave the server running and change nothing", async (t) => {
  const s = await server(t);
  const doc = await owner(s.port), front = await desk(s.port), pat = await member(s.port, "pat1"), lee = await member(s.port, "lee2");
  pat.send("tele_knock"); lee.send("tele_knock"); await pat.ping(); await lee.ping();
  // Scheduling is enough to send these (the front desk), and the owner's screen can send them all
  for (const ev of ["tele_admit", "tele_invite", "tele_uninvite", "tele_decline", "tele_role", "tele_end"]) { front.sendRaw(`["${ev}",{"clientId":${OBJ}}]`); doc.sendRaw(`["${ev}",{"clientId":${OBJ}}]`); }
  front.sendRaw(`["tele_resume",{"people":[{"clientId":${OBJ}}]}]`);
  await front.ping(); await doc.ping(); await settle();
  assert.deepEqual(s.tele.snapshot().waiting.map((w) => w.clientId), ["pat1", "lee2"], "nobody was admitted, declined or moved");
  // Hosting a visit: a set-up message and a removal addressed to an object reach nobody
  doc.send("tele_admit", { clientId: "pat1" }); await doc.ping();
  assert.equal(s.tele.snapshot().inCall.clientId, "pat1");
  doc.sendRaw(`["tele_signal",{"to":${OBJ},"sdp":"x"}]`); doc.sendRaw(`["tele_end",{"clientId":${OBJ}}]`);
  assert.equal(await doc.ping(), true);
  await pat.ping();
  assert.equal(pat.last("tele_signal"), undefined, "the message went to nobody");
  assert.equal(s.tele.snapshot().inCall.clientId, "pat1", "nobody was removed");
  assert.deepEqual(s.failed(), [], "nothing had to be caught: an id that is not text is no id");
  for (const c of [doc, front, pat, lee]) c.close();
});

test("knocking again from the same page while waiting does not read the member's records again", async (t) => {
  const s = await server(t);
  const pat = await member(s.port, "pat1");
  for (let i = 0; i < 40; i++) pat.send("tele_knock");
  await pat.ping();
  assert.deepEqual(s.describes, ["pat1"], "read once, on the first knock");
  assert.equal(pat.got.filter((x) => x.ev === "tele_waiting_room").length, 40, "every knock is still answered");
  pat.close();
});

test("a member connection that sends too much has the rest dropped, and the server keeps answering everyone", async (t) => {
  const s = await server(t);
  const max = RATE_MAX["/member"];
  const pat = await member(s.port, "pat1"), lee = await member(s.port, "lee2");
  const pings = Array.from({ length: max + 30 }, () => pat.ping());
  await settle(); await settle();
  const answered = (await Promise.race([Promise.all(pings).then(() => "all"), settle().then(() => "some")]));
  assert.equal(answered, "some", "not every message was handled");
  assert.equal(s.warns.filter(([e]) => e === "socket_rate_limited").length, 1, "logged once, not once per dropped message");
  assert.equal(await lee.ping(), true, "another member is not affected");
  pat.close(); lee.close();
});

test("any handler on a live connection that throws, or rejects, is logged and dropped", async () => {
  const warns = [], logger = { warn: (e, d) => warns.push([e, d]) };
  const s = guard(new EventEmitter(), "/admin", logger);
  s.on("boom", () => { throw new Error("broke"); });
  s.on("later", async () => { throw new Error("broke later"); });
  s.on("fine", (x) => warns.push(["fine", x]));
  s.emit("boom"); s.emit("later", 1); s.emit("fine", 2);
  await settle();
  assert.deepEqual(warns.map(([e, d]) => [e, d.event || d]), [["socket_handler_failed", "boom"], ["fine", 2], ["socket_handler_failed", "later"]]);
  assert.equal(JSON.stringify(warns).includes("broke"), true, "the error message is kept; nothing the browser sent is");
});
