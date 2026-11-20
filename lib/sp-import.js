// Bringing the practice's records over from SimplePractice, its previous EMR. Owner only (the "/import" prefix is not
// mapped in lib/staff.js, so no staff role can reach it).
//
// The owner uploads SimplePractice's own export in the workspace. The browser unpacks the zip files and reads the
// contact cards; this module then
//   1. plans:   matches each contact to an MD Fit account (same email, else same name and no conflicting birth date)
//   2. writes:  creates the missing client accounts (no password and no email to them: nobody is contacted), links the
//               rest, fills only blanks on existing accounts, and makes everyone with clinical records a patient
//   3. files:   puts each document on that person's chart (encrypted, original date kept, marked as imported); an
//               invoice is also read and entered on the chart, so it counts in revenue in the month it was issued
//   4. undoes:  a whole import, taking out only what it put in
// Everything is in the audit ledger, by person, never with the content. Imported invoices are clinic revenue, settled
// outside Stripe: they are not online revenue and never enter the revenue share or commissions.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { ValidationError, EMAIL_RE } = require("./validate");

const SOURCE = "simplepractice";
const KINDS = ["record", "invoice", "admin", "message"];
const fail = (m) => { throw new ValidationError(m); };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
const dayOf = (v) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) ? s : ""; };
const emailOf = (v) => { const e = str(v, 200).toLowerCase(); return e && EMAIL_RE.test(e) ? e : ""; };
const phoneOf = (v) => { const p = str(v, 40).replace(/[^\d+()\-. ]/g, ""); return p.replace(/\D/g, "").length >= 7 ? p : ""; };

// ---- Invoices: SimplePractice's invoice PDF, read as text lines (the PDF library is loaded only when needed)
let pdfjs = null;
async function pdfLines(buf) {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const lines = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const tc = await (await doc.getPage(p)).getTextContent(), rows = new Map();
      for (const it of tc.items) { const y = Math.round(it.transform[5]); rows.set(y, (rows.get(y) || []).concat([[it.transform[4], it.str]])); }
      for (const [, r] of [...rows].sort((a, b) => b[0] - a[0])) lines.push(r.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" ").replace(/\s+/g, " ").trim());
    }
  } finally { await doc.destroy(); }
  return lines.filter(Boolean);
}
const money = (s) => Number(String(s).replace(/[$,\s]/g, ""));
const usDay = (s) => { const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : ""; };
function readInvoice(lines) {
  const find = (re) => { for (const l of lines) { const m = l.match(re); if (m) return m; } return null; };
  const total = find(/^Total\s+\$?([\d,]+\.\d{2})$/i), paid = find(/^Amount Paid\s+\$?([\d,]+\.\d{2})$/i), issued = find(/Issued:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const items = lines.map((l) => l.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+\$?([\d,]+\.\d{2})$/)).filter(Boolean).map((m) => ({ date: usDay(m[1]), what: m[2].trim(), amount: money(m[3]) }));
  if (!total) return null;
  return { total: money(total[1]), paid: paid ? money(paid[1]) : 0, issued: issued ? usDay(issued[1]) : (items[0] && items[0].date) || "", description: items.map((i) => i.what).filter(Boolean).join("; ").slice(0, 160) || "Professional services" };
}

