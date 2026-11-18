"use strict";
// "Welcome back": the first time a member opens the app each clinic day earns 5 XP, and the server says it was the
// first, so the app celebrates it once (one device) and never twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
const { rewards } = require("../lib/rewards");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

test("welcome back: +5 XP once a day, flagged first only the first time", async (t) => {
  let now = new Date("2026-11-02T15:00:00Z");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const server = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => now }).listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  token = (await call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "test-pass-123" })).body.token;
  const xpToday = async () => (await call("GET", "/api/me/rewards")).body.todayXp;
  const before = await xpToday();
  const first = await call("POST", "/api/me/xp", { kind: "open" });
  assert.equal(first.status, 200); assert.equal(first.body.first, true); assert.equal(first.body.xp, 5);
  assert.equal(await xpToday(), before + 5);
  const again = await call("POST", "/api/me/xp", { kind: "open" });
  assert.equal(again.body.first, false, "a second device or a reopen doesn't celebrate again");
  assert.equal(await xpToday(), before + 5, "and earns nothing more");
});

test("welcome back counts once per day in the XP total", () => {
  const r = rewards({ actions: [{ date: "2026-11-02", kind: "open" }, { date: "2026-11-02", kind: "open" }, { date: "2026-11-03", kind: "open" }] }, "2026-11-03");
  assert.equal(r.xp >= 10, true);
  assert.equal(r.todayXp, 5);
});
