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
  assert.deepEqual(doc.last("tele_waiting").data, { waiting: [], inCall: null, group: false, room: [], invited: [] });

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
  // opening a private visit to more people: the person in it becomes a viewer first and is told why, then others can come in
  doc.fire("tele_group", { on: true });
  assert.deepEqual(pat.last("tele_role").data, { role: "viewer", opened: true });
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => [m.clientId, m.role]), [["pat1", "viewer"]]); assert.equal(doc.last("tele_waiting").data.group, true);
  doc.fire("tele_group", { on: false });
  assert.match(doc.last("tele_error").data.error, /End the live room/);
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.deepEqual(other.last("tele_admitted").data, { role: "viewer", group: true });
  other.fire("tele_leave"); other.fire("tele_knock");

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

test("inviting: the member is told, shows as pending, and is let in on arrival; a busy private visit still makes them wait", async () => {
  const told = [];
  const audit = { rows: [], record(e) { this.rows.push(e); } };
  let clock = 1000;
  const tele = createTelehealth({ audit, now: () => clock, describe: (id) => ({ name: id === "pat1" ? "Pat Doe" : "Lee Other" }),
    invite: async (id) => { if (id === "ghost") return null; told.push(id); return { name: id === "pat1" ? "Pat Doe" : "Lee Other", emailed: true, pushed: true }; } });
  const tick = () => new Promise((r) => setImmediate(r));
  const doc = conn(), a = conn("pat1"), b = conn("lee2");
  tele.staffJoin(doc); tele.patientJoin(a); tele.patientJoin(b);

  doc.fire("tele_invite", { clientId: "ghost" }); await tick();
  assert.match(doc.last("tele_error").data.error, /could not be invited/);
  doc.fire("tele_invite", { clientId: "pat1" }); await tick();
  assert.deepEqual(told, ["pat1"]); assert.equal(doc.last("tele_invited").data.emailed, true);
  assert.deepEqual(doc.last("tele_waiting").data.invited.map((x) => [x.clientId, x.name]), [["pat1", "Pat Doe"]], "pending");
  assert.equal(tele.isInvited("pat1"), true); assert.equal(tele.isInvited("lee2"), false);
  doc.fire("tele_invite", { clientId: "pat1" }); await tick();
  assert.match(doc.last("tele_error").data.error, /a moment ago/); assert.equal(told.length, 1, "not told twice in a minute");

  // arriving lets them straight in; nobody else gets in that way
  a.fire("tele_knock");
  assert.deepEqual(a.last("tele_admitted").data, { role: "speaker", group: false });
  assert.equal(doc.last("tele_started").data.clientId, "pat1"); assert.deepEqual(doc.last("tele_waiting").data.invited, []);
  b.fire("tele_knock");
  assert.equal(b.last("tele_admitted"), undefined, "someone not invited waits to be admitted");

  // invited while a private visit is on: they wait, and can be admitted once it ends
  clock += 120000; doc.fire("tele_invite", { clientId: "lee2" }); await tick();
  assert.equal(b.last("tele_admitted"), undefined); assert.deepEqual(doc.last("tele_waiting").data.waiting.map((w) => w.clientId), ["lee2"]);
  doc.fire("tele_end");
  doc.fire("tele_admit", { clientId: "lee2" });
  assert.deepEqual(b.last("tele_admitted").data, { role: "speaker", group: false });
  doc.fire("tele_end");

  // live room: an invited person comes in as a viewer, and can be made a speaker
  doc.fire("tele_group", { on: true });
  const c = conn("kim3"); tele.patientJoin(c);
  clock += 120000; doc.fire("tele_invite", { clientId: "kim3" }); doc.fire("tele_invite", { clientId: "pat1" }); await tick();
  c.fire("tele_knock"); a.fire("tele_knock");
  assert.deepEqual(c.last("tele_admitted").data, { role: "viewer", group: true }); assert.deepEqual(a.last("tele_admitted").data, { role: "viewer", group: true });
  doc.fire("tele_role", { clientId: "kim3", role: "speaker" });
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => [m.clientId, m.role]), [["kim3", "speaker"], ["pat1", "viewer"]]);
  // removing someone cancels their invitation; a withdrawn or expired invitation no longer lets anyone in
  doc.fire("tele_end", { clientId: "pat1" });
  a.fire("tele_knock"); assert.equal(a.last("tele_declined").data.removed, true);
  doc.fire("tele_end");
  clock += 120000; doc.fire("tele_invite", { clientId: "lee2" }); await tick();
  doc.fire("tele_uninvite", { clientId: "lee2" });
  b.fire("tele_knock"); assert.equal(b.count("tele_admitted"), 1, "invitation withdrawn: back to knocking");
  b.fire("tele_leave");
  clock += 120000; doc.fire("tele_invite", { clientId: "lee2" }); await tick();
  clock += 3 * 60 * 60 * 1000;
  assert.equal(tele.isInvited("lee2"), false); b.fire("tele_knock"); assert.equal(b.count("tele_admitted"), 1, "an old invitation has lapsed");
  assert.ok(audit.rows.some((e) => e.action === "telehealth.invite" && e.subject === "pat1" && e.meta.emailed === true));
});

