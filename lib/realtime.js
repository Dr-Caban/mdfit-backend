"use strict";
const { Server } = require("socket.io");
const { verifyToken } = require("./auth");

function createRealtime(httpServer, cfg) {
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

  adminNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      const decoded = verifyToken(token, cfg.sessionSecret);
      if (!decoded?.admin) return next(new Error("Not admin"));
      socket.admin = true;
      next();
    } catch { next(new Error("Invalid token")); }
  });

  memberNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      const decoded = verifyToken(token, cfg.sessionSecret);
      if (!decoded?.id) return next(new Error("Not a member"));
      socket.clientId = decoded.id;
      socket.clientName = decoded.name || "";
      next();
    } catch { next(new Error("Invalid token")); }
  });

  // Track online users
  const onlineMembers = new Map();
  const onlinePages = new Map();

  adminNs.on("connection", (socket) => {
    socket.join("admin");
    socket.emit("online_count", { members: onlineMembers.size, pages: onlinePages.size });
    socket.on("disconnect", () => {});
  });

  memberNs.on("connection", (socket) => {
    socket.join(`client:${socket.clientId}`);
    onlineMembers.set(socket.id, { id: socket.clientId, name: socket.clientName, since: Date.now() });
    broadcastOnline();

    socket.on("viewing", (page) => {
      const m = onlineMembers.get(socket.id);
      if (m) m.page = String(page || "").slice(0, 60);
    });

    socket.on("disconnect", () => {
      onlineMembers.delete(socket.id);
      broadcastOnline();
    });
  });

  publicNs.on("connection", (socket) => {
    onlinePages.set(socket.id, { since: Date.now() });
    broadcastOnline();
    socket.on("disconnect", () => {
      onlinePages.delete(socket.id);
      broadcastOnline();
    });
  });

  function broadcastOnline() {
    adminNs.to("admin").emit("online_count", { members: onlineMembers.size, pages: onlinePages.size });
  }

  function emitActivity(type, detail = {}) {
    const safe = sanitize(detail);
    adminNs.to("admin").emit("activity", { type, time: new Date().toISOString(), ...safe });
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
      adminNs.to("admin").emit("toast", { text: toasts[type], type });
    }
  }

  function emitToAdmin(event, data) {
    adminNs.to("admin").emit(event, data);
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

  return { io, adminNs, memberNs, publicNs, emitActivity, emitToAdmin, emitToClient, emitBookingUpdate, onlineStats };
}

module.exports = { createRealtime };
