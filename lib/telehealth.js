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
// about their care), show as "pending" on the host's screen, and are let in on arrival without knocking: straight in
// when the room is free or the live room is open, otherwise they wait like anyone else. An invitation lasts two hours.
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
function createTelehealth({ describe, invite, audit, logger, live = false, now = () => Date.now() } = {}) {
  const staff = new Set();          // signed-in staff connections
  const waiting = new Map();        // clientId -> { clientId, name, visit, minutes, since, socket }
  const room = new Map();           // clientId -> { clientId, name, visit, minutes, since, socket, role }
  let host = null;                  // the staff connection running the visit
  let group = !!live;               // live-room mode: more than one person may be admitted, as viewers
  const removed = new Set();        // people the host removed: they cannot knock again until this room has ended
  const invited = new Map();        // clientId -> { clientId, name, at }: asked to join, let in on arrival
  const claims = new Map();         // clientId -> { socket, at }: a member who says they are still in a visit
  let resume = null;                // { socket, people: Map(clientId -> role), group, at }: the host's side of the same

  const rows = () => [...waiting.values()].map(({ socket, ...w }) => w).sort((a, b) => a.since - b.since);
  const people = () => [...room.values()].map(({ socket, visit, minutes, ...m }) => m).sort((a, b) => a.since - b.since);
  const pending = () => { for (const [id, x] of invited) if (now() - x.at > INVITE_MS) invited.delete(id); return [...invited.values()].filter((x) => !waiting.has(x.clientId) && !room.has(x.clientId)).sort((a, b) => a.at - b.at); };
  const snapshot = () => { const first = people()[0]; return { waiting: rows(), inCall: first ? { clientId: first.clientId, name: first.name, since: first.since } : null, group, room: people(), invited: pending() }; };
  const tellStaff = () => { const s = snapshot(); staff.forEach((x) => x.emit("tele_waiting", s)); };
  const small = (d) => { try { return JSON.stringify(d).length <= MAX_SIGNAL; } catch { return false; } };
  const record = (action, clientId, meta = {}) => { try { if (audit) audit.record({ actor: "admin", action, subject: clientId, ip: "", meta }); } catch {} };

  // One person leaves the visit (they left, were removed, or the visit ended)
  function drop(clientId, why, { tellThem = true } = {}) {
    const m = room.get(clientId); if (!m) return;
    room.delete(clientId);
    const seconds = Math.max(0, Math.round((now() - m.since) / 1000));
    if (tellThem) m.socket.emit("tele_ended", { why });
    record("telehealth.end", m.clientId, { seconds, why });
    if (logger) logger.info("telehealth_end", { seconds, why });
    if (host) { host.emit("tele_left", { clientId, why }); if (!room.size) host.emit("tele_ended", { why }); }
    if (!room.size) host = null;
  }
  function end(why) { for (const id of [...room.keys()]) drop(id, why); host = null; removed.clear(); tellStaff(); }

  // Let one waiting person in. Returns what went wrong, or nothing.
  function admit(clientId, socket) {
    const w = waiting.get(clientId);
    if (!w) return "That person is no longer waiting.";
    if (room.size && host !== socket) return "Another staff screen is running the visit.";
    if (room.size && !group) return "End the current visit before admitting someone else, or switch on the live room.";
    if (room.size >= MAX_ROOM) return `The room is full (${MAX_ROOM} people).`;
    waiting.delete(w.clientId);
    // One to one: both sides talk. Live room: everyone arrives as a viewer, camera and microphone off.
    const role = group ? "viewer" : "speaker";
    room.set(w.clientId, { clientId: w.clientId, name: w.name, visit: w.visit, minutes: w.minutes, since: now(), socket: w.socket, role });
    host = socket;
    w.socket.emit("tele_admitted", { role, group });
    socket.emit("tele_started", { clientId: w.clientId, name: w.name, visit: w.visit, minutes: w.minutes, role, group });
    record("telehealth.admit", w.clientId, { role });
    tellStaff();
    return "";
  }
  // Someone the host invited has arrived: straight in if the room can take them, otherwise they wait to be admitted
  function arrive(clientId) {
    const x = invited.get(clientId), s = host || [...staff][0];
    if (x && now() - x.at <= INVITE_MS && s && (!room.size || group) && !admit(clientId, s)) return;
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
      record("telehealth.resume", id);
    }
    if (back) tellStaff();
  }

  function staffJoin(socket) {
    staff.add(socket);
    socket.emit("tele_waiting", snapshot());
    socket.on("tele_list", () => socket.emit("tele_waiting", snapshot()));
    // A private visit can be opened to more people, but a person in it must never find themselves on screen in front
    // of a room: whoever is in the visit becomes a viewer first (camera and microphone off) and is told why. They are
    // seen again only if the host makes them a speaker and they agree on their own screen. A live room with people in
    // it cannot be switched back to one to one.
    socket.on("tele_group", (d) => {
      const on = !!(d && d.on);
      if (on === group) return;
      if (!on && room.size) { socket.emit("tele_error", { error: "End the live room before switching back to one to one." }); return tellStaff(); }
      if (room.size && host !== socket) { socket.emit("tele_error", { error: "Another staff screen is running the visit." }); return tellStaff(); }
      group = on;
      if (on) for (const m of room.values()) if (m.role === "speaker") { m.role = "viewer"; m.socket.emit("tele_role", { role: "viewer", opened: true }); record("telehealth.undock", m.clientId, { opened: true }); }
      tellStaff();
    });
    socket.on("tele_admit", (d) => {
      const err = admit(String((d && d.clientId) || ""), socket);
      if (err) socket.emit("tele_error", { error: err });
    });
    // Invite a member by name: they are told in the app and by email, and let in when they arrive
    socket.on("tele_invite", async (d) => {
      const id = String((d && d.clientId) || "");
      if (!id) return;
      if (room.has(id)) return socket.emit("tele_error", { error: "They are already in the room." });
      const had = invited.get(id);
      if (had && now() - had.at < REINVITE_MS) return socket.emit("tele_error", { error: "They were invited a moment ago. Give it a minute before sending another." });
      let r = null;
      try { r = invite ? await invite(id) : null; } catch (e) { if (logger) logger.warn("telehealth_invite_failed", { error: e.message }); }
      if (!r) return socket.emit("tele_error", { error: "That client could not be invited." });
      removed.delete(id); // an invitation lets back in someone who was removed earlier
      invited.set(id, { clientId: id, name: String(r.name || "A member").slice(0, 100), at: now() });
      record("telehealth.invite", id, { emailed: !!r.emailed, pushed: !!r.pushed });
      socket.emit("tele_invited", { clientId: id, name: r.name, emailed: !!r.emailed, pushed: !!r.pushed });
      if (waiting.has(id)) arrive(id); else tellStaff();
    });
    // "I am still in a visit with these people": the host's screen after its connection came back
    socket.on("tele_resume", (d) => {
      if (host && host !== socket) return;
      const people = new Map();
      for (const x of (Array.isArray(d && d.people) ? d.people : []).slice(0, MAX_ROOM)) { const id = String((x && x.clientId) || ""); if (id) people.set(id, x.role === "viewer" ? "viewer" : "speaker"); }
      resume = people.size ? { socket, people, group: !!(d && d.group), at: now() } : null;
      pair(); socket.emit("tele_waiting", snapshot());
    });
    socket.on("tele_uninvite", (d) => { if (invited.delete(String((d && d.clientId) || ""))) tellStaff(); });
    socket.on("tele_decline", (d) => {
      const w = waiting.get(String((d && d.clientId) || "")); if (!w) return;
      waiting.delete(w.clientId); w.socket.emit("tele_declined", {}); tellStaff();
    });
    // Into the dock (speaker) or back to the audience (viewer). The person's own screen asks before any camera turns on.
    socket.on("tele_role", (d) => {
      const m = room.get(String((d && d.clientId) || "")); if (!m || host !== socket) return;
      const role = d.role === "speaker" ? "speaker" : "viewer";
      if (m.role === role) return;
      m.role = role; m.socket.emit("tele_role", { role });
      record(role === "speaker" ? "telehealth.dock" : "telehealth.undock", m.clientId);
      tellStaff();
    });
    // Set-up messages go to one named person in the visit. (With exactly one person, the name may be left out.)
    socket.on("tele_signal", (d) => {
      if (host !== socket || !d || !small(d)) return;
      const { to, ...rest } = d;
      const m = to !== undefined ? room.get(String(to)) : (room.size === 1 ? [...room.values()][0] : null);
      if (m) m.socket.emit("tele_signal", rest);
    });
    // End the whole visit, or remove one person from it
    socket.on("tele_end", (d) => {
      if (host !== socket) return;
      if (d && d.clientId !== undefined) { const id = String(d.clientId); if (room.has(id)) { removed.add(id); invited.delete(id); drop(id, "removed"); if (!room.size) removed.clear(); tellStaff(); } } else end("ended");
    });
    socket.on("disconnect", () => { staff.delete(socket); if (resume && resume.socket === socket) resume = null; if (host === socket) end("staff_left"); });
  }

  function patientJoin(socket) {
    const id = String(socket.clientId || "");
    if (!id) return;
    const mine = () => { const m = room.get(id); return m && m.socket === socket ? m : null; };
    socket.on("tele_knock", () => {
      if (room.has(id)) return; // already in the visit (a second tab)
      if (removed.has(id)) return socket.emit("tele_declined", { removed: true }); // removed by the host from the room in progress
      const info = (describe && describe(id)) || {};
      const old = waiting.get(id);
      if (old && old.socket !== socket) old.socket.emit("tele_moved", {});
      waiting.set(id, { clientId: id, name: String(info.name || socket.clientName || "A member").slice(0, 100), visit: String(info.visit || "").slice(0, 120), minutes: Math.max(0, Math.min(600, Number(info.minutes) || 0)), since: old ? old.since : now(), socket });
      socket.emit("tele_waiting_room", { staffOnline: staff.size > 0 });
      arrive(id);
    });
    const leaveWaiting = () => { const w = waiting.get(id); if (w && w.socket === socket) { waiting.delete(id); tellStaff(); } };
    const leaveVisit = () => { if (mine()) { drop(id, "patient_left", { tellThem: false }); tellStaff(); } };
    socket.on("tele_leave", () => { leaveWaiting(); leaveVisit(); if (claims.get(id) && claims.get(id).socket === socket) claims.delete(id); });
    // "I am still in a visit": the member's page after its connection came back. Counts only if the host says so too.
    socket.on("tele_here", () => {
      const m = room.get(id);
      if (m) { if (m.socket === socket) socket.emit("tele_resumed", { role: m.role, group }); return; }
      if (removed.has(id)) return socket.emit("tele_ended", { why: "removed" });
      claims.set(id, { socket, at: now() }); pair();
    });
    // A person's set-up messages go to the host only, marked with who they are. Never to another member.
    socket.on("tele_signal", (d) => { const m = mine(); if (m && host && d && small(d)) host.emit("tele_signal", { ...d, from: id }); });
    socket.on("disconnect", () => { leaveWaiting(); leaveVisit(); if (claims.get(id) && claims.get(id).socket === socket) claims.delete(id); });
  }

  return { staffJoin, patientJoin, snapshot, end, isInvited: (id) => { const x = invited.get(String(id)); return !!x && now() - x.at <= INVITE_MS && !room.has(String(id)); } };
}

module.exports = { createTelehealth, iceServers, MAX_ROOM };
