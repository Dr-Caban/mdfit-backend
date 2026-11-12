// Refunds: behind the owner's password every time, back to the card through Stripe, all or part, never twice.
// Made-up data and stand-ins for Stripe and the email service.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-refund-"));
  const made = [], refunds = [], mail = [], sessions = new Map();
  // one charge per checkout; "cus_other" owns ch_other
  const charges = new Map([["ch_other", { id: "ch_other", status: "succeeded", amount: 5000, amount_refunded: 0, customer: "cus_other" }], ["ch_mine", { id: "ch_mine", status: "succeeded", amount: 2100, amount_refunded: 0, customer: "cus_1" }]]);
  const stripeClient = {
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: {
      create: async (o) => { const id = "cs_r_" + (made.length + 1), ch = { id: "ch_" + id, status: "succeeded", amount: o.line_items[0].price_data.unit_amount, amount_refunded: 0, customer: o.customer || null }; made.push(o); charges.set(ch.id, ch); sessions.set(id, { id, status: "open", payment_status: "unpaid", metadata: o.metadata, customer: o.customer, client_reference_id: o.client_reference_id, amount_total: ch.amount, payment_intent: { id: "pi_" + id, latest_charge: ch } }); return { id, url: "https://pay.example.com/" + id }; },
      retrieve: async (id) => sessions.get(id) } },
    charges: { retrieve: async (id) => { const c = charges.get(id); if (!c) throw new Error("No such charge"); return c; }, list: async () => ({ data: [] }) },
    refunds: { create: async (o, opts) => { if (refunds.some((r) => r.key === opts.idempotencyKey)) return { id: "re_same" }; refunds.push({ ...o, key: opts.idempotencyKey }); const c = charges.get(o.charge); c.amount_refunded += o.amount; return { id: "re_" + refunds.length }; } },
    invoices: { list: async () => ({ data: [] }) }, paymentMethods: { list: async () => ({ data: [] }) },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) }
  };
  const post = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const j = JSON.parse(b); mail.push(...(Array.isArray(j) ? j : [j])); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","data":[]}'); }); }).listen(0);
  await new Promise((r) => post.once("listening", r));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-12T15:00:00Z"), calWatchMs: 0, siteUrl: "https://site.example.com",
    stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up", resendKey: "re_made_up", notifyFrom: "MD Fit <office@example.com>", resendUrl: `http://127.0.0.1:${post.address().port}`, notifyGapMs: 1 });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const hook = (sid) => { const s = sessions.get(sid); return fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "x" }, body: JSON.stringify({ id: "evt_" + sid, type: "checkout.session.completed", created: 1793200000, data: { object: { ...s, payment_intent: s.payment_intent.id, mode: "payment", status: "complete", payment_status: "paid" } } }) }); };
  const mails = async () => { await new Promise((r) => setTimeout(r, 500)); return mail.map((m) => ({ to: [].concat(m.to).join(","), subject: m.subject, text: m.text || "" })); };
  return { call, adminToken, signup, hook, mails, made, refunds, charges, sessions, close: () => { server.close(); post.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("refunds: the owner's password is asked every time; part or all goes back to the card once; cash is not refunded here", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), cal = await s.signup("Cal Client"), id = cal.client.id, u = "/api/admin/refunds";
  // an invoice on the chart, paid online
  const inv = (await s.call("POST", `/api/admin/emr/${id}/invoices`, { description: "Private matter", amount: 120 }, A)).body;
  await s.call("POST", `/api/admin/emr/${id}/invoices/${inv.id}/paylink`, {}, A);
  assert.equal((await s.hook("cs_r_1")).status, 200);
  const cash = (await s.call("POST", `/api/admin/emr/${id}/invoices`, { description: "Tape", amount: 18, method: "cash" }, A)).body;

  assert.equal((await s.call("POST", u, { clientId: id, invoiceId: inv.id, password: "admin-pass-123" })).status, 401, "staff only");
  assert.equal((await s.call("POST", u, { clientId: id, invoiceId: inv.id, password: "admin-pass-123" }, cal.token)).status, 401);
  // signed in is not enough: the password is checked for this refund
  const no = await s.call("POST", u, { clientId: id, invoiceId: inv.id }, A);
  assert.equal(no.status, 403); assert.match(no.body.error, /not the owner password/);
  assert.equal((await s.call("POST", u, { clientId: id, invoiceId: inv.id, password: "wrong" }, A)).status, 403);
  assert.equal(s.refunds.length, 0, "nothing moved");

  // part of it
  const part = await s.call("POST", u, { clientId: id, invoiceId: inv.id, amount: 20, password: "admin-pass-123" }, A);
  assert.equal(part.status, 200); assert.deepEqual(part.body, { ok: true, amount: 2000, left: 10000, total: 12000 });
  assert.deepEqual([s.refunds[0].charge, s.refunds[0].amount, s.refunds[0].reason], ["ch_cs_r_1", 2000, "requested_by_customer"]);
  let row = (await s.call("GET", `/api/admin/emr/${id}/billing`, undefined, A)).body.invoices.find((x) => x.number === inv.number);
  assert.equal(row.status, "paid"); assert.equal(row.refunded, 2000);
  // more than is left is refused; then the rest
  const over = await s.call("POST", u, { clientId: id, invoiceId: inv.id, amount: 150, password: "admin-pass-123" }, A);
  assert.equal(over.status, 400); assert.match(over.body.error, /up to \$100\.00/);
  const rest = await s.call("POST", u, { clientId: id, invoiceId: inv.id, password: "admin-pass-123" }, A);
  assert.equal(rest.body.amount, 10000); assert.equal(rest.body.left, 0);
  row = (await s.call("GET", `/api/admin/emr/${id}/billing`, undefined, A)).body.invoices.find((x) => x.number === inv.number);
  assert.equal(row.status, "refunded"); assert.equal(row.refunded, 12000);
  assert.equal((await s.call("POST", u, { clientId: id, invoiceId: inv.id, password: "admin-pass-123" }, A)).status, 400, "nothing left to refund");
  assert.equal((await s.call("PUT", `/api/admin/emr/${id}/invoices/${inv.id}`, { status: "void" }, A)).status, 400, "a refunded card payment is not then voided or marked unpaid");
  assert.equal(s.refunds.length, 2);
  assert.notEqual(s.refunds[0].key, s.refunds[1].key, "each refund has its own key, so the same one sent twice is one refund");

  // cash is settled by hand; a card payment listed for the client; one that belongs to someone else
  const c2 = await s.call("POST", u, { clientId: id, invoiceId: cash.id, password: "admin-pass-123" }, A);
  assert.equal(c2.status, 400); assert.match(c2.body.error, /cash or check/);
  assert.equal((await s.call("POST", u, { clientId: id, chargeId: "ch_mine", amount: 5, password: "admin-pass-123" }, A)).body.left, 1600);
  const other = await s.call("POST", u, { clientId: id, chargeId: "ch_other", password: "admin-pass-123" }, A);
  assert.equal(other.status, 400); assert.match(other.body.error, /doesn't belong to this client/); assert.equal(s.charges.get("ch_other").amount_refunded, 0);
  assert.equal((await s.call("POST", u, { clientId: id, chargeId: "../../x", password: "admin-pass-123" }, A)).status, 400);

  const mails = await s.mails();
  assert.equal(mails.filter((m) => m.to === "cal.client@example.com" && m.subject === "Your MD Fit refund").length, 3);
  assert.ok(mails.some((m) => /refund of \$20\.00/.test(m.text) && /5 to 10 business days/.test(m.text)));
  const log = JSON.stringify((await s.call("GET", "/api/admin/audit?action=refund", undefined, A)).body);
  assert.match(log, /refund\.issued/); assert.match(log, /refund\.denied/); assert.equal(/Private matter|4242|cus_/.test(log), false);
});

test("refunds: an invoice sent to someone without an account can be refunded too; wrong passwords are counted and then refused", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), u = "/api/admin/refunds";
  const g = (await s.call("POST", "/api/admin/invoices", { description: "Workshop seat", amount: 45, name: "Gia Guest", email: "gia@example.com" }, A)).body.invoices[0];
  const gid = g.url.match(/id=([0-9a-f]{32})/)[1];
  assert.equal((await s.call("POST", u, { linkId: g.id, password: "admin-pass-123" }, A)).status, 400, "not paid yet");
  await s.call("POST", `/api/invoices/${gid}/pay`, {}); assert.equal((await s.hook("cs_r_1")).status, 200);
  const r = await s.call("POST", u, { linkId: g.id, password: "admin-pass-123" }, A);
  assert.equal(r.status, 200); assert.equal(r.body.amount, 4500);
  const row = (await s.call("GET", "/api/admin/invoices", undefined, A)).body.invoices.find((x) => x.id === g.id);
  assert.equal(row.status, "refunded"); assert.equal(row.refunded, 4500);
  assert.equal((await s.call("GET", `/api/invoices/${gid}`)).body.status, "refunded");
  assert.equal((await s.call("POST", `/api/invoices/${gid}/pay`, {})).status, 410, "a refunded invoice does not take a new payment");
  assert.ok((await s.mails()).some((m) => m.to === "gia@example.com" && m.subject === "Your MD Fit refund"));
  // six wrong passwords, then even the right one waits
  for (let i = 0; i < 6; i++) assert.equal((await s.call("POST", u, { linkId: g.id, password: "guess" + i }, A)).status, 403);
  const locked = await s.call("POST", u, { linkId: g.id, password: "admin-pass-123" }, A);
  assert.equal(locked.status, 429); assert.match(locked.body.error, /fifteen minutes/);
});
