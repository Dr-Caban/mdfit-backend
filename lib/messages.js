// Member messaging: one private thread per member with Dr. Jared.
// Modeled on the digitalapple-backend Threads system: poll-based delivery, read tracking with unread badges,
// server-side permission checks, and AES-256-GCM encryption of message bodies at rest (unreadable in data backups).
// Email notifications say "new message" only, never the content, so health details stay out of inboxes.
// The one exception is asked for on purpose: a broadcast sent by email (lib/broadcast-email.js) carries its own text and
// photos. It is an announcement to a group (never to one person), and the composer says to keep health details out.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { ValidationError } = require("./validate");
const { logger } = require("./logger");
const BE = require("./broadcast-email");

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

// Who may write to Dr. Jared (owner, Nov 2026): Expert Advice and the 1-on-1 tiers (a tier with directMessages), anyone
// on an active paid treatment plan, clinic patients (a visit on record, a program or plan from Dr. Jared, or the
// in-clinic toggle), and anyone Dr. Jared wrote to in the last two weeks, so a broadcast can be answered. Everyone
// else still reads their thread; the app offers Expert Advice instead of the message box.
const REPLY_DAYS = 14;
const NO_SEND = "Messaging Dr. Jared directly is part of Expert Advice ($50/mo) and the 1-on-1 tiers.";

