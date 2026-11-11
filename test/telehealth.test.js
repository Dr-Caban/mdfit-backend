// Built-in video visits and live rooms. The call itself runs browser to browser; this tests the part the server
// plays: who may knock, who is admitted and in which role, and who may exchange set-up messages with whom.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createTelehealth, iceServers, MAX_ROOM } = require("../lib/telehealth");

// A stand-in connection: what the server sends it is kept in .got; fire() plays a message from that browser
const conn = (clientId, clientName) => {
  const ee = new EventEmitter(), got = [];
  return { clientId, clientName, got, on: (e, f) => ee.on(e, f), emit: (event, data) => got.push({ event, data }), fire: (e, d) => ee.emit(e, d),
    last: (event) => got.filter((x) => x.event === event).pop(), count: (event) => got.filter((x) => x.event === event).length };
};
const setup = () => {
  const ledger = []; let t = 1000;
  const names = { pat1: "Pat Doe", lee2: "Lee Park", kim3: "Kim Roe" };
  const tele = createTelehealth({ audit: { record: (e) => ledger.push(e) }, now: () => t,
    describe: (id) => ({ name: names[id] || "Member " + id, visit: id === "pat1" ? "Online Evaluation · 2:00 PM" : "", minutes: id === "pat1" ? 60 : 0 }) });
  return { tele, ledger, tick: (ms) => { t += ms; } };
};

test("one to one: knock, admit as speaker, set-up messages both ways, end; the ledger holds no content", () => {
  const { tele, ledger, tick } = setup();
  const doc = conn(), pat = conn("pat1", "Pat Doe");
  tele.staffJoin(doc); tele.patientJoin(pat);
  assert.deepEqual(doc.last("tele_waiting").data, { waiting: [], inCall: null, group: false, room: [] });

  pat.fire("tele_knock");
  assert.deepEqual(pat.last("tele_waiting_room").data, { staffOnline: true });
  const row = doc.last("tele_waiting").data.waiting[0];
  assert.equal(row.name, "Pat Doe"); assert.equal(row.visit, "Online Evaluation · 2:00 PM"); assert.equal(row.minutes, 60);
  assert.equal(row.socket, undefined, "connections never leave the server");

  pat.fire("tele_signal", { sdp: "early" });
  assert.equal(doc.last("tele_signal"), undefined, "nothing passes before the patient is admitted");

  doc.fire("tele_admit", { clientId: "pat1" });
  assert.deepEqual(pat.last("tele_admitted").data, { role: "speaker", group: false });
  assert.equal(doc.last("tele_started").data.role, "speaker"); assert.equal(doc.last("tele_started").data.minutes, 60);
  assert.equal(doc.last("tele_waiting").data.inCall.clientId, "pat1");
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => [m.clientId, m.role]), [["pat1", "speaker"]]);

  doc.fire("tele_signal", { to: "pat1", sdp: { type: "offer", sdp: "v=0" } });
  assert.deepEqual(pat.last("tele_signal").data, { sdp: { type: "offer", sdp: "v=0" } }, "the patient gets the message without the address");
  doc.fire("tele_signal", { candidate: "c1" }); // with exactly one person the name may be left out
  assert.deepEqual(pat.last("tele_signal").data, { candidate: "c1" });
  pat.fire("tele_signal", { sdp: { type: "answer", sdp: "v=0" } });
  assert.deepEqual(doc.last("tele_signal").data, { sdp: { type: "answer", sdp: "v=0" }, from: "pat1" }, "the host is told who it came from");
  const before = pat.got.length;
  doc.fire("tele_signal", { to: "pat1", blob: "x".repeat(30000) });
  assert.equal(pat.got.length, before, "an oversized message is dropped");

  tick(125000);
  doc.fire("tele_end");
  assert.equal(pat.last("tele_ended").data.why, "ended"); assert.equal(doc.last("tele_ended").data.why, "ended");
  assert.equal(doc.last("tele_waiting").data.inCall, null);
  assert.deepEqual(ledger.map((e) => [e.action, e.subject]), [["telehealth.admit", "pat1"], ["telehealth.end", "pat1"]]);
  assert.equal(ledger[1].meta.seconds, 125);
  assert.equal(JSON.stringify(ledger).includes("v=0"), false, "set-up messages are never recorded");
});

