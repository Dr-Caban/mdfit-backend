// Built-in video visits and live rooms (Workspace → Telehealth, and the patient page /visit). Owner, Nov 2026.
//
// How it works: a member opens /visit, signed in, and "knocks". Dr. Jared sees them in the waiting room and admits
// them. From then on their browser and his talk to each other directly: sound and picture travel browser to browser,
// encrypted by the browsers themselves (WebRTC, DTLS-SRTP). This server only carries the short set-up messages
// between them (over the same signed-in live connection the app already uses) and never sees, relays or records any
// sound or picture. Nothing about a visit is stored except lines in the audit ledger: admitted, brought into the
// dock or sent back to the audience, and ended with the length.
//
// Two ways to run it, chosen by the host:
//   - One to one (the default): one patient, camera and microphone both ways. A second person stays in the waiting room.
//   - Live room: several people can be admitted. Everyone comes in as a VIEWER, camera and microphone off, seeing and
//     hearing only the host. The host can bring a viewer "into the dock", which makes them a SPEAKER: their camera
//     and microphone turn on (after they agree on their own screen) and the room sees and hears them. The host can
//     send them back to the audience at any time. Viewers are never shown who else is watching.
//
// Inviting: the host can invite a member by name. They are told in the app and by email (a link to /visit, nothing
// about their care), show as "pending" on the host's screen, and are let in on arrival without knocking. Someone who
// was invited always comes in as a VIEWER (an empty private room opens as a live room for them); if a private visit is
// under way they wait like anyone else. An invitation lasts two hours at most: it is used up when they come in, and
// any still open end when the room empties, as does a live room an invitation (or the host) opened in a room that
// starts private. Nobody is let into a later session by an invitation to an earlier one.
//
// Asking to speak: a viewer can ask. The host sees who is asking and admits them, which makes them a speaker. Because
// they asked, their camera and microphone come on without a second question on their screen; asking is the consent.
//
// Surviving a restart: sound and picture go browser to browser, so a visit keeps running even if this server restarts
// or the connection to it drops for a moment. The room list here is lost, though. When they reconnect, the host's
// screen says who it is still in a visit with and each of those members says they are still in one; a member is put
// back in the room only when both agree. The host is signed-in staff, so a member's word alone restores nothing.
//
// A member can only knock as themselves (their sign-in decides who they are). Set-up messages pass only between the
// host and a person the host admitted; members never exchange anything with each other through this server.
//
// Finding a path between two browsers needs a public "STUN" address (it sees network addresses only, never the
// call). Some networks block direct paths; those calls need a relay ("TURN") that the owner can add with
// TURN_URL, TURN_USERNAME and TURN_CREDENTIAL. Without one, a call on such a network fails to connect and says so.
"use strict";

