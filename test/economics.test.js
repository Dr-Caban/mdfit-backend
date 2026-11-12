// System economics: totals read from Stripe's balance history, the invoices on the charts, the member list and the
// calendar, plus the running costs the owner keeps. Made-up data and a stand-in for Stripe.
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

const NOW = new Date("2026-11-12T15:00:00Z");
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
async function* each(rows) { for (const r of rows) yield r; }

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-econ-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => NOW, calWatchMs: 0, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const signup = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body;
  return { call, adminToken, signup, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("economics: staff only; with no Stripe key it says so and every other figure still comes from the records", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("GET", "/api/admin/economics")).status, 401);
  const A = await s.adminToken();
  const sam = await s.signup("Sam Sample"); await s.signup("Pat Paid");
  // two invoices on Sam's chart: one settled in cash, one still owed
  assert.equal((await s.call("POST", `/api/admin/emr/${sam.client.id}/invoices`, { amount: 120, description: "Private matter one", method: "cash" }, A)).status, 201);
  assert.equal((await s.call("POST", `/api/admin/emr/${sam.client.id}/invoices`, { amount: 80.5, description: "Private matter two" }, A)).status, 201);
  const r = await s.call("GET", "/api/admin/economics?months=6", undefined, A);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.months, ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.equal(r.body.currentMonth, "2026-11");
  assert.equal(r.body.stripe.on, false);
  assert.equal(r.body.outside["2026-11"], 12000, "the cash invoice counts as money taken outside Stripe");
  assert.deepEqual(r.body.owed, { count: 1, total: 8050 });
  assert.equal(r.body.people.total, 2); assert.equal(r.body.people.signups["2026-11"], 2);
  assert.equal(r.body.members.paying, 0); assert.equal(r.body.members.listMonthly, 0);
  assert.deepEqual(r.body.costs, []); assert.equal(r.body.costsMonthly, 0); assert.equal(r.body.systemMonthly, 0); assert.equal(r.body.expensesMonthly, 0);
  const whole = JSON.stringify(r.body);
  assert.equal(/Sam|Pat|example\.com|Private matter/.test(whole), false, "totals only: no names, addresses or invoice wording");
  assert.equal((await s.call("GET", "/api/admin/economics?months=99", undefined, A)).body.months.length, 12, "at most a year");
});