test("one to one keeps a second person waiting; leaving and dropping clean up", () => {
  const { tele } = setup();
  const doc = conn(), pat = conn("pat1"), other = conn("lee2");
  tele.staffJoin(doc); tele.patientJoin(pat); tele.patientJoin(other);
  pat.fire("tele_knock"); other.fire("tele_knock");
  doc.fire("tele_admit", { clientId: "pat1" });
  other.fire("tele_signal", { candidate: "evil" });
  assert.equal(doc.count("tele_signal"), 0, "someone still waiting cannot inject into the visit");
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.match(doc.last("tele_error").data.error, /End the current visit/);
  assert.equal(other.last("tele_admitted"), undefined);
  // a private visit cannot be turned into a live room while the patient is in it
  doc.fire("tele_group", { on: true });
  assert.match(doc.last("tele_error").data.error, /before opening the live room/); assert.equal(doc.last("tele_waiting").data.group, false);

  pat.fire("disconnect");
  assert.equal(doc.last("tele_ended").data.why, "patient_left");
  assert.deepEqual(doc.last("tele_waiting").data.waiting.map((w) => w.clientId), ["lee2"]);
  other.fire("tele_leave");
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.match(doc.last("tele_error").data.error, /no longer waiting/);

  const again = conn("lee2"); tele.patientJoin(again); again.fire("tele_knock");
  doc.fire("tele_decline", { clientId: "lee2" });
  assert.ok(again.last("tele_declined"));
  again.fire("tele_knock"); doc.fire("tele_admit", { clientId: "lee2" });
  doc.fire("disconnect");
  assert.equal(again.last("tele_ended").data.why, "staff_left");
});

test("live room: everyone arrives as a viewer; the dock makes a speaker; members never reach each other; removal sticks", () => {
  const { tele, ledger } = setup();
  const doc = conn(), a = conn("pat1"), b = conn("lee2"), c = conn("kim3");
  tele.staffJoin(doc); [a, b, c].forEach((x) => { tele.patientJoin(x); x.fire("tele_knock"); });
  doc.fire("tele_group", { on: true });
  assert.equal(doc.last("tele_waiting").data.group, true);

  doc.fire("tele_admit", { clientId: "pat1" }); doc.fire("tele_admit", { clientId: "lee2" });
  assert.deepEqual(a.last("tele_admitted").data, { role: "viewer", group: true });
  assert.deepEqual(b.last("tele_admitted").data, { role: "viewer", group: true });
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => [m.clientId, m.role]), [["pat1", "viewer"], ["lee2", "viewer"]]);
  assert.equal(a.count("tele_waiting"), 0, "a member is never sent the list of who else is in the room");

  // set-up messages are addressed: only the named person gets one, and members' messages go to the host only
  doc.fire("tele_signal", { to: "lee2", sdp: "for-lee" });
  assert.deepEqual(b.last("tele_signal").data, { sdp: "for-lee" }); assert.equal(a.count("tele_signal"), 0);
  const sent = b.got.length;
  doc.fire("tele_signal", { sdp: "no-name" });
  assert.equal(b.got.length, sent, "with several people an unaddressed message goes to nobody");
  a.fire("tele_signal", { to: "lee2", candidate: "from-pat" });
  assert.equal(b.got.length, sent, "a member cannot address another member");
  assert.equal(doc.last("tele_signal").data.from, "pat1");

  // into the dock and back
  doc.fire("tele_role", { clientId: "pat1", role: "speaker" });
  assert.deepEqual(a.last("tele_role").data, { role: "speaker" }); assert.equal(b.count("tele_role"), 0);
  assert.equal(doc.last("tele_waiting").data.room.find((m) => m.clientId === "pat1").role, "speaker");
  doc.fire("tele_role", { clientId: "pat1", role: "viewer" });
  assert.deepEqual(a.last("tele_role").data, { role: "viewer" });
  a.fire("tele_role", { clientId: "pat1", role: "speaker" });
  assert.equal(doc.last("tele_waiting").data.room.find((m) => m.clientId === "pat1").role, "viewer", "a member cannot promote themselves");

  // removed from the room: told so, gone from the list, and cannot knock back in while the room is open
  doc.fire("tele_end", { clientId: "lee2" });
  assert.equal(b.last("tele_ended").data.why, "removed"); assert.equal(doc.last("tele_left").data.clientId, "lee2");
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => m.clientId), ["pat1"]);
  b.fire("tele_knock");
  assert.deepEqual(b.last("tele_declined").data, { removed: true });
  assert.equal(doc.last("tele_waiting").data.waiting.some((w) => w.clientId === "lee2"), false);
  assert.equal(a.count("tele_ended"), 0, "removing one person leaves the others in the room");

  // the mode cannot change while anyone is in the room
  doc.fire("tele_admit", { clientId: "kim3" });
  doc.fire("tele_group", { on: false });
  assert.match(doc.last("tele_error").data.error, /End the live room/); assert.equal(doc.last("tele_waiting").data.group, true);
  c.fire("tele_leave");
  assert.equal(doc.last("tele_left").data.why, "patient_left"); assert.equal(doc.count("tele_ended"), 0, "the room stays open while someone is in it");

  // ending the room ends it for everyone, and the removal no longer applies
  doc.fire("tele_end");
  assert.equal(a.last("tele_ended").data.why, "ended"); assert.deepEqual(doc.last("tele_waiting").data.room, []);
  b.fire("tele_knock");
  assert.ok(b.last("tele_waiting_room"), "after the room has ended a removed person may knock for a new visit");
  assert.deepEqual(ledger.filter((e) => /dock/.test(e.action)).map((e) => [e.action, e.subject]), [["telehealth.dock", "pat1"], ["telehealth.undock", "pat1"]]);
  assert.equal(ledger.filter((e) => e.action === "telehealth.end").length, 3);
});

