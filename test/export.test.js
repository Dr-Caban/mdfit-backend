// Exporting client data: chosen clients or everyone, as a spreadsheet or as full records. Staff only, audited,
// and never anything that works as a key.
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

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-export-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (method, url, body, token) => fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (...a) => { const res = await raw(...a); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { raw, call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("export: a spreadsheet or full records, for chosen clients or everyone; staff only, audited, no keys", async (t) => {
  const s = await start(); t.after(s.close);
  const mk = async (name, email) => (await s.call("POST", "/api/clients/signup", { name, email, phone: "941-555-0100", password: "pat-pass-123" })).body;
  const pat = await mk("Pat Doe", "pat@example.com"), lee = await mk("Lee =SUM(A1)", "lee@example.com"); await mk("Kim Third", "kim@example.com");
  const A = await s.adminToken(), u = `/api/admin/emr/${pat.client.id}`;
  await s.call("PUT", u + "/summary", { summary: "Runner with hip pain.", tags: ["Runner"] }, A);
  await s.call("POST", u + "/allergies", { name: "Penicillin" }, A);
  await s.call("POST", u + "/measures", { name: "Hip flexion", value: 110, unit: "deg" }, A);
  await s.call("POST", u + "/invoices", { description: "Tape", amount: 18 }, A);
  await s.call("POST", u + "/notes", { text: "Do your heel slides." }, A);
  await s.call("POST", "/api/admin/notes", { clientId: pat.client.id, template: "soap", text: "S: standard note text." }, A);
  await s.call("POST", "/api/admin/notes", { clientId: pat.client.id, template: "free", tier: "T2", text: "restricted-marker" }, A);
  await s.call("PUT", `/api/admin/clients/${pat.client.id}/plan`, { guides: [], exercises: [{ name: "Hip phase 1", detail: "Couch stretch" }], notes: "Run 5k by January." }, A);
  await s.call("POST", "/api/me/intake/info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" }, pat.token);

  // staff only; a choice is required
  assert.equal((await s.call("POST", "/api/admin/export/clients", { all: true, kind: "csv" })).status, 401);
  assert.equal((await s.call("POST", "/api/admin/export/clients", { all: true, kind: "csv" }, pat.token)).status, 401);
  assert.equal((await s.call("POST", "/api/admin/export/clients", { kind: "csv" }, A)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/export/clients", { all: true }, A)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/export/clients", { ids: ["nobody"], kind: "csv" }, A)).status, 400);

  // the spreadsheet: everyone, one row each, and a cell that looks like a formula is defused
  let r = await s.raw("POST", "/api/admin/export/clients", { all: true, kind: "csv" }, A);
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/csv/); assert.match(r.headers.get("content-disposition"), /attachment; filename="?mdfit-clients-2026-11-02\.csv"?/); assert.equal(r.headers.get("cache-control"), "no-store");
  const csv = await r.text(), lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 4, "a header and three clients");
  assert.match(lines[0], /^name,email,phone,clientType,status/);
  assert.ok(lines.some((l) => /^Pat Doe,pat@example\.com/.test(l) && /Runner/.test(l) && /Penicillin/.test(l) && /18\.00$/.test(l)), "tags, alerts and what is owed");
  assert.ok(csv.includes("Lee =SUM(A1)"), "kept as text");
  // only the chosen ones
  r = await s.raw("POST", "/api/admin/export/clients", { ids: [lee.client.id], kind: "csv" }, A);
  assert.equal((await r.text()).trim().split("\r\n").length, 2);

  // full records for one client
  r = await s.raw("POST", "/api/admin/export/clients", { ids: [pat.client.id], kind: "records" }, A);
  assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /mdfit-client-records-2026-11-02\.json/);
  const text = await r.text(), out = JSON.parse(text), rec = out.clients[0];
  assert.equal(out.count, 1); assert.equal(rec.name, "Pat Doe");
  assert.equal(rec.chart.careSummary, "Runner with hip pain."); assert.deepEqual(rec.chart.allergiesAndAlerts.map((x) => x.name), ["Penicillin"]);
  assert.equal(rec.chart.measures[0].value, 110); assert.equal(rec.chart.invoices[0].amount, "18.00"); assert.equal(rec.chart.notesToPatient[0].text, "Do your heel slides.");
  assert.equal(rec.plan.treatmentPlan, "Run 5k by January."); assert.equal(rec.plan.protocols[0].name, "Hip phase 1");
  assert.ok(rec.newPatientDocuments.length >= 1, "the documents they filled out");
  const std = rec.clinicalNotes.find((n) => n.sensitivity === "T1"), high = rec.clinicalNotes.find((n) => n.sensitivity === "T2");
  assert.equal(std.text, "S: standard note text."); assert.equal(high.text, null); assert.match(high.note, /Restricted note/);
  assert.equal(text.includes("restricted-marker"), false, "a restricted note's text is not in the file");
  // nothing that works as a key
  assert.equal(/passwordHash|scrypt\$|cancelToken|resetCode|stripeCustomerId|cus_|pushTokens|referralCode/.test(text), false);
  assert.equal(text.includes(pat.token), false);

  // the ledger says an export happened and how big, never what was in it
  const log = (await s.call("GET", "/api/admin/audit?action=export", undefined, A)).body;
  const rows = (log.entries || log).filter((e) => e.action === "export.clients");
  assert.equal(rows.length, 3);
  assert.ok(rows.some((e) => e.meta.kind === "records" && e.meta.count === 1 && e.subject === pat.client.id) && rows.some((e) => e.meta.all === true && e.meta.count === 3));
  assert.equal(/Penicillin|Runner with/.test(JSON.stringify(log)), false);
});