test("economics: Stripe's balance history gives what was taken, refunded and charged in fees, by month in clinic time", async (t) => {
  let asked = 0, sinceSeen = 0;
  const stripeClient = { balanceTransactions: { list: (q) => { asked++; sinceSeen = q.created.gte; return each([
    { type: "charge", currency: "usd", amount: 10000, fee: 320, created: at("2026-11-03T15:00:00Z") },
    { type: "charge", currency: "usd", amount: 1995, fee: 88, created: at("2026-11-05T15:00:00Z") },
    { type: "refund", currency: "usd", amount: -1995, fee: 0, created: at("2026-11-06T15:00:00Z") },
    { type: "stripe_fee", currency: "usd", amount: -200, fee: 0, created: at("2026-11-07T15:00:00Z") },
    { type: "payout", currency: "usd", amount: -9000, fee: 0, created: at("2026-11-08T15:00:00Z") },
    { type: "charge", currency: "usd", amount: 5000, fee: 175, created: at("2026-11-01T03:30:00Z") }, // 11:30 pm on Oct 31 in the clinic
    { type: "charge", currency: "eur", amount: 7777, fee: 1, created: at("2026-11-02T15:00:00Z") },
    { type: "charge", currency: "usd", amount: 4000, fee: 100, created: at("2026-01-02T15:00:00Z") } // before the months shown
  ]); } } };
  const s = await start({ stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" }); t.after(s.close);
  const A = await s.adminToken();
  const r = (await s.call("GET", "/api/admin/economics?months=3", undefined, A)).body;
  assert.equal(r.stripe.on, true); assert.equal(r.stripe.fees, true); assert.equal(r.stripe.error, undefined);
  assert.deepEqual(r.stripe.byMonth["2026-11"], { gross: 11995, refunds: 1995, fees: 320 + 88 + 200, other: 0, net: 11995 - 1995 - 608, payments: 2 }, "payouts and other currencies are left out");
  assert.deepEqual(r.stripe.byMonth["2026-10"], { gross: 5000, refunds: 0, fees: 175, other: 0, net: 4825, payments: 1 }, "a payment late on the 31st belongs to October");
  assert.equal(r.stripe.byMonth["2026-09"].gross, 0);
  assert.ok(sinceSeen <= at("2026-09-01T00:00:00Z"), "asked from the first month shown");
  await s.call("GET", "/api/admin/economics?months=3", undefined, A);
  assert.equal(asked, 1, "Stripe is not asked again within a few minutes");
});

test("economics: a key that may not read the balance history falls back to charges and says fees are unknown; a key that may read neither is reported plainly", async (t) => {
  const denied = () => { const e = new Error("The provided key 'rk_live_********abcd' does not have the required permissions"); e.type = "StripePermissionError"; e.statusCode = 403; throw e; };
  const stripeClient = { balanceTransactions: { list: denied }, charges: { list: () => each([
    { paid: true, status: "succeeded", currency: "usd", amount: 6000, amount_refunded: 1000, created: at("2026-11-04T15:00:00Z") },
    { paid: false, status: "failed", currency: "usd", amount: 9999, amount_refunded: 0, created: at("2026-11-04T15:00:00Z") }]) } };
  const s = await start({ stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" }); t.after(s.close);
  const A = await s.adminToken();
  const r = (await s.call("GET", "/api/admin/economics?months=3", undefined, A)).body;
  assert.equal(r.stripe.fees, false);
  assert.deepEqual(r.stripe.byMonth["2026-11"], { gross: 6000, refunds: 1000, fees: 0, other: 0, net: 5000, payments: 1 });

  const s2 = await start({ stripeClient: { balanceTransactions: { list: denied }, charges: { list: denied } }, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" }); t.after(s2.close);
  const r2 = await s2.call("GET", "/api/admin/economics?months=3", undefined, await s2.adminToken());
  assert.equal(r2.status, 200, "the rest of the screen still loads");
  assert.match(r2.body.stripe.error, /did not let this key read/);
  assert.equal(/rk_live|abcd/.test(JSON.stringify(r2.body)), false, "the processor's own wording, which describes the key, is never passed on");
  assert.equal(r2.body.stripe.byMonth["2026-11"].gross, 0);
});

test("economics: running costs are the owner's to keep: saved as a list, checked, staff only, and stored encrypted like everything else", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken(), u = "/api/admin/economics/costs";
  assert.equal((await s.call("PUT", u, { costs: [] })).status, 401);
  assert.equal((await s.call("PUT", u, { costs: "x" }, A)).status, 400);
  assert.equal((await s.call("PUT", u, { costs: [{ name: "", monthly: 5 }] }, A)).status, 400, "a cost needs a name");
  assert.equal((await s.call("PUT", u, { costs: [{ name: "Hosting", monthly: -1 }] }, A)).status, 400);
  assert.equal((await s.call("PUT", u, { costs: [{ name: "Hosting", monthly: "lots" }] }, A)).status, 400);
  assert.equal((await s.call("PUT", u, { costs: Array.from({ length: 41 }, (_, i) => ({ name: "c" + i, monthly: 1 })) }, A)).status, 400);
  const r = await s.call("PUT", u, { costs: [{ name: "  Server   hosting ", monthly: 20 }, { name: "Email", monthly: 0, kind: "system" }, { name: "Video", monthly: 9.99, kind: "nonsense" }, { name: "Rent", monthly: 1500, kind: "expense" }] }, A);
  assert.equal(r.status, 200); assert.equal(r.body.costsMonthly, 152999);
  assert.equal(r.body.systemMonthly, 2999, "what the software costs"); assert.equal(r.body.expensesMonthly, 150000, "everything else");
  assert.deepEqual(r.body.costs.map((x) => [x.name, x.kind, x.monthly]), [["Server hosting", "system", 2000], ["Email", "system", 0], ["Video", "system", 999], ["Rent", "expense", 150000]]);
  // editing keeps a line's id; a line left out is gone
  const first = r.body.costs[0];
  const r2 = await s.call("PUT", u, { costs: [{ id: first.id, name: "Server hosting", monthly: 25 }] }, A);
  assert.deepEqual(r2.body.costs, [{ id: first.id, name: "Server hosting", kind: "system", monthly: 2500 }]);
  const seen = (await s.call("GET", "/api/admin/economics", undefined, A)).body;
  assert.equal(seen.costsMonthly, 2500); assert.equal(seen.systemMonthly, 2500); assert.equal(seen.expensesMonthly, 0); assert.equal(seen.costs.length, 1);
  const log = JSON.stringify((await s.call("GET", "/api/admin/audit", undefined, A)).body);
  assert.match(log, /admin\.change \/economics\/costs/, "the change is in the ledger");
});