test("live room: only the host's screen can run it, and it has a size limit", () => {
  const { tele } = setup();
  const doc = conn(), other = conn();
  tele.staffJoin(doc); tele.staffJoin(other);
  doc.fire("tele_group", { on: true });
  const members = Array.from({ length: MAX_ROOM + 1 }, (_, i) => conn("m" + i));
  members.forEach((m) => { tele.patientJoin(m); m.fire("tele_knock"); });
  doc.fire("tele_admit", { clientId: "m0" });
  other.fire("tele_admit", { clientId: "m1" });
  assert.match(other.last("tele_error").data.error, /Another staff screen/);
  other.fire("tele_role", { clientId: "m0", role: "speaker" }); other.fire("tele_end"); other.fire("tele_signal", { to: "m0", sdp: "x" });
  assert.equal(members[0].count("tele_role") + members[0].count("tele_ended") + members[0].count("tele_signal"), 0, "a second staff screen cannot steer the room");
  for (let i = 1; i < MAX_ROOM; i++) doc.fire("tele_admit", { clientId: "m" + i });
  assert.equal(tele.snapshot().room.length, MAX_ROOM);
  doc.fire("tele_admit", { clientId: "m" + MAX_ROOM });
  assert.match(doc.last("tele_error").data.error, /room is full/);
});

test("a patient with nobody signed in is told so; a connection without a member id cannot knock", () => {
  const { tele } = setup();
  const pat = conn("pat1"); tele.patientJoin(pat); pat.fire("tele_knock");
  assert.deepEqual(pat.last("tele_waiting_room").data, { staffOnline: false });
  const anon = conn(""); tele.patientJoin(anon); anon.fire("tele_knock");
  assert.equal(anon.got.length, 0);
  assert.equal(tele.snapshot().waiting.length, 1);
});

test("path-finding addresses: a default, an optional relay, and nothing malformed", () => {
  assert.deepEqual(iceServers({}), [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  assert.deepEqual(iceServers({ telehealth: { stun: "", turnUrl: "" } }), []);
  const withRelay = iceServers({ telehealth: { stun: "stun:a.example:3478, https://not-stun", turnUrl: "turns:relay.example:5349", turnUser: "u", turnCred: "c" } });
  assert.deepEqual(withRelay, [{ urls: ["stun:a.example:3478"] }, { urls: ["turns:relay.example:5349"], username: "u", credential: "c" }]);
  assert.equal(iceServers({ telehealth: { turnUrl: "turn:relay.example", turnUser: "", turnCred: "" } }).length, 1, "a relay without credentials is left out");
});
