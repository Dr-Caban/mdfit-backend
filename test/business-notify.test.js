"use strict";
// Business notifications go to BUSINESS_EMAILS when it is set, to the owner's alert address otherwise, and never fail
// the request that triggered them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBusinessNotify } = require("../lib/business-notify");

test("business notifications: to BUSINESS_EMAILS when set, to the owner otherwise, and never throw", () => {
  const sent = [];
  const notify = { client: (to, subject) => sent.push(["client", to, subject]), owner: (subject) => sent.push(["owner", subject]) };
  createBusinessNotify({ cfg: { businessEmails: "Jared@Example.com, second@example.com; not-an-email" }, notify })("Revenue share paid: $1.00", "x");
  assert.deepEqual(sent, [["client", "jared@example.com", "Revenue share paid: $1.00"], ["client", "second@example.com", "Revenue share paid: $1.00"]]);
  sent.length = 0;
  createBusinessNotify({ cfg: { businessEmails: "" }, notify })("Partner registered: Iron Gym", "x");
  assert.deepEqual(sent, [["owner", "Partner registered: Iron Gym"]]);
  const boom = { client: () => { throw new Error("down"); } };
  assert.doesNotThrow(() => createBusinessNotify({ cfg: { businessEmails: "a@example.com" }, notify: boom })("s", "t"));
});
