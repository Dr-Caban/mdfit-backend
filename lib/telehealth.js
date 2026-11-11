// Built-in video visits (Workspace → Telehealth, and the patient page /visit). Owner, Nov 2026.
//
// How it works: the patient opens /visit, signed in, and "knocks". Dr. Jared sees them in the waiting room and admits
// them. From then on the two browsers talk to each other directly: sound and picture travel browser to browser,
// encrypted by the browsers themselves (WebRTC, DTLS-SRTP). This server only carries the short set-up messages
// between the two (over the same signed-in live connection the app already uses) and never sees, relays or records
// any sound or picture. Nothing about a call is stored except two lines in the audit ledger: admitted, and ended
// with its length.
//
// One visit at a time: this is a single-clinician practice. A patient can only knock as themselves (their sign-in
// decides who they are), and only the patient Dr. Jared admitted can exchange set-up messages with him.
//
// Finding a path between two browsers needs a public "STUN" address (it sees network addresses only, never the
// call). Some networks block direct paths; those calls need a relay ("TURN") that the owner can add with
// TURN_URL, TURN_USERNAME and TURN_CREDENTIAL. Without one, a call on such a network fails to connect and says so.
"use strict";

const MAX_SIGNAL = 24000; // one set-up message; a session description is a few KB

function iceServers(cfg = {}) {
  const t = cfg.telehealth || {};
  const stun = String(t.stun === undefined ? "stun:stun.cloudflare.com:3478" : t.stun).split(/[\s,]+/).filter((u) => /^stuns?:/.test(u));
  const out = stun.length ? [{ urls: stun }] : [];
  if (/^turns?:/.test(String(t.turnUrl || "")) && t.turnUser && t.turnCred) out.push({ urls: String(t.turnUrl).split(/[\s,]+/).filter(Boolean), username: t.turnUser, credential: t.turnCred });
  return out;
}

// describe(clientId) -> { name, visit } for the waiting-room row; audit is the ledger (optional)
function createTelehealth({ describe, audit, logger, now = () => Date.now() } = {}) {
  const staff = new Set();          // signed-in staff connections
  const waiting = new Map();        // clientId -> { clientId, name, visit, since, socket }
  let call = null;                  // { clientId, name, since, patient, staff }

  const rows = () => [...waiting.values()].map(({ socket, ...w }) => w).sort((a, b) => a.since - b.since);
  const snapshot = () => ({ waiting: rows(), inCall: call ? { clientId: call.clientId, name: call.name, since: call.since } : null });
  const tellStaff = () => { const s = snapshot(); staff.forEach((x) => x.emit("tele_waiting", s)); };
  const small = (d) => { try { return JSON.stringify(d).length <= MAX_SIGNAL; } catch { return false; } };
  const record = (action, clientId, meta = {}) => { try { if (audit) audit.record({ actor: "admin", action, subject: clientId, ip: "", meta }); } catch {} };

  function end(why) {
    if (!call) return;
    const c = call; call = null;
    const seconds = Math.max(0, Math.round((now() - c.since) / 1000));
    c.patient.emit("tele_ended", { why }); c.staff.emit("tele_ended", { why });
    record("telehealth.end", c.clientId, { seconds, why });
    if (logger) logger.info("telehealth_end", { seconds, why });
    tellStaff();
  }

  function staffJoin(socket) {
    staff.add(socket);
    socket.emit("tele_waiting", snapshot());
    socket.on("tele_list", () => socket.emit("tele_waiting", snapshot()));
    socket.on("tele_admit", (d) => {
      const w = waiting.get(String((d && d.clientId) || ""));
      if (!w) return socket.emit("tele_error", { error: "That person is no longer waiting." });
      if (call) return socket.emit("tele_error", { error: "End the current visit before admitting someone else." });
      waiting.delete(w.clientId);
      call = { clientId: w.clientId, name: w.name, since: now(), patient: w.socket, staff: socket };
      w.socket.emit("tele_admitted", {});
      socket.emit("tele_started", { clientId: w.clientId, name: w.name, visit: w.visit });
      record("telehealth.admit", w.clientId);
      tellStaff();
    });
    socket.on("tele_decline", (d) => {
      const w = waiting.get(String((d && d.clientId) || "")); if (!w) return;
      waiting.delete(w.clientId); w.socket.emit("tele_declined", {}); tellStaff();
    });
    socket.on("tele_signal", (d) => { if (call && call.staff === socket && small(d)) call.patient.emit("tele_signal", d); });
    socket.on("tele_end", () => { if (call && call.staff === socket) end("ended"); });
    socket.on("disconnect", () => { staff.delete(socket); if (call && call.staff === socket) end("staff_left"); });
  }

  function patientJoin(socket) {
    const id = String(socket.clientId || "");
    if (!id) return;
    socket.on("tele_knock", () => {
      if (call && call.clientId === id) return; // already in the visit (a second tab)
      const info = (describe && describe(id)) || {};
      const old = waiting.get(id);
      if (old && old.socket !== socket) old.socket.emit("tele_moved", {});
      waiting.set(id, { clientId: id, name: String(info.name || socket.clientName || "A member").slice(0, 100), visit: String(info.visit || "").slice(0, 120), since: old ? old.since : now(), socket });
      socket.emit("tele_waiting_room", { staffOnline: staff.size > 0 });
      tellStaff();
    });
    const leave = () => { const w = waiting.get(id); if (w && w.socket === socket) { waiting.delete(id); tellStaff(); } };
    socket.on("tele_leave", () => { leave(); if (call && call.patient === socket) end("patient_left"); });
    socket.on("tele_signal", (d) => { if (call && call.patient === socket && small(d)) call.staff.emit("tele_signal", d); });
    socket.on("disconnect", () => { leave(); if (call && call.patient === socket) end("patient_left"); });
  }

  return { staffJoin, patientJoin, snapshot, end };
}

module.exports = { createTelehealth, iceServers };
