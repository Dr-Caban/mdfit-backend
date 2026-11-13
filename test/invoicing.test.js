// Invoice generator: drafted once, sent to one person or many, paid only on Stripe's word.
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

async function start({ stripe = true, email = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-invgen-"));
  const made = [], mail = [], sessions = new Map(), expiredIds = [];
  const stripeClient = {
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: {
      create: async (o) => { const id = "cs_i_" + (made.length + 1); made.push(o); sessions.set(id, { id, status: "open", payment_status: "unpaid", metadata: o.metadata, customer: o.customer, client_reference_id: o.client_reference_id, amount_total: o.line_items[0].price_data.unit_amount }); return { id, url: "https://pay.example.com/" + id }; },
      retrieve: async (id) => { const s = sessions.get(id); if (!s) throw new Error("No such session"); return s; },
      expire: async (id) => { expiredIds.push(id); const s = sessions.get(id); if (s && s.status === "open") s.status = "expired"; return s; } } },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) }
  };
  const post = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const j = JSON.parse(b); mail.push(...(Array.isArray(j) ? j : [j])); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","data":[]}'); }); }).listen(0);
  await new Promise((r) => post.once("listening", r));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-12T15:00:00Z"), calWatchMs: 0, siteUrl: "https://site.example.com",
    ...(stripe ? { stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" } : {}),
    ...(email ? { resendKey: "re_made_up", notifyFrom: "MD Fit <office@example.com>", resendUrl: `http://127.0.0.1:${post.address().port}`, notifyGapMs: 1 } : {}) });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  const hook = (sid, n = "") => { const s = sessions.get(sid); return fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "x" }, body: JSON.stringify({ id: "evt_" + sid + n, type: "checkout.session.completed", created: 1793200000, data: { object: { ...s, mode: "payment", status: "complete", payment_status: "paid" } } }) }); };
  const mails = async () => { await new Promise((r) => setTimeout(r, 500)); return mail.map((m) => ({ to: [].concat(m.to).join(","), subject: m.subject, text: m.text || "" })); };
  return { call, adminToken, signup, hook, mails, made, sessions, expiredIds, dataDir, close: () => { server.close(); post.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const idOf = (url) => url.match(/id=([0-9a-f]{32})/)[1];

test("invoice generator: one draft, many people. Clients get it on their chart, others get one of their own, and nobody is sent two", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), cal = await s.signup("Cal Client"), dee = await s.signup("Dee Client"), u = "/api/admin/invoices";
  assert.equal((await s.call("GET", u)).status, 401); assert.equal((await s.call("POST", u, { description: "x", amount: 5, name: "a", email: "a@example.com" })).status, 401);
  for (const bad of [{ amount: 20, name: "Gia", email: "gia@example.com" }, { description: "Workshop", amount: 0.1, name: "Gia", email: "gia@example.com" }, { description: "Workshop", amount: 20, name: "Gia", email: "nope" },
    { description: "Workshop", amount: 20, email: "gia@example.com" }, { description: "Workshop", amount: 20, recipients: [] }, { description: "Workshop", amount: 20, recipients: Array.from({ length: 51 }, (_, i) => ({ name: "P" + i, email: `p${i}@example.com` })) },
    { description: "Workshop", amount: 20, recipients: [{ name: "Ann", email: "ann@example.com" }, { name: "", email: "b@example.com" }] }])
    assert.equal((await s.call("POST", u, bad, A)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await s.call("GET", u, undefined, A)).body.invoices.length, 0, "a draft with a bad line creates nothing");

  const r = await s.call("POST", u, { description: "Shoulder mobility workshop, Dec 5", amount: 45, subject: "Your spot at the workshop", message: "Looking forward to seeing you.", send: true,
    recipients: [{ clientId: cal.client.id }, { name: "Gia Guest", email: "Gia@Example.com" }, { name: "Gia Again", email: "gia@example.com" }, { name: "Typed In", email: "dee.client@example.com" }] }, A);
  assert.equal(r.status, 201); assert.equal(r.body.created, 3, "the same address twice is one invoice"); assert.equal(r.body.sent, 3);
  const [c1, g1, d1] = r.body.invoices;
  assert.equal(new Set(r.body.invoices.map((x) => x.number)).size, 3); assert.ok(r.body.invoices.every((x) => /^INV-\d+$/.test(x.number) && x.status === "unpaid" && x.amount === 4500));
  assert.equal(c1.clientId, cal.client.id); assert.equal(g1.clientId, null); assert.equal(g1.email, "gia@example.com");
  assert.equal(d1.clientId, dee.client.id, "someone typed in who has an account still gets it on their chart"); assert.equal(d1.name, "Dee Client");
  // on the client's chart like any other invoice
  const bill = (await s.call("GET", `/api/admin/emr/${cal.client.id}/billing`, undefined, A)).body;
  assert.deepEqual(bill.invoices.filter((x) => x.custom).map((x) => [x.number, x.description, x.amount, x.status]), [[c1.number, "Shoulder mobility workshop, Dec 5", 4500, "unpaid"]]);
  assert.equal(bill.balance, 4500);

  const mails = await s.mails();
  const sent = mails.filter((m) => m.subject === "Your spot at the workshop");
  assert.deepEqual(sent.map((m) => m.to).sort(), ["cal.client@example.com", "dee.client@example.com", "gia@example.com"]);
  const toGia = sent.find((m) => m.to === "gia@example.com");
  assert.ok(/Hi Gia,/.test(toGia.text) && /Looking forward to seeing you\./.test(toGia.text) && toGia.text.includes(g1.url) && toGia.text.includes(`Invoice ${g1.number}: $45.00`));
  assert.equal(sent.some((m) => /workshop, Dec 5|mobility/i.test(m.text)), false, "the email carries the number, the amount and your own words: not what the invoice is for");
  const log = JSON.stringify((await s.call("GET", "/api/admin/audit?action=invoice", undefined, A)).body);
  assert.match(log, /invoice\.generated/); assert.equal(/workshop|gia@|Guest/i.test(log), false, "the ledger holds the invoice number, not what it was or whose");
  // a client sees their own unpaid invoice in the app (for the bell and its Pay button); nobody else's, and never a guest's
  const mine = await s.call("GET", "/api/me/invoices", undefined, cal.token);
  assert.deepEqual(mine.body.invoices.map((x) => [x.number, x.amount, /^\/invoice\?id=[0-9a-f]{32}$/.test(x.path)]), [[c1.number, 4500, true]]);
  assert.equal(typeof mine.body.invoices[0].description, "string"); assert.ok(mine.body.invoices[0].description.length > 0, "the signed-in member is told what their own invoice is for (Sunny says it on the device)");
  assert.equal((await s.call("GET", "/api/me/invoices")).status, 401);
  await s.call("POST", `${u}/${c1.id}/status`, { status: "paid", method: "cash" }, A);
  assert.deepEqual((await s.call("GET", "/api/me/invoices", undefined, cal.token)).body.invoices, [], "once it is paid it is gone from the app");
  await s.call("POST", `${u}/${c1.id}/status`, { status: "unpaid" }, A);
  // the money screen counts what is owed, chart or not
  assert.deepEqual((await s.call("GET", "/api/admin/economics", undefined, A)).body.owed, { count: 3, total: 13500 });
});

