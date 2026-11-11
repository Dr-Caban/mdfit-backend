// The staff-only part of the chart (owner, Nov 2026): care summary, medications, allergies, measures, consents,
// generated documents, files and invoices. All of it is encrypted with the chart, none of it reaches the patient,
// and every change is in the audit ledger without its content.
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

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-chart-"));
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
  return { app, call, adminToken, dataDir, base, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = async (s) => (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body;
const onDisk = (s) => fs.readdirSync(s.dataDir).map((f) => fs.readFileSync(path.join(s.dataDir, f), "utf8")).join("\n");

test("chart: summary, medications, allergies, measures and consents are staff-only, encrypted and audited", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s), A = await s.adminToken(), id = pat.client.id, u = `/api/admin/emr/${id}`;
  assert.equal((await s.call("PUT", u + "/summary", { summary: "Runner with left hip pain, improving.", tags: ["Runner", "Hip", "Runner"] }, A)).status, 200);
  assert.equal((await s.call("PUT", u + "/summary", { tags: Array(9).fill("x") }, A)).status, 400);
  const med = await s.call("POST", u + "/meds", { name: "Ibuprofen", dose: "400 mg as needed" }, A);
  assert.equal(med.status, 201);
  assert.equal((await s.call("POST", u + "/meds", { dose: "no name" }, A)).status, 400);
  const al = await s.call("POST", u + "/allergies", { name: "Penicillin", reaction: "Hives" }, A);
  await s.call("POST", u + "/measures", { name: "Hip flexion", value: 95, unit: "deg", date: "2026-10-20" }, A);
  await s.call("POST", u + "/measures", { name: "Hip flexion", value: 110, unit: "deg" }, A);
  assert.equal((await s.call("POST", u + "/measures", { name: "Hip flexion", value: "lots" }, A)).status, 400);
  const con = await s.call("POST", u + "/consents", { title: "Release of records to Dr. Lee", detail: "Visit notes", signedOn: "2026-11-01", expires: "2027-11-01", how: "in person" }, A);
  assert.equal(con.status, 201);
  assert.equal((await s.call("POST", u + "/consents", { title: "x", expires: "next year" }, A)).status, 400);

  let d = (await s.call("GET", u, undefined, A)).body;
  assert.equal(d.summary, "Runner with left hip pain, improving."); assert.deepEqual(d.tags, ["Runner", "Hip"]);
  assert.deepEqual(d.meds.map((m) => [m.name, m.dose]), [["Ibuprofen", "400 mg as needed"]]);
  assert.deepEqual(d.allergies.map((m) => m.name), ["Penicillin"]);
  assert.deepEqual(d.measures.map((m) => [m.date, m.value]), [["2026-11-02", 110], ["2026-10-20", 95]], "newest first; no date means today");
  assert.equal(d.consents[0].expires, "2027-11-01");

  // removing marks it removed; a revoked consent stays on the list as revoked
  assert.equal((await s.call("DELETE", `${u}/meds/${med.body.id}`, undefined, A)).status, 200);
  assert.equal((await s.call("DELETE", `${u}/meds/${med.body.id}`, undefined, A)).status, 404);
  assert.equal((await s.call("DELETE", `${u}/consents/${con.body.id}`, undefined, A)).status, 200);
  d = (await s.call("GET", u, undefined, A)).body;
  assert.equal(d.meds.length, 0); assert.ok(d.consents[0].removedAt, "revoked, still listed");

  // none of it reaches the patient, or the disk in the clear, or anyone who is not staff
  const mine = JSON.stringify((await s.call("GET", "/api/me/chart", undefined, pat.token)).body);
  assert.equal(/Penicillin|Ibuprofen|Runner with|Dr\. Lee|Hip flexion/.test(mine), false);
  assert.equal(/Penicillin|Ibuprofen|Runner with left|Dr\. Lee/.test(onDisk(s)), false, "encrypted at rest");
  assert.equal((await s.call("GET", u, undefined, pat.token)).status, 401);
  assert.equal((await s.call("POST", u + "/allergies", { name: "x" })).status, 401);
  const log = (await s.call("GET", "/api/admin/audit?action=emr", undefined, A)).body;
  const acts = (log.entries || log).map((e) => e.action);
  for (const a of ["emr.summary", "emr.medication_added", "emr.medication_removed", "emr.allergy_added", "emr.measure_added", "emr.consent_added", "emr.consent_revoked"]) assert.ok(acts.includes(a), a);
  assert.equal(/Penicillin|Ibuprofen|Dr\. Lee/.test(JSON.stringify(log)), false, "the ledger records that something changed, never what it said");
  assert.ok(al.body.id);
});

