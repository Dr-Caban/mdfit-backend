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
  const app = { get: (k, fn) => { if (fn) { routes[k] = fn; return; } return vals[k]; }, set: (k, v) => { vals[k] = v; } };
  const me = { get: (p, fn) => { routes[p] = fn; }, post: (p, fn) => { routes["POST " + p] = fn; } };
  const api = mountMemberCalendar({ app, me, store, clients: () => people, save: () => {}, tiers: () => [{ id: "member", name: "MD Fit Membership" }], debounceMs: 0,
    cfg: { siteUrl: "https://www.mymdfit.com", tz: "America/New_York" }, zonedToUtc: (d, t) => new Date(`${d}T${t}:00-05:00`) });
  const call = async () => { let out; await routes["/calendar"]({ client: client }, { set() {}, json: (x) => { out = x; } }); return out.entries; };
  return { store, sent, api, call, app, routes, data, people };
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

test("calendar feed: a private link for the phone's calendar, titles only, and a new link retires the old", async () => {
  // The feed carries the last 90 days and what is ahead, counted from today, so every date here is counted from today
  // too: a member since seven weeks ago who renews in ten days, an invoice from last week. (Fixed dates fell out of
  // the 90 days as the year went on.)
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const client = { id: "c1", email: "a@example.com", emailVerifiedAt: "2026-01-01",
    membership: { tier: "member", since: day(-50), until: day(10), stripeSubscriptionId: "sub_1", status: "active" } };
  const { routes, data, store } = setup({ client, invoices: [{ id: "i1", number: "INV-1001", date: day(-6), amount: 12000, status: "unpaid", description: "Dry needling, left shoulder" }] });
  const soon = day(3), old = day(-200);
  store.write("appointments", [
    { id: "a1", clientId: "c1", date: soon, time: "15:00", minutes: 30, typeName: "Dry needling follow-up", status: "booked" },
    { id: "a2", clientId: "c1", date: soon, time: "09:00", typeName: "Video consult", typeId: "telehealth", status: "booked" },
    { id: "a3", clientId: "c1", date: soon, time: "11:00", typeName: "Eval", status: "cancelled" },
    { id: "a4", clientId: "c1", date: old, time: "11:00", typeName: "Eval", status: "booked" },
    { id: "a5", clientId: "c2", date: soon, time: "12:00", typeName: "Someone else", status: "booked" }]);
  data.classes = [{ id: "k1", title: "Mobility, Core; Breath", time: "18:00", durationMin: 45 }];
  store.write("bookings", [{ id: "b1", classId: "k1", email: "A@example.com", date: soon }]);
  const json = async (fn, req) => { let out; await fn(req, { set() {}, json: (x) => { out = x; } }); return out; };
  const link = await json(routes["/calendar/feed"], { client });
  assert.match(link.url, /^https:\/\/www\.mymdfit\.com\/api\/calendar-feed\/[a-f0-9]{48}\.ics$/);
  assert.equal(link.webcal, link.url.replace("https:", "webcal:"));
  assert.equal((await json(routes["/calendar/feed"], { client })).url, link.url, "the same link until it is reset");
  const get = async (file) => { const r = { status: 200, type: "", body: "" }; await routes["/api/calendar-feed/:file"]({ params: { file } }, { set() { return this; }, status(n) { r.status = n; return this; }, type(t) { r.type = t; return this; }, send(b) { r.body = b; } }); return r; };
  const token = link.url.split("/").pop();
  const r = await get(token);
  assert.equal(r.status, 200); assert.match(r.type, /text\/calendar/);
  const body = r.body;
  assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n") && body.endsWith("END:VCALENDAR\r\n"));
  assert.ok(body.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded");
  assert.match(body, /SUMMARY:MD Fit visit\r\n/); assert.match(body, /SUMMARY:MD Fit video visit\r\n/);
  assert.match(body, new RegExp(`DTSTART:${soon.replace(/-/g, "")}T200000Z`), "15:00 Eastern in UTC");
  assert.match(body, /SUMMARY:MD Fit class: Mobility\\, Core\\; Breath/);
  assert.match(body, /SUMMARY:MD Fit invoice INV-1001: \$120\.00 \(unpaid\)/);
  assert.match(body, /SUMMARY:MD Fit Membership renews\r\n/); assert.match(body, /SUMMARY:MD Fit Membership started\r\n/);
  assert.equal((body.match(/BEGIN:VEVENT/g) || []).length, 6, "2 visits, 1 class, 1 invoice, membership start and renewal: no cancelled, old or other people's visits");
  for (const secret of ["Dry needling", "shoulder", "Someone else", "follow-up", "Video consult"]) assert.ok(!body.includes(secret), `no "${secret}"`);
  // A new link: the old one stops working
  const fresh = await json(routes["POST /calendar/feed/reset"], { client });
  assert.notEqual(fresh.url, link.url);
  assert.equal((await get(token)).status, 404);
  assert.equal((await get(fresh.url.split("/").pop())).status, 200);
  assert.equal((await get("../../etc/passwd")).status, 404);
});
