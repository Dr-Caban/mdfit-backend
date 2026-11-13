// STAFF ACCOUNTS, ROLES AND PERMISSIONS.
//
// Until now there was exactly one admin identity: ADMIN_EMAIL + ADMIN_PASSWORD_HASH in the host's variables. This
// module adds staff accounts beside it so the owner can give someone an Administrator login without handing over
// the owner password.
//
//   - The OWNER is the environment account. It is never stored here, can never be created, edited, deactivated or
//     deleted through the API, and bypasses every permission check.
//   - A ROLE is only a preset. What is actually enforced is the `permissions` array on the staff record, which the
//     owner can adjust per person.
//   - `charts` is the PHI permission (EMR, clinical notes, the AI scribe, intake/forms). It is OFF by default and
//     is not part of the Administrator preset: an office administrator runs the practice without reading charts.
//   - The route gate FAILS CLOSED: an admin route whose first path segment is not in ROUTE_PERMISSIONS is
//     owner-only. Adding a new admin route therefore never leaks it to staff by accident.
//   - Nothing is ever deleted. Deactivating sets active:false + deactivatedAt; the record and its history stay.
//   - The record is re-read from the store on EVERY request (see requireAdmin in server.js), never trusted from the
//     token, so deactivating someone or narrowing their permissions takes effect immediately on tokens already out.
"use strict";
const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./auth");
const { ValidationError, EMAIL_RE } = require("./validate");

const KEY = "staff";
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;
const NAME_MAX = 80;
// "owner" is what GET /me reports for the environment account, which has no record here. No staff record may ever
// carry it, so the workspace can compare the two safely.
const OWNER_ID = "owner";
const newId = () => { let v; do { v = crypto.randomBytes(6).toString("hex"); } while (v === OWNER_ID); return v; };
const fail = (msg) => { throw new ValidationError(msg); };

// ---- The permission keys. These are a contract shared with the workspace UI: never rename one.
const PERMISSIONS = [
  { key: "charts", label: "Charts & clinical notes", description: "Patient charts (EMR), clinical notes, the AI scribe and intake forms. This is protected health information." },
  { key: "clients", label: "Clients", description: "Client and lead records, memberships and profiles." },
  { key: "scheduling", label: "Scheduling", description: "The calendar, appointments, classes, bookings and video visits." },
  { key: "messages", label: "Messages", description: "Messages with clients and push notifications." },
  { key: "billing", label: "Billing", description: "Payments, invoices, refunds and the economics screens." },
  { key: "content", label: "Content", description: "Site content, exercise videos, habits and the MD Fit guide." },
  { key: "reviews", label: "Reviews & feedback", description: "Google reviews, client feedback and feedback reports." },
  { key: "insights", label: "Insights", description: "Analytics, statistics, search analytics and the activity feed." },
  { key: "settings", label: "Settings", description: "Practice settings, hours, pricing and devices." },
  { key: "security", label: "Security & exports", description: "The audit ledger and data exports." },
  { key: "staff", label: "Staff", description: "Add staff accounts and set what each person can reach." }
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const LABELS = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));

// ---- Role presets. "owner" is deliberately NOT here: it is implicit and cannot be assigned.
const ROLES = {
  admin: { label: "Administrator", permissions: PERMISSION_KEYS.filter((k) => k !== "charts") },
  clinician: { label: "Clinician", permissions: ["charts", "clients", "scheduling", "messages", "content"] },
  frontdesk: { label: "Front desk", permissions: ["clients", "scheduling", "messages", "reviews"] }
};
const ROLE_KEYS = Object.keys(ROLES);