test("invoice generator: the link is the key to a page that gives little away, and only Stripe's word marks it paid: once", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), cal = await s.signup("Cal Client"), u = "/api/admin/invoices";
  const made = (await s.call("POST", u, { description: "Custom brace fitting", amount: 120.5, message: "Thanks for coming in.", recipients: [{ name: "Gia Guest", email: "gia@example.com" }, { clientId: cal.client.id }] }, A)).body.invoices;
  const g = made[0], c = made[1], gid = idOf(g.url), cid = idOf(c.url);
  assert.equal(g.emailedAt, null, "created without sending"); assert.equal(g.url, `https://site.example.com/invoice?id=${gid}`);

  const pub = await s.call("GET", `/api/invoices/${gid}`);
  assert.deepEqual(pub.body, { number: g.number, amount: 12050, firstName: "Gia", message: "Thanks for coming in.", status: "unpaid" });
  assert.equal((await s.call("GET", "/api/invoices/" + "0".repeat(32))).status, 404); assert.equal((await s.call("GET", "/api/invoices/not-an-id")).status, 404);

  // paying: Stripe is told the number and the amount, never what it is for
  const pay = await s.call("POST", `/api/invoices/${gid}/pay`, {});
  assert.equal(pay.body.url, "https://pay.example.com/cs_i_1");
  const o = s.made[0];
  assert.equal(o.line_items[0].price_data.unit_amount, 12050); assert.equal(o.line_items[0].price_data.product_data.name, `MD Fit invoice ${g.number}`);
  assert.equal(o.customer_email, "gia@example.com"); assert.equal(o.metadata.kind, "invoice_link"); assert.equal(o.metadata.linkId, gid);
  assert.equal(o.success_url, `https://site.example.com/invoice?id=${gid}&paid=1`); assert.equal(/brace|fitting/i.test(JSON.stringify(o)), false);
  // the browser coming back and saying "paid" changes nothing while Stripe says unpaid
  assert.equal((await s.call("POST", `/api/invoices/${gid}/confirm`, { paid: true })).body.status, "unpaid");
  // Stripe confirms, twice: paid once, one receipt
  assert.equal((await s.hook("cs_i_1")).status, 200); assert.equal((await s.hook("cs_i_1", "b")).status, 200);
  assert.equal((await s.call("GET", `/api/invoices/${gid}`)).body.status, "paid");
  const again = await s.call("POST", `/api/invoices/${gid}/pay`, {}); assert.equal(again.status, 409); assert.equal(s.made.length, 1, "a paid invoice cannot be paid twice");

  // a client's: pays as their Stripe customer, and the chart's invoice is what gets marked paid.
  // No webhook this time: they closed the page after paying, and this server asks Stripe itself.
  await s.call("POST", `/api/invoices/${cid}/pay`, {}); await s.call("POST", `/api/invoices/${cid}/pay`, {});
  assert.equal(s.made[1].customer, "cus_1"); assert.equal(s.made[1].customer_email, undefined);
  Object.assign(s.sessions.get("cs_i_3"), { status: "complete", payment_status: "paid" });
  assert.equal((await s.call("POST", `/api/invoices/${cid}/confirm`, {})).body.status, "paid");
  const onChart = (await s.call("GET", `/api/admin/emr/${cal.client.id}/billing`, undefined, A)).body.invoices.find((x) => x.number === c.number);
  assert.equal(onChart.status, "paid"); assert.equal(onChart.method, "card");
  // a checkout that belongs to another link can never pay for this one
  const other = (await s.call("POST", u, { description: "Other", amount: 10, name: "Otto Other", email: "otto@example.com" }, A)).body.invoices[0], oid = idOf(other.url);
  await s.call("POST", `/api/invoices/${oid}/pay`, {});
  Object.assign(s.sessions.get("cs_i_4"), { status: "complete", payment_status: "paid", metadata: { kind: "invoice_link", linkId: gid } });
  assert.equal((await s.call("POST", `/api/invoices/${oid}/confirm`, {})).body.status, "unpaid");

  const list = (await s.call("GET", u, undefined, A)).body.invoices;
  assert.deepEqual(list.map((x) => [x.number, x.status, x.method]), [[other.number, "unpaid", ""], [c.number, "paid", "card"], [g.number, "paid", "card"]]);
  // opened inside the app: Stripe comes back through /app-return to the same invoice page
  const viaApp = await s.call("POST", `/api/invoices/${oid}/pay`, { ui: "app" });
  assert.equal(viaApp.status, 200);
  const last = s.made[s.made.length - 1];
  assert.equal(last.success_url, `https://site.example.com/app-return?to=${encodeURIComponent(`/invoice?id=${oid}&paid=1`)}&session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(last.cancel_url, `https://site.example.com/app-return?cancel=1&to=${encodeURIComponent(`/invoice?id=${oid}`)}`);
  const mails = await s.mails();
  assert.equal(mails.filter((m) => m.to === "gia@example.com" && /receipt: invoice/i.test(m.subject)).length, 1, "one receipt, however many times Stripe says so");
  assert.equal(mails.filter((m) => m.to === "cal.client@example.com" && /receipt: invoice/i.test(m.subject)).length, 1);
  assert.ok(mails.some((m) => /Invoice paid: Gia Guest/.test(m.subject)), "the owner is told");
  assert.equal(mails.some((m) => /brace|fitting/i.test(m.text)), false);
});

