"use strict";
// The Progress calendar carries invoices, card payments and membership dates, and the member's app is told when any
// visit or class booking of theirs changes, however it was saved.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mountMemberCalendar } = require("../lib/member-calendar");

function setup({ client, charges = [], invoices = [], links = [] } = {}) {
  const data = { appointments: [], bookings: [] }, sent = [], routes = {};
  const store = { read: (k, f) => (k in data ? JSON.parse(JSON.stringify(data[k])) : f), write: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
  const people = [client, { id: "c2", email: "other@example.com", emailVerifiedAt: "2026-01-01" }];
  const vals = {
    rt: { emitToClient: (id, ev, d) => sent.push([id, ev, d.why]) },
    payApi: { billing: async () => ({ charges }) },
    emrApi: { chartOf: () => ({ clinic: { invoices } }) },
    invoiceLinks: { all: () => links }
  };
  const app = { get: (k) => vals[k], set: (k, v) => { vals[k] = v; } };
  const me = { get: (p, fn) => { routes[p] = fn; } };
  const api = mountMemberCalendar({ app, me, store, clients: () => people, tiers: () => [{ id: "member", name: "MD Fit Membership" }], debounceMs: 0 });
  const call = async () => { let out; await routes["/calendar"]({ client: client }, { set() {}, json: (x) => { out = x; } }); return out.entries; };
  return { store, sent, api, call, app };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("calendar: invoices, payments and the membership become dated entries", async () => {
  const client = { id: "c1", email: "a@example.com", emailVerifiedAt: "2026-01-01", stripeCustomerId: "cus_1",
    membership: { tier: "member", since: "2026-10-03", until: "2026-12-03", stripeSubscriptionId: "sub_1", status: "active" } };
  const { call } = setup({
    client,
    invoices: [
      { id: "i1", number: "1001", date: "2026-11-02", amount: 12000, status: "unpaid", description: "Dry needling" },
      { id: "i2", number: "1002", date: "2026-11-05", amount: 5000, status: "paid", paidAt: "2026-11-09T15:00:00Z" },
      { id: "i3", number: "1003", date: "2026-11-06", amount: 900, status: "void" }
    ],
    links: [{ id: "L1", clientId: "c1", invoiceId: "i1" }],
    charges: [{ date: "2026-11-03", amount: 4900, description: "Membership", status: "paid", receiptUrl: "https://pay.stripe.com/r/1" },
      { date: "2026-11-10", amount: 15000, description: "Visit", status: "failed" }]
  });
  const e = await call(), on = (d) => e.filter((x) => x.date === d).map((x) => `${x.k}|${x.t}|${x.s}`);
  assert.deepEqual(on("2026-11-02"), ["bill|Invoice 1001: $120.00|Unpaid · Dry needling"]);
  assert.equal(e.find((x) => x.date === "2026-11-02").path, "/invoice?id=L1");
  assert.deepEqual(on("2026-11-05"), ["bill|Invoice 1002: $50.00|Paid later"]);
  assert.deepEqual(on("2026-11-09"), ["bill|Paid invoice 1002|$50.00"]);
  assert.deepEqual(on("2026-11-06"), [], "void invoices are left off");
  assert.deepEqual(on("2026-11-03"), ["plan|Membership: $49.00|Paid"]);
  assert.deepEqual(on("2026-11-10"), ["bill|Visit: $150.00|Payment didn't go through"]);
  assert.deepEqual(on("2026-10-03"), ["plan|MD Fit Membership started|Membership"]);
  assert.deepEqual(on("2026-12-03"), ["plan|MD Fit Membership renews|Billed to the card on file"]);

  client.membership.cancelAtPeriodEnd = true;
  assert.equal((await call()).find((x) => x.date === "2026-12-03").t, "MD Fit Membership ends");
  delete client.membership.stripeSubscriptionId;
  assert.equal((await call()).find((x) => x.date === "2026-12-03").t, "MD Fit Membership paid through");
});

test("calendar: a booking saved anywhere tells only its own member's app", async () => {
  const client = { id: "c1", email: "a@example.com", emailVerifiedAt: "2026-01-01" };
  const { store, sent } = setup({ client });
  store.write("appointments", [{ id: "a1", clientId: "c1", date: "2026-11-20", status: "booked" }]);
  await tick();
  assert.deepEqual(sent, [["c1", "calendar_changed", "visit"]]);
  sent.length = 0;
  // Unchanged rows send nothing; a cancelled one does, matched by a verified email when the row has no account id
  store.write("appointments", [{ id: "a1", clientId: "c1", date: "2026-11-20", status: "booked" }, { id: "a2", email: "Other@Example.com", status: "booked" }]);
  await tick();
  assert.deepEqual(sent, [["c2", "calendar_changed", "visit"]]);
  sent.length = 0;
  store.write("bookings", [{ id: "b1", email: "a@example.com", date: "2026-11-21" }]);
  await tick();
  assert.deepEqual(sent, [["c1", "calendar_changed", "class"]]);
  sent.length = 0;
  store.write("bookings", []); // removed
  await tick();
  assert.deepEqual(sent, [["c1", "calendar_changed", "class"]]);
  sent.length = 0;
  store.write("clients", [{ id: "c1" }]); // other stores are not watched
  await tick();
  assert.deepEqual(sent, []);
});

test("calendar: calendarChanged is shared on the app and debounces per member", async () => {
  const client = { id: "c1", email: "a@example.com" };
  const { sent, app } = setup({ client });
  const cc = app.get("calendarChanged");
  cc("c1", "workout"); cc("c1", "workout"); cc(null);
  await tick();
  assert.deepEqual(sent, [["c1", "calendar_changed", "workout"]]);
});