// ---- Which permission each admin route needs, by its first path segment (paths are relative to /api/admin).
// `null` means "any signed-in staff member". A segment that is absent is OWNER-ONLY — see the note at the top.
const ROUTE_PERMISSIONS = {
  // Protected health information
  "/emr": "charts", "/notes": "charts", "/scribe": "charts",
  // People
  "/clients": "clients", "/leads": "clients", "/members": "clients",
  // The diary
  "/appointments": "scheduling", "/calendar": "scheduling", "/bookings": "scheduling", "/busy": "scheduling",
  "/calsync": "scheduling", "/cal": "scheduling", "/classes": "scheduling", "/telehealth": "scheduling",
  // Talking to people
  "/messages": "messages", "/push": "messages", "/subscribers": "messages",
  // Money
  "/payments": "billing", "/invoices": "billing", "/refunds": "billing", "/economics": "billing",
  // What members see
  "/content": "content", "/videos": "content", "/habits": "content", "/guide": "content",
  // Reputation
  "/feedback": "reviews", "/reviews": "reviews", "/feedback-reports": "reviews",
  // Numbers
  "/analytics": "insights", "/stats": "insights", "/search-analytics": "insights", "/online": "insights",
  "/activity": "insights", "/email-log": "insights",
  // The practice
  "/settings": "settings", "/devices": "settings",
  // The ledger and the data
  "/audit": "security", "/export": "security",
  // This module
  "/staff": "staff",
  // Your own account: any signed-in staff member
  "/me": null
};

const hasRule = (seg) => Object.prototype.hasOwnProperty.call(ROUTE_PERMISSIONS, seg);
// The first path segment, lower-cased because Express matches routes case-insensitively by default:
// without this, GET /api/admin/EMR would reach the chart routes past a gate that saw an unknown segment.
function segmentOf(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts.length ? "/" + parts[0].toLowerCase() : "/";
}
// What a path needs: { open: true } | { need: "<permission>" } | { owner: true }
function needFor(path) {
  const seg = segmentOf(path);
  if (!hasRule(seg)) return { owner: true };
  const need = ROUTE_PERMISSIONS[seg];
  return need === null ? { open: true } : { need };
}

const DENY_OWNER = "Only the practice owner can do that.";
const denial = (need) => `Your account doesn't have the "${LABELS[need] || need}" permission. Ask the practice owner to turn it on.`;