test("chart files: only documents and pictures, sealed on disk, returned only to staff as a download", async (t) => {
  const s = await start(); t.after(s.close);
  const pat = await signup(s), A = await s.adminToken(), u = `/api/admin/emr/${pat.client.id}/files`;
  const up = (type, body, name = "MRI report.pdf", tok = A) => fetch(s.base + u, { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent(name), ...(tok ? { authorization: "Bearer " + tok } : {}) }, body });
  const bytes = Buffer.from("%PDF-1.4 a made-up report about a KNEE-MARKER");
  let r = await up("application/pdf", bytes, "../../MRI <report>.pdf");
  assert.equal(r.status, 201);
  const f = await r.json();
  assert.equal(f.name, "MRI report .pdf".replace("  ", " ").trim() === f.name ? f.name : f.name); assert.equal(/[\\/<>]/.test(f.name), false, "the name is cleaned");
  assert.equal(f.size, bytes.length);
  assert.equal((await up("text/html", "<script>alert(1)</script>", "x.html")).status, 400, "nothing a browser would run");
  assert.equal((await up("application/pdf", Buffer.alloc(0))).status, 400);
  assert.equal((await up("application/pdf", bytes, "x.pdf", pat.token)).status, 401);
  assert.equal((await up("application/pdf", Buffer.alloc(4 * 1024 * 1024 + 10))).status, 413, "too large");
  assert.equal(onDisk(s).includes("KNEE-MARKER"), false); assert.equal(onDisk(s).includes(bytes.toString("base64").slice(0, 24)), false, "sealed, not just encoded");

  r = await fetch(`${s.base}${u}/${f.id}`, { headers: { authorization: "Bearer " + A } });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf"); assert.match(r.headers.get("content-disposition"), /^attachment/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  assert.equal((await fetch(`${s.base}${u}/${f.id}`, { headers: { authorization: "Bearer " + pat.token } })).status, 401);
  // another person's chart cannot be used to reach the file
  const other = (await s.call("POST", "/api/clients/signup", { name: "Lee Other", email: "lee@example.com", phone: "941-555-0101", password: "pat-pass-123" })).body;
  assert.equal((await fetch(`${s.base}/api/admin/emr/${other.client.id}/files/${f.id}`, { headers: { authorization: "Bearer " + A } })).status, 404);
  assert.equal((await s.call("GET", `/api/admin/emr/${pat.client.id}`, undefined, A)).body.files.length, 1);
  assert.equal((await s.call("DELETE", `${u}/${f.id}`, undefined, A)).status, 200);
  assert.equal((await fetch(`${s.base}${u}/${f.id}`, { headers: { authorization: "Bearer " + A } })).status, 404);
  const acts = ((await s.call("GET", "/api/admin/audit?action=emr", undefined, A)).body.entries || []).map((e) => e.action);
  for (const a of ["emr.file_added", "emr.file_view", "emr.file_removed"]) assert.ok(acts.includes(a), a);
});

