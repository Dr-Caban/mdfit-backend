"use strict";
const { Server } = require("socket.io");
const { verifyToken } = require("./auth");
const { createStore } = require("./store");

// What a staff account must hold to be sent each live event (the keys of lib/staff.js). The owner gets everything.
// Anything not listed here goes to the owner only, so a new event never reaches staff by accident.
const EVENT_NEEDS = { new_message: "messages", message_reaction: "messages", calendar_changed: "scheduling", online_count: "insights" };
const ACTIVITY_NEEDS = {
  appointment: "scheduling", appointment_cancelled: "scheduling", booking: "scheduling", booking_cancelled: "scheduling",
  visit_scheduled: "scheduling", visit_self_scheduled: "scheduling", telehealth_invite: "scheduling", class_created: "scheduling", class_deleted: "scheduling",
  lead: "clients", client_signup: "clients", message: "messages", feedback: "reviews", bug_report: "reviews", suggestion: "reviews"
};
const RECHECK_MS = 30 * 1000; // how often connections already open are checked against the store again
// How many messages one member or visitor connection may send in RATE_MS before the rest are dropped. A member's video
// visit sends a few dozen set-up messages when it starts; nothing a real page does comes near this. Staff connections
// are not limited: a host's screen sets up a call with every person in a live room at once.
const RATE_MS = 10 * 1000, RATE_MAX = { "/member": 100, "/public": 20 };

// Nothing a browser sends over the live connection is trusted to be well formed. Every handler on a connection runs
// inside a catch, so one that throws (or an async one whose promise is rejected) is logged and dropped: a bad message
// can never stop the server, and with it every patient's and staff member's session. Member and visitor connections
// also have a ceiling on how much they may send (RATE_MAX).
function guard(socket, ns, logger) {
  const warn = (what, detail) => { try { if (logger) logger.warn(what, { ns, ...detail }); } catch {} };
  const on = socket.on.bind(socket);
  socket.on = (event, fn) => on(event, typeof fn !== "function" ? fn : function (...args) {
    const failed = (e) => warn("socket_handler_failed", { event: String(event).slice(0, 40), error: String((e && e.message) || e).slice(0, 200) });
    try { const r = fn.apply(this, args); if (r && typeof r.then === "function") r.then(null, failed); return r; } catch (e) { failed(e); }
  });
  const max = RATE_MAX[ns];
  if (max && typeof socket.use === "function") {
    let from = 0, n = 0, told = false;
    socket.use((packet, next) => {
      const t = Date.now();
      if (t - from > RATE_MS) { from = t; n = 0; told = false; }
      if (++n <= max) return next();
      if (!told) { told = true; warn("socket_rate_limited", { max }); } // once a window: the dropped messages themselves are not logged
    });
  }
  return socket;
}

