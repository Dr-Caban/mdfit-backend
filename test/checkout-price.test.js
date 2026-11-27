// Checkout charges the membership price the app shows. Saved tiers are read the way every other part of the server reads
// them (content.tiersOf): the old round prices move to the current ones and a tier added since the last save is there.
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

async function start(saved) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-price-"));
  if (saved) fs.writeFileSync(path.join(dataDir, "content.json"), JSON.stringify(saved));
  const calls = [];
  const fake = {
    customers: { create: async (p) => (calls.push(["customer", p]), { id: "cus_1" }) },
    prices: { list: async () => ({ data: [] }), create: async (p) => (calls.push(["price", p]), { id: "price_" + calls.length }) },
    products: { create: async (p) => (calls.push(["product", p]), { id: "prod_" + calls.length }) },
    checkout: { sessions: { create: async (p) => (calls.push(["session", p]), { id: "cs_" + calls.length, url: "https://checkout.stripe.com/c/pay/cs_test" }) } },
  };
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"],
    tz: "America/New_York", siteUrl: "https://mdfit.example.com", calWatchMs: 0, noVideoSync: true, noAffiliateJobs: true,
    stripeClient: fake, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const member = async (name) => (await call("POST", "/api/clients/signup", { name, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com", password: "made-up-pass-1" })).body.token;
  return { call, member, calls, close: () => { server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const priceOf = (s) => s.calls.filter((c) => c[0] === "price").map((c) => c[1].unit_amount);

test("checkout: tiers saved before the price change are charged at the price the app shows", async (t) => {
  // content saved with the old round prices and before Expert Advice existed; the owner never re-saved the tiers
  const old = { tiers: [{ id: "member", name: "Membership", price: 20, perks: ["Programs"] }, { id: "accountability", name: "Accountability", price: 30, accountability: true, perks: ["Check-ins"] }] };
  const s = await start(old); t.after(s.close);
  const shown = (await s.call("GET", "/api/content")).body.tiers;
  const memberShown = shown.find((x) => x.id === "member").price;
  assert.equal(memberShown, 19.95, "the app shows the current price");
  const tok = await s.member("Pat Payer");
  const r = await s.call("POST", "/api/me/checkout/membership", { tier: "member" }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(priceOf(s), [Math.round(memberShown * 100)], "charged what was shown, not the stored $20");
  // a tier added since that save can be bought too
  const expert = shown.find((x) => !old.tiers.some((o) => o.id === x.id));
  assert.ok(expert, "a tier the app shows that was not in the saved list");
  const e = await s.call("POST", "/api/me/checkout/membership", { tier: expert.id }, await s.member("Eve Expert"));
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(priceOf(s)[1], Math.round(expert.price * 100));
});

test("checkout: a price the owner set again themselves is the one charged", async (t) => {
  const s = await start({ ownPrices: true, tiers: [{ id: "member", name: "Membership", price: 20, perks: ["Programs"] }] });
  t.after(s.close);
  assert.equal((await s.call("GET", "/api/content")).body.tiers.find((x) => x.id === "member").price, 20);
  const r = await s.call("POST", "/api/me/checkout/membership", { tier: "member" }, await s.member("Oli Owner"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(priceOf(s), [2000]);
});