function mountSpImport({ app, admin, store, cfg, audit, activity, clients, save }) {
  const nowIso = () => (cfg && typeof cfg.now === "function" ? cfg.now() : new Date()).toISOString();
  const emr = () => { const e = app.get("emrApi"); if (!e || !e.importFile) fail("The chart module is not loaded."); return e; };
  const batches = () => { const b = store.read("sp-imports", []); return Array.isArray(b) ? b : []; };
  const writeBatches = (b) => store.write("sp-imports", b);
  const record = (req, action, subject, meta) => audit && audit.record({ actor: `admin:${req.admin}`, action, subject, ip: req.ip, meta });
  const batchOf = (bid) => { const b = batches(), x = b.find((y) => y.id === bid); if (!x) fail("Unknown import. Start again from the preview."); if (x.undoneAt) fail("This import was undone."); return [b, x]; };

  const contactIn = (x) => ({ key: str(x && x.key, 200), name: str(x && x.name, 100), first: str(x && x.first, 60), last: str(x && x.last, 60), email: emailOf(x && x.email), phone: phoneOf(x && x.phone), dob: dayOf(x && x.dob), address: str(x && x.address, 300) });

  // 1. Who is already here
  function plan(list, contacts) {
    const byEmail = new Map(list.filter((c) => c.email).map((c) => [c.email, c]));
    const byName = new Map(); for (const c of list) { const k = norm(c.name); if (k) byName.set(k, (byName.get(k) || []).concat([c])); }
    const view = (c) => ({ id: c.id, name: c.name, email: c.email || "", dob: c.dob || "", lastLoginAt: c.lastLoginAt || null });
    return contacts.map((x) => {
      if (x.email && byEmail.has(x.email)) return { key: x.key, action: "link", clientId: byEmail.get(x.email).id, how: "email", match: view(byEmail.get(x.email)) };
      const same = (byName.get(norm(x.name)) || []).filter((c) => !(x.email && c.email && c.email !== x.email) && !(x.dob && c.dob && c.dob !== x.dob));
      if (same.length === 1) return { key: x.key, action: "link", clientId: same[0].id, how: "name", match: view(same[0]) };
      if (same.length > 1) return { key: x.key, action: "new", how: "ambiguous", candidates: same.map(view) };
      return { key: x.key, action: "new", how: null };
    });
  }
  admin.post("/import/sp/plan", (req, res) => {
    const contacts = (Array.isArray((req.body || {}).contacts) ? req.body.contacts : []).slice(0, 5000).map(contactIn).filter((x) => x.key && x.name);
    if (!contacts.length) fail("No contacts were found in the files.");
    res.set("Cache-Control", "no-store");
    res.json({ rows: plan(clients(), contacts), batches: batches().slice(-10).reverse().map(summary) });
  });

  // 2. Accounts
  admin.post("/import/sp/clients", (req, res) => {
    const b = req.body || {}, rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 5000);
    if (!rows.length) fail("Nothing to import.");
    const list = clients(), byId = new Map(list.map((c) => [c.id, c])), emails = new Set(list.filter((c) => c.email).map((c) => c.email));
    const batch = { id: crypto.randomBytes(6).toString("hex"), at: nowIso(), by: req.admin, created: [], linked: [], patients: [], files: [], invoices: [], filled: [] };
    const map = {}, problems = [];
    for (const r of rows) {
      const x = contactIn(r), action = r.action === "link" ? "link" : r.action === "skip" ? "skip" : "new";
      if (!x.key || !x.name) { problems.push({ key: x.key, error: "No name." }); continue; }
      if (action === "skip") continue;
      let c;
      if (action === "link") {
        c = byId.get(str(r.clientId, 40));
        if (!c) { problems.push({ key: x.key, error: "That account no longer exists." }); continue; }
        const fill = {}; // only blanks: nothing the person or the practice entered in MD Fit is overwritten
        if (!c.phone && x.phone) fill.phone = x.phone;
        if (!c.dob && x.dob) fill.dob = x.dob;
        if (!c.address && x.address) fill.address = x.address;
        if (!c.email && x.email && !emails.has(x.email)) { fill.email = x.email; emails.add(x.email); }
        if (Object.keys(fill).length) { Object.assign(c, fill); batch.filled.push({ id: c.id, fields: Object.keys(fill) }); }
        c.imported = { ...(c.imported || {}), source: SOURCE, at: batch.at };
        batch.linked.push(c.id);
      } else {
        const email = x.email && !emails.has(x.email) ? x.email : "";
        if (email) emails.add(email);
        c = { id: crypto.randomBytes(6).toString("hex"), email, name: x.name, ...(x.first ? { firstName: x.first } : {}), ...(x.last ? { lastName: x.last } : {}), phone: x.phone, ...(x.dob ? { dob: x.dob } : {}), ...(x.address ? { address: x.address } : {}),
          passwordHash: null, pwv: 0, plan: { guides: [], exercises: [], notes: "", updatedAt: null }, painLog: [], createdAt: batch.at, lastLoginAt: null,
          addedBy: req.admin, imported: { source: SOURCE, at: batch.at, batch: batch.id } };
        list.push(c); byId.set(c.id, c); batch.created.push(c.id);
      }
      const since = dayOf(r.patientSince);
      if (since && !(c.patient && c.patient.status === "active")) { c.patient = { status: "active", since: `${since}T12:00:00.000Z`, by: "import" }; batch.patients.push(c.id); }
      map[x.key] = c.id;
    }
    save(list);
    writeBatches([...batches(), batch].slice(-50));
    record(req, "import.sp.clients", batch.id, { created: batch.created.length, linked: batch.linked.length, patients: batch.patients.length });
    activity && activity("sp_import", { created: batch.created.length, linked: batch.linked.length });
    res.status(201).json({ batch: batch.id, map, created: batch.created.length, linked: batch.linked.length, patients: batch.patients.length, problems });
  });

  // 3. One document onto one chart
  admin.post("/import/sp/file", express.raw({ type: () => true, limit: 4 * 1024 * 1024 }), async (req, res, next) => {
    try {
      const [b, x] = batchOf(str(req.query.batch, 20));
      const kind = KINDS.includes(req.query.kind) ? req.query.kind : "record";
      const list = clients(), c = list.find((y) => y.id === str(req.query.client, 40));
      if (!c) return res.status(404).json({ error: "Client not found." });
      if (!x.created.includes(c.id) && !x.linked.includes(c.id)) fail("That client is not part of this import.");
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      let name = ""; try { name = decodeURIComponent(String(req.get("x-file-name") || "")); } catch {}
      const type = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const label = kind === "message" ? `Secure messages (SimplePractice) ${name}` : name;
      const e = emr(), out = e.importFile(c, { name: label, type, buf, date: dayOf(req.query.date), source: SOURCE });
      let invoice = null, note = "";
      if (kind === "invoice" && type === "application/pdf") {
        let inv = null; try { inv = readInvoice(await pdfLines(buf)); } catch { inv = null; }
        if (!inv) note = "The invoice could not be read, so it was filed but not entered in billing.";
        else if (!(inv.total > 0)) note = "A $0 invoice: filed, not entered in billing.";
        else {
          const r = e.importInvoice(c, { amount: inv.total, paid: inv.paid >= inv.total, date: inv.issued, description: `SimplePractice: ${inv.description}`, ref: name, source: SOURCE });
          invoice = { id: r.invoice.id, number: r.invoice.number, amount: r.invoice.amount, status: r.invoice.status, date: r.invoice.date, duplicate: r.duplicate };
          if (!r.duplicate) x.invoices.push({ client: c.id, id: r.invoice.id });
        }
      }
      if (!out.duplicate) x.files.push({ client: c.id, id: out.file.id });
      save(list); writeBatches(b);
      record(req, "import.sp.file", c.id, { batch: x.id, kind, file: out.file.id, duplicate: out.duplicate, ...(invoice ? { invoice: invoice.number, amount: invoice.amount } : {}) });
      res.status(201).json({ file: { id: out.file.id, at: out.file.at }, duplicate: out.duplicate, invoice, note });
    } catch (err) { next(err); }
  });

  // 4. History and undo
  const summary = (x) => ({ id: x.id, at: x.at, by: x.by, created: x.created.length, linked: x.linked.length, patients: x.patients.length, files: x.files.length, invoices: x.invoices.length, undoneAt: x.undoneAt || null });
  admin.get("/import/sp/batches", (req, res) => res.json(batches().slice().reverse().map(summary)));
  admin.post("/import/sp/batches/:id/undo", (req, res) => {
    const [b, x] = batchOf(str(req.params.id, 20)), list = clients(), e = emr();
    const created = new Set(x.created), kept = [];
    for (const c of list) {
      const files = x.files.filter((f) => f.client === c.id).map((f) => f.id), invoices = x.invoices.filter((i) => i.client === c.id).map((i) => i.id);
      if (files.length || invoices.length) e.dropImported(c, { files, invoices });
      if (x.patients.includes(c.id) && c.patient && c.patient.by === "import") delete c.patient;
      const fill = x.filled.find((f) => f.id === c.id); if (fill) for (const k of fill.fields) delete c[k];
      // an account this import made goes again, unless the person has since signed in or it was given more
      const ch = e.chartOf(c), added = ch.notes.length || ch.movements.length || ch.clinic.files.some((f) => !f.source && !f.removedAt) || ch.clinic.invoices.some((i) => !i.source);
      if (created.has(c.id) && !c.lastLoginAt && !c.passwordHash && !c.membership && !c.googleSub && !c.appleSub && !added) continue;
      kept.push(c);
    }
    save(kept);
    x.undoneAt = nowIso(); x.undoneBy = req.admin; writeBatches(b);
    record(req, "import.sp.undo", x.id, { removedAccounts: list.length - kept.length, files: x.files.length, invoices: x.invoices.length });
    res.json({ ...summary(x), removedAccounts: list.length - kept.length });
  });
}

module.exports = { mountSpImport, readInvoice, pdfLines };