// findStaff(email) -> the staff record, or null. Without one, records are read from the store on disk (cfg.dataDir).
function createRealtime(httpServer, cfg, { findClient, findStaff, logger } = {}) {
  const io = new Server(httpServer, {
    cors: {
      origin: cfg.origins.includes("*") ? "*" : cfg.origins,
      methods: ["GET", "POST"],
      credentials: true
    },
    path: "/ws",
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 20000
  });

  const adminNs = io.of("/admin");
  const memberNs = io.of("/member");
  const publicNs = io.of("/public");

  // A staff member's record is read from the store each time, never taken from the token (as requireAdmin does)
  let staffStore = null;
  const staffRec = findStaff || ((email) => {
    try {
      if (!cfg.dataDir) return null;
      staffStore = staffStore || createStore(cfg.dataDir, { key: cfg.dataKey });
      const list = staffStore.read("staff", []);
      return (Array.isArray(list) ? list : []).find((s) => s && s.email === email) || null;
    } catch { return null; }
  });
  // An active staff account's permissions; otherwise null
  const staffPerms = (email) => { const rec = staffRec(email); return rec && rec.active === true ? [...(rec.permissions || [])].sort() : null; };

  adminNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      // The same rules as the REST admin guard (requireAdmin in server.js). The owner's token is { sub: adminEmail, exp }
      // and carries no role (a member or board token can never be the owner's); a staff token is { sub: email, role:
      // "staff", exp } and counts only while that account is active.
      const decoded = verifyToken(token, cfg.sessionSecret);
      const email = decoded ? String(decoded.sub || "").trim().toLowerCase() : "";
      if (!email || !cfg.adminEmail) return next(new Error("Not admin"));
      if (email === cfg.adminEmail) {
        if (decoded.role) return next(new Error("Not admin"));
        socket.permissions = null; // the owner: everything
      } else {
        const perms = decoded.role === "staff" ? staffPerms(email) : null;
        if (!perms) return next(new Error("Not admin"));
        socket.staffEmail = email; socket.permissions = perms;
      }
      socket.admin = true; socket.tokenExp = decoded.exp;
      next();
    } catch { next(new Error("Invalid token")); }
  });

  memberNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      // Client tokens are { sub: clientId, role: "client", pwv, exp }; a password change (pwv bump) signs old tokens out
      const decoded = verifyToken(token, cfg.sessionSecret);
      if (!decoded || decoded.role !== "client" || !decoded.sub) return next(new Error("Not a member"));
      const c = findClient ? findClient(decoded.sub) : null;
      if (findClient && (!c || (c.pwv || 0) !== (decoded.pwv || 0))) return next(new Error("Please log in again"));
      socket.clientId = decoded.sub; socket.pwv = decoded.pwv || 0; socket.tokenExp = decoded.exp;
      socket.clientName = (c && c.name) || "";
      next();
    } catch { next(new Error("Invalid token")); }
  });

  // After the sign-in checks above, so a connection they turn away costs nothing more
  for (const ns of [adminNs, memberNs, publicNs]) ns.use((socket, next) => { guard(socket, ns.name, logger); next(); });

  // Track online users
  const onlineMembers = new Map();
  const onlinePages = new Map();

  // "Are you there?" Any page may ask and gets an answer straight back; a page that hears nothing knows its
  // connection is dead even though it still looks open, and reconnects.
  const tag = (socket) => socket.on("rt_ping", (reply) => { if (typeof reply === "function") reply({ at: Date.now() }); });

  // The owner is in "admin" and hears everything. A staff member is only in a room for each permission they hold.
  const can = (socket, need) => !socket.permissions || socket.permissions.includes(need);
  const admins = (need) => adminNs.to(need ? ["admin", `perm:${need}`] : "admin");

  adminNs.on("connection", (socket) => {
    tag(socket);
    if (socket.permissions) socket.permissions.forEach((p) => socket.join(`perm:${p}`)); else socket.join("admin");
    if (can(socket, EVENT_NEEDS.online_count)) socket.emit("online_count", { members: onlineMembers.size, pages: onlinePages.size });
    socket.on("disconnect", () => {});
  });

  memberNs.on("connection", (socket) => {
    tag(socket);
    socket.join(`client:${socket.clientId}`);
    onlineMembers.set(socket.id, { id: socket.clientId, name: socket.clientName, since: Date.now() });
    broadcastOnline();

    socket.on("viewing", (page) => {
      const m = onlineMembers.get(socket.id);
      if (m && typeof page === "string") m.page = page.slice(0, 60); // a page name, nothing else
    });

    socket.on("disconnect", () => {
      onlineMembers.delete(socket.id);
      broadcastOnline();
    });
  });

  publicNs.on("connection", (socket) => {
    tag(socket);
    onlinePages.set(socket.id, { since: Date.now() });
    broadcastOnline();
    socket.on("disconnect", () => {
      onlinePages.delete(socket.id);
      broadcastOnline();
    });
  });

  function broadcastOnline() {
    admins(EVENT_NEEDS.online_count).emit("online_count", { members: onlineMembers.size, pages: onlinePages.size });
  }

  // A sign-in is checked when the connection opens, but a connection can stay open for days. So every one is checked
  // again on a timer and closed when it would no longer be let in: a member whose password changed (pwv), whose
  // account is gone, or whose token ran out; a staff member who was switched off or whose permissions changed (they
  // reconnect with the new ones); an owner token that ran out. Closing it also takes them out of a video visit.
  function recheck(now = Date.now()) {
    let closed = 0;
    const out = (socket) => { closed++; try { socket.emit("signed_out", {}); } catch {} socket.disconnect(true); };
    const seen = new Map(); // one store read per member, however many tabs they have open
    for (const socket of [...memberNs.sockets.values()]) {
      if (!(socket.tokenExp > now)) { out(socket); continue; }
      if (!findClient) continue;
      if (!seen.has(socket.clientId)) seen.set(socket.clientId, findClient(socket.clientId));
      const c = seen.get(socket.clientId);
      if (!c || (c.pwv || 0) !== (socket.pwv || 0)) out(socket);
    }
    for (const socket of [...adminNs.sockets.values()]) {
      if (!(socket.tokenExp > now)) { out(socket); continue; }
      if (!socket.staffEmail) continue;
      const perms = staffPerms(socket.staffEmail);
      if (!perms || perms.join() !== (socket.permissions || []).join()) out(socket);
    }
    return closed;
  }
  const recheckMs = cfg.rtRecheckMs === undefined ? RECHECK_MS : Number(cfg.rtRecheckMs);
  if (recheckMs > 0) setInterval(() => { try { recheck(); } catch {} }, recheckMs).unref();

  function emitActivity(type, detail = {}) {
    const safe = sanitize(detail);
    admins(ACTIVITY_NEEDS[type]).emit("activity", { time: new Date().toISOString(), ...safe, type });
    // Send toast-worthy events
    const toasts = {
      appointment: `New booking from ${safe.email || "a client"}`,
      appointment_cancelled: `Appointment cancelled by ${safe.email || "a client"}`,
      lead: `New evaluation request from ${safe.email || "a lead"}`,
      booking: `New class booking from ${safe.email || "a client"}`,
      message: `New message from ${safe.email || "a member"}`,
      subscribe: `New subscriber: ${safe.email || ""}`,
      bug_report: "New bug report submitted",
      suggestion: "New suggestion submitted",
      feedback: `New review from ${safe.email || "a client"}`,
      login: null,
      settings: null
    };
    if (toasts[type] !== undefined && toasts[type] !== null) {
      admins(ACTIVITY_NEEDS[type]).emit("toast", { text: toasts[type], type });
    }
  }

  function emitToAdmin(event, data) {
    admins(EVENT_NEEDS[event]).emit(event, data);
  }

  function emitToClient(clientId, event, data) {
    memberNs.to(`client:${clientId}`).emit(event, data);
  }

  function emitBookingUpdate(date) {
    publicNs.emit("slots_changed", { date });
    memberNs.emit("slots_changed", { date });
  }

  function onlineStats() {
    return {
      members: [...onlineMembers.values()].map((m) => ({ name: m.name, page: m.page })),
      memberCount: onlineMembers.size,
      visitorCount: onlinePages.size
    };
  }

  function sanitize(obj) {
    const out = { ...obj };
    delete out.password;
    delete out.token;
    delete out.cancelToken;
    return out;
  }

  return { io, adminNs, memberNs, publicNs, emitActivity, emitToAdmin, emitToClient, emitBookingUpdate, onlineStats, recheck };
}

module.exports = { createRealtime, guard, RATE_MAX, RATE_MS };