function createStaff({ store, cfg, audit, logger, now = () => new Date() }) {
  const ownerEmail = () => String(cfg.adminEmail || "").trim().toLowerCase();
  const all = () => { const l = store.read(KEY, []); return Array.isArray(l) ? l : []; };
  const write = (l) => store.write(KEY, l);
  const clean = (e) => String(e || "").trim().toLowerCase();
  // The password hash never leaves the server. Everything that answers a request goes through this.
  const view = (s) => { const { passwordHash, ...rest } = s; return rest; };

  const byEmail = (email) => { const e = clean(email); return e ? all().find((s) => s.email === e) || null : null; };
  const byId = (sid) => (String(sid || "") === OWNER_ID ? null : all().find((s) => s.id === String(sid || "")) || null);

  // ---- Validation
  function checkPassword(password) {
    const p = String(password == null ? "" : password);
    if (p.length < PASSWORD_MIN) fail(`Password must be at least ${PASSWORD_MIN} characters.`);
    if (p.length > PASSWORD_MAX) fail("That password is too long.");
    return p;
  }
  function checkName(name) {
    const n = String(name || "").trim();
    if (!n) fail("Enter the person's name.");
    if (n.length > NAME_MAX) fail("That name is too long.");
    return n;
  }
  function checkRole(role) {
    const r = String(role || "").trim().toLowerCase();
    if (r === "owner") fail("The owner account can't be given to anyone: it lives in the host's variables.");
    if (!ROLE_KEYS.includes(r)) fail(`Choose a role: ${ROLE_KEYS.join(", ")}.`);
    return r;
  }
  // An address is never changed after the account is made, so this only has to guard the new one.
  function checkEmail(email) {
    const e = clean(email);
    if (!EMAIL_RE.test(e) || e.length > 254) fail("Enter a valid email address.");
    if (e === ownerEmail()) fail("That's the owner's email. The owner account isn't managed here.");
    if (all().some((s) => s.email === e)) fail("Someone already has an account with that email.");
    return e;
  }
  function checkPermissions(perms) {
    if (!Array.isArray(perms)) fail("Permissions must be a list.");
    const out = [];
    for (const p of perms) {
      const k = String(p || "").trim();
      if (!PERMISSION_KEYS.includes(k)) fail(`"${k}" isn't a permission.`);
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  // ---- No privilege escalation. Nobody may hand out authority they don't hold themselves; only the owner holds
  // everything. This is checked on create AND on update, and it covers role presets as well as explicit lists,
  // so an Administrator without `charts` can neither grant `charts` nor quietly give it to themselves.
  function escalation(actor, wanted) {
    if (actor && actor.isOwner) return null;
    const held = (actor && actor.permissions) || [];
    const missing = wanted.find((p) => !held.includes(p));
    return missing || null;
  }

  // ---- Reads
  const listFor = () => all().map(view).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const catalogue = () => ({
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, permissions: [...v.permissions] }])),
    permissions: PERMISSIONS.map((p) => ({ ...p }))
  });

  // ---- Writes. Each one records who did it in the tamper-evident ledger.
  const stamp = () => now().toISOString();
  function logIt(actor, action, subject, ip, meta = {}) {
    if (!audit) return;
    audit.record({ actor: `admin:${(actor && actor.email) || "unknown"}`, action, subject, ip, meta });
  }

  function create(actor, body = {}, ip = "") {
    const name = checkName(body.name);
    const email = checkEmail(body.email);
    const role = checkRole(body.role);
    const permissions = body.permissions === undefined ? [...ROLES[role].permissions] : checkPermissions(body.permissions);
    const over = escalation(actor, permissions);
    if (over) return { denied: over };
    const password = checkPassword(body.password);
    const rec = {
      id: newId(), name, email, passwordHash: hashPassword(password), role, permissions,
      active: true, mustChangePassword: true,
      createdAt: stamp(), createdBy: (actor && actor.email) || "", updatedAt: stamp(),
      lastLoginAt: "", deactivatedAt: ""
    };
    write([...all(), rec]);
    logIt(actor, "staff.create", rec.id, ip, { role, permissions });
    logger && logger.info("staff_created", { role, permissions: permissions.length });
    return { staff: view(rec) };
  }

  function update(actor, sid, body = {}, ip = "") {
    const list = all();
    const rec = list.find((s) => s.id === String(sid || ""));
    if (!rec) return { notFound: true };
    const self = !!actor && !actor.isOwner && actor.id === rec.id;
    const changed = {};

    if (body.name !== undefined) { rec.name = checkName(body.name); changed.name = rec.name; }

    // A staff member may not change their own role, their own permissions, or switch themselves off.
    const touchesAuthority = body.role !== undefined || body.permissions !== undefined || body.active !== undefined;
    if (self && touchesAuthority) return { self: true };

    let permissions = null;
    if (body.role !== undefined) { rec.role = checkRole(body.role); changed.role = rec.role; permissions = [...ROLES[rec.role].permissions]; }
    if (body.permissions !== undefined) permissions = checkPermissions(body.permissions);
    if (permissions) {
      // Only what is being ADDED needs to be within the actor's own authority; taking a permission away is always fine.
      const over = escalation(actor, permissions.filter((p) => !rec.permissions.includes(p)));
      if (over) return { denied: over };
      rec.permissions = permissions;
      changed.permissions = permissions;
    }
    if (body.active !== undefined) {
      const active = body.active === true || body.active === "true";
      if (active !== rec.active) {
        rec.active = active;
        rec.deactivatedAt = active ? "" : stamp();
        changed.active = active;
      }
    }
    rec.updatedAt = stamp();
    write(list);
    logIt(actor, "staff.update", rec.id, ip, changed);
    return { staff: view(rec) };
  }

  // Resetting someone's password hands you their account, so it is escalation by another road: only the owner,
  // or someone who already holds everything the target holds, may do it.
  function setPassword(actor, sid, password, ip = "") {
    const list = all();
    const rec = list.find((s) => s.id === String(sid || ""));
    if (!rec) return { notFound: true };
    const over = escalation(actor, rec.permissions || []);
    if (over) return { denied: over };
    const p = checkPassword(password);
    rec.passwordHash = hashPassword(p);
    rec.mustChangePassword = true;
    rec.updatedAt = stamp();
    write(list);
    logIt(actor, "staff.password_reset", rec.id, ip);
    return { staff: view(rec) };
  }

  // Deactivate. Never a hard delete: the record and everything it is attributed to stay in place.
  function deactivate(actor, sid, ip = "") {
    const list = all();
    const rec = list.find((s) => s.id === String(sid || ""));
    if (!rec) return { notFound: true };
    if (actor && !actor.isOwner && actor.id === rec.id) return { self: true };
    if (rec.active) { rec.active = false; rec.deactivatedAt = stamp(); }
    rec.updatedAt = stamp();
    write(list);
    logIt(actor, "staff.deactivate", rec.id, ip);
    return { staff: view(rec) };
  }

  // Someone changing their own password. Clears the "you must change this" flag the owner's reset set.
  function changeOwnPassword(actor, current, password, ip = "") {
    const list = all();
    const rec = list.find((s) => s.id === (actor && actor.id));
    if (!rec) return { notFound: true };
    if (!verifyPassword(String(current || ""), rec.passwordHash)) return { wrong: true };
    const p = checkPassword(password);
    rec.passwordHash = hashPassword(p);
    rec.mustChangePassword = false;
    rec.updatedAt = stamp();
    write(list);
    logIt(actor, "staff.password_change", rec.id, ip);
    return { ok: true };
  }

  // A successful sign-in. Returns the fresh record, or null if the account is missing, switched off or the
  // password is wrong.
  function authenticate(email, password) {
    const rec = byEmail(email);
    if (!rec || rec.active !== true) return null;
    if (!verifyPassword(String(password == null ? "" : password), rec.passwordHash)) return null;
    return rec;
  }
  function noteLogin(sid) {
    const list = all();
    const rec = list.find((s) => s.id === sid);
    if (!rec) return;
    rec.lastLoginAt = stamp();
    write(list);
  }

  return {
    PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_KEYS, ROUTE_PERMISSIONS, PASSWORD_MIN, OWNER_ID,
    needFor, denial, DENY_OWNER, view, byEmail, byId, listFor, catalogue,
    create, update, setPassword, deactivate, changeOwnPassword, authenticate, noteLogin,
    checkPassword
  };
}

