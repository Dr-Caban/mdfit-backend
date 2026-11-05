// Member messaging: one private thread per member with Dr. Jared.
// Modeled on the digitalapple-backend Threads system: poll-based delivery, read tracking with unread badges,
// server-side permission checks, and AES-256-GCM encryption of message bodies at rest (unreadable in data backups).
// Email notifications say "new message" only, never the content, so health details stay out of inboxes.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const PREFIX = "v1:";
// secrets: [current, ...older]. New messages use the first; older keys still decrypt (key rotation / separation).
function cipher(secrets) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean).map((x) => crypto.scryptSync(String(x), "mdfit-msg-v1", 32));
  if (!keys.length) keys.push(crypto.scryptSync("mdfit-dev-fallback-key", "mdfit-msg-v1", 32));
  const KEY = keys[0];
  return {
    enc(plain) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
      const out = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
    },
    dec(stored) {
      if (typeof stored !== "string" || !stored.startsWith(PREFIX)) return stored || "";
      const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
      for (const K of keys) {
        try {
          const d = crypto.createDecipheriv("aes-256-gcm", K, raw.subarray(0, 12));
          d.setAuthTag(raw.subarray(12, 28));
          return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
        } catch {}
      }
      return "";
    }
  };
}

// KEEP is the total stored across all threads; broadcasts add one per recipient, so it is set high enough that they
// never push older private conversations out.
const MAX_LEN = 2000, KEEP = 100000;
const REACTIONS = ["👍", "❤️", "😂", "🙏", "💪", "😮"];
const fail = (msg) => { throw new ValidationError(msg); };
const bodyOf = (b) => {
  const s = typeof (b && b.body) === "string" ? b.body.trim() : "";
  if (!s) fail("Type a message first.");
  if (s.length > MAX_LEN) fail(`Messages can be up to ${MAX_LEN} characters.`);
  return s;
};

