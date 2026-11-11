// Clinical notes: staff-only drafts that are signed and locked, with dated addenda afterwards.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-notes-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s, over = {}) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123", ...over });
const TEXT = "Subjective: right knee stiff in the morning.\nObjective: flexion 110 degrees.\nAssessment: improving.\nPlan: heel slides twice a day.";

test("clinical note: draft, autosave, sign and lock, addendum; the patient never sees it", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const pat = (await signup(s)).body, cid = pat.client.id;

  assert.equal((await s.call("GET", `/api/admin/notes?clientId=${cid}`)).status, 401, "staff only");
  assert.equal((await s.call("GET", "/api/admin/notes", undefined, A)).status, 400);
  assert.equal((await s.call("POST", "/api/admin/notes", { clientId: "nope", text: "x" }, A)).status, 404);
  assert.equal((await s.call("POST", "/api/admin/notes", { clientId: cid, template: "psychiatry" }, A)).status, 400);

  const made = await s.call("POST", "/api/admin/notes", { clientId: cid, template: "soap", tier: "T1", tags: ["Soft tissue", "Home program", "Soft tissue"], text: "first words" }, A);
  assert.equal(made.status, 201); assert.equal(made.body.status, "draft"); assert.deepEqual(made.body.tags, ["Soft tissue", "Home program"]);
  const id = made.body.id;

  // autosave edits the draft
  const saved = await s.call("PUT", `/api/admin/notes/${id}`, { text: TEXT, template: "followup" }, A);
  assert.equal(saved.status, 200); assert.equal(saved.body.text, TEXT); assert.equal(saved.body.template, "followup");
  assert.equal((await s.call("PUT", `/api/admin/notes/${id}`, { text: "x".repeat(20001) }, A)).status, 400);

  // sealed at rest
  const stored = fs.readFileSync(path.join(s.dataDir, "clinical-notes.json"), "utf8");
  assert.equal(/heel slides|flexion/.test(stored), false, "note text is never stored in the clear");

  // an addendum needs a signed note; signing needs text
  assert.equal((await s.call("POST", `/api/admin/notes/${id}/addendum`, { text: "later" }, A)).status, 409);
  const empty = (await s.call("POST", "/api/admin/notes", { clientId: cid }, A)).body;
  assert.equal((await s.call("POST", `/api/admin/notes/${empty.id}/sign`, {}, A)).status, 400);
  assert.equal((await s.call("DELETE", `/api/admin/notes/${empty.id}`, undefined, A)).status, 200, "a draft can be discarded");

  const signed = await s.call("POST", `/api/admin/notes/${id}/sign`, {}, A);
  assert.equal(signed.status, 200); assert.equal(signed.body.status, "signed"); assert.equal(signed.body.signedBy, "coach@example.com"); assert.ok(signed.body.signedAt);

  // locked: no edit, no second signature, no delete
  assert.equal((await s.call("PUT", `/api/admin/notes/${id}`, { text: "rewritten" }, A)).status, 409);
  assert.equal((await s.call("POST", `/api/admin/notes/${id}/sign`, {}, A)).status, 409);
  assert.equal((await s.call("DELETE", `/api/admin/notes/${id}`, undefined, A)).status, 409);
  assert.equal((await s.call("GET", `/api/admin/notes/${id}`, undefined, A)).body.text, TEXT, "the signed text is unchanged");

  // addendum is added underneath, dated, and the original stays
  assert.equal((await s.call("POST", `/api/admin/notes/${id}/addendum`, { text: "  " }, A)).status, 400);
  const add = await s.call("POST", `/api/admin/notes/${id}/addendum`, { text: "Patient called: swelling after stairs." }, A);
  assert.equal(add.status, 201); assert.equal(add.body.text, TEXT); assert.equal(add.body.addendaList.length, 1);
  assert.equal(add.body.addendaList[0].by, "coach@example.com"); assert.ok(add.body.addendaList[0].at);

  // the ledger holds the fingerprint of what was signed, and no text
  const log = (await s.call("GET", "/api/admin/audit?action=notes", undefined, A)).body;
  const entries = log.entries || log;
  const sig = entries.find((e) => e.action === "notes.sign");
  assert.equal(sig.subject, cid); assert.equal(sig.meta.sha256, crypto.createHash("sha256").update(TEXT, "utf8").digest("hex"));
  assert.ok(entries.some((e) => e.action === "notes.create") && entries.some((e) => e.action === "notes.addendum") && entries.some((e) => e.action === "notes.discard"));
  assert.equal(JSON.stringify(entries).includes("heel slides"), false);

  // nothing of it reaches the patient
  const mine = (await s.call("GET", "/api/me/chart", undefined, pat.token)).body;
  assert.deepEqual(mine.notes, []);
  assert.equal(JSON.stringify((await s.call("GET", "/api/me", undefined, pat.token)).body).includes("flexion"), false);
  assert.equal((await s.call("GET", `/api/admin/notes?clientId=${cid}`, undefined, pat.token)).status, 401, "a patient token cannot read staff notes");
});

test("clinical note: sensitive tiers are withheld from lists and opening one is logged", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const cid = (await signup(s)).body.client.id;
  await s.call("POST", "/api/admin/notes", { clientId: cid, tier: "T1", text: "routine visit" }, A);
  const t2 = (await s.call("POST", "/api/admin/notes", { clientId: cid, tier: "T2", text: "sensitive detail" }, A)).body;
  const list = (await s.call("GET", `/api/admin/notes?clientId=${cid}`, undefined, A)).body.notes;
  assert.equal(list.length, 2);
  const row = list.find((n) => n.id === t2.id);
  assert.equal(row.withheld, true); assert.equal(row.text, undefined, "the list never carries a sensitive note's text");
  assert.equal(list.find((n) => n.tier === "T1").text, "routine visit");
  assert.equal((await s.call("GET", `/api/admin/notes/${t2.id}`, undefined, A)).body.text, "sensitive detail");
  const entries = ((await s.call("GET", "/api/admin/audit?action=notes.open", undefined, A)).body.entries) || [];
  assert.ok(entries.some((e) => e.action === "notes.open" && e.meta.note === t2.id && e.meta.tier === "T2"));
});

test("clinical note: one that cannot be opened is never saved over, signed or added to", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const cid = (await signup(s)).body.client.id;
  const n = (await s.call("POST", "/api/admin/notes", { clientId: cid, text: "years of history" }, A)).body;
  const { cipher } = require("../lib/messages");
  const f = path.join(s.dataDir, "clinical-notes.json"), list = JSON.parse(fs.readFileSync(f, "utf8"));
  const foreign = cipher(["some-other-key-entirely"]).enc(JSON.stringify({ text: "years of history", addenda: [] }));
  list[0].data = foreign; fs.writeFileSync(f, JSON.stringify(list));
  const got = (await s.call("GET", `/api/admin/notes/${n.id}`, undefined, A)).body;
  assert.equal(got.unreadable, true);
  assert.equal((await s.call("PUT", `/api/admin/notes/${n.id}`, { text: "new text" }, A)).status, 409);
  assert.equal((await s.call("POST", `/api/admin/notes/${n.id}/sign`, {}, A)).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8"))[0].data, foreign, "the stored note is untouched");
});