// ---- The /api/admin/staff screens. The `staff` permission is already required by the gate on the admin router.
function mountStaff({ admin, staff, activity }) {
  const actorOf = (req) => req.account;
  const denied = (res, need) => res.status(403).json({ error: staff.denial(need), need });

  admin.get("/staff", (req, res) => res.json({ staff: staff.listFor(), ...staff.catalogue() }));

  admin.post("/staff", (req, res) => {
    const out = staff.create(actorOf(req), req.body || {}, req.ip);
    if (out.denied) return denied(res, out.denied);
    activity && activity("staff", { action: "created", email: out.staff.email, role: out.staff.role });
    res.status(201).json({ staff: out.staff });
  });

  admin.put("/staff/:id", (req, res) => {
    const out = staff.update(actorOf(req), req.params.id, req.body || {}, req.ip);
    if (out.notFound) return res.status(404).json({ error: "That staff account doesn't exist." });
    if (out.self) return res.status(403).json({ error: "You can't change your own role, permissions or access. Ask the practice owner.", need: "owner" });
    if (out.denied) return denied(res, out.denied);
    activity && activity("staff", { action: "updated", email: out.staff.email, role: out.staff.role });
    res.json({ staff: out.staff });
  });

  admin.post("/staff/:id/password", (req, res) => {
    const out = staff.setPassword(actorOf(req), req.params.id, (req.body || {}).password, req.ip);
    if (out.notFound) return res.status(404).json({ error: "That staff account doesn't exist." });
    if (out.denied) return denied(res, out.denied);
    activity && activity("staff", { action: "password-reset", email: out.staff.email });
    res.json({ ok: true, staff: out.staff });
  });

  admin.delete("/staff/:id", (req, res) => {
    const out = staff.deactivate(actorOf(req), req.params.id, req.ip);
    if (out.notFound) return res.status(404).json({ error: "That staff account doesn't exist." });
    if (out.self) return res.status(403).json({ error: "You can't switch off your own account. Ask the practice owner.", need: "owner" });
    activity && activity("staff", { action: "deactivated", email: out.staff.email });
    res.json({ staff: out.staff });
  });
}

module.exports = { createStaff, mountStaff, OWNER_ID, PERMISSIONS, PERMISSION_KEYS, ROLES, ROUTE_PERMISSIONS, PASSWORD_MIN, needFor, denial, DENY_OWNER };
