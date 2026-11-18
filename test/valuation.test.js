"use strict";
// The valuation workbench behind a passcode: the right code opens the page, a wrong one doesn't, tries are limited,
// the token opens nothing else and no other token opens it, and the page never sits on the public site.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-val-"));
  const app = createApp({ adminEmail: "jared@example.com", adminPasswordHash: hashPassword("owner-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", noVideoSync: true, noAffiliateJobs: true, ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => undefined) }; };
  return { call, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("valuation workbench: the passcode opens the page, nothing else does, and the token opens nothing else", async (t) => {
  const s = await start({ valuationPasscode: "2424" }); t.after(s.close);
  assert.equal((await s.call("GET", "/api/valuation/page")).status, 401);
  assert.equal((await s.call("POST", "/api/valuation/enter", { code: "1111" })).status, 401);
  let r = await s.call("POST", "/api/valuation/enter", { code: "2424" });
  assert.equal(r.status, 200); const tok = r.body.token;
  r = await s.call("GET", "/api/valuation/page", undefined, tok);
  assert.equal(r.status, 200); assert.match(r.body.html, /MD Fit valuation workbench/); assert.match(r.body.html, /\/vendor\/xlsx-0\.18\.5\.full\.min\.js/);
  assert.ok(!r.body.html.includes("cdn.jsdelivr.net"), "no outside scripts");
  // The workbench token is not an admin, member or board login
  assert.equal((await s.call("GET", "/api/admin/me", undefined, tok)).status, 401);
  assert.equal((await s.call("GET", "/api/me", undefined, tok)).status, 401);
  // An owner token doesn't open the workbench
  const owner = (await s.call("POST", "/api/admin/login", { email: "jared@example.com", password: "owner-pass-123" })).body.token;
  assert.equal((await s.call("GET", "/api/valuation/page", undefined, owner)).status, 401);
  // Eight tries per 15 minutes, right or wrong
  for (let i = 0; i < 6; i++) await s.call("POST", "/api/valuation/enter", { code: "0000" });
  assert.equal((await s.call("POST", "/api/valuation/enter", { code: "2424" })).status, 429);
});

test("valuation workbench: closed when no passcode is set; the board's passcode works when the workbench has none of its own", async (t) => {
  const off = await start({ valuationPasscode: "", boardPasscode: "" }); t.after(off.close);
  assert.equal((await off.call("POST", "/api/valuation/enter", { code: "2424" })).status, 503);
  const prev = process.env.VALUATION_PASSCODE; delete process.env.VALUATION_PASSCODE; t.after(() => { if (prev !== undefined) process.env.VALUATION_PASSCODE = prev; });
  const board = await start({ boardPasscode: "2424" }); t.after(board.close);
  assert.equal((await board.call("POST", "/api/valuation/enter", { code: "2424" })).status, 200);
});