function mountMessages({ app, admin, store, me, clients, today, notify, cfg, limiter, activity, audit, settings = () => ({}), activeMembership = () => null, activePlan = () => false, isInpatient = () => false, owns = (c, a) => a.clientId === c.id }) {
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
  const tiers = () => { const content = require("./content"); return content.tiersOf(store.read("content", {})); };
  const clinicPatient = (c) => isInpatient(c) || (c.assignedPrograms || []).length > 0
    || !!(c.plan && ((c.plan.guides || []).length || (c.plan.exercises || []).length || c.plan.notes))
    || store.read("appointments", []).some((a) => a.status !== "cancelled" && owns(c, a));
  const canSend = (c, mine) => {
    const m = activeMembership(c), t = m && tiers().find((x) => x.id === m.tier);
    if (t && t.directMessages === true) return true;
    if (activePlan(c) || clinicPatient(c)) return true;
    const since = new Date(Date.now() - REPLY_DAYS * 864e5).toISOString();
    return (mine || all().filter((x) => x.clientId === c.id)).some((x) => x.from === "doctor" && x.at >= since);
  };

  // ---- Member side
  me.get("/messages", (req, res) => {
    const mine = all().filter((m) => m.clientId === req.client.id);
    const ok = canSend(req.client, mine);
    res.json({ member: !!active(req.client), canSend: ok, why: ok ? "" : NO_SEND, messages: mine.map(view), unread: mine.filter((m) => m.from === "doctor" && !m.readAt).length });
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
    if (!canSend(c)) return res.status(403).json({ error: NO_SEND, upgrade: true });
    const m = { id: id(), clientId: c.id, from: "client", body: C.enc(bodyOf(req.body)), at: new Date().toISOString(), readAt: null };
    const list = all(); list.push(m); write(list);
    activity("message", { email: c.email, name: c.name });
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
  // Each one says how it went out, so the workspace can tell them apart: delivery "app" (a message in each private
  // thread, with or without the "a message is waiting" notice), "email" (the message itself by email, nothing in the
  // app) or "both". For email the counts are: emailTo (people it was addressed to), emailed (accepted by the mail
  // service), failed, and who was left out and why.
  admin.get("/messages/broadcasts", (req, res) => {
    const groups = new Map();
    all().forEach((m) => {
      if (!m.broadcastId) return;
      const g = groups.get(m.broadcastId) || { broadcastId: m.broadcastId, at: m.at, preview: C.dec(m.body).slice(0, 120), recipients: 0, read: 0, emailed: 0, delivery: "app" };
      g.recipients++; if (m.readAt) g.read++; if (m.emailedAt) g.emailed++;
      groups.set(m.broadcastId, g);
    });
    sentByEmail().forEach((r) => {
      const g = groups.get(r.id) || { broadcastId: r.id, at: r.at, preview: C.dec(r.body).slice(0, 120), recipients: 0, read: 0, emailed: 0 };
      // A send that is not running and never finished was cut short (the server restarted while it was going out)
      Object.assign(g, { delivery: r.delivery, subject: C.dec(r.subject), emailTo: r.emailTo, emailed: (r.sentTo || []).length, failed: r.failed || 0, skipped: r.skipped || {}, photos: r.photos || 0, stopped: !r.doneAt && !running.has(r.id) });
      groups.set(r.id, g);
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
  const people_ = (n) => `${n} ${n === 1 ? "person" : "people"}`;

  // ---- Who may be emailed by a broadcast (the notice, the reminder and the full email all follow this one rule)
  // People who used an unsubscribe link, by account id. Kept apart from the client record, so it holds whatever
  // happens to that record (moved to the trash, restored).
  const optOuts = () => { const o = store.read("broadcast-optouts", {}); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; };
  // The unsubscribe links are signed with a key of their own, made once and kept with the data: a link in an email
  // sent months ago has to keep working, whatever happens to the sign-in secret.
  let unsubKey = null;
  const unsubSecret = () => {
    if (unsubKey) return unsubKey;
    let k = store.read("broadcast-keys", null);
    if (!k || typeof k.unsub !== "string" || k.unsub.length < 32) { k = { unsub: crypto.randomBytes(32).toString("hex") }; store.write("broadcast-keys", k); }
    return (unsubKey = k.unsub);
  };
  const unsubLinks = (c) => {
    const q = `c=${encodeURIComponent(c.id)}&t=${BE.unsubToken(unsubSecret(), c.id)}`;
    return { page: `${cfg.siteUrl}/unsubscribe?${q}`, oneClick: `${cfg.siteUrl}/api/unsubscribe?${q}` };
  };
  // "none": no inbox (no address, or a closed account, which keeps its record under deleted+id@mdfit.invalid).
  // "restricted": the person asked to be reached another way, or has a contact restriction on file that only a
  // person can read (the same rule the birthday email follows). They are left out, and counted, never guessed about.
  const emailState = (c, out) => (!c.email || c.deletedAt || /@mdfit\.invalid$/i.test(c.email) ? "none" : out[c.id] ? "unsubscribed"
    : c.privacy && ((c.privacy.contactBy && c.privacy.contactBy !== "email") || String(c.privacy.restrictions || "").trim()) ? "restricted" : "ok");
  function emailAudience(people) {
    const res = { mailable: [], noEmail: [], unsubscribed: [], restricted: [] }, seen = new Set(), out = optOuts();
    people.forEach((c) => {
      const st = emailState(c, out);
      if (st === "none") res.noEmail.push(c.id);
      else if (st !== "ok") res[st].push(c.id);
      else if (!seen.has(c.email)) { seen.add(c.email); res.mailable.push(c); } // two accounts on one address get one email
    });
    return res;
  }

  // Email notices for a group message ("a message is waiting": never the message) go out in bulk (notify.many:
  // batched, rate-limited, retried). Each message records whether its notice was accepted (emailedAt), so a failed
  // notice can be re-sent later. Each notice ends with that person's own unsubscribe link.
  async function emailBroadcast(broadcastId, people, reminder = false) {
    const byEmail = new Map(emailAudience(people).mailable.map((c) => [c.email, c]));
    const ok = await notify.many([...byEmail.values()].map((c) => ({
      to: c.email,
      subject: reminder ? "Reminder: you have a message from Dr. Jared" : "New message from Dr. Jared",
      text: `Hi ${firstName(c)},\n\nDr. Jared sent you a message. Read it in the MD Fit app:\n${cfg.siteUrl || ""}/account#messages\n\nMD Fit${cfg.siteUrl ? `\n\nStop these emails: ${unsubLinks(c).page}` : ""}`
    })));
    const sentIds = new Set([...ok].map((e) => byEmail.get(e).id));
    const now = new Date().toISOString(), list = all();
    let changed = 0;
    list.forEach((m) => { if (m.broadcastId === broadcastId && sentIds.has(m.clientId)) { m.emailedAt = now; changed++; } });
    if (changed) write(list);
    return { sent: ok.size, failed: byEmail.size - ok.size };
  }
  const running = new Set(); // broadcastIds with emails still going out
  // One message into each person's own private thread, with the live update and the phone notification
  function toThreads(people, body, at, broadcastId) {
    const enc = C.enc(body), list = all();
    people.forEach((c) => list.push({ id: id(), clientId: c.id, from: "doctor", body: enc, at, readAt: null, broadcastId }));
    write(list);
    const rt = app.get("rt");
    if (rt) people.forEach((c) => rt.emitToClient(c.id, "new_message", { from: "doctor", at }));
    { const push = app.get("push"); if (push) people.forEach((c) => push.toClient(c.id, { title: "Message from Dr. Jared", body: "You have a new message in the MD Fit app.", route: "messages/dr", thread: "messages", collapseId: `msg:${c.id}` })); }
  }

  // ---- By email: the message itself, with photos, in each person's inbox (lib/broadcast-email.js).
  // delivery "email" sends only that; "both" also puts the message in each private thread. "app" is the original
  // broadcast below: its optional email is a notice that never carries the message.
  const staging = BE.createStaging();
  const sentByEmail = () => store.read("broadcast-emails", []);
  const writeSent = (list) => store.write("broadcast-emails", list.slice(-200));
  // What a send still going out needs to finish: its photos and who it is for. Kept on disk (sealed like every other
  // file) only until the send is done, so a restart in the middle picks it up instead of dropping everyone left.
  const RESUME_HOURS = 12; // the mail service remembers what it already took for 24 hours; a resume stays well inside that
  const pendingAll = () => { const p = store.read("broadcast-pending", {}); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; };
  const pendingSet = (bid, job) => { const p = pendingAll(); if (job) p[bid] = job; else if (!(bid in p)) return; else delete p[bid]; store.write("broadcast-pending", p); };
  const clinicOf = () => { const b = (settings() || {}).business || {}; return { name: b.name || "MD Fit", address: b.address || "", phone: b.phone || "" }; };
  // Photos ride inside the email (shown in the message by their content id), so nothing has to be hosted
  const attach = (photos) => photos.map((p, i) => ({ filename: `photo-${i + 1}.${p.type === "image/png" ? "png" : "jpg"}`, content: p.buf.toString("base64"), content_type: p.type, content_id: `photo${i + 1}` }));

  // What the composer needs to show the two audiences apart: who is a paying member, and who cannot be emailed and why
  admin.get("/messages/broadcast/people", (req, res) => {
    const list = clients(), a = emailAudience(list);
    res.json({ total: list.length, members: list.filter(isMember).map((c) => c.id), noEmail: a.noEmail, unsubscribed: a.unsubscribed, restricted: a.restricted,
      emailOn: !!(notify.enabled && cfg.siteUrl), testTo: req.admin || "", sending: running.size > 0,
      limits: { photos: BE.MAX_PHOTOS, photoBytes: BE.MAX_PHOTO_BYTES, subject: BE.MAX_SUBJECT, emailBody: BE.MAX_EMAIL_BODY, appBody: MAX_LEN, minEmail: BE.MIN_RECIPIENTS } });
  });
  // A photo added in the composer waits here (in memory, for an hour, for the person who added it) until it is sent
  admin.post("/messages/broadcast/photo", express.raw({ type: ["image/jpeg", "image/png"], limit: BE.MAX_PHOTO_BYTES + 1024 }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail("Photos must be JPG or PNG.");
    res.status(201).json(staging.add(req.body, req.admin));
  });
  admin.delete("/messages/broadcast/photo/:id", (req, res) => { staging.drop(req.params.id, req.admin); res.json({ ok: true }); });

  // Sends to `mailable` and writes down each person as the mail service accepts their copy. Every copy has a fixed
  // name at the mail service (the broadcast and the person), so one that was accepted just before a restart is not
  // delivered a second time when the send picks up again.
  async function sendByEmail(rec, { subject, body, photos, mailable }) {
    const clinic = clinicOf(), atts = attach(photos), cids = atts.map((a) => ({ cid: a.content_id }));
    const byEmail = new Map(mailable.map((c) => [c.email, c]));
    const items = mailable.map((c) => {
      const l = unsubLinks(c), e = BE.buildEmail({ firstName: firstName(c), body, photos: cids, clinic, unsubscribeUrl: l.page });
      return { to: c.email, subject, text: e.text, html: e.html, attachments: atts, key: `mdfit-bc-${rec.id}-${c.id}`, headers: { "List-Unsubscribe": `<${l.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
    });
    let waiting = [];
    const flush = (done) => {
      if (!waiting.length && !done) return;
      const list = sentByEmail(), r = list.find((x) => x.id === rec.id);
      if (!r) return;
      r.sentTo = [...new Set([...(r.sentTo || []), ...waiting])]; waiting = [];
      if (done) { r.failed = Math.max(0, r.emailTo - r.sentTo.length); r.doneAt = new Date().toISOString(); }
      writeSent(list);
    };
    // with photos it is one request per person, so each is written down at once; without, per batch of a hundred
    const each = atts.length > 0;
    const ok = await notify.campaign(items, { group: `mdfit-bc-${rec.id}`, onSent: (addr) => { const c = byEmail.get(addr); if (c) waiting.push(c.id); if (each || waiting.length >= 100) flush(false); } });
    flush(true);
    if (rec.delivery === "both" && ok.size) {
      const sentIds = new Set([...ok].map((e) => byEmail.get(e).id)), now = new Date().toISOString(), list = all();
      list.forEach((m) => { if (m.broadcastId === rec.id && sentIds.has(m.clientId)) m.emailedAt = now; });
      write(list);
    }
    const r = sentByEmail().find((x) => x.id === rec.id) || rec;
    return { sent: (r.sentTo || []).length, failed: r.failed || 0 };
  }
  // Runs a send in the background and tells the owner how it went. The work it needs stays on disk until it is done.
  function launch(rec, job) {
    running.add(rec.id);
    return sendByEmail(rec, job)
      .then((r) => notify.owner(`Email broadcast sent to ${people_(r.sent)}${r.failed ? ` (${r.failed} not sent)` : ""}`,
        `"${job.subject}" went by email to ${people_(r.sent)}${r.failed ? `; ${r.failed} could not be sent` : ""}${rec.photos ? `, with ${rec.photos === 1 ? "1 photo" : `${rec.photos} photos`}` : ""}.\n\nLeft out: ${rec.skipped.noEmail} with no email on file, ${rec.skipped.unsubscribed} unsubscribed, ${rec.skipped.restricted} who asked to be reached another way.${rec.delivery === "both" ? `\n\nIt is also in ${people_(rec.people)}'s messages in the MD Fit app.` : ""}\n\nMessage:\n"${job.body.slice(0, 300)}${job.body.length > 300 ? "…" : ""}"\n\nSee it in Admin → Messages → Broadcast:\n${cfg.siteUrl || ""}/admin`))
      .catch((err) => logger.warn("broadcast_email_failed", { error: err && err.message }))
      .finally(() => { running.delete(rec.id); pendingSet(rec.id, null); });
  }
  // After a restart: any send that was still going out is picked up where it stopped. People already written down
  // are not emailed again, and anyone who unsubscribed in the meantime is left out. A send older than RESUME_HOURS
  // is not picked up; it shows as stopped in the workspace.
  function resumeEmailBroadcasts() {
    if (!notify.enabled || !cfg.siteUrl) return 0;
    let n = 0;
    for (const [bid, job] of Object.entries(pendingAll())) {
      if (running.has(bid)) continue;
      const rec = sentByEmail().find((x) => x.id === bid);
      if (!rec || rec.doneAt || !job || Date.now() - Date.parse(rec.at) > RESUME_HOURS * 3600e3) { pendingSet(bid, null); continue; }
      const got = new Set(rec.sentTo || []), want = new Set((Array.isArray(job.to) ? job.to : []).filter((x) => !got.has(x)));
      const mailable = emailAudience(clients().filter((c) => want.has(c.id))).mailable;
      const photos = (Array.isArray(job.photos) ? job.photos : []).map((p) => ({ type: p.type, buf: Buffer.from(String(p.b64 || ""), "base64") }));
      logger.info("broadcast_email_resumed", { id: bid, left: mailable.length });
      launch(rec, { subject: C.dec(rec.subject), body: C.dec(rec.body), photos, mailable });
      n++;
    }
    return n;
  }
  app.set("resumeBroadcasts", resumeEmailBroadcasts);

  // The composer gives each press of Send a name of its own. If the answer is lost on the way back and Send is pressed
  // again, the same name comes in again and gets the first answer: nothing is sent twice.
  const pressed = new Map(); // name -> { at, body }
  const pressOf = (b) => (b && typeof b.key === "string" && /^[A-Za-z0-9-]{8,48}$/.test(b.key) ? b.key : "");
  const already = (key) => {
    if (!key) return null;
    for (const [k, v] of pressed) if (Date.now() - v.at > 3600e3) pressed.delete(k);
    const hit = pressed.get(key);
    if (hit) return hit.body;
    const rec = sentByEmail().find((x) => x.key === key);
    return rec ? { delivery: rec.delivery, sent: rec.delivery === "both" ? rec.people : 0, emailing: rec.emailTo, skipped: rec.skipped, broadcastId: rec.id } : null;
  };
  const remember = (key, body) => { if (key) pressed.set(key, { at: Date.now(), body }); return body; };

  async function byEmail(req, res, delivery, testOnly = false) {
    const b = req.body || {}, who = req.admin || "";
    if (!notify.enabled) fail("Email is not set up on this server, so a broadcast cannot go out by email yet.");
    if (!cfg.siteUrl) fail("The site address is not set on this server, so unsubscribe links cannot be made.");
    // Every announcement email has to show where it comes from (the law on bulk email asks for a postal address)
    if (!clinicOf().address.trim()) fail("Add the practice\u2019s street address in Settings first: every announcement email must show it.");
    const subject = BE.subjectOf(b.subject);
    const body = delivery === "both" ? bodyOf(b) : BE.emailBodyOf(b.body);
    const photos = staging.take(b.photoIds, who);
    // A test goes to the person sending it and to nobody else, and leaves no record
    if (testOnly || b.test === true) {
      if (!who) fail("Sign in again to send a test.");
      const atts = attach(photos), e = BE.buildEmail({ firstName: "there", body, photos: atts.map((a) => ({ cid: a.content_id })), clinic: clinicOf(), test: true });
      const ok = await notify.campaign([{ to: who, subject: `[Test] ${subject}`, text: e.text, html: e.html, attachments: atts }]);
      return res.json({ test: true, sent: ok.size === 1, to: who });
    }
    // one email broadcast at a time: a second press, or a second person, waits for the first to finish going out
    if (running.size) return res.status(409).json({ error: "Emails from an earlier broadcast are still going out. Try again in a minute." });
    const people = audienceOf(b).filter((c) => c && c.id);
    if (!people.length) fail("Nobody matches that choice yet.");
    const aud = emailAudience(people);
    if (!aud.mailable.length) fail("Nobody in that choice can be emailed: no email on file, unsubscribed, or asked to be reached another way.");
    // An email to one person is a private letter, not a broadcast: what is written to one person stays in their
    // thread in the app, where it is not sitting in an inbox.
    if (aud.mailable.length < BE.MIN_RECIPIENTS) fail(`Only one person in that choice can be emailed. An email broadcast is for a group (at least ${BE.MIN_RECIPIENTS} people); to write to one person, use their message thread in the app.`);
    const at = new Date().toISOString(), broadcastId = id();
    if (delivery === "both") toThreads(people, body + (photos.length ? `\n\n(The email version of this message has ${photos.length === 1 ? "a photo" : `${photos.length} photos`}.)` : ""), at, broadcastId);
    const rec = { id: broadcastId, at, by: who, delivery, to: typeof b.to === "string" ? b.to : "", subject: C.enc(subject), body: C.enc(body), people: people.length, emailTo: aud.mailable.length, sentTo: [], failed: 0,
      skipped: { noEmail: aud.noEmail.length, unsubscribed: aud.unsubscribed.length, restricted: aud.restricted.length }, photos: photos.length, doneAt: null, ...(pressOf(b) ? { key: pressOf(b) } : {}) };
    { const list = sentByEmail(); list.push(rec); writeSent(list); }
    pendingSet(broadcastId, { to: aud.mailable.map((c) => c.id), photos: photos.map((p) => ({ type: p.type, b64: p.buf.toString("base64") })) });
    if (audit) audit.record({ actor: `admin:${who}`, action: "broadcast.email", subject: "", ip: req.ip, meta: { id: broadcastId, delivery, emailTo: rec.emailTo, inApp: delivery === "both" ? people.length : 0, photos: rec.photos, noEmail: rec.skipped.noEmail, unsubscribed: rec.skipped.unsubscribed, restricted: rec.skipped.restricted } });
    staging.drop(photos.map((p) => p.id), who);
    launch(rec, { subject, body, photos, mailable: aud.mailable });
    res.status(201).json(remember(pressOf(b), { delivery, sent: delivery === "both" ? people.length : 0, emailing: aud.mailable.length, skipped: rec.skipped, broadcastId }));
  }
  // The email exactly as it will look, to the person composing it and to nobody else. Nothing is recorded.
  admin.post("/messages/broadcast/test", (req, res) => {
    const delivery = req.body && req.body.delivery === "both" ? "both" : "email";
    return byEmail(req, res, delivery, true);
  });

  admin.post("/messages/broadcast", (req, res) => {
    const b = req.body || {}, delivery = b.delivery !== undefined ? b.delivery : "app";
    if (!["app", "email", "both"].includes(delivery)) fail('Choose how it goes out: "app", "email" or "both".');
    // A request that says "test" in any way must never turn into a real send
    if (b.test !== undefined && b.test !== false) {
      if (b.test !== true) fail("test is true or false.");
      if (delivery === "app") fail("A test is for an email broadcast. An app message has no test: it would go to everyone.");
    }
    { const was = b.test === true ? null : already(pressOf(b)); if (was) return res.json({ ...was, repeat: true }); }
    if (delivery !== "app") return byEmail(req, res, delivery);
    const body = bodyOf(req.body), people = audienceOf(req.body).filter((c) => c && c.id);
    if (!people.length) fail("Nobody matches that choice yet.");
    const at = new Date().toISOString(), broadcastId = id();
    toThreads(people, body, at, broadcastId);
    const email = !(req.body && req.body.email === false);
    const emailing = email ? emailAudience(people).mailable.length : 0;
    if (email) {
      running.add(broadcastId);
      emailBroadcast(broadcastId, people)
        .then((r) => notify.owner(`Group message sent to ${people.length} ${people.length === 1 ? "person" : "people"}${r.failed ? ` (${r.failed} emails failed)` : ""}`,
          `Your group message reached ${people.length} ${people.length === 1 ? "person" : "people"} in the MD Fit app.\n\nEmail notices: ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ""}${people.length - r.sent - r.failed > 0 ? `, ${people.length - r.sent - r.failed} not emailed (no email address, unsubscribed, or asked to be reached another way)` : ""}.\n\nMessage:\n"${body.slice(0, 300)}${body.length > 300 ? "…" : ""}"\n\nSee who has read it, and email a reminder to the rest, in Admin → Messages:\n${cfg.siteUrl || ""}/admin`))
        .catch(() => {}).finally(() => running.delete(broadcastId));
    }
    res.status(201).json(remember(pressOf(b), { delivery: "app", sent: people.length, emailing, broadcastId }));
  });

  // ---- Unsubscribe: the link at the bottom of every email a broadcast sends, and the one-click request mail apps
  // send. It turns off the emails a broadcast sends (the full email, the "a message is waiting" notice and its
  // reminder). Emails about a person's own visits and account are not affected, and the app message still arrives.
  const unsubLimit = limiter(120, 15 * 60 * 1000);
  const unsubId = (req) => {
    const q = req.query || {}, b = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
    const pick = (k) => (typeof q[k] === "string" ? q[k] : typeof b[k] === "string" ? b[k] : "");
    const c = pick("c");
    return BE.unsubOk(unsubSecret(), c, pick("t")) ? c : null;
  };
  const BAD_LINK = "This link is not valid. Use the unsubscribe link at the bottom of an MD Fit email.";
  app.get("/api/unsubscribe", unsubLimit.mw, (req, res) => {
    // A person who opens this address in a browser (some mail apps show it as a link) lands on the page, not on data.
    // The page itself asks with fetch, which does not say it wants HTML.
    if (cfg.siteUrl && /text\/html/i.test(req.get("accept") || "")) {
      const q = req.query || {}, part = (k) => encodeURIComponent(typeof q[k] === "string" ? q[k] : "");
      return res.redirect(302, `${cfg.siteUrl}/unsubscribe?c=${part("c")}&t=${part("t")}`);
    }
    const cid = unsubId(req);
    if (!cid) return res.status(400).json({ error: BAD_LINK });
    res.set("Cache-Control", "no-store").json({ unsubscribed: !!optOuts()[cid] });
  });
  app.post("/api/unsubscribe", unsubLimit.mw, (req, res) => {
    const cid = unsubId(req);
    if (!cid) return res.status(400).json({ error: BAD_LINK });
    const back = !!(req.body && req.body.resubscribe === true), out = optOuts();
    if (back === !!out[cid]) {
      if (back) delete out[cid]; else out[cid] = new Date().toISOString();
      store.write("broadcast-optouts", out);
      if (audit) audit.record({ actor: `client:${cid}`, action: back ? "broadcast.resubscribed" : "broadcast.unsubscribed", subject: cid, ip: req.ip, meta: {} });
    }
    res.set("Cache-Control", "no-store").json({ unsubscribed: !back });
  });

  // Email a reminder to everyone in a group message who hasn't read it yet (e.g. after notices failed)
  admin.post("/messages/broadcast/:broadcastId/remind", async (req, res) => {
    const bid = req.params.broadcastId;
    if (running.has(bid)) return res.status(409).json({ error: "Emails for this message are still going out. Try again in a minute." });
    const unread = new Set(all().filter((m) => m.broadcastId === bid && !m.readAt).map((m) => m.clientId));
    if (!all().some((m) => m.broadcastId === bid)) return res.status(404).json({ error: "Group message not found." });
    const people = emailAudience(clients().filter((c) => unread.has(c.id))).mailable;
    if (!people.length) return res.json({ sent: 0, failed: 0, unread: unread.size });
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
    { const push = app.get("push"); if (push) push.toClient(c.id, { title: "Dr. Jared replied", body: "You have a new message in the MD Fit app.", route: "messages/dr", thread: "messages", collapseId: `msg:${c.id}` }); }
    res.status(201).json(view(m));
  });
}

module.exports = { mountMessages, cipher, REACTIONS };