function mountMessages({ app, admin, store, me, clients, today, notify, cfg, limiter, activity }) {
  const C = cipher([process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const all = () => store.read("messages", []);
  const write = (list) => store.write("messages", list.slice(-KEEP));
  const id = () => crypto.randomBytes(6).toString("hex");
  const active = () => true;
  const view = (m) => ({ id: m.id, from: m.from, body: C.dec(m.body), at: m.at, read: !!m.readAt, reactions: m.reactions || {} });
  const react = (clientId, msgId, side, emoji) => {
    if (emoji !== null && !REACTIONS.includes(emoji)) fail("Unsupported reaction.");
    const list = all(), m = list.find((x) => x.id === msgId && x.clientId === clientId);
    if (!m) return null;
    const r = { ...(m.reactions || {}) };
    if (emoji === null || r[side] === emoji) delete r[side]; else r[side] = emoji;
    m.reactions = r; write(list);
    const rt = app.get("rt");
    if (rt) { rt.emitToAdmin("message_reaction", { clientId, id: m.id }); rt.emitToClient(clientId, "message_reaction", { id: m.id }); }
    return view(m);
  };
  const emojiOf = (b) => (b && typeof b.emoji === "string" ? b.emoji : null);
  const sendLimit = limiter(40, 60 * 60 * 1000);

  // ---- Member side
  me.get("/messages", (req, res) => {
    const mine = all().filter((m) => m.clientId === req.client.id);
    res.json({ member: !!active(req.client), messages: mine.map(view), unread: mine.filter((m) => m.from === "doctor" && !m.readAt).length });
  });
  me.get("/messages/unread-count", (req, res) => {
    res.json({ unread: all().filter((m) => m.clientId === req.client.id && m.from === "doctor" && !m.readAt).length });
  });
  me.post("/messages/read", (req, res) => {
    const list = all(); let n = 0;
    list.forEach((m) => { if (m.clientId === req.client.id && m.from === "doctor" && !m.readAt) { m.readAt = new Date().toISOString(); n++; } });
    if (n) write(list);
    res.json({ ok: true, marked: n });
  });
  me.post("/messages/:id/react", (req, res) => {
    const v = react(req.client.id, req.params.id, "client", emojiOf(req.body));
    if (!v) return res.status(404).json({ error: "Message not found." });
    res.json(v);
  });
  me.post("/messages", sendLimit.mw, (req, res) => {
    const c = req.client;
    const m = { id: id(), clientId: c.id, from: "client", body: C.enc(bodyOf(req.body)), at: new Date().toISOString(), readAt: null };
    const list = all(); list.push(m); write(list);
    activity("message", { email: c.email });
    notify.owner(`New message from ${c.name}`, `${c.name} (${c.email}) sent you a message in the MD Fit app.\n\nRead and reply in Admin → Messages:\n${cfg.siteUrl || ""}/admin`);
    const rt = app.get("rt");
    if (rt) rt.emitToAdmin("new_message", { clientId: c.id, clientName: c.name, at: m.at });
    res.status(201).json(view(m));
  });

  // ---- Dr. Jared (admin) side
  admin.get("/messages", (req, res) => {
    const list = all(), byClient = new Map();
    list.forEach((m) => { const t = byClient.get(m.clientId) || []; t.push(m); byClient.set(m.clientId, t); });
    const cl = new Map(clients().map((c) => [c.id, c]));
    const threads = [...byClient.entries()].map(([cid, ms]) => {
      const c = cl.get(cid) || {}, last = ms[ms.length - 1];
      return { clientId: cid, name: c.name || "Former client", email: c.email || "", member: !!active(c), tier: c.membership ? c.membership.tier : null,
        last: { from: last.from, body: C.dec(last.body).slice(0, 140), at: last.at },
        unread: ms.filter((m) => m.from === "client" && !m.readAt).length };
    }).sort((a, b) => (a.last.at < b.last.at ? 1 : -1));
    res.json({ threads, unread: threads.reduce((s, t) => s + t.unread, 0) });
  });
  // (before /messages/:clientId, or "broadcasts" would be read as a client id)
  // Recent group messages, with how many people have read each one and how many email notices went out
  admin.get("/messages/broadcasts", (req, res) => {
    const groups = new Map();
    all().forEach((m) => {
      if (!m.broadcastId) return;
      const g = groups.get(m.broadcastId) || { broadcastId: m.broadcastId, at: m.at, preview: C.dec(m.body).slice(0, 120), recipients: 0, read: 0, emailed: 0 };
      g.recipients++; if (m.readAt) g.read++; if (m.emailedAt) g.emailed++;
      groups.set(m.broadcastId, g);
    });
    res.json([...groups.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10).map((g) => ({ ...g, sending: running.has(g.broadcastId) })));
  });
  admin.get("/messages/:clientId", (req, res) => {
    const c = clients().find((x) => x.id === req.params.clientId);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const list = all(); let n = 0;
    list.forEach((m) => { if (m.clientId === c.id && m.from === "client" && !m.readAt) { m.readAt = new Date().toISOString(); n++; } });
    if (n) write(list);
    res.json({ client: { id: c.id, name: c.name, email: c.email, phone: c.phone, member: !!active(c), tier: c.membership ? c.membership.tier : null },
      messages: list.filter((m) => m.clientId === c.id).map(view) });
  });
  // Send one message to many members at once: everyone, every active member, one membership tier, or picked people.
  // Each recipient gets it in their own private thread (so they can reply as usual) plus the usual "new message" email.
  // Registered before /messages/:clientId so "broadcast" is never read as a client id.
  const isMember = (c) => !!(c.membership && (!c.membership.until || c.membership.until >= today()));
  const MAX_PICK = 2000;
  function audienceOf(b) {
    const to = b && b.to, list = clients();
    if (to === "all") return list;
    if (to === "members") return list.filter(isMember);
    if (to === "tier") {
      const tier = typeof b.tier === "string" ? b.tier.trim() : "";
      if (!tier) fail("Pick a membership tier.");
      return list.filter((c) => isMember(c) && c.membership.tier === tier);
    }
    if (to === "selected") {
      const ids = Array.isArray(b.clientIds) ? [...new Set(b.clientIds.filter((x) => typeof x === "string"))] : [];
      if (!ids.length) fail("Pick at least one person.");
      if (ids.length > MAX_PICK) fail(`You can pick up to ${MAX_PICK} people at once.`);
      const want = new Set(ids);
      return list.filter((c) => want.has(c.id));
    }
    fail('Choose who gets it: "all", "members", "tier" or "selected".');
  }
  const firstName = (c) => String(c.name || "").split(" ")[0] || "there";
  // Email notices for a group message go out in bulk (notify.many: batched, rate-limited, retried). Each message
  // records whether its notice was accepted (emailedAt), so a failed notice can be re-sent later.
  async function emailBroadcast(broadcastId, people, reminder = false) {
    const byEmail = new Map(people.filter((c) => c.email).map((c) => [c.email, c]));
    const ok = await notify.many([...byEmail.values()].map((c) => ({
      to: c.email,
      subject: reminder ? "Reminder: you have a message from Dr. Jared" : "New message from Dr. Jared",
      text: `Hi ${firstName(c)},\n\nDr. Jared sent you a message. Read it in the MD Fit app:\n${cfg.siteUrl || ""}/account#messages\n\nMD Fit`
    })));
    const sentIds = new Set([...ok].map((e) => byEmail.get(e).id));
    const now = new Date().toISOString(), list = all();
    let changed = 0;
    list.forEach((m) => { if (m.broadcastId === broadcastId && sentIds.has(m.clientId)) { m.emailedAt = now; changed++; } });
    if (changed) write(list);
    return { sent: ok.size, failed: byEmail.size - ok.size };
  }
  const running = new Set(); // broadcastIds with emails still going out
  admin.post("/messages/broadcast", (req, res) => {
    const body = bodyOf(req.body), people = audienceOf(req.body).filter((c) => c && c.id);
    if (!people.length) fail("Nobody matches that choice yet.");
    const at = new Date().toISOString(), enc = C.enc(body), broadcastId = id();
    const list = all();
    people.forEach((c) => list.push({ id: id(), clientId: c.id, from: "doctor", body: enc, at, readAt: null, broadcastId }));
    write(list);
    const rt = app.get("rt");
    if (rt) people.forEach((c) => rt.emitToClient(c.id, "new_message", { from: "doctor", at }));
    const email = !(req.body && req.body.email === false);
    if (email) { running.add(broadcastId); emailBroadcast(broadcastId, people).catch(() => {}).finally(() => running.delete(broadcastId)); }
    res.status(201).json({ sent: people.length, emailing: email ? people.filter((c) => c.email).length : 0, broadcastId });
  });

  // Email a reminder to everyone in a group message who hasn't read it yet (e.g. after notices failed)
  admin.post("/messages/broadcast/:broadcastId/remind", async (req, res) => {
    const bid = req.params.broadcastId;
    if (running.has(bid)) return res.status(409).json({ error: "Emails for this message are still going out. Try again in a minute." });
    const unread = new Set(all().filter((m) => m.broadcastId === bid && !m.readAt).map((m) => m.clientId));
    if (!all().some((m) => m.broadcastId === bid)) return res.status(404).json({ error: "Group message not found." });
    const people = clients().filter((c) => unread.has(c.id) && c.email);
    if (!people.length) return res.json({ sent: 0, failed: 0, unread: 0 });
    running.add(bid);
    try { res.json({ ...(await emailBroadcast(bid, people, true)), unread: unread.size }); }
    finally { running.delete(bid); }
  });

  admin.post("/messages/:clientId/:id/react", (req, res) => {
    const v = react(req.params.clientId, req.params.id, "doctor", emojiOf(req.body));
    if (!v) return res.status(404).json({ error: "Message not found." });
    res.json(v);
  });
  admin.post("/messages/:clientId", (req, res) => {
    const c = clients().find((x) => x.id === req.params.clientId);
    if (!c) return res.status(404).json({ error: "Client not found." });
    const m = { id: id(), clientId: c.id, from: "doctor", body: C.enc(bodyOf(req.body)), at: new Date().toISOString(), readAt: null };
    const list = all(); list.push(m); write(list);
    notify.client(c.email, "Dr. Jared replied to your message", `Hi ${c.name.split(" ")[0]},\n\nDr. Jared answered your message. Read it in the MD Fit app:\n${cfg.siteUrl || ""}/account#messages\n\nMD Fit`);
    const rt = app.get("rt");
    if (rt) rt.emitToClient(c.id, "new_message", { from: "doctor", at: m.at });
    res.status(201).json(view(m));
  });
}

module.exports = { mountMessages, cipher, REACTIONS };