test("invoice generator: paid another way, voided, sent again; voiding closes the payment page and money that still lands is never lost track of", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), cal = await s.signup("Cal Client"), u = "/api/admin/invoices";
  const [g, c, h] = (await s.call("POST", u, { description: "Taping supplies", amount: 18, recipients: [{ name: "Gia Guest", email: "gia@example.com" }, { clientId: cal.client.id }, { name: "Hal Helper", email: "hal@example.com" }] }, A)).body.invoices;
  // cash at the desk
  assert.equal((await s.call("POST", `${u}/${g.id}/status`, { status: "paid" }, A)).status, 400, "say how it was paid");
  const cash = (await s.call("POST", `${u}/${g.id}/status`, { status: "paid", method: "cash" }, A)).body;
  assert.equal(cash.status, "paid"); assert.equal(cash.method, "cash");
  assert.equal((await s.call("POST", `/api/invoices/${idOf(g.url)}/pay`, {})).status, 409);
  assert.equal((await s.call("POST", `${u}/${g.id}/send`, {}, A)).status, 400, "nothing to send once it is paid");
  assert.equal((await s.call("GET", "/api/admin/economics", undefined, A)).body.outside["2026-11"], 1800, "cash from someone without an account still counts as money taken");
  // a client's, marked paid by check here: it is the chart's invoice that changes
  assert.equal((await s.call("POST", `${u}/${c.id}/status`, { status: "paid", method: "check" }, A)).body.method, "check");
  assert.equal((await s.call("GET", `/api/admin/emr/${cal.client.id}/billing`, undefined, A)).body.invoices.find((x) => x.number === c.number).status, "paid");
  // sent again with new words, then voided while its payment page is open
  const re = await s.call("POST", `${u}/${h.id}/send`, { subject: "A reminder", message: "Whenever you get a chance." }, A);
  assert.equal(re.status, 200); assert.ok(re.body.emailedAt);
  await s.call("POST", `/api/invoices/${idOf(h.url)}/pay`, {});
  assert.equal((await s.call("POST", `${u}/${h.id}/status`, { status: "void" }, A)).body.status, "void");
  assert.deepEqual(s.expiredIds, ["cs_i_1"], "the open payment page was closed at Stripe");
  assert.equal((await s.call("POST", `/api/invoices/${idOf(h.url)}/pay`, {})).status, 410);
  assert.equal((await s.call("GET", `/api/invoices/${idOf(h.url)}`)).body.status, "void");
  // the payment went through anyway: marked paid, flagged, and the owner is told
  assert.equal((await s.hook("cs_i_1")).status, 200);
  const late = (await s.call("GET", u, undefined, A)).body.invoices.find((x) => x.id === h.id);
  assert.equal(late.status, "paid"); assert.equal(late.afterVoid, true);
  assert.equal((await s.call("POST", `${u}/${h.id}/status`, { status: "void" }, A)).status, 400, "a card payment is refunded at Stripe, not voided here");
  const mails = await s.mails();
  assert.ok(mails.some((m) => m.subject === "A reminder" && /Whenever you get a chance\./.test(m.text)));
  assert.ok(mails.some((m) => /Paid after you voided it/.test(m.subject) && /refund it in Stripe/.test(m.text)));
});

test("invoice generator: with card payments or email off it says so, and invoices can still be written and collected by hand", async (t) => {
  const s = await start({ stripe: false, email: false }); t.after(s.close);
  const A = await s.adminToken(), u = "/api/admin/invoices";
  const send = await s.call("POST", u, { description: "Workshop", amount: 20, name: "Gia Guest", email: "gia@example.com", send: true }, A);
  assert.equal(send.status, 503); assert.match(send.body.error, /not switched on/);
  const made = await s.call("POST", u, { description: "Workshop", amount: 20, name: "Gia Guest", email: "gia@example.com" }, A);
  assert.equal(made.status, 201);
  const g = made.body.invoices[0];
  assert.equal((await s.call("POST", `/api/invoices/${idOf(g.url)}/pay`, {})).status, 503);
  assert.equal((await s.call("POST", `${u}/${g.id}/status`, { status: "paid", method: "cash" }, A)).body.status, "paid");
  const list = (await s.call("GET", u, undefined, A)).body; assert.equal(list.payments, false); assert.equal(list.email, false);
});
