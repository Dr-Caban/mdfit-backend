// HIPAA patient rights and compliance records (lib/hipaa.js): right of access, accounting of disclosures, amendment
// requests, confidential-communication preferences, retention dry run, incident log, NPP acknowledgment.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { computeDeadlines } = require("../lib/hipaa");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-h-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const raw = (name) => fs.readFileSync(path.join(dataDir, name + ".json"), "utf8");
  return { call, adminToken, dataDir, raw, base, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });

test("right of access: a member downloads their own record, decrypted, audited, without session notes by default", async (t) => {
  const s = await start(); t.after(s.close);
  const su = (await signup(s)).body, tok = su.token, admin = await s.adminToken();
  const appt = (await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "09:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", notes: "left knee since March" })).body.appointment;
  await s.call("PATCH", `/api/admin/appointments/${appt.id}`, { adminNotes: "PRIVATE SESSION NOTE" }, admin);
  await s.call("POST", `/api/appointments/${appt.id}/intake/history`, { token: appt.cancelToken, conditions: ["Asthma / lung condition"], medications: "Albuterol inhaler", redFlags: "No" });
  await s.call("POST", `/api/admin/messages/${su.client.id}`, { body: "Hello, how is the knee?" }, admin); // a member may answer once Dr. Jared has written
  await s.call("POST", "/api/me/messages", { body: "Hello doctor, knee update" }, tok);
  await s.call("POST", "/api/me/pain", { area: "Knee", level: 4, note: "after stairs" }, tok);

  const r = await s.call("GET", "/api/me/records", undefined, tok);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-disposition"), /attachment; filename="mdfit-records-pat-doe-2026-11-02\.json"/);
  const rec = r.body;
  assert.equal(rec.profile.email, "pat@example.com");
  assert.equal(rec.appointments.length, 1);
  assert.equal(rec.appointments[0].notes, "left knee since March");
  assert.equal(rec.appointments[0].visitNotes, undefined, "session notes stay out of the self-service copy by default");
  assert.equal(rec.appointments[0].cancelToken, undefined);
  const hist = rec.intakeDocuments.find((d) => d.document === "Health history");
  assert.ok(hist, "intake answers are in the export");
  assert.ok(hist.answers.some((a) => a.value === "Albuterol inhaler"), "answers are decrypted");
  assert.deepEqual(rec.messages.map((m) => m.body), ["Hello, how is the knee?", "Hello doctor, knee update"]);
  assert.equal(rec.painLog[0].note, "after stairs");
  assert.equal(rec.privacy.noticeOfPrivacyPractices.acknowledged, false);

  const audit = (await s.call("GET", "/api/admin/audit?action=client.records", undefined, admin)).body.entries;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, `client:${su.client.id}`);
  assert.equal(audit[0].subject, su.client.id);
  assert.ok(!JSON.stringify(audit[0]).includes("Albuterol"), "the ledger holds ids, never content");

  // Admin export carries the session notes and the access log; another member can't see Pat's record
  const a = await s.call("GET", `/api/admin/clients/${su.client.id}/records`, undefined, admin);
  assert.equal(a.status, 200);
  assert.equal(a.body.appointments[0].visitNotes, "PRIVATE SESSION NOTE");
  assert.ok(a.body.accessLog.some((e) => e.what === "client.records.export"));
  assert.equal((await s.call("GET", `/api/admin/clients/${su.client.id}/records`, undefined, tok)).status, 401);
  const other = (await signup(s, { email: "other@example.com" })).body.token;
  const o = (await s.call("GET", "/api/me/records", undefined, other)).body;
  assert.equal(o.appointments.length, 0); assert.equal(o.messages.length, 0);

  // Owner switch: include session notes in the member's copy
  await s.call("PUT", "/api/admin/compliance/settings", { includeVisitNotesInMemberExport: true }, admin);
  assert.equal((await s.call("GET", "/api/me/records", undefined, tok)).body.appointments[0].visitNotes, "PRIVATE SESSION NOTE");
});

