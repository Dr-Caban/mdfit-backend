// Memberships and their prices (the tiers in the content save) are money: lib/payments.js charges from them. The
// content save is behind the Content permission, which is also given to roles that are kept away from money
// (Developer, Manager) and to Clinicians. So a real change to the tiers is taken only from the owner or an account
// holding Billing; the same list sent back with some other content save (what the earlier admin does on every save)
// still goes through. Made-up data only.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-prices-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date("2026-11-12T15:00:00Z"), calWatchMs: 0, siteUrl: "https://site.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  const owner = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const staff = async (role) => { const email = `${role}@example.com`, made = await call("POST", "/api/admin/staff", { name: `${role} person`, email, role, password: "staff-pass-1234" }, owner); assert.equal(made.status, 201, JSON.stringify(made.body)); return (await call("POST", "/api/admin/login", { email, password: "staff-pass-1234" })).body.token; };
  const stored = () => { try { return fs.readFileSync(path.join(dataDir, "content.json"), "utf8"); } catch { return null; } };
  const put = (body, token) => call("PUT", "/api/admin/content", body, token);
  const tiers = async () => (await call("GET", "/api/content")).body.tiers;
  const prices = async () => (await tiers()).map((t) => [t.id, t.price]);
  return { call, owner, staff, stored, put, tiers, prices, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const REFUSED = { error: "Only the practice owner or an account with the Billing permission can change memberships and prices. Nothing was saved.", need: "billing" };
const BUILT_IN = [["member", 19.95], ["accountability", 29.95], ["expert", 50], ["premium", 200], ["premium-plus", 349]];
// What the earlier admin's Content form sends for the tiers on every save, changed or not: each tier as it was loaded,
// with the form's own fields laid over it (the accountability tick and the lowest price are always filled in)
const classicForm = (list) => list.map((t) => ({ ...t, accountability: !!t.accountability, floor: t.floor ?? 0 }));
// What the workspace's Membership types form sends: each tier as loaded, with the messaging tick always filled in
const workspaceForm = (list) => list.map((t) => ({ ...t, directMessages: !!t.directMessages }));

test("content: a Content account without Billing cannot change memberships or prices, and a refused save writes nothing", async (t) => {
  const s = await start(); t.after(s.close);
  const before = await s.tiers();
  assert.deepEqual(await s.prices(), BUILT_IN);
  for (const role of ["developer", "manager", "clinician"]) {
    const tok = await s.staff(role);
    const all = (await s.call("GET", "/api/admin/content", undefined, tok)).body;
    assert.ok(Array.isArray(all.tiers), `${role} holds Content`);
    const cheap = await s.put({ tiers: before.map((x) => (x.id === "member" ? { ...x, price: 1 } : x)) }, tok);
    assert.equal(cheap.status, 403, role); assert.deepEqual(cheap.body, REFUSED, role);
    // the same change inside a whole content save: nothing in that save is written, not the lecture either
    const whole = await s.put({ lectures: all.lectures.map((l, i) => (i ? l : { ...l, title: "Renamed with a price change" })), tiers: classicForm(before).map((x) => (x.id === "premium" ? { ...x, price: 2 } : x)) }, tok);
    assert.equal(whole.status, 403, role); assert.deepEqual(whole.body, REFUSED, role);
    assert.equal(s.stored(), null, "nothing was written");
    assert.deepEqual(await s.prices(), BUILT_IN, role);
    assert.notEqual((await s.call("GET", "/api/content")).body.lectures[0].title, "Renamed with a price change");
  }
  // every kind of change to the list is a change: a name, sessions, the credit, messaging, a perk, the order, one fewer, one more
  const dev = (await s.call("POST", "/api/admin/login", { email: "developer@example.com", password: "staff-pass-1234" })).body.token;
  const edit = (id, patch) => before.map((x) => (x.id === id ? { ...x, ...patch } : x));
  const changes = { name: edit("member", { name: "Membership Plus" }), sessions: edit("premium", { meetings: 3 }), minutes: edit("premium", { meetingMinutes: 45 }),
    "credit on": edit("member", { accountability: true, floor: 5 }), "credit off": edit("accountability", { accountability: false }), "lowest price": edit("accountability", { floor: 1 }),
    "messaging on": edit("member", { directMessages: true }), "messaging off": edit("premium", { directMessages: false }), perk: edit("member", { perks: [...before[0].perks, "A free massage"] }),
    order: [...before].reverse(), "one fewer": before.slice(0, -1), "one more": [...before, { id: "vip", name: "VIP", price: 5, meetings: 0, meetingMinutes: 0, perks: [] }], "one cent": edit("member", { price: 19.94 }),
    // Expert Advice has no sessions, so leaving its messaging out reads as no messaging (tiersOf): that is a change too
    "messaging left out": before.map(({ directMessages, ...x }) => (x.id === "expert" ? x : { ...x, directMessages })) };
  for (const [what, list] of Object.entries(changes)) { const r = await s.put({ tiers: list }, dev); assert.equal(r.status, 403, what); assert.deepEqual(r.body, REFUSED, what); }
  assert.equal(s.stored(), null); assert.deepEqual(await s.tiers(), before);
  // a list that would not pass the checks is still told what is wrong with it, as before
  assert.equal((await s.put({ tiers: [] }, dev)).status, 400);
  assert.equal((await s.put({ tiers: edit("member", { price: -1 }) }, dev)).status, 400);
});

test("content: the same memberships sent back with a content save go through, and that account's save leaves the tiers alone", async (t) => {
  const s = await start(); t.after(s.close);
  const dev = await s.staff("developer"), before = await s.tiers();
  const all = (await s.call("GET", "/api/admin/content", undefined, dev)).body;
  // the earlier admin: every list in one save, tiers included, only a lecture title edited
  const saved = await s.put({ live: all.live, lectures: all.lectures.map((l, i) => (i ? l : { ...l, title: "Renamed by the developer" })), recommendations: all.recommendations, tiers: classicForm(all.tiers), events: all.events || [] }, dev);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await s.call("GET", "/api/content")).body.lectures[0].title, "Renamed by the developer", "the rest of the save is kept");
  assert.deepEqual(await s.tiers(), before);
  let file = JSON.parse(s.stored());
  assert.equal("tiers" in file || "ownPrices" in file || "knownTiers" in file, false, "nothing about memberships was written by that account");
  // the workspace's Membership types form pressed with nothing edited is the same list too
  assert.equal((await s.put({ tiers: workspaceForm(before) }, dev)).status, 200);
  assert.equal((await s.put({ tiers: before }, dev)).status, 200);
  // a tier with 1-on-1 sessions that does not say whether it includes messaging is read as including it (tiersOf), as it is now
  assert.equal((await s.put({ tiers: before.map(({ directMessages, ...x }) => (x.meetings > 0 ? x : { ...x, directMessages })) }, dev)).status, 200);
  file = JSON.parse(s.stored()); assert.equal("tiers" in file, false);

  // after the owner sets a price, the same holds against the owner's list, and it stays exactly as the owner saved it
  const mine = before.map((x) => (x.id === "member" ? { ...x, price: 24.5 } : x));
  assert.equal((await s.put({ tiers: mine }, s.owner)).status, 200);
  assert.equal((await s.prices())[0][1], 24.5);
  const kept = JSON.stringify(JSON.parse(s.stored()).tiers);
  assert.equal((await s.put({ tiers: classicForm(await s.tiers()), lectures: all.lectures }, dev)).status, 200);
  assert.equal(JSON.stringify(JSON.parse(s.stored()).tiers), kept);
  assert.equal((await s.put({ tiers: classicForm(before) }, dev)).status, 403, "the built-in price is now a change");
  assert.equal((await s.prices())[0][1], 24.5);
});