test("a visit survives a server restart: it is put back only when the host and the member both say it is still on", () => {
  // a fresh server (nothing in the room), as after a restart; everyone reconnects
  let clock = 1000;
  const audit = { rows: [], record(e) { this.rows.push(e); } };
  const tele = createTelehealth({ audit, now: () => clock, describe: (id) => ({ name: id === "pat1" ? "Pat Doe" : "Lee Other" }) });
  const doc = conn(), a = conn("pat1"), b = conn("lee2");
  tele.staffJoin(doc); tele.patientJoin(a); tele.patientJoin(b);

  // a member's word alone restores nothing, and gives them no way to reach staff
  b.fire("tele_here");
  assert.deepEqual(doc.last("tele_waiting").data.room, []);
  b.fire("tele_signal", { candidate: "x" }); assert.equal(doc.count("tele_signal"), 0);

  // the host names who it is with; the one who also says so is back in the room, the other is not
  a.fire("tele_here");
  doc.fire("tele_resume", { group: false, people: [{ clientId: "pat1", role: "speaker" }] });
  assert.deepEqual(doc.last("tele_waiting").data.room.map((m) => [m.clientId, m.name, m.role]), [["pat1", "Pat Doe", "speaker"]]);
  assert.deepEqual(a.last("tele_resumed").data, { role: "speaker", group: false }); assert.equal(b.last("tele_resumed"), undefined);
  // and the visit works again: set-up messages pass, a second person still has to wait, and End ends it
  doc.fire("tele_signal", { to: "pat1", sdp: { type: "offer" } }); assert.equal(a.count("tele_signal"), 1);
  a.fire("tele_signal", { candidate: "c" }); assert.equal(doc.last("tele_signal").data.from, "pat1");
  b.fire("tele_knock"); doc.fire("tele_admit", { clientId: "lee2" });
  assert.match(doc.last("tele_error").data.error, /End the current visit/);
  doc.fire("tele_end"); assert.equal(a.last("tele_ended").data.why, "ended");
  assert.ok(audit.rows.some((e) => e.action === "telehealth.resume" && e.subject === "pat1"));

  // the order does not matter, a live room comes back with its roles, and a stale claim lapses
  const tele2 = createTelehealth({ now: () => clock, describe: () => ({ name: "Someone" }) });
  const doc2 = conn(), c = conn("kim3"), d = conn("pat1"), e = conn("old9");
  tele2.staffJoin(doc2); [c, d, e].forEach((x) => tele2.patientJoin(x));
  e.fire("tele_here"); clock += 120000;
  doc2.fire("tele_resume", { group: true, people: [{ clientId: "kim3", role: "speaker" }, { clientId: "pat1", role: "viewer" }, { clientId: "old9", role: "viewer" }] });
  c.fire("tele_here"); d.fire("tele_here");
  const snap = doc2.last("tele_waiting").data;
  assert.equal(snap.group, true); assert.deepEqual(snap.room.map((m) => [m.clientId, m.role]).sort(), [["kim3", "speaker"], ["pat1", "viewer"]]);
  // another staff screen cannot take a running visit this way
  const other = conn(), f = conn("new7"); tele2.staffJoin(other); tele2.patientJoin(f);
  other.fire("tele_resume", { group: true, people: [{ clientId: "new7", role: "speaker" }] }); f.fire("tele_here");
  assert.equal(doc2.last("tele_waiting").data.room.length, 2); assert.equal(f.last("tele_resumed"), undefined);
});