test("accounting of disclosures: recorded by Admin, encrypted at rest, visible to the member", async (t) => {
  const s = await start(); t.after(s.close);
  const su = (await signup(s)).body, tok = su.token, admin = await s.adminToken(), cid = su.client.id;
  assert.equal((await s.call("POST", `/api/admin/clients/${cid}/disclosures`, { recipient: "", purpose: "x", description: "y" }, admin)).status, 400);
  const d = await s.call("POST", `/api/admin/clients/${cid}/disclosures`, { recipient: "Sarasota Orthopedic Associates", purpose: "Referral records request", description: "Intake packet and visit notes, faxed", date: "2026-10-20", basis: "Patient authorization" }, admin);
  assert.equal(d.status, 201);
  assert.equal(d.body.recipient, "Sarasota Orthopedic Associates");
  const stored = s.raw("disclosures");
  assert.ok(!stored.includes("Sarasota Orthopedic") && !stored.includes("faxed"), "recipient, purpose and description are encrypted on disk");
  assert.ok(stored.includes("2026-10-20"), "the date stays searchable");

  const list = (await s.call("GET", `/api/admin/clients/${cid}/disclosures`, undefined, admin)).body;
  assert.equal(list.disclosures.length, 1);
  assert.equal(list.disclosures[0].purpose, "Referral records request");
  assert.equal(list.client.clientName, "Pat Doe");
  const all = (await s.call("GET", "/api/admin/disclosures", undefined, admin)).body;
  assert.equal(all[0].clientEmail, "pat@example.com");

  const mine = (await s.call("GET", "/api/me/disclosures", undefined, tok)).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].description, "Intake packet and visit notes, faxed");
  const other = (await signup(s, { email: "other@example.com" })).body.token;
  assert.equal((await s.call("GET", "/api/me/disclosures", undefined, other)).body.length, 0);
  assert.ok((await s.call("GET", "/api/admin/audit?action=admin.change", undefined, admin)).body.entries.some((e) => e.action === "admin.change /clients/:id/disclosures" && e.subject === cid));
});

test("amendment requests: 60-day due date, deny needs a reason, one 30-day extension, encrypted at rest", async (t) => {
  const s = await start(); t.after(s.close);
  const su = (await signup(s)).body, tok = su.token, admin = await s.adminToken();
  assert.equal((await s.call("POST", "/api/me/amendments", { record: "", request: "x" }, tok)).status, 400);
  const r = await s.call("POST", "/api/me/amendments", { record: "Health history", request: "My surgery was in 2019, not 2021", reason: "Typo on the form" }, tok);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "pending");
  assert.equal(r.body.dueAt, "2027-01-01", "60 days after Nov 2, 2026");
  assert.equal(r.body.daysLeft, 60);
  assert.ok(!s.raw("amendments").includes("surgery was in 2019"), "request text is encrypted on disk");

  const list = (await s.call("GET", "/api/admin/amendments?status=pending", undefined, admin)).body;
  assert.equal(list.length, 1); assert.equal(list[0].clientName, "Pat Doe"); assert.equal(list[0].request, "My surgery was in 2019, not 2021");
  assert.equal((await s.call("PATCH", `/api/admin/amendments/${r.body.id}`, { status: "denied" }, admin)).status, 400, "a denial must say why");
  const ext = await s.call("POST", `/api/admin/amendments/${r.body.id}/extend`, {}, admin);
  assert.equal(ext.status, 200); assert.equal(ext.body.dueAt, "2027-01-31");
  assert.equal((await s.call("POST", `/api/admin/amendments/${r.body.id}/extend`, {}, admin)).status, 400, "only one extension");
  const dec = await s.call("PATCH", `/api/admin/amendments/${r.body.id}`, { status: "accepted", reason: "Corrected the surgery year." }, admin);
  assert.equal(dec.status, 200); assert.equal(dec.body.status, "accepted"); assert.equal(dec.body.decidedBy, "coach@example.com");
  assert.equal((await s.call("PATCH", `/api/admin/amendments/${r.body.id}`, { status: "denied", reason: "again" }, admin)).status, 400, "already answered");
  const mine = (await s.call("GET", "/api/me/amendments", undefined, tok)).body;
  assert.equal(mine[0].decisionReason, "Corrected the surgery year.");
  assert.equal((await s.call("GET", "/api/admin/compliance", undefined, admin)).body.counts.pendingAmendments, 0);
});

