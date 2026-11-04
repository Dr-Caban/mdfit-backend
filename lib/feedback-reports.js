// Bug reports and suggestions from members. Lightweight: stored in-store, encrypted at rest, sent to the
// owner by email ("new feedback in Admin", no details so health info never leaves the server), and listed
// in Admin -> Feedback.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { cipher } = require("./messages");

const KINDS = ["bug", "suggestion"];
const KEEP = 2000;
const MAX_TITLE = 100, MAX_BODY = 4000, MAX_META = 400;

const fail = (m) => { throw new ValidationError(m); };
const text = (v, label, max, min = 0) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};

function mountFeedbackReports({ app, admin, store, me, cfg, notify, activity, limiter }) {
  const C = cipher([process.env.FEEDBACK_ENC_KEY, process.env.MESSAGE_ENC_KEY, cfg.sessionSecret]);
  const all = () => store.read("feedbackReports", []);
  const write = (list) => store.write("feedbackReports", list.slice(-KEEP));
  const limit = limiter(10, 60 * 60 * 1000);

  const view = (r) => {
    let body = {};
    try { body = JSON.parse(C.dec(r.data) || "{}"); } catch {}
    return { id: r.id, kind: r.kind, status: r.status || "new", createdAt: r.createdAt, resolvedAt: r.resolvedAt || null,
      clientId: r.clientId, clientName: r.clientName, clientEmail: r.clientEmail, ...body };
  };

  // Member: submit a bug or suggestion
  me.post("/feedback-reports", limit.mw, (req, res) => {
    const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : fail("Pick bug or suggestion.");
    const title = text(b.title, kind === "bug" ? "Short summary" : "Idea in one line", MAX_TITLE, 2);
    const body = text(b.body, "Details", MAX_BODY, 2);
    const page = text(b.page || "", "Page", MAX_META);
    const ua = text(b.userAgent || "", "Device", MAX_META);
    const c = req.client;
    const entry = {
      id: crypto.randomBytes(6).toString("hex"), kind, status: "new",
      clientId: c.id, clientName: c.name, clientEmail: c.email,
      createdAt: new Date().toISOString(),
      data: C.enc(JSON.stringify({ title, body, page, userAgent: ua }))
    };
    const list = all(); list.push(entry); write(list);
    activity(kind === "bug" ? "bug_report" : "suggestion", { email: c.email });
    notify.owner(`New ${kind === "bug" ? "bug report" : "suggestion"} from ${c.name}`,
      `${c.name} submitted a ${kind}.\n\nFor privacy, details aren't in this email. Read it in Admin → Feedback:\n${cfg.siteUrl || ""}/admin`);
    res.status(201).json({ ok: true });
  });

  // Member: list my own feedback reports
  me.get("/feedback-reports", (req, res) => {
    const mine = all().filter((r) => r.clientId === req.client.id).map((r) => {
      const v = view(r);
      return { id: v.id, kind: v.kind, status: v.status, title: v.title, createdAt: v.createdAt, resolvedAt: v.resolvedAt };
    }).reverse();
    res.json(mine);
  });

  // Admin: list and update
  admin.get("/feedback-reports", (req, res) => {
    const kind = req.query.kind;
    const status = req.query.status;
    const list = all().map(view).reverse()
      .filter((r) => (!kind || r.kind === kind) && (!status || r.status === status));
    const open = all().filter((r) => (r.status || "new") !== "resolved").length;
    res.json({ reports: list, open });
  });

  admin.patch("/feedback-reports/:id", (req, res) => {
    const list = all(); const r = list.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: "Report not found." });
    const b = req.body || {};
    if (b.status !== undefined) {
      if (!["new", "working", "resolved"].includes(b.status)) fail("Unknown status.");
      r.status = b.status;
      r.resolvedAt = b.status === "resolved" ? new Date().toISOString() : null;
    }
    if (b.adminNotes !== undefined) r.adminNotes = text(b.adminNotes, "Notes", 2000);
    write(list);
    res.json(view(r));
  });

  admin.delete("/feedback-reports/:id", (req, res) => {
    write(all().filter((x) => x.id !== req.params.id));
    res.json({ ok: true });
  });
}

module.exports = { mountFeedbackReports, KINDS };