const MAX_SIGNAL = 24000; // one set-up message; a session description is a few KB (more with several speakers)
const MAX_ROOM = 12;      // people in a live room besides the host: every picture is sent browser to browser
const INVITE_MS = 2 * 60 * 60 * 1000, REINVITE_MS = 60 * 1000;
const RESUME_MS = 60 * 1000; // how long a "still in a visit" from either side waits for the other
// A member id as a browser sent it: a string (or a plain number), otherwise nothing. Anything else (an object, an
// array) is never turned into text, so a crafted message can name nobody and cannot throw.
const idOf = (v) => (typeof v === "string" ? v.slice(0, 200) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

function iceServers(cfg = {}) {
  const t = cfg.telehealth || {};
  const stun = String(t.stun === undefined ? "stun:stun.cloudflare.com:3478" : t.stun).split(/[\s,]+/).filter((u) => /^stuns?:/.test(u));
  const out = stun.length ? [{ urls: stun }] : [];
  if (/^turns?:/.test(String(t.turnUrl || "")) && t.turnUser && t.turnCred) out.push({ urls: String(t.turnUrl).split(/[\s,]+/).filter(Boolean), username: t.turnUser, credential: t.turnCred });
  return out;
}

// describe(clientId) -> { name, visit, minutes } for the waiting-room row; audit is the ledger (optional)
// invite(clientId) -> { name, emailed, pushed } after telling the member, or null if there is no such member
// live: whether the room starts as a live room (people come in as viewers) or as a private one to one visit
// ownerEmail: the owner's sign-in email, so the ledger can name the owner when the owner is the one acting
function createTelehealth({ describe, invite, audit, logger, live = false, ownerEmail = "", now = () => Date.now() } = {}) {
  const staff = new Set();          // signed-in staff connections
  const waiting = new Map();        // clientId -> { clientId, name, visit, minutes, since, socket }
  const room = new Map();           // clientId -> { clientId, name, visit, minutes, since, socket, role }
  let host = null;                  // the staff connection running the visit
  let group = !!live;               // live-room mode: more than one person may be admitted, as viewers
  const removed = new Set();        // people the host removed: they cannot knock again until this room has ended
  const invited = new Map();        // clientId -> { clientId, name, at, by }: asked to join, let in on arrival (by: the inviting screen)
  const claims = new Map();         // clientId -> { socket, at }: a member who says they are still in a visit
  let resume = null;                // { socket, people: Map(clientId -> role), group, at }: the host's side of the same

  const rows = () => [...waiting.values()].map(({ socket, ...w }) => w).sort((a, b) => a.since - b.since);
  const people = () => [...room.values()].map(({ socket, visit, minutes, asking, askedAt, ...m }) => ({ ...m, asking: !!asking })).sort((a, b) => a.since - b.since);
  const pending = () => { for (const [id, x] of invited) if (now() - x.at > INVITE_MS) invited.delete(id); return [...invited.values()].filter((x) => !waiting.has(x.clientId) && !room.has(x.clientId)).sort((a, b) => a.at - b.at).map(({ by, ...x }) => x); };
  const snapshot = () => { const first = people()[0]; return { waiting: rows(), inCall: first ? { clientId: first.clientId, name: first.name, since: first.since } : null, group, room: people(), invited: pending() }; };
  const tellStaff = () => { const s = snapshot(); staff.forEach((x) => x.emit("tele_waiting", s)); };
  const small = (d) => { try { return JSON.stringify(d).length <= MAX_SIGNAL; } catch { return false; } };
  // Who did it, spelled as the rest of the ledger spells it. A staff connection carries its account's email
  // (lib/realtime.js); the owner's carries none, so the owner's email is handed in. Something a member's own action
  // causes (asking to speak, leaving, coming in on an invitation) is theirs: "client:<id>".
  const staffActor = (socket) => { const email = (socket && socket.staffEmail) || ownerEmail; return email ? `admin:${email}` : "admin"; };
  const memberActor = (clientId) => `client:${clientId}`;
  const record = (action, actor, clientId, meta = {}) => { try { if (audit) audit.record({ actor, action, subject: clientId, ip: "", meta }); } catch {} };
  // A handler for a message from a browser. One that throws (or rejects) is logged and dropped; it never reaches the
  // process (lib/realtime.js does the same for every connection; this keeps it so wherever these are attached).
  const on = (socket, event, fn) => socket.on(event, (...args) => {
    const failed = (e) => { try { if (logger) logger.warn("telehealth_handler_failed", { event, error: String((e && e.message) || e).slice(0, 200) }); } catch {} };
    try { const r = fn(...args); if (r && typeof r.then === "function") r.then(null, failed); } catch (e) { failed(e); }
  });

  // One person leaves the visit (they left, were removed, or the visit ended)
  function drop(clientId, why, { tellThem = true } = {}) {
    const m = room.get(clientId); if (!m) return;
    room.delete(clientId);
    const seconds = Math.max(0, Math.round((now() - m.since) / 1000));
    if (tellThem) m.socket.emit("tele_ended", { why });
    record("telehealth.end", why === "patient_left" ? memberActor(m.clientId) : staffActor(host), m.clientId, { seconds, why }); // otherwise the host ended it, removed them or left
    if (logger) logger.info("telehealth_end", { seconds, why });
    if (host) { host.emit("tele_left", { clientId, why }); if (!room.size) host.emit("tele_ended", { why }); }
    if (!room.size) closed();
  }
  // The room has emptied, however that happened (the host ended it, the last person left or was removed, a connection
  // dropped): what belonged to that session goes with it. An invitation is for one session, so one that was never
  // taken up cannot let anyone into the next; nobody stays locked out; and the room goes back to how it starts.
  function closed() { host = null; removed.clear(); invited.clear(); group = !!live; }
  function end(why) { for (const id of [...room.keys()]) drop(id, why); host = null; removed.clear(); tellStaff(); }

  // Let one waiting person in. Returns what went wrong, or nothing. by: who the ledger names when nobody pressed Admit
  // and the person came in on an invitation (see arrive).
  function admit(clientId, socket, by = "") {
    const w = waiting.get(clientId);
    if (!w) return "That person is no longer waiting.";
    if (room.size && host !== socket) return "Another staff screen is running the visit.";
    if (room.size && !group) return "End the current visit before admitting someone else, or switch on the live room.";
    if (room.size >= MAX_ROOM) return `The room is full (${MAX_ROOM} people).`;
    waiting.delete(w.clientId);
    invited.delete(w.clientId); // an invitation is used up by coming in: leaving and knocking again means waiting like anyone else
    // One to one: both sides talk. Live room: everyone arrives as a viewer, camera and microphone off.
    const role = group ? "viewer" : "speaker";
    room.set(w.clientId, { clientId: w.clientId, name: w.name, visit: w.visit, minutes: w.minutes, device: w.device || null, since: now(), socket: w.socket, role });
    host = socket;
    w.socket.emit("tele_admitted", { role, group });
    socket.emit("tele_started", { clientId: w.clientId, name: w.name, visit: w.visit, minutes: w.minutes, role, group });
    record("telehealth.admit", by || staffActor(socket), w.clientId, by ? { role, invited: true } : { role });
    tellStaff();
    return "";
  }
  // Someone the host invited has arrived: straight in if the room can take them, otherwise they wait to be admitted.
  // by: whose doing it is. The member's own when they knock; the inviting staff member's when the person was already
  // waiting. Never the screen that happens to host the room, which did nothing.
  // They go to the screen running the room, or else the newest screen signed in to the account that invited them. That
  // is the inviting screen itself unless the account has opened one since: a screen whose network dropped comes back
  // as a new connection while the old one is still held for up to 45 s, and the person must not be put on the dead
  // one. With no screen of that account, they wait for someone to press Admit: never handed to another account.
  // from: the screen that just pressed Invite for someone already waiting. It was just heard from, so it is live and
  // it is the one the person is in front of: they come in there.
  function arrive(clientId, by, from) {
    const x = invited.get(clientId);
    const s = host || (from && staff.has(from) ? from : x && x.by && [...staff].reverse().find((t) => staffActor(t) === staffActor(x.by))) || null;
    if (x && now() - x.at <= INVITE_MS && s && (!room.size || group)) {
      const was = group;
      if (!room.size) group = true; // an invited person is a viewer first, so the room they open is a live room
      if (!admit(clientId, s, by)) return;
      group = was; // not let in after all: an empty private room stays private
    }
    tellStaff();
  }

  // Put back together a visit both sides say is still running (after a restart or a dropped connection)
  function pair() {
    for (const [id, c] of claims) if (now() - c.at > RESUME_MS) claims.delete(id);
    if (!resume || now() - resume.at > RESUME_MS || !staff.has(resume.socket)) { resume = null; return; }
    if (host && host !== resume.socket) return;
    if (!room.size) group = resume.group;
    let back = 0;
    for (const [id, role] of resume.people) {
      const c = claims.get(id);
      if (!c || room.has(id) || room.size >= MAX_ROOM || (!group && room.size >= 1)) continue;
      const info = (describe && describe(id)) || {};
      room.set(id, { clientId: id, name: String(info.name || "A member").slice(0, 100), visit: "", minutes: 0, since: now(), socket: c.socket, role: group && role === "viewer" ? "viewer" : "speaker" });
      claims.delete(id); waiting.delete(id); host = resume.socket; back++;
      c.socket.emit("tele_resumed", { role: room.get(id).role, group });
      record("telehealth.resume", staffActor(resume.socket), id); // restored on the host's word; a member's alone restores nothing
    }
    if (back) tellStaff();
  }

  function staffJoin(socket) {
    // A staff account without the Scheduling permission is connected for other things (lib/realtime.js lists what it
    // holds; the owner has no list): it never sees the waiting room and cannot run a visit.
    if (Array.isArray(socket.permissions) && !socket.permissions.includes("scheduling")) return;
    staff.add(socket);
    socket.emit("tele_waiting", snapshot());
    on(socket, "tele_list", () => socket.emit("tele_waiting", snapshot()));
    // A private visit can be opened to more people, but a person in it must never find themselves on screen in front
    // of a room: whoever is in the visit becomes a viewer first (camera and microphone off) and is told why. They are
    // seen again only if the host makes them a speaker and they agree on their own screen. A live room with people in
    // it cannot be switched back to one to one.
    on(socket, "tele_group", (d) => {
      const on = !!(d && d.on);
      if (on === group) return;
      if (!on && room.size) { socket.emit("tele_error", { error: "End the live room before switching back to one to one." }); return tellStaff(); }
      if (room.size && host !== socket) { socket.emit("tele_error", { error: "Another staff screen is running the visit." }); return tellStaff(); }
      group = on;
      if (on) for (const m of room.values()) if (m.role === "speaker") { m.role = "viewer"; m.socket.emit("tele_role", { role: "viewer", opened: true }); record("telehealth.undock", staffActor(socket), m.clientId, { opened: true }); }
      tellStaff();
    });
    on(socket, "tele_admit", (d) => {
      const err = admit(idOf(d && d.clientId), socket);
      if (err) socket.emit("tele_error", { error: err });
    });
    // Invite a member by name: they are told in the app and by email, and let in when they arrive
    on(socket, "tele_invite", async (d) => {
      const id = idOf(d && d.clientId);
      if (!id) return;
      if (room.has(id)) return socket.emit("tele_error", { error: "They are already in the room." });
      const had = invited.get(id);
      if (had && now() - had.at < REINVITE_MS) return socket.emit("tele_error", { error: "They were invited a moment ago. Give it a minute before sending another." });
      let r = null;
      try { r = invite ? await invite(id) : null; } catch (e) { if (logger) logger.warn("telehealth_invite_failed", { error: e.message }); }
      if (!r) return socket.emit("tele_error", { error: "That client could not be invited." });
      removed.delete(id); // an invitation lets back in someone who was removed earlier
      invited.set(id, { clientId: id, name: String(r.name || "A member").slice(0, 100), at: now(), by: socket });
      record("telehealth.invite", staffActor(socket), id, { emailed: !!r.emailed, pushed: !!r.pushed });
      socket.emit("tele_invited", { clientId: id, name: r.name, emailed: !!r.emailed, pushed: !!r.pushed });
      if (waiting.has(id)) arrive(id, staffActor(socket), socket); else tellStaff();
    });
    // "I am still in a visit with these people": the host's screen after its connection came back
    on(socket, "tele_resume", (d) => {
      if (host && host !== socket) return;
      const people = new Map();
      for (const x of (Array.isArray(d && d.people) ? d.people : []).slice(0, MAX_ROOM)) { const id = idOf(x && x.clientId); if (id) people.set(id, x.role === "viewer" ? "viewer" : "speaker"); }
      resume = people.size ? { socket, people, group: !!(d && d.group), at: now() } : null;
      pair(); socket.emit("tele_waiting", snapshot());
    });
    on(socket, "tele_uninvite", (d) => { if (invited.delete(idOf(d && d.clientId))) tellStaff(); });
    on(socket, "tele_decline", (d) => {
      const w = waiting.get(idOf(d && d.clientId)); if (!w) return;
      waiting.delete(w.clientId); w.socket.emit("tele_declined", {}); tellStaff();
    });
    // Into the dock (speaker) or back to the audience (viewer). The person's own screen asks before any camera turns on.
    on(socket, "tele_role", (d) => {
      const m = room.get(idOf(d && d.clientId)); if (!m || host !== socket) return;
      const role = d.role === "speaker" ? "speaker" : "viewer";
      if (m.role === role) { if (role === "viewer" && m.asking) { m.asking = false; m.socket.emit("tele_ask_declined", {}); tellStaff(); } return; }
      const asked = role === "speaker" && !!m.asking; m.asking = false;
      m.role = role; m.socket.emit("tele_role", { role, ...(asked ? { asked: true } : {}) });
      record(role === "speaker" ? "telehealth.dock" : "telehealth.undock", staffActor(socket), m.clientId, asked ? { asked: true } : {});
      tellStaff();
    });
    // Set-up messages go to one named person in the visit. (With exactly one person, the name may be left out.)
    on(socket, "tele_signal", (d) => {
      if (host !== socket || !d || !small(d)) return;
      const { to, ...rest } = d;
      const m = to !== undefined ? room.get(idOf(to)) : (room.size === 1 ? [...room.values()][0] : null);
      if (m) m.socket.emit("tele_signal", rest);
    });
    // End the whole visit, or remove one person from it
    on(socket, "tele_end", (d) => {
      if (host !== socket) return;
      if (d && d.clientId !== undefined) { const id = idOf(d.clientId); if (room.has(id)) { removed.add(id); invited.delete(id); drop(id, "removed"); if (!room.size) removed.clear(); tellStaff(); } } else end("ended");
    });
    on(socket, "disconnect", () => { staff.delete(socket); if (resume && resume.socket === socket) resume = null; if (host === socket) end("staff_left"); });
  }

  function patientJoin(socket) {
    const id = String(socket.clientId || "");
    if (!id) return;
    const mine = () => { const m = room.get(id); return m && m.socket === socket ? m : null; };
    on(socket, "tele_knock", () => {
      if (room.has(id)) return; // already in the visit (a second tab)
      if (removed.has(id)) return socket.emit("tele_declined", { removed: true }); // removed by the host from the room in progress
      const old = waiting.get(id);
      // Knocking again from the same page while already waiting changes nothing: it is answered without reading the
      // member's records again (a page that knocks over and over cannot make the server re-read them each time)
      if (old && old.socket === socket) return socket.emit("tele_waiting_room", { staffOnline: staff.size > 0 });
      const info = (describe && describe(id)) || {};
      if (old && old.socket !== socket) old.socket.emit("tele_moved", {});
      waiting.set(id, { clientId: id, name: String(info.name || socket.clientName || "A member").slice(0, 100), visit: String(info.visit || "").slice(0, 120), minutes: Math.max(0, Math.min(600, Number(info.minutes) || 0)), device: info.device || null, since: old ? old.since : now(), socket });
      socket.emit("tele_waiting_room", { staffOnline: staff.size > 0 });
      arrive(id, memberActor(id));
    });
    const leaveWaiting = () => { const w = waiting.get(id); if (w && w.socket === socket) { waiting.delete(id); tellStaff(); } };
    const leaveVisit = () => { if (mine()) { drop(id, "patient_left", { tellThem: false }); tellStaff(); } };
    on(socket, "tele_leave", () => { leaveWaiting(); leaveVisit(); if (claims.get(id) && claims.get(id).socket === socket) claims.delete(id); });
    // "I am still in a visit": the member's page after its connection came back. Counts only if the host says so too.
    on(socket, "tele_here", () => {
      const m = room.get(id);
      if (m) { if (m.socket === socket) socket.emit("tele_resumed", { role: m.role, group }); return; }
      if (removed.has(id)) return socket.emit("tele_ended", { why: "removed" });
      claims.set(id, { socket, at: now() }); pair();
    });
    // A viewer asks to speak (or takes the request back). Only the host is told; nothing turns on until he admits them.
    on(socket, "tele_ask", (d) => {
      const m = mine(); if (!m || !group || m.role !== "viewer") return;
      const off = !!(d && d.off);
      if (off) { if (!m.asking) return; m.asking = false; return tellStaff(); }
      if (m.asking || (m.askedAt && now() - m.askedAt < 5000)) return;
      m.asking = true; m.askedAt = now();
      record("telehealth.ask", memberActor(m.clientId), m.clientId);
      if (host) host.emit("tele_asked", { clientId: m.clientId, name: m.name });
      tellStaff();
    });
    // A person's set-up messages go to the host only, marked with who they are. Never to another member.
    on(socket, "tele_signal", (d) => { const m = mine(); if (m && host && d && small(d)) host.emit("tele_signal", { ...d, from: id }); });
    on(socket, "disconnect", () => { leaveWaiting(); leaveVisit(); if (claims.get(id) && claims.get(id).socket === socket) claims.delete(id); });
  }

  return { staffJoin, patientJoin, snapshot, end, isInvited: (id) => { const x = invited.get(String(id)); return !!x && now() - x.at <= INVITE_MS && !room.has(String(id)); } };
}

module.exports = { createTelehealth, iceServers, MAX_ROOM };