test("privacy preferences (§164.522) are saved, encrypted, and shown to Admin; NPP acknowledgment reuses the intake consent", async (t) => {
  const s = await start(); t.after(s.close);
  const su = (await signup(s)).body, tok = su.token, admin = await s.adminToken(), cid = su.client.id;
  assert.equal((await s.call("PUT", "/api/me/privacy", { contactBy: "pigeon" }, tok)).status, 400);
  const p = await s.call("PUT", "/api/me/privacy", { contactBy: "email", noVoicemail: true, noText: false, restrictions: "Please don't share anything with my employer's wellness program." }, tok);
  assert.equal(p.status, 200); assert.equal(p.body.preferences.contactBy, "email"); assert.equal(p.body.preferences.noVoicemail, true);
  assert.ok(!s.raw("clients").includes("wellness program"), "the free-text request is encrypted on disk");
  const a = (await s.call("GET", `/api/admin/clients/${cid}/privacy`, undefined, admin)).body;
  assert.equal(a.preferences.restrictions, "Please don't share anything with my employer's wellness program.");
  assert.equal(a.npp.acknowledged, false);

  // The intake "Consent & policies" document already carries the privacy acknowledgment: no second ask
  const consent = { treatment: true, privacy: true, financial: true, signature: "Pat Doe" };
  await s.call("POST", "/api/me/intake/consent", consent, tok);
  const me = (await s.call("GET", "/api/me/privacy", undefined, tok)).body;
  assert.equal(me.npp.acknowledged, true); assert.equal(me.npp.via, "intake");
  assert.equal((await s.call("POST", "/api/me/privacy/acknowledge", {}, tok)).body.already, true);

  // A member with no intake can acknowledge from the account, and the Admin list shows who is missing
  const o = (await signup(s, { email: "other@example.com", name: "Sam Lee" })).body;
  let npp = (await s.call("GET", "/api/admin/compliance/npp", undefined, admin)).body;
  assert.equal(npp.acknowledged, 1); assert.deepEqual(npp.missing.map((m) => m.email), ["other@example.com"]);
  const ack = await s.call("POST", "/api/me/privacy/acknowledge", {}, o.token);
  assert.equal(ack.status, 201); assert.equal(ack.body.npp.via, "account");
  npp = (await s.call("GET", "/api/admin/compliance/npp", undefined, admin)).body;
  assert.equal(npp.missing.length, 0);
});

