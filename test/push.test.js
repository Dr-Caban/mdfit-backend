"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPush, normaliseKey } = require("../lib/push");
const { createStore } = require("../lib/store");
const { nowParts } = require("../server");

const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
const tok = (n) => n.toString(16).padStart(64, "0");
const zonedToUtc = (date, time) => new Date(`${date}T${time}:00Z`); // tests run as if the clinic were on UTC

test("normaliseKey accepts PEM, escaped newlines and base64", () => {
  const pem = key();
  assert.equal(normaliseKey(pem), normaliseKey(pem.replace(/\n/g, "\\n")));
  assert.equal(normaliseKey(Buffer.from(pem).toString("base64")), normaliseKey(pem));
  assert.equal(normaliseKey("not a key"), "");
});

test("devices: register moves a phone to its new owner, caps per person, unregister removes", () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), "push-")));
  const push = createPush({ key: key(), keyId: "K1", teamId: "T1", store, nowParts, zonedToUtc });
  assert.equal(push.enabled, true);
  assert.equal(push.register({ token: "nope", clientId: "a" }), false);
  for (let i = 1; i <= 7; i++) push.register({ token: tok(i), clientId: "a" });
  assert.equal(store.read("devices", []).length, 5);
  push.register({ token: tok(7), clientId: "b" });
  assert.deepEqual(store.read("devices", []).filter((d) => d.clientId === "b").map((d) => d.token), [tok(7)]);
  push.register({ token: tok(99), admin: true });
  assert.equal(store.read("devices", []).find((d) => d.admin).token, tok(99));
  push.unregister(tok(99));
  assert.equal(store.read("devices", []).some((d) => d.admin), false);
  push.forgetClient("a");
  assert.deepEqual(store.read("devices", []).map((d) => d.clientId), ["b"]);
});

test("APNs auth token is a signed ES256 JWT with the key id and team", () => {
  const pem = key();
  const push = createPush({ key: pem, keyId: "ABC123", teamId: "TEAM1", store: null, nowParts, zonedToUtc });
  const [h, p, s] = push._authToken().split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "ABC123" });
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "TEAM1");
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: pem, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("reminders fire once in their window and remember what was sent", () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), "push-")));
  const push = createPush({ key: key(), keyId: "K1", teamId: "T1", store, nowParts, zonedToUtc, prettyTime: (t) => t });
  const sent = [];
  push.toClient = (id, n) => sent.push({ id, ...n }); // not used by remind (internal reference), so count via the store instead
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 59 * 60e3);
  const appt = { id: "ap1", status: "booked", clientId: "c1", date: inOneHour.toISOString().slice(0, 10), time: inOneHour.toISOString().slice(11, 16), typeName: "Evaluation" };
  push.remind([appt, { ...appt, id: "ap2", clientId: null }, { ...appt, id: "ap3", status: "cancelled" }]);
  const done = store.read("pushsent", {});
  assert.deepEqual(Object.keys(done), [`ap1:hour:${appt.date}`]);
  push.remind([appt]);
  assert.equal(Object.keys(store.read("pushsent", {})).length, 1, "not sent twice");
});

test("Android (FCM) tokens register alongside iPhone tokens", () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), "push-")));
  const push = createPush({ key: key(), keyId: "K1", teamId: "T1", store, nowParts, zonedToUtc });
  const fcmTok = "d" + "x".repeat(120) + ":APA91b" + "y".repeat(40);
  assert.equal(push.register({ token: fcmTok, clientId: "a", platform: "android" }), true);
  assert.equal(push.register({ token: fcmTok, clientId: "a", platform: "ios" }), false, "not an APNs token");
  assert.equal(store.read("devices", [])[0].platform, "android");
  assert.equal(push.unregister(fcmTok), true);
  assert.equal(store.read("devices", []).length, 0);
});