test("content: the list is compared with the prices in effect, not with the raw file", async (t) => {
  const s = await start(); t.after(s.close);
  const dev = await s.staff("developer"), builtIn = await s.tiers();
  // a file saved before Nov 2026: the old round $20, which members are shown and charged as $19.95 (tiersOf)
  const old = builtIn.filter((x) => x.id !== "expert").map((x) => (x.id === "member" ? { ...x, price: 20 } : x));
  fs.writeFileSync(path.join(s.dataDir, "content.json"), JSON.stringify({ tiers: old }));
  assert.deepEqual(await s.prices(), BUILT_IN, "in effect: $19.95, and Expert Advice offered");
  assert.equal((await s.put({ tiers: classicForm(await s.tiers()) }, dev)).status, 200, "what is in effect, sent back");
  assert.deepEqual(JSON.parse(s.stored()), { tiers: old }, "and the file holds what it held: no price pinned, nothing marked");
  const up = await s.put({ tiers: old }, dev); // the raw file sent back would make $20 the price and drop Expert Advice
  assert.equal(up.status, 403); assert.deepEqual(up.body, REFUSED);
  assert.deepEqual(JSON.parse(s.stored()), { tiers: old }); assert.deepEqual(await s.prices(), BUILT_IN);
});

test("content: the owner and an account holding Billing change memberships and prices as before", async (t) => {
  const s = await start(); t.after(s.close);
  const before = await s.tiers();
  const viaOwner = await s.put({ tiers: before.map((x) => (x.id === "member" ? { ...x, price: 21 } : x)) }, s.owner);
  assert.equal(viaOwner.status, 200); assert.equal((await s.prices())[0][1], 21);
  let file = JSON.parse(s.stored());
  assert.deepEqual([file.tiers[0].price, file.ownPrices, file.knownTiers], [21, true, ["expert"]]);
  // the Administrator role holds Billing as well as Content
  const adm = await s.staff("admin");
  const me = (await s.call("GET", "/api/admin/me", undefined, adm)).body;
  assert.equal(me.isOwner, false); assert.ok(me.permissions.includes("billing") && me.permissions.includes("content"));
  const viaAdmin = await s.put({ tiers: (await s.tiers()).map((x) => (x.id === "member" ? { ...x, price: 22.5 } : x)) }, adm);
  assert.equal(viaAdmin.status, 200); assert.equal((await s.prices())[0][1], 22.5);
  // an unchanged list from them is saved as before as well
  assert.equal((await s.put({ tiers: classicForm(await s.tiers()) }, adm)).status, 200);
  file = JSON.parse(s.stored()); assert.equal(file.tiers[0].price, 22.5); assert.equal(file.ownPrices, true);
});