test("retention: settings default to 7 years and the dry run lists eligible records without deleting anything", async (t) => {
  const s = await start(); t.after(s.close);
  const admin = await s.adminToken();
  const c = (await s.call("GET", "/api/admin/compliance", undefined, admin)).body;
  assert.equal(c.settings.retentionYears, 7); assert.equal(c.settings.auditRetentionYears, 6);
  assert.equal((await s.call("PUT", "/api/admin/compliance/settings", { retentionYears: 0 }, admin)).status, 400);
  await s.call("PUT", "/api/admin/compliance/settings", { retentionYears: 5, privacyOfficer: "Dr. Jared Caban", lastRiskAnalysisAt: "2026-10-01" }, admin);
  // An old appointment and a recent one, written straight to the store (the API refuses past dates)
  const appts = [{ id: "old1", date: "2019-05-01", time: "09:00", typeName: "Eval", email: "x@example.com", status: "completed" }, { id: "new1", date: "2026-10-01", time: "09:00", typeName: "Eval", email: "x@example.com", status: "completed" }];
  fs.writeFileSync(path.join(s.dataDir, "appointments.json"), JSON.stringify(appts));
  const r = (await s.call("GET", "/api/admin/compliance/retention", undefined, admin)).body;
  assert.equal(r.dryRun, true); assert.equal(r.cutoff, "2021-11-02");
  const g = r.groups.find((x) => x.name.startsWith("Appointments"));
  assert.equal(g.total, 2); assert.equal(g.eligible, 1); assert.deepEqual(g.sample, ["old1"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, "appointments.json"), "utf8")).length, 2, "nothing was deleted");
  const after = (await s.call("GET", "/api/admin/compliance", undefined, admin)).body.settings;
  assert.equal(after.privacyOfficer, "Dr. Jared Caban"); assert.equal(after.retentionYears, 5);
});

test("incident log: deadlines computed (60 days, media >500 in a state, HHS, Florida 30 days), encrypted at rest", async (t) => {
  const s = await start(); t.after(s.close);
  const admin = await s.adminToken();
  const d = computeDeadlines({ discoveredAt: "2026-11-02", affectedCount: 12, states: [{ state: "FL", count: 12 }] });
  assert.equal(d.individuals.by, "2027-01-01");
  assert.equal(d.media.required, false);
  assert.equal(d.hhs.by, "2027-03-01", "under 500: annual log");
  assert.equal(d.floridaIndividuals.by, "2026-12-02"); assert.equal(d.floridaAttorneyGeneral.required, false);
  const big = computeDeadlines({ discoveredAt: "2026-11-02", affectedCount: 900, states: [{ state: "FL", count: 600 }, { state: "GA", count: 300 }] });
  assert.equal(big.media.required, true); assert.deepEqual(big.media.states, ["FL"]);
  assert.equal(big.hhs.by, "2027-01-01"); assert.equal(big.floridaAttorneyGeneral.required, true);

  assert.equal((await s.call("POST", "/api/admin/incidents", { title: "Lost laptop" }, admin)).status, 400, "discovery date required");
  const i = await s.call("POST", "/api/admin/incidents", { title: "Lost laptop", description: "Laptop with cached admin session left in a car", discoveredAt: "2026-11-01", affectedCount: 3, states: [{ state: "fl", count: 3 }],
    riskAssessment: { nature: "Names and visit dates", recipient: "Unknown", acquired: "Unknown", mitigation: "Session revoked, password rotated", conclusion: "pending" } }, admin);
  assert.equal(i.status, 201);
  assert.equal(i.body.deadlines.individuals.by, "2026-12-31");
  assert.equal(i.body.deadlines.floridaIndividuals.by, "2026-12-01");
  assert.deepEqual(i.body.states, [{ state: "FL", count: 3 }]);
  const stored = s.raw("incidents");
  assert.ok(!stored.includes("Lost laptop") && !stored.includes("password rotated"), "title, description and risk assessment are encrypted on disk");
  const u = await s.call("PATCH", `/api/admin/incidents/${i.body.id}`, { status: "closed", riskAssessment: { conclusion: "not-a-breach", mitigation: "Disk was encrypted; laptop recovered" }, notifications: { individualsAt: "2026-11-05" } }, admin);
  assert.equal(u.status, 200); assert.equal(u.body.status, "closed"); assert.equal(u.body.riskAssessment.conclusion, "not-a-breach"); assert.equal(u.body.notifications.individualsAt, "2026-11-05");
  assert.equal(u.body.title, "Lost laptop");
  assert.equal((await s.call("GET", "/api/admin/incidents", undefined, admin)).body.length, 1);
  assert.equal((await s.call("GET", "/api/admin/incidents")).status, 401);
});
