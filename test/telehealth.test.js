// Built-in video visits: the waiting room and call set-up. The call itself runs browser to browser; this tests the
// part the server plays: who may knock, who is admitted, and who may exchange set-up messages with whom.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createTelehealth, iceServers } = require("../lib/telehealth");

// A stand-in connection: what the server sends it is kept in .got; fire() plays a message from that browser
const conn = (clientId, clientName) => {
  const ee = new EventEmitter(), got = [];
  return { clientId, clientName, got, on: (e, f) => ee.on(e, f), emit: (event, data) => got.push({ event, data }), fire: (e, d) => ee.emit(e, d),
    last: (event) => got.filter((x) => x.event === event).pop() };
};
const setup = () => {
  const ledger = []; let t = 1000;
  const tele = createTelehealth({ audit: { record: (e) => ledger.push(e) }, now: () => t,
    describe: (id) => ({ name: id === "pat1" ? "Pat Doe" : "Lee Park", visit: id === "pat1" ? "Online Evaluation · 2:00 PM" : "" }) });
  return { tele, ledger, tick: (ms) => { t += ms; } };
};

test("knock, waiting room, admit, set-up messages both ways, end; the ledger gets two lines and no content", () => {
  const { tele, ledger, tick } = setup();
  const doc = conn(), pat = conn("pat1", "Pat Doe");
  tele.staffJoin(doc); tele.patientJoin(pat);
  assert.deepEqual(doc.last("tele_waiting").data, { waiting: [], inCall: null });

  pat.fire("tele_knock");
  assert.deepEqual(pat.last("tele_waiting_room").data, { staffOnline: true });
  const row = doc.last("tele_waiting").data.waiting[0];
  assert.equal(row.name, "Pat Doe"); assert.equal(row.visit, "Online Evaluation · 2:00 PM"); assert.equal(row.clientId, "pat1");
  assert.equal(row.socket, undefined, "connections never leave the server");

  // nothing passes before the patient is admitted
  pat.fire("tele_signal", { sdp: "early" });
  assert.equal(doc.last("tele_signal"), undefined);

  doc.fire("tele_admit", { clientId: "pat1" });
  assert.ok(pat.last("tele_admitted")); assert.equal(doc.last("tele_started").data.name, "Pat Doe");
  assert.equal(doc.last("tele_waiting").data.waiting.length, 0); assert.equal(doc.last("tele_waiting").data.inCall.clientId, "pat1");

  doc.fire("tele_signal", { sdp: { type: "offer", sdp: "v=0" } });
  assert.deepEqual(pat.last("tele_signal").data, { sdp: { type: "offer", sdp: "v=0" } });
  pat.fire("tele_signal", { sdp: { type: "answer", sdp: "v=0" } });
  assert.deepEqual(doc.last("tele_signal").data, { sdp: { type: "answer", sdp: "v=0" } });
  const before = pat.got.length;
  doc.fire("tele_signal", { blob: "x".repeat(30000) });
  assert.equal(pat.got.length, before, "an oversized message is dropped");

  tick(125000);
  doc.fire("tele_end");
  assert.equal(pat.last("tele_ended").data.why, "ended"); assert.equal(doc.last("tele_ended").data.why, "ended");
  assert.equal(doc.last("tele_waiting").data.inCall, null);
  assert.deepEqual(ledger.map((e) => [e.action, e.subject]), [["telehealth.admit", "pat1"], ["telehealth.end", "pat1"]]);
  assert.equal(ledger[1].meta.seconds, 125);
  assert.equal(JSON.stringify(ledger).includes("v=0"), false, "set-up messages are never recorded");
});

test("only the admitted patient can talk to staff; one visit at a time; leaving and dropping clean up", () => {
  const { tele } = setup();
  const doc = conn(), pat = conn("pat1"), other = conn("lee2");
  tele.staffJoin(doc); tele.patientJoin(pat); tele.patientJoin(other);
  pat.fire("tele_knock"); other.fire("tele_knock");
  assert.equal(doc.last("tele_waiting").data.waiting.length, 2);
  doc.fire("tele_admit", { clientId: "pat1" });

  // the other member is still waiting and cannot inject into the visit
  other.fire("tele_signal", { candidate: "evil" });
  assert.equal(doc.got.filter((x) => x.event === "tele_signal").length, 0);
  // a second admit is refused while a visit is running
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.match(doc.last("tele_error").data.error, /End the current visit/);
  assert.equal(other.last("tele_admitted"), undefined);

  // the patient's connection drops: the visit ends for staff, the other member is still in the waiting room
  pat.fire("disconnect");
  assert.equal(doc.last("tele_ended").data.why, "patient_left");
  assert.deepEqual(doc.last("tele_waiting").data.waiting.map((w) => w.clientId), ["lee2"]);

  // the waiting member leaves; an admit for someone who left is refused
  other.fire("tele_leave");
  assert.equal(doc.last("tele_waiting").data.waiting.length, 0);
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.match(doc.last("tele_error").data.error, /no longer waiting/);

  // staff can turn someone away; staff dropping mid-visit ends it for the patient
  const again = conn("lee2"); tele.patientJoin(again); again.fire("tele_knock");
  doc.fire("tele_decline", { clientId: "lee2" });
  assert.ok(again.last("tele_declined"));
  again.fire("tele_knock"); doc.fire("tele_admit", { clientId: "lee2" });
  doc.fire("disconnect");
  assert.equal(again.last("tele_ended").data.why, "staff_left");
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
