// Clinical notes (Workspace → Notes). Owner, Nov 2026.
//
// These are the practice's own notes about a visit: staff only, never shown to the patient. (The short notes a patient
// reads in their app are a different thing and live on the chart, lib/emr.js.)
//
// A note starts as a draft that can be edited and autosaved. Signing locks it: the text can never be changed again.
// Anything learned later is added as a dated addendum underneath. Signing writes the note's SHA-256 fingerprint to
// the audit ledger, so a later change to the stored text would be detectable.
//
// Storage: one collection, "clinical-notes". What a note says (text and addenda) is sealed with AES-256-GCM before
// it is stored, on top of the encrypted store; the unsealed envelope holds only ids, dates, template, tier and state.
// A note whose text cannot be opened with the server's current keys is reported as unreadable and is never saved over.
//
// Sensitivity tiers: T1 standard clinical, T2 sensitive, T3 restricted. Lists never include the text of a T2 or T3
// note; opening one is written to the audit ledger as its own entry.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { cipher } = require("./messages");

const MAX_TEXT = 20000, MAX_NOTES = 20000, MAX_ADDENDA = 50;
const TEMPLATES = ["soap", "evaluation", "followup", "discharge", "free"];
const TIERS = ["T1", "T2", "T3"];
const fail = (m) => { throw new ValidationError(m); };
const id = () => crypto.randomBytes(6).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function mountNotes({ admin, store, cfg, audit, clients }) {
  const C = cipher([process.env.INTAKE_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const now = () => (typeof cfg.now === "function" ? cfg.now() : new Date()).toISOString();
  const all = () => store.read("clinical-notes", []);
  const write = (list) => store.write("clinical-notes", list.slice(-MAX_NOTES));
  const log = (req, action, n, meta = {}) => audit && audit.record({ actor: "admin", action, subject: n.clientId, ip: req.ip, meta: { note: n.id, tier: n.tier, ...meta } });

  // Opens the sealed part. null = it exists but cannot be opened (wrong key or damaged): callers must not write over it.
  const open = (n) => {
    if (!n.data) return { text: "", addenda: [] };
    try { const raw = C.dec(n.data); if (!raw) return null; const d = JSON.parse(raw); return { text: String(d.text || ""), addenda: Array.isArray(d.addenda) ? d.addenda : [] }; }
    catch { return null; }
  };
  const seal = (n, body) => { n.data = C.enc(JSON.stringify(body)); };
  const meta = (n) => ({ id: n.id, clientId: n.clientId, template: n.template, tier: n.tier, tags: n.tags || [], status: n.status,
    createdAt: n.createdAt, updatedAt: n.updatedAt, signedAt: n.signedAt || null, signedBy: n.signedBy || null, addenda: n.addendaCount || 0 });
  const full = (n) => { const b = open(n); return b ? { ...meta(n), text: b.text, addendaList: b.addenda } : { ...meta(n), unreadable: true, text: "", addendaList: [] }; };

  const textOf = (v) => { const s = typeof v === "string" ? v : ""; if (s.length > MAX_TEXT) fail(`A note can be up to ${MAX_TEXT.toLocaleString("en-US")} characters.`); return s; };
  const pick = (v, list, label) => { if (!list.includes(v)) fail(`${label} is not valid.`); return v; };
  const tagsOf = (v) => (Array.isArray(v) ? [...new Set(v.filter((t) => typeof t === "string").map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20) : []);
  const find = (req, res) => { const list = all(), n = list.find((x) => x.id === req.params.id); if (!n) res.status(404).json({ error: "Note not found." }); return [list, n]; };

  // A client's notes, newest first. Text is included for T1 only; T2 and T3 must be opened one at a time.
  admin.get("/notes", (req, res) => {
    const cid = String(req.query.clientId || "");
    if (!cid) return res.status(400).json({ error: "Pick a client." });
    const rows = all().filter((n) => n.clientId === cid).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((n) => (n.tier === "T1" ? full(n) : { ...meta(n), withheld: true }));
    res.json({ notes: rows, templates: TEMPLATES, tiers: TIERS });
  });

  admin.get("/notes/:id", (req, res) => {
    const [, n] = find(req, res); if (!n) return;
    if (n.tier !== "T1") log(req, "notes.open", n);
    res.json(full(n));
  });

  admin.post("/notes", (req, res) => {
    const b = req.body || {};
    const c = clients().find((x) => x.id === String(b.clientId || ""));
    if (!c) return res.status(404).json({ error: "Client not found." });
    const n = { id: id(), clientId: c.id, template: pick(b.template || "soap", TEMPLATES, "Template"), tier: pick(b.tier || "T1", TIERS, "Sensitivity"),
      tags: tagsOf(b.tags), status: "draft", createdAt: now(), updatedAt: now() };
    seal(n, { text: textOf(b.text), addenda: [] });
    const list = all(); list.push(n); write(list);
    log(req, "notes.create", n, { template: n.template });
    res.status(201).json(full(n));
  });

  // Edit a draft (this is what autosave calls). A signed note is locked.
  admin.put("/notes/:id", (req, res) => {
    const [list, n] = find(req, res); if (!n) return;
    if (n.status !== "draft") return res.status(409).json({ error: "This note is signed and locked. Add an addendum instead." });
    const body = open(n);
    if (!body) return res.status(409).json({ error: "This note can't be opened with the server's current keys, so nothing was saved and nothing was changed." });
    const b = req.body || {};
    if (b.text !== undefined) body.text = textOf(b.text);
    if (b.template !== undefined) n.template = pick(b.template, TEMPLATES, "Template");
    if (b.tier !== undefined) n.tier = pick(b.tier, TIERS, "Sensitivity");
    if (b.tags !== undefined) n.tags = tagsOf(b.tags);
    n.updatedAt = now(); seal(n, body); write(list);
    res.json(full(n));
  });

  // Sign and lock. From here on the text never changes; its fingerprint goes in the ledger.
  admin.post("/notes/:id/sign", (req, res) => {
    const [list, n] = find(req, res); if (!n) return;
    if (n.status !== "draft") return res.status(409).json({ error: "This note is already signed." });
    const body = open(n);
    if (!body) return res.status(409).json({ error: "This note can't be opened with the server's current keys, so it was not signed." });
    if (!body.text.trim()) fail("Write the note before signing it.");
    n.status = "signed"; n.signedAt = now(); n.signedBy = req.admin || cfg.adminEmail || "admin"; n.updatedAt = n.signedAt; n.hash = sha(body.text);
    write(list);
    log(req, "notes.sign", n, { sha256: n.hash, chars: body.text.length });
    res.json(full(n));
  });

  // After signing, new information is added underneath, dated, and the original stays as it was signed
  admin.post("/notes/:id/addendum", (req, res) => {
    const [list, n] = find(req, res); if (!n) return;
    if (n.status !== "signed") return res.status(409).json({ error: "Only a signed note takes an addendum. Edit the draft instead." });
    const body = open(n);
    if (!body) return res.status(409).json({ error: "This note can't be opened with the server's current keys, so nothing was added." });
    const text = textOf((req.body || {}).text).trim();
    if (!text) fail("Write the addendum first.");
    if (body.addenda.length >= MAX_ADDENDA) fail("This note has the most addenda it can hold.");
    if (n.hash && sha(body.text) !== n.hash) return res.status(409).json({ error: "The stored text no longer matches what was signed. Nothing was added; check the audit ledger." });
    body.addenda.push({ id: id(), at: now(), by: req.admin || cfg.adminEmail || "admin", text });
    n.addendaCount = body.addenda.length; n.updatedAt = now(); seal(n, body); write(list);
    log(req, "notes.addendum", n, { sha256: sha(text) });
    res.status(201).json(full(n));
  });

  // Only a draft can be discarded. A signed note is part of the record.
  admin.delete("/notes/:id", (req, res) => {
    const [list, n] = find(req, res); if (!n) return;
    if (n.status !== "draft") return res.status(409).json({ error: "A signed note can't be deleted." });
    write(list.filter((x) => x.id !== n.id));
    log(req, "notes.discard", n);
    res.json({ ok: true });
  });

  // For a record export: a client's notes, newest first. Standard-tier notes carry their text; higher tiers are listed
  // without it (those are opened one at a time in the workspace, where each opening is recorded).
  const forClient = (cid) => all().filter((n) => n.clientId === cid).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((n) => (n.tier === "T1" ? full(n) : { ...meta(n), withheld: true }));
  return { TEMPLATES, TIERS, forClient };
}

module.exports = { mountNotes };