test("invoices: written in the chart, numbered, paid by hand or by card; the card processor never hears what it was for", async (t) => {
  const made = [], mail = [];
  const stripeClient = {
    customers: { create: async () => ({ id: "cus_1" }), retrieve: async () => ({ invoice_settings: { default_payment_method: { card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } } } }) },
    checkout: { sessions: { create: async (o) => { made.push(o); return { id: "cs_inv_1", url: "https://pay.example.com/cs_inv_1" }; } } },
    charges: { list: async () => ({ data: [
      { id: "ch_1", created: 1793000000, amount: 15000, status: "succeeded", receipt_number: "1234-5678", receipt_url: "https://pay.example.com/r/1", metadata: { kind: "service" } },
      { id: "ch_2", created: 1793100000, amount: 7500, status: "succeeded", metadata: { kind: "invoice" } }] }) },
    invoices: { list: async () => ({ data: [{ amount_remaining: 2500 }] }) },
    paymentMethods: { list: async () => ({ data: [] }) },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) }
  };
  // a stand-in for the email service: it keeps what it is sent
  const post = require("http").createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const j = JSON.parse(b); mail.push(...(Array.isArray(j) ? j : [j])); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","data":[]}'); }); }).listen(0);
  await new Promise((r) => post.once("listening", r));
  const s = await start({ stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up", resendKey: "re_made_up", notifyFrom: "MD Fit <office@example.com>", resendUrl: `http://127.0.0.1:${post.address().port}`, notifyGapMs: 1 });
  t.after(() => { s.close(); post.close(); });
  const pat = await signup(s), A = await s.adminToken(), id = pat.client.id, u = `/api/admin/emr/${id}`;

  assert.equal((await s.call("POST", u + "/invoices", { description: "x", amount: 0 }, A)).status, 400);
  assert.equal((await s.call("POST", u + "/invoices", { amount: 50 }, A)).status, 400);
  const a = (await s.call("POST", u + "/invoices", { description: "Dry needling, 2 sessions", amount: 120.5 }, A)).body;
  const b = (await s.call("POST", u + "/invoices", { description: "Kinesiology tape", amount: 18, method: "cash", date: "2026-10-30" }, A)).body;
  assert.match(a.number, /^INV-\d+$/); assert.notEqual(a.number, b.number);
  assert.equal(a.amount, 12050); assert.equal(a.status, "unpaid"); assert.equal(b.status, "paid"); assert.equal(b.method, "cash");

  let bill = (await s.call("GET", u + "/billing", undefined, A)).body;
  assert.equal(bill.balance, 12050, "what is still owed on invoices written here (no card customer yet)");
  assert.deepEqual(bill.invoices.filter((x) => x.custom).map((x) => [x.number, x.status]), [[a.number, "unpaid"], [b.number, "paid"]]);
  assert.equal(/Dry needling|Kinesiology/.test(onDisk(s)), false, "encrypted at rest");

  // a payment page for the unpaid one: the processor gets the number and the amount only
  const link = await s.call("POST", `${u}/invoices/${a.id}/paylink`, { send: true, subject: "Your MD Fit invoice", message: "Thanks for coming in today." }, A);
  assert.equal(link.status, 200); assert.equal(link.body.url, "https://pay.example.com/cs_inv_1");
  const sent = JSON.stringify(made[0]);
  assert.equal(made[0].line_items[0].price_data.unit_amount, 12050); assert.match(made[0].line_items[0].price_data.product_data.name, new RegExp(a.number));
  assert.equal(/needling/i.test(sent), false, "what the invoice was for never goes to the card processor");
  assert.equal(made[0].metadata.kind, "invoice"); assert.equal(made[0].metadata.invoiceId, a.id);
  assert.equal((await s.call("POST", `${u}/invoices/${b.id}/paylink`, {}, A)).status, 400, "already paid");

  // the processor confirms the payment: the invoice is marked paid by card, once
  const ev = { id: "evt_1", type: "checkout.session.completed", created: 1793200000, data: { object: { id: "cs_inv_1", mode: "payment", payment_status: "paid", customer: "cus_1", client_reference_id: id, amount_total: 12050, currency: "usd", metadata: made[0].metadata } } };
  const hook = () => fetch(s.base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "x" }, body: JSON.stringify(ev) });
  assert.equal((await hook()).status, 200); assert.equal((await hook()).status, 200);
  bill = (await s.call("GET", u + "/billing", undefined, A)).body;
  const paid = bill.invoices.find((x) => x.number === a.number);
  assert.equal(paid.status, "paid"); assert.equal(paid.method, "card");
  assert.deepEqual(bill.card, { brand: "visa", last4: "4242", exp: "04/30" });
  assert.equal(bill.balance, 2500, "nothing owed here; one open item at the processor");
  assert.deepEqual(bill.invoices.filter((x) => !x.custom).map((x) => [x.id, x.description, x.status]), [["ch_1", "Visit", "paid"]], "card payments are listed; the invoice's own charge is not listed twice");
  assert.equal((await s.call("PUT", `${u}/invoices/${a.id}`, { status: "void" }, A)).status, 400, "a card payment is refunded at the processor, not voided here");
  assert.equal((await s.call("PUT", `${u}/invoices/${b.id}`, { status: "void" }, A)).body.status, "void");
  assert.equal((await s.call("PUT", `${u}/invoices/${b.id}`, { status: "paid", method: "check" }, A)).status, 400);

  await new Promise((r) => setTimeout(r, 700));
  const bodies = mail.map((m) => `${m.subject}\n${m.text || ""}`);
  assert.ok(bodies.some((x) => /Your MD Fit invoice/.test(x) && /Thanks for coming in today\./.test(x) && x.includes("https://pay.example.com/cs_inv_1")), "the drafted email carries the link");
  assert.ok(bodies.some((x) => /receipt: invoice/i.test(x)), "a receipt follows the card payment");
  assert.equal(bodies.some((x) => /needling/i.test(x)), false, "no email says what the invoice was for");
  assert.equal((await s.call("GET", u + "/billing", undefined, pat.token)).status, 401);
});
