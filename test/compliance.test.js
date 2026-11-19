// The compliance records and the safeguards the checklist reports on (lib/compliance.js, the staff session list in
// server.js, and the staff-side patient-rights routes in lib/hipaa.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-c-"));
  const cfg = { adminEmail: "owner@example.com", adminPasswordHash: hashPassword("owner-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date("2026-11-02T15:00:00Z"), siteUrl: "https://mdfit.example.com", trashTimer: false, ...extra };
  let server = createApp(cfg).listen(0); await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const call = async (method, url, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "content-type": "application/json", connection: "close", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const login = async (email, password) => (await call("POST", "/api/admin/login", { email, password })).body.token;
  const owner = await login("owner@example.com", "owner-pass-123");
  const mk = async (role, email = `${role}@example.com`) => { const r = await call("POST", "/api/admin/staff", { name: role + " person", email, role, password: "staff-pass-1234" }, owner); assert.equal(r.status, 201, JSON.stringify(r.body)); return login(email, "staff-pass-1234"); };
  const restart = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); server = createApp(cfg).listen(port); await new Promise((r) => server.once("listening", r)); };
  return { call, login, owner, mk, restart, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const row = (list, id) => list.rows.find((r) => r.id === id);

test("automatic logoff is enforced by the server: idle sessions end, sign-out ends a session, activity keeps one alive", async () => {
  const s = await start({ staffIdleMinutes: 0.01 }); // 600 ms
  try {
    let t = await s.login("owner@example.com", "owner-pass-123");
    assert.equal((await s.call("GET", "/api/admin/me", undefined, t)).status, 200);
    for (let i = 0; i < 4; i++) { await wait(300); assert.equal((await s.call("GET", "/api/admin/me", undefined, t)).status, 200, "a session in use stays open past the idle time"); }
    await wait(800);
    const idle = await s.call("GET", "/api/admin/me", undefined, t);
    assert.equal(idle.status, 401); assert.equal(idle.body.idle, true, "the same token is refused once it has sat idle");
    assert.equal((await s.call("GET", "/api/admin/me", undefined, t)).status, 401, "and it stays refused");
    // sign-out
    t = await s.login("owner@example.com", "owner-pass-123");
    assert.equal((await s.call("POST", "/api/admin/logout", {}, t)).status, 200);
    assert.equal((await s.call("GET", "/api/admin/me", undefined, t)).status, 401, "a signed-out token no longer works anywhere");
  } finally { s.close(); }
});

test("a staff session survives a restart while in use, and a token the server never issued a session for is refused", async () => {
  const s = await start({ staffIdleMinutes: 15 });
  try {
    const t = await s.login("owner@example.com", "owner-pass-123");
    assert.equal((await s.call("POST", "/api/admin/logout", {}, await s.login("owner@example.com", "owner-pass-123"))).status, 200); // forces the list to be saved
    await s.restart();
    assert.equal((await s.call("GET", "/api/admin/me", undefined, t)).status, 200, "a redeploy does not sign out someone who is working");
    const { signToken } = require("../lib/auth");
    const minted = signToken({ sub: "owner@example.com", exp: Date.now() + 3600e3 }, "s".repeat(40));
    assert.equal((await s.call("GET", "/api/admin/me", undefined, minted)).status, 401, "a correctly signed token with no session on the server is refused");
  } finally { s.close(); }
});

test("checklist: every row is worked out from the live state, and moves to met as the records are filled in", async () => {
  const s = await start({ dataKey: "k".repeat(40), backupPassphrase: "a long enough passphrase" });
  try {
    let c = (await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body;
    assert.equal(c.rows.length, 16);
    for (const id of ["risk", "officers", "baa", "training", "devices", "policies", "audit", "npp"]) assert.equal(row(c, id).status, "action", id);
    for (const id of ["rights", "breach", "access", "logoff", "encrypt", "retention"]) assert.equal(row(c, id).status, "met", id);
    assert.equal(row(c, "backup").status, "notmet", "no email service in this test, so the weekly backup cannot be sent: the checklist says so");
    assert.match(row(c, "backup").detail, /Email isn't set up/);
    assert.equal(c.summary.notmet, 1);
    assert.match(row(c, "baa").detail, /Railway/); assert.match(row(c, "baa").detail, /Vercel/);

    const add = async (type, body) => { const r = await s.call("POST", `/api/admin/compliance/registers/${type}`, body, s.owner); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
    await add("risk", { title: "Annual risk analysis", party: "Owner", date: "2026-10-20" });
    await s.call("PUT", "/api/admin/compliance/settings", { privacyOfficer: "Dr. Example", securityOfficer: "Dr. Example", nppVersion: "2026-1", nppUpdatedAt: "2026-01-01" }, s.owner);
    await add("baa", { title: "Railway BAA", party: "Railway", date: "2026-10-01", status: "signed" });
    const vercel = await add("baa", { title: "Vercel BAA", party: "Vercel", date: "2026-10-01", status: "requested" });
    c = (await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body;
    assert.equal(row(c, "baa").status, "action", "an agreement that was only requested does not count");
    assert.equal((await s.call("PATCH", `/api/admin/compliance/registers/baa/${vercel.id}`, { status: "signed" }, s.owner)).status, 200);
    await add("training", { title: "HIPAA basics", party: "owner@example.com", date: "2026-09-01" });
    await add("device", { title: "Front desk laptop", party: "Owner", status: "secured" });
    for (const p of (await s.call("GET", "/api/admin/compliance/registers", undefined, s.owner)).body.policies) await add("policy", { title: p, party: "Owner", date: "2026-10-01", status: "adopted" });
    await add("restore", { title: "Opened the Oct 26 backup, records present", party: "Owner", date: "2026-10-27" });
    assert.equal((await s.call("POST", "/api/admin/compliance/audit-review", { notes: "Nothing unusual." }, s.owner)).status, 201);
    c = (await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body;
    for (const id of ["risk", "officers", "baa", "training", "devices", "policies", "audit", "npp"]) assert.equal(row(c, id).status, "met", `${id}: ${row(c, id).detail}`);
    assert.equal(row(c, "auth").status, "action", "two-step sign-in is off here, so that row still asks for it");
    assert.equal(c.summary.met, 14);

    // a new staff member has no training on record: the row reopens
    await s.mk("clinician");
    c = (await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body;
    assert.equal(row(c, "training").status, "action"); assert.match(row(c, "training").detail, /1 of 2/);
    // a risk analysis more than a year old stops counting
    const old = (await s.call("GET", "/api/admin/compliance/registers", undefined, s.owner)).body.registers.risk[0];
    await s.call("PATCH", `/api/admin/compliance/registers/risk/${old.id}`, { date: "2025-10-01" }, s.owner);
    assert.equal(row((await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body, "risk").status, "action");
  } finally { s.close(); }
});

test("checklist reports a safeguard that is off: no data key, no backup passphrase", async () => {
  const s = await start({ backupPassphrase: "" });
  try {
    const c = (await s.call("GET", "/api/admin/compliance/checklist", undefined, s.owner)).body;
    assert.equal(row(c, "encrypt").status, "notmet"); assert.match(row(c, "encrypt").todo, /DATA_ENC_KEY/);
    assert.equal(row(c, "backup").status, "notmet");
    assert.ok(c.summary.notmet >= 2);
  } finally { s.close(); }
});

test("registers keep their history: entries are retired, never deleted, and every change is in the audit ledger", async () => {
  const s = await start();
  try {
    const e = (await s.call("POST", "/api/admin/compliance/registers/policy", { title: "Security policy", party: "Owner", date: "2026-10-01", status: "adopted" }, s.owner)).body;
    assert.equal((await s.call("DELETE", `/api/admin/compliance/registers/policy/${e.id}`, undefined, s.owner)).status, 404, "there is no delete");
    assert.equal((await s.call("PATCH", `/api/admin/compliance/registers/policy/${e.id}`, { retired: true }, s.owner)).status, 200);
    const reg = (await s.call("GET", "/api/admin/compliance/registers", undefined, s.owner)).body.registers.policy;
    assert.equal(reg.length, 1); assert.ok(reg[0].retiredAt, "the retired entry is still on the register");
    assert.equal((await s.call("POST", "/api/admin/compliance/registers/nonsense", { title: "x", date: "2026-10-01" }, s.owner)).status, 400);
    assert.equal((await s.call("POST", "/api/admin/compliance/registers/baa", { title: "x", date: "2026-10-01", status: "whatever" }, s.owner)).status, 400);
    const actions = (await s.call("GET", "/api/admin/audit?limit=50", undefined, s.owner)).body.entries.map((x) => x.action);
    assert.ok(actions.includes("compliance.policy.added")); assert.ok(actions.includes("compliance.policy.retired"));
  } finally { s.close(); }
});

test("who may open what: compliance and patient-rights records follow the role limits", async () => {
  const s = await start();
  try {
    const pat = (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
    const id = pat.client.id;
    await s.call("PUT", `/api/admin/emr/${id}/patient`, { active: true }, s.owner);
    await s.call("POST", `/api/admin/emr/${id}/notes`, { text: "Note for the patient" }, s.owner);
    await s.call("PUT", `/api/admin/emr/${id}/summary`, { summary: "Clinic-only summary" }, s.owner);
    const manager = await s.mk("manager"), developer = await s.mk("developer"), desk = await s.mk("frontdesk"), clin = await s.mk("clinician");
    for (const t of [manager, developer]) for (const u of ["/api/admin/compliance/checklist", "/api/admin/compliance/registers", "/api/admin/compliance/audit-review", "/api/admin/incidents", "/api/admin/amendments", "/api/admin/disclosures", `/api/admin/clients/${id}/records`])
      assert.equal((await s.call("GET", u, undefined, t)).status, 403, u);
    // the front desk has Clients but not Charts: a whole record, and its disclosure accounting, stay closed
    assert.equal((await s.call("GET", `/api/admin/clients/${id}/records`, undefined, desk)).status, 403);
    assert.equal((await s.call("GET", `/api/admin/clients/${id}/disclosures`, undefined, desk)).status, 403);
    assert.equal((await s.call("POST", `/api/admin/clients/${id}/amendments`, { record: "Visit note", request: "Wrong side" }, desk)).status, 403);
    // but they can record how a patient asked to be contacted, and a notice signed on paper
    assert.equal((await s.call("PUT", `/api/admin/clients/${id}/privacy`, { contactBy: "email", noVoicemail: true }, desk)).status, 200);
    const ack = await s.call("POST", `/api/admin/clients/${id}/privacy/acknowledge`, {}, desk);
    assert.equal(ack.status, 200); assert.equal(ack.body.npp.acknowledged, true);

    // a clinician exports the record: the chart is in it, clinic-only parts included
    const rec = await s.call("GET", `/api/admin/clients/${id}/records`, undefined, clin);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.chart.notes[0].text, "Note for the patient"); assert.equal(rec.body.chart.clinic.summary, "Clinic-only summary");
    assert.equal(rec.body.privacy.preferences.noVoicemail, true);
    // the patient's own copy has their notes and never the clinic-only part
    const mine = await s.call("GET", "/api/me/records", undefined, pat.token);
    assert.equal(mine.status, 200); assert.equal(mine.body.chart.notes[0].text, "Note for the patient"); assert.equal(mine.body.chart.clinic, undefined);
    assert.equal(JSON.stringify(mine.body).includes("Clinic-only summary"), false);

    // a correction asked for at the desk: logged by the clinician, on the 60-day clock, answered by the owner
    const am = await s.call("POST", `/api/admin/clients/${id}/amendments`, { record: "Visit note", request: "It was the right knee" }, clin);
    assert.equal(am.status, 201); assert.equal(am.body.dueAt, "2027-01-01"); assert.equal(am.body.status, "pending");
    assert.equal((await s.call("PATCH", `/api/admin/amendments/${am.body.id}`, { status: "denied" }, s.owner)).status, 400, "a denial must give its reason");
    assert.equal((await s.call("PATCH", `/api/admin/amendments/${am.body.id}`, { status: "accepted" }, s.owner)).status, 200);

    // the audit review counts the clinician's chart work and names nobody's patient
    const rv = (await s.call("GET", "/api/admin/compliance/audit-review", undefined, s.owner)).body;
    assert.equal(rv.chainOk, true);
    const c = rv.people.find((p) => p.who === "clinician@example.com"); assert.ok(c && c.exports >= 1);
    assert.equal(JSON.stringify(rv).includes("Pat Doe"), false);
  } finally { s.close(); }
});
