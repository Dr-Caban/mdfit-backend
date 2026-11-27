// Fixes from the full server debug (Nov 2026). Each test here failed before its fix: a client's earlier email address
// written to the log in full, requests that were the caller's mistake answered as a server fault, a request log that
// dropped "/api/me" and "/api/admin" and let a push token through, a failed calendar read treated as an empty
// calendar, prescribed pain tracks missing from the exported record, and video-visit ledger entries that named nobody.
// Invented people only.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger, maskEmails, logPath } = require("../lib/logger");
const { createCalSync } = require("../lib/calsync");
const { createTelehealth } = require("../lib/telehealth");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const OWNER = "coach@example.com", OWNER_PASS = "admin-pass-123";

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-dbg-server-"));
  const app = createApp({ adminEmail: OWNER, adminPasswordHash: hashPassword(OWNER_PASS), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    now: () => new Date("2026-11-12T15:00:00Z"), siteUrl: "https://mdfit.example.com", calWatchMs: 0, noVideoSync: true, noBackupSchedule: true, ...extra });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  // raw: these exact bytes and headers
  const raw = async (method, url, { body, headers = {}, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const call = (method, url, body, token) => raw(method, url, { body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" }, token });
  const ownerToken = async () => (await call("POST", "/api/admin/login", { email: OWNER, password: OWNER_PASS })).body.token;
  const signup = async (name, email) => (await call("POST", "/api/clients/signup", { name, email, phone: "941-555-0100", password: "made-up-pass-1" })).body;
  return { app, port, raw, call, ownerToken, signup, dataDir, close: () => { server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
// Every log line written while fn runs, parsed (the logger is silent in tests otherwise)
async function logged(fn) {
  const lines = [], sink = logger.sink, level = logger.level;
  logger.level = 10; logger.sink = (l) => lines.push(JSON.parse(l));
  try { await fn(lines); await new Promise((r) => setTimeout(r, 100)); } finally { logger.level = level; logger.sink = sink; }
  return lines;
}
const errorLines = (lines) => lines.filter((l) => l.level === "error").map((l) => `${l.msg} ${l.path || ""}`);

// ---------------------------------------------------------------- 1. emails in the activity log line

test("log: maskEmails masks every email address in a set of log fields and leaves the rest alone", () => {
  assert.deepEqual(maskEmails({ email: "pat@example.com", previousEmail: "old.address@example.com", note: "moved from a@example.com to b@example.com", count: 2, roles: ["charts"], when: "Mon at 10:00 AM" }),
    { email: "p**@example.com", previousEmail: "o**@example.com", note: "moved from a**@example.com to b**@example.com", count: 2, roles: ["charts"], when: "Mon at 10:00 AM" });
  assert.deepEqual(maskEmails(undefined), {});
});

test("log: when staff change a client's email, neither address is logged in full; the activity feed keeps both", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), before = "zebulon.quartermaine@example.com", after = "zq.new@example.com";
  const pat = await s.signup("Zebulon Quartermaine", before);
  const lines = await logged(async () => {
    const r = await s.call("PUT", `/api/admin/clients/${pat.client.id}/contact`, { name: "Zebulon Quartermaine", email: after, phone: "941-555-0100" }, A);
    assert.equal(r.status, 200, r.text);
  });
  const line = lines.find((l) => l.msg === "activity" && l.type === "client_contact");
  assert.ok(line, "the change is logged");
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(before) && !all.includes(after), "neither address is in any log line in full");
  assert.equal(line.previousEmail, "z**@example.com"); assert.equal(line.email, "z**@example.com");
  // the feed staff read in the workspace is unchanged: it still says which address it was
  const feed = (await s.call("GET", "/api/admin/activity", undefined, A)).body.find((e) => e.type === "client_contact");
  assert.equal(feed.previousEmail, before); assert.equal(feed.email, after);
});

// ---------------------------------------------------------------- 2. the request log's path

test("request log: the whole path, prefix included; a device's push token and a subscriber's email are never in any log line", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), m = await s.signup("Pat Logpath", "pat.logpath@example.com");
  const TOKEN = "a".repeat(20) + "PUSHTOKENSECRET" + "b".repeat(29), EMAIL = "news.reader@example.com";
  const J = { "content-type": "application/json" };
  const lines = await logged(async () => {
    assert.equal((await s.call("POST", "/api/subscribe", { email: EMAIL })).status, 201);
    assert.equal((await s.call("GET", "/api/me", undefined, m.token)).status, 200);
    assert.equal((await s.call("PUT", "/api/me/prefs", {}, m.token)).status, 200);
    assert.equal((await s.call("GET", "/api/admin/analytics/members", undefined, A)).status, 200);
    // the routes with something private in the path, as an app sends them and in the other spellings Express accepts
    for (const [url, token] of [[`/api/me/devices/${TOKEN}`, m.token], [`/api/admin/devices/${TOKEN}`, A], [`/api/me/Devices/${TOKEN}`, m.token], [`/API/ADMIN/DEVICES/${TOKEN}`, A], [`/api/me/devices/${TOKEN}/`, m.token], [`/api/me/devices/${TOKEN}?x=${TOKEN}`, m.token]])
      assert.equal((await s.raw("DELETE", url, { token })).status, 200, url.replace(TOKEN, "<token>"));
    // requests on those paths that fail before they reach the route: the error handler writes a line of its own
    await s.raw("DELETE", `/api/me/devices/${TOKEN}`, { token: m.token, body: "{}", headers: { "content-type": "application/json; charset=klingon" } });
    await s.raw("DELETE", `/api/admin/subscribers/${EMAIL}`, { token: A, body: "{}", headers: { ...J, "content-encoding": "gzip" } });
    assert.equal((await s.raw("DELETE", `/api/admin/Subscribers/${EMAIL}`, { token: A })).status, 200);
    assert.equal((await s.raw("DELETE", `/api/admin/subscribers/${encodeURIComponent(EMAIL)}`, { token: A })).status, 404, "already removed");
  });
  assert.equal(lines.filter((l) => l.msg === "bad_request" || l.msg === "server_error").length, 2, "both failed requests left a line from the error handler");
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(TOKEN), "the push token is in no log line");
  assert.ok(!all.includes(EMAIL) && !all.includes(encodeURIComponent(EMAIL)) && !all.includes("news.reader"), "the subscriber's email is in no log line");
  const paths = lines.filter((l) => l.msg === "request").map((l) => `${l.method} ${l.path}`);
  for (const p of ["GET /api/me", "PUT /api/me/prefs", "GET /api/admin/analytics/members", "DELETE /api/me/devices/[hidden]", "DELETE /api/admin/devices/[hidden]", "DELETE /api/me/Devices/[hidden]",
    "DELETE /API/ADMIN/DEVICES/[hidden]", "DELETE /api/me/devices/[hidden]/", "DELETE /api/admin/subscribers/[hidden]", "DELETE /api/admin/Subscribers/[hidden]"]) assert.ok(paths.includes(p), `${p} in ${JSON.stringify(paths)}`);
  assert.ok(lines.filter((l) => l.msg === "request").every((l) => l.path.toLowerCase().startsWith("/api/")), "no line has lost its prefix");
});

test("request log: the path is put together from the mount point and the route, never from the address as it was sent", () => {
  const secret = "SECRETKEY123";
  const req = (baseUrl, p) => ({ baseUrl, path: p, originalUrl: `/sent/${secret}?token=${secret}`, url: p });
  assert.equal(logPath(req("/api/me", "/prefs")), "/api/me/prefs");
  assert.equal(logPath(req("/api/me", "/")), "/api/me");
  assert.equal(logPath(req("", "/api/health")), "/api/health");
  assert.equal(logPath(req(undefined, "/api/health")), "/api/health");
  // what was blanked before still is, with the prefix in front, whatever the letter case
  assert.equal(logPath(req("/api/me", `/shares/${secret}/save`)), "/api/me/shares/[key]/save");
  assert.equal(logPath(req("/api/board", `/shared/${secret}`)), "/api/board/shared/[key]");
  assert.equal(logPath(req("/api/board", `/Shared/${secret}/`)), "/api/board/Shared/[key]/", "Express also accepts a closing slash");
  assert.equal(logPath(req("", `/api/Board/Shared/${secret}`)), "/api/Board/Shared/[key]");
  assert.equal(logPath(req("", `/API/shares/${secret}`)), "/API/shares/[key]");
  assert.equal(logPath(req("", `/api/calendar-feed/${secret}.ics`)), "/api/calendar-feed/[key]");
  assert.equal(logPath(req("/api/me", `/devices/${secret}`)), "/api/me/devices/[hidden]");
  assert.equal(logPath(req("", `/api/admin/Subscribers/${secret}`)), "/api/admin/Subscribers/[hidden]");
  assert.equal(logPath(req("/api/admin", "/telehealth/devices")), "/api/admin/telehealth/devices", "a list of devices has nothing to hide");
});

// ---------------------------------------------------------------- 3. requests that are the caller's mistake

test("errors: a body the server cannot read or a broken % escape is the caller's 4xx, not a server error", async (t) => {
  const s = await start(); t.after(s.close);
  const body = JSON.stringify({ email: "private.person@example.com", password: "made-up-pass-1" });
  const lines = await logged(async () => {
    let r = await s.raw("POST", "/api/clients/login", { body, headers: { "content-type": "application/json; charset=klingon" } });
    assert.equal(r.status, 415, "an unknown character set"); assert.deepEqual(r.body, { error: "Invalid request." });
    r = await s.raw("POST", "/api/clients/login", { body, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
    assert.equal(r.status, 400, "marked as gzip but sent plain"); assert.deepEqual(r.body, { error: "Invalid request." });
    r = await s.raw("GET", "/api/shares/%E0%A4%A");
    assert.equal(r.status, 400, "a malformed % escape in a path parameter"); assert.deepEqual(r.body, { error: "Invalid request." });
    // what was already answered properly still is
    assert.deepEqual((await s.raw("POST", "/api/clients/login", { body: "{", headers: { "content-type": "application/json" } })).body, { error: "Invalid JSON." });
    assert.equal((await s.raw("POST", "/api/clients/login", { body: JSON.stringify({ pad: "x".repeat(300000) }), headers: { "content-type": "application/json" } })).status, 413);
  });
  assert.deepEqual(errorLines(lines), [], "nothing at error level, and no server_error");
  assert.ok(!lines.some((l) => l.msg === "server_error"));
  const warned = lines.filter((l) => l.msg === "bad_request");
  assert.deepEqual(warned.map((l) => [l.level, l.status, l.kind, l.path]), [["warn", 415, "charset.unsupported", "/api/clients/login"], ["warn", 400, "Z_DATA_ERROR", "/api/clients/login"], ["warn", 400, "URIError", "/api/shares/[key]"]]);
  // the kind of mistake is logged, never what was sent
  const all = JSON.stringify(lines);
  for (const sent of ["private.person", "made-up-pass-1", "klingon", "KLINGON", "%E0%A4%A"]) assert.ok(!all.includes(sent), `"${sent}" is not in the log`);
});

test("errors: a request cut off half-way is noted, not answered and not a server error", async (t) => {
  const s = await start(); t.after(s.close);
  const lines = await logged(async () => {
    // 500 bytes announced, 20 sent, then the connection drops: a phone losing signal
    await new Promise((done) => {
      const c = net.connect(s.port, "127.0.0.1", () => {
        c.write("POST /api/clients/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"email\":\"cut.off@ex");
        setTimeout(() => c.destroy(), 60);
      });
      c.on("error", () => {}); c.on("close", () => setTimeout(done, 150));
    });
  });
  assert.deepEqual(errorLines(lines), []);
  const noted = lines.filter((l) => l.msg === "request_aborted");
  assert.deepEqual(noted.map((l) => [l.level, l.path]), [["info", "/api/clients/login"]]);
  assert.ok(!JSON.stringify(lines).includes("cut.off"), "nothing of the body is logged");
  assert.equal((await s.call("GET", "/api/health")).status, 200, "and the server carries on");
});

test("errors: a field sent as an object where text belongs is a 400 on the public routes", async (t) => {
  const s = await start(); t.after(s.close);
  const obj = { toString: "x" };
  const cases = [
    ["/api/clients/login", { email: obj, password: "made-up-pass-1" }],
    ["/api/clients/signup", { name: "Pat Doe", email: "pat.obj@example.com", password: "made-up-pass-1", referralCode: obj }],
    ["/api/clients/forgot", { email: obj }],
    ["/api/clients/verify-code", { email: obj, code: "123456" }],
    ["/api/clients/reset", { token: obj, password: "made-up-pass-2" }],
    ["/api/referral/visit", { code: obj }],
    ["/api/clients/login", { email: { toString: "x", valueOf: "y" }, password: "made-up-pass-1" }]
  ];
  const lines = await logged(async () => {
    for (const [url, body] of cases) {
      const r = await s.call("POST", url, body);
      assert.equal(r.status, 400, `${url}: ${r.text}`); assert.deepEqual(r.body, { error: "Invalid value." }, url);
    }
  });
  assert.deepEqual(errorLines(lines), []);
  assert.equal(lines.filter((l) => l.msg === "bad_request" && l.level === "warn" && l.kind === "object_for_value" && l.status === 400).length, cases.length);
  // an ordinary sign-in still works afterwards
  await s.signup("Pat Fine", "pat.fine@example.com");
  assert.equal((await s.call("POST", "/api/clients/login", { email: "pat.fine@example.com", password: "made-up-pass-1" })).status, 200);
});

test("errors: a real fault is still a 500 and server_error, also when a service the server called answered it with a 4xx", async (t) => {
  // The card processor refusing the server's own key (401), or the server's request (400): not the member's doing.
  // Its errors carry that status, so they must not be passed on as the member's 401 or 400.
  let fail = Object.assign(new Error("Invalid API Key provided"), { type: "StripeAuthenticationError", statusCode: 401 });
  const stripeClient = { customers: { create: async () => { throw fail; } } };
  const s = await start({ stripeClient, stripeSecretKey: "rk_test_made_up", stripeWebhookSecret: "whsec_made_up" }); t.after(s.close);
  const m = await s.signup("Pat Payer", "pat.payer@example.com");
  const tier = (await s.call("GET", "/api/content")).body.tiers[0].id;
  const lines = await logged(async () => {
    let r = await s.call("POST", "/api/me/checkout/membership", { tier }, m.token);
    assert.equal(r.status, 500, r.text); assert.deepEqual(r.body, { error: "Something went wrong. Try again." });
    fail = Object.assign(new Error("No such price"), { type: "StripeInvalidRequestError", statusCode: 400, status: 400 });
    r = await s.call("POST", "/api/me/checkout/membership", { tier }, m.token);
    assert.equal(r.status, 500, r.text);
  });
  const faults = lines.filter((l) => l.msg === "server_error");
  assert.deepEqual(faults.map((l) => [l.level, l.path, l.error]), [["error", "/api/me/checkout/membership", "Invalid API Key provided"], ["error", "/api/me/checkout/membership", "No such price"]]);
  assert.ok(!lines.some((l) => l.msg === "bad_request"));
  assert.equal((await s.call("GET", "/api/me", undefined, m.token)).status, 200, "the member is still signed in");
});

// ---------------------------------------------------------------- 4. a failed calendar read

// A stand-in for Google's calendar and the SimplePractice feed. state.google / state.feed: "up", "down" (the call
// fails as it did in production) or, for Google, "second-refused" (the second calendar answers with an error).
const zonedToUtc = (d, time) => new Date(`${d}T${time}:00-05:00`); // November: Eastern Standard Time
function standIn() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "svc@proj.iam.example.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const state = { google: "up", feed: "up", asked: 0, fed: 0,
    busy: { "dr@example.com": [{ start: "2026-11-16T15:00:00Z", end: "2026-11-16T16:00:00Z" }], "second@example.com": [{ start: "2026-11-17T19:00:00Z", end: "2026-11-17T20:00:00Z" }] },
    ics: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261118T140000Z\r\nDTEND:20261118T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes("oauth2.googleapis.com/token")) return json(200, { access_token: "made-up", expires_in: 3600 });
    if (url.endsWith("/freeBusy")) {
      state.asked++;
      if (state.google === "down") throw new TypeError("fetch failed");
      const q = JSON.parse(opts.body), ids = q.items.map((x) => x.id);
      const asked = (id) => (state.busy[id] || []).filter((b) => b.end > q.timeMin && b.start < q.timeMax); // only the dates asked about, as Google answers
      return json(200, { calendars: Object.fromEntries(ids.map((id, i) => [id, i === 1 && state.google === "second-refused" ? { errors: [{ reason: "backendError" }] } : { busy: asked(id) }])) });
    }
    if (url.startsWith("https://sp.example/")) {
      state.fed++;
      if (state.feed === "down") return { ok: false, status: 503, text: async () => "" };
      return { ok: true, status: 200, text: async () => state.ics };
    }
    return json(404, {});
  };
  // the calendar's own clock (its three-minute cache and the once-a-minute outage log line run on it)
  const clock = { t: Date.parse("2026-11-12T15:00:00Z") };
  const make = (over = {}) => createCalSync({ serviceAccount: sa, calendarId: "dr@example.com", tz: "America/New_York", zonedToUtc, fetchImpl, logger, now: () => new Date(clock.t), ...over });
  return { state, make, clock };
}
const times = (list) => list.map((b) => `${b.source} ${b.start.toISOString().slice(0, 16)}`);

test("calendar: a read that fails is answered with the last good one for those dates, and is not kept", async () => {
  const g = standIn(), cs = g.make();
  const good = await cs.busy("2026-11-12", "2026-11-30");
  assert.deepEqual(times(good), ["google 2026-11-16T15:00"]);
  cs.clear(); // what the every-minute watch does before each read

  g.state.google = "down";
  const during = await cs.busy("2026-11-12", "2026-11-30");
  assert.deepEqual(times(during), ["google 2026-11-16T15:00"], "the time that was taken is still taken");
  assert.equal(cs.status().lastError, "fetch failed", "and staff still see the error");
  // a booking asks about one day only, dates never read on their own: the wider good read covers it
  assert.deepEqual(times(await cs.busy("2026-11-16", "2026-11-16")), ["google 2026-11-16T15:00"]);
  assert.deepEqual(await cs.busy("2026-11-17", "2026-11-17"), [], "and only the dates asked for come back");
  // dates only partly covered by a good read: what is known for them is still used
  assert.deepEqual(times(await cs.busy("2026-11-14", "2026-12-20")), ["google 2026-11-16T15:00"]);

  // the failure was not kept: the same question goes to Google again, and its new answer is used at once
  const asked = g.state.asked;
  g.state.google = "up"; g.state.busy["dr@example.com"] = [{ start: "2026-11-16T18:00:00Z", end: "2026-11-16T19:00:00Z" }];
  const after = await cs.busy("2026-11-12", "2026-11-30");
  assert.equal(g.state.asked, asked + 1, "asked again without waiting for the three minutes");
  assert.deepEqual(times(after), ["google 2026-11-16T18:00"]);
  assert.equal(cs.status().lastError, "");
  await cs.busy("2026-11-12", "2026-11-30");
  assert.equal(g.state.asked, asked + 1, "a good answer is kept for three minutes as before");
  // and the next failure falls back to that newer answer, not the first one
  cs.clear(); g.state.google = "down";
  assert.deepEqual(times(await cs.busy("2026-11-12", "2026-11-30")), ["google 2026-11-16T18:00"]);

  // the one day a booking checks is answered from the newest read that covers it: here a one-day read that saw an
  // event the wider read before it had not
  g.state.google = "up"; g.state.busy["dr@example.com"].push({ start: "2026-11-20T15:00:00Z", end: "2026-11-20T16:00:00Z" });
  assert.deepEqual(times(await cs.busy("2026-11-20", "2026-11-20")), ["google 2026-11-20T15:00"]);
  cs.clear(); g.state.google = "down";
  assert.deepEqual(times(await cs.busy("2026-11-20", "2026-11-20")), ["google 2026-11-20T15:00"]);
  assert.deepEqual(times(await cs.busy("2026-11-12", "2026-11-30")), ["google 2026-11-16T18:00"], "the wider dates still have their own last answer");
});

test("calendar: with no good read yet, a failed one still counts as no busy times (unchanged; the owner's call)", async () => {
  const g = standIn(), cs = g.make();
  g.state.google = "down";
  assert.deepEqual(await cs.busy("2026-11-12", "2026-11-30"), []);
  assert.equal(cs.status().lastError, "fetch failed");
  const asked = g.state.asked;
  await cs.busy("2026-11-12", "2026-11-30");
  assert.equal(g.state.asked, asked + 1, "not kept either: the next call asks again");
});

test("calendar: the same outage is written to the log once every ten minutes, not on every call; every call still asks Google", async () => {
  const g = standIn(), cs = g.make();
  await cs.busy("2026-11-12", "2026-11-30"); cs.clear();
  g.state.google = "down";
  const asked = g.state.asked;
  const lines = await logged(async () => { for (let i = 0; i < 5; i++) { await cs.busy("2026-11-12", "2026-11-30"); g.clock.t += 5e3; } });
  assert.equal(g.state.asked, asked + 5, "asked every time");
  assert.equal(lines.filter((l) => l.msg === "gcal_busy_failed").length, 1, "logged once, not on each call");
  assert.equal(cs.status().lastError, "fetch failed", "and staff see it every time");
  g.clock.t += 5 * 60e3;
  const mid = await logged(() => cs.busy("2026-11-12", "2026-11-30"));
  assert.equal(mid.filter((l) => l.msg === "gcal_busy_failed").length, 0, "not again five minutes in");
  g.clock.t += 6 * 60e3;
  const later = await logged(() => cs.busy("2026-11-12", "2026-11-30"));
  assert.equal(later.filter((l) => l.msg === "gcal_busy_failed").length, 1, "and again once ten minutes have passed");
});

test("calendar: a time added in Google after the last good read is refused the moment Google answers again", async () => {
  const g = standIn(), cs = g.make();
  assert.deepEqual(times(await cs.busy("2026-11-17", "2026-11-17")), []); cs.clear();
  g.state.google = "down"; assert.deepEqual(await cs.busy("2026-11-17", "2026-11-17"), []); // one failed read
  // Google is back and an event has been added on that day since the last good read
  g.state.google = "up"; g.state.busy["dr@example.com"].push({ start: "2026-11-17T14:00:00Z", end: "2026-11-17T15:00:00Z" });
  assert.deepEqual(times(await cs.busy("2026-11-17", "2026-11-17")), ["google 2026-11-17T14:00"], "the booking check reads Google fresh");
});

test("calendar: one calendar reporting its own error: nothing is kept, a time taken there is refused once it answers, and the same log line is written once every ten minutes", async () => {
  const g = standIn(), cs = g.make({ calendarId: "dr@example.com, second@example.com" });
  assert.deepEqual(times(await cs.busy("2026-11-17", "2026-11-17")), ["google-2 2026-11-17T19:00"]); cs.clear();
  g.state.google = "second-refused";
  const lines = await logged(async () => { for (let i = 0; i < 4; i++) { await cs.busy("2026-11-17", "2026-11-17"); g.clock.t += 5e3; } });
  assert.equal(lines.filter((l) => l.msg === "gcal_busy_partial").length, 1, "logged once, not on each view");
  assert.match(cs.status().lastError, /calendar 2: backendError/, "staff see it on every call");
  // a time is taken on the second calendar meanwhile; it answers again: the very next check sees it
  g.state.google = "up"; g.state.busy["second@example.com"].push({ start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z" });
  assert.deepEqual(times(await cs.busy("2026-11-17", "2026-11-17")).sort(), ["google-2 2026-11-17T15:00", "google-2 2026-11-17T19:00"]);
  // that clean read resets the log: the next refusal, seconds later, is written at once
  cs.clear(); g.state.google = "second-refused"; g.clock.t += 5e3;
  const again = await logged(() => cs.busy("2026-11-17", "2026-11-17"));
  assert.equal(again.filter((l) => l.msg === "gcal_busy_partial").length, 1, "the first refusal after a clean read is logged");
});

test("calendar: each source falls back on its own (one Google calendar of two, the SimplePractice feed)", async () => {
  const g = standIn(), cs = g.make({ calendarId: "dr@example.com, second@example.com", icsUrl: "https://sp.example/feed.ics" });
  const all = ["google 2026-11-16T15:00", "google-2 2026-11-17T19:00", "simplepractice 2026-11-18T14:00"];
  assert.deepEqual(times(await cs.busy("2026-11-12", "2026-11-30")), all);
  cs.clear();
  // the second calendar answers with an error while the first has a new event: the first is fresh, the second as last known
  g.state.google = "second-refused"; g.state.busy["dr@example.com"].push({ start: "2026-11-19T15:00:00Z", end: "2026-11-19T16:00:00Z" });
  let r = await cs.busy("2026-11-12", "2026-11-30");
  assert.deepEqual(times(r), ["google 2026-11-16T15:00", "google 2026-11-19T15:00", "google-2 2026-11-17T19:00", "simplepractice 2026-11-18T14:00"]);
  assert.match(cs.status().lastError, /calendar 2: backendError/);
  const asked = g.state.asked;
  await cs.busy("2026-11-12", "2026-11-30");
  assert.equal(g.state.asked, asked + 1, "an answer with a failure in it is not kept");
  // the feed fails: its last good times stay, Google is fresh
  g.state.google = "up"; g.state.feed = "down";
  r = await cs.busy("2026-11-12", "2026-11-30");
  assert.deepEqual(times(r), ["google 2026-11-16T15:00", "google 2026-11-19T15:00", "google-2 2026-11-17T19:00", "simplepractice 2026-11-18T14:00"]);
  assert.match(cs.status().lastError, /SimplePractice feed: HTTP 503/);
  // a feed's last answer is never used for another feed address
  assert.deepEqual(times(await cs.busy("2026-11-12", "2026-11-30", { icsUrl: "https://sp.example/other.ics" })).filter((x) => /^simplepractice/.test(x)), []);
});

test("calendar: while Google cannot be read, booking pages keep the taken time hidden, it cannot be booked, and nothing is announced as changed", async (t) => {
  const g = standIn(), s = await start({ calsync: g.make() }); t.after(s.close);
  const sent = [];
  s.app.set("rt", { emitBookingUpdate: (d) => sent.push(["slots_changed", d]), emitToAdmin: (ev, data) => sent.push([ev, data]), emitActivity: () => {} });
  const watch = s.app.get("watchCalendar"), day = "2026-11-16"; // the Google event is 10:00 to 11:00 at the clinic that day
  const slots = async () => { const r = await s.call("GET", `/api/availability?from=${day}&days=1`); return { type: r.body.type, slots: r.body.days[0].slots }; };
  assert.deepEqual(await watch(), [], "the first check only records");
  const open = await slots();
  assert.ok(open.slots.length > 0 && !open.slots.includes("10:00"), "10:00 is taken on Google's calendar");

  g.state.google = "down";
  const lines = await logged(async () => { assert.deepEqual(await watch(), [], "a failed read changes no day"); });
  assert.deepEqual(sent, [], "so no booking page and no staff screen is told anything changed");
  assert.ok(lines.some((l) => l.msg === "gcal_busy_failed") && !lines.some((l) => l.msg === "calendar_changed"));
  assert.deepEqual((await slots()).slots, open.slots, "the same times are offered as before the failure");
  const booking = { typeId: open.type.id, date: day, time: "10:00", name: "Pat Example", email: "pat.example@example.com", phone: "941-555-0100", notes: "", areas: [], painLevel: null };
  assert.equal((await s.call("POST", "/api/appointments", booking)).status, 409, "the taken hour cannot be booked");
  const A = await s.ownerToken();
  assert.equal((await s.call("GET", "/api/admin/calsync", undefined, A)).body.lastError, "fetch failed", "staff see that Google is not answering");

  // Google answers again: nothing had changed, so nothing is announced, and an open time can be booked
  g.state.google = "up";
  assert.deepEqual(await watch(), []); assert.deepEqual(sent, []);
  assert.equal((await s.call("GET", "/api/admin/calsync", undefined, A)).body.lastError, "");
  assert.equal((await s.call("POST", "/api/appointments", { ...booking, time: open.slots[0] })).status, 201);
});

// ---------------------------------------------------------------- 5. the exported record

test("export: the full record carries the pain tracks and protocols prescribed from the chart", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await s.signup("Pat Doe", "pat.doe@example.com"), lee = await s.signup("Lee Park", "lee.park@example.com");
  const rx = await s.call("PUT", `/api/admin/clients/${pat.client.id}/pain-plan`, { items: [{ kind: "track", id: "scalenes", note: "Twice a day, stop if it tingles" }, { kind: "protocol", id: "upper-trap" }] }, A);
  assert.equal(rx.status, 200, rx.text);
  const r = await s.call("POST", "/api/admin/export/clients", { all: true, kind: "records" }, A);
  assert.equal(r.status, 200, r.text);
  const rec = Object.fromEntries(r.body.clients.map((c) => [c.email, c]));
  const got = rec["pat.doe@example.com"].assignedPain;
  assert.deepEqual(got.map((x) => [x.kind, x.id, x.note]), [["track", "scalenes", "Twice a day, stop if it tingles"], ["protocol", "upper-trap", ""]]);
  assert.deepEqual(got.map((x) => Object.keys(x)), [["kind", "id", "note", "assignedAt"], ["kind", "id", "note", "assignedAt"]]);
  assert.ok(got.every((x) => !Number.isNaN(Date.parse(x.assignedAt))), "each with the day it was prescribed");
  assert.deepEqual(rec["lee.park@example.com"].assignedPain, [], "an empty list for someone with nothing prescribed");
  assert.ok(Array.isArray(rec["pat.doe@example.com"].assignedPrograms), "beside the assigned programs");
});

// ---------------------------------------------------------------- 6. who did it, on video-visit ledger entries

// A stand-in connection, as in test/telehealth.test.js
const conn = (over = {}) => { const ee = new EventEmitter(), got = []; return { ...over, got, on: (e, f) => ee.on(e, f), emit: (event, data) => got.push({ event, data }), fire: (e, d) => ee.emit(e, d) }; };

test("video visits: the ledger names the staff member, the owner or the member who caused each entry", async () => {
  const rows = [], audit = { record: (e) => rows.push(e) };
  const room = () => createTelehealth({ audit, live: true, ownerEmail: OWNER, describe: () => ({ name: "A Member" }), invite: async () => ({ name: "A Member", emailed: true, pushed: false }) });
  const last = () => { const e = rows[rows.length - 1]; return [e.action, e.actor, e.subject]; };
  const why = () => rows[rows.length - 1].meta.why;
  const desk = conn({ staffEmail: "desk@example.com", permissions: ["scheduling"] }), pat = conn({ clientId: "pat1" }), lee = conn({ clientId: "lee2" });
  let tele = room();
  tele.staffJoin(desk); tele.patientJoin(pat); tele.patientJoin(lee);

  // the front desk invites someone; they come in on the invitation, which nobody on staff had to press Admit for
  desk.fire("tele_invite", { clientId: "pat1" }); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(last(), ["telehealth.invite", "admin:desk@example.com", "pat1"]);
  pat.fire("tele_knock");
  assert.deepEqual(last(), ["telehealth.admit", "client:pat1", "pat1"]); assert.equal(rows[rows.length - 1].meta.invited, true);
  // the front desk admits a second person by hand
  lee.fire("tele_knock"); desk.fire("tele_admit", { clientId: "lee2" });
  assert.deepEqual(last(), ["telehealth.admit", "admin:desk@example.com", "lee2"]); assert.equal(rows[rows.length - 1].meta.invited, undefined);
  // a viewer asks to speak (theirs); the host lets them (the host's), then sends them back
  lee.fire("tele_ask");
  assert.deepEqual(last(), ["telehealth.ask", "client:lee2", "lee2"]);
  desk.fire("tele_role", { clientId: "lee2", role: "speaker" });
  assert.deepEqual(last(), ["telehealth.dock", "admin:desk@example.com", "lee2"]);
  desk.fire("tele_role", { clientId: "lee2", role: "viewer" });
  assert.deepEqual(last(), ["telehealth.undock", "admin:desk@example.com", "lee2"]);
  // a member leaves by themselves; the host removes the other
  pat.fire("tele_leave");
  assert.deepEqual([...last(), why()], ["telehealth.end", "client:pat1", "pat1", "patient_left"]);
  desk.fire("tele_end", { clientId: "lee2" });
  assert.deepEqual([...last(), why()], ["telehealth.end", "admin:desk@example.com", "lee2", "removed"]);

  // The owner's connection carries no email of its own: the owner's sign-in email is used. The owner invites a guest,
  // so the guest comes in on the owner's screen (the screen that invited them, not merely the first one connected):
  // that arrival is the guest's entry, not the owner's, who pressed no Admit.
  tele = room();
  const desk2 = conn({ staffEmail: "desk@example.com", permissions: ["scheduling"] }), owner = conn(), kim = conn({ clientId: "kim3" }), ana = conn({ clientId: "ana4" });
  tele.staffJoin(desk2); tele.staffJoin(owner); tele.patientJoin(kim); tele.patientJoin(ana);
  owner.fire("tele_invite", { clientId: "kim3" }); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(last(), ["telehealth.invite", `admin:${OWNER}`, "kim3"]);
  kim.fire("tele_knock");
  assert.equal(owner.got.some((x) => x.event === "tele_started"), true, "on the inviting owner's screen");
  assert.equal(desk2.got.some((x) => x.event === "tele_started"), false, "not on the front desk's, though it connected first");
  assert.deepEqual(last(), ["telehealth.admit", "client:kim3", "kim3"]);
  ana.fire("tele_knock"); owner.fire("tele_admit", { clientId: "ana4" });
  assert.deepEqual(last(), ["telehealth.admit", `admin:${OWNER}`, "ana4"]);
  owner.fire("tele_end", {});
  assert.deepEqual(rows.slice(-2).map((e) => [e.action, e.actor, e.subject, e.meta.why]), [["telehealth.end", `admin:${OWNER}`, "kim3", "ended"], ["telehealth.end", `admin:${OWNER}`, "ana4", "ended"]]);
  // someone already in the waiting room when the front desk invites them comes straight in: the front desk's doing,
  // though the owner's screen is the one hosting
  const bo = conn({ clientId: "bo5" }); tele.patientJoin(bo); bo.fire("tele_knock");
  desk2.fire("tele_invite", { clientId: "bo5" }); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rows.slice(-2).map((e) => [e.action, e.actor, e.subject]), [["telehealth.invite", "admin:desk@example.com", "bo5"], ["telehealth.admit", "admin:desk@example.com", "bo5"]]);
  assert.equal(rows[rows.length - 1].meta.invited, true);
  owner.fire("tele_end", {});
  // the host's connection dropping ends the visit: that is the host's entry too
  kim.fire("tele_knock"); desk2.fire("tele_admit", { clientId: "kim3" }); desk2.fire("disconnect");
  assert.deepEqual([...last(), why()], ["telehealth.end", "admin:desk@example.com", "kim3", "staff_left"]);
  assert.ok(rows.every((e) => /^(admin:[^@\s]+@example\.com|client:\w+)$/.test(e.actor)), "no entry is left as a bare \"admin\"");

  // a room given no owner email (a unit test, say) still writes "admin" for the owner, as before
  const rows2 = [], bare = createTelehealth({ audit: { record: (e) => rows2.push(e) } }), doc = conn(), p2 = conn({ clientId: "pat1" });
  bare.staffJoin(doc); bare.patientJoin(p2); p2.fire("tele_knock"); doc.fire("tele_admit", { clientId: "pat1" });
  assert.deepEqual(rows2.map((e) => [e.action, e.actor]), [["telehealth.admit", "admin"]]);
});

test("video visits: the running server gives the room the owner's email, so the owner's entries name the owner", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.ownerToken(), pat = await s.signup("Pat Visit", "pat.visit@example.com");
  const owner = conn(), desk = conn({ staffEmail: "desk@example.com", permissions: ["scheduling"] });
  s.app.get("telehealth").staffJoin(owner); s.app.get("telehealth").staffJoin(desk);
  owner.fire("tele_invite", { clientId: pat.client.id }); await new Promise((r) => setTimeout(r, 30));
  const entries = async () => (await s.call("GET", "/api/admin/audit?action=telehealth.invite", undefined, A)).body.entries;
  assert.deepEqual((await entries()).map((e) => [e.action, e.actor, e.subject]), [["telehealth.invite", `admin:${OWNER}`, pat.client.id]]);
});

// ---------------------------------------------------------------- 7. the clinic's date for Insights

test("insights: the server hands over a helper that gives the clinic's date for a timestamp", async (t) => {
  const mi = require("../lib/member-insights"), real = mi.mountMemberInsights;
  let given = null;
  mi.mountMemberInsights = (deps) => { given = deps; return real(deps); };
  t.after(() => { mi.mountMemberInsights = real; });
  const s = await start(); t.after(s.close);
  assert.deepEqual(Object.keys(given).sort(), ["admin", "clients", "clinicDay", "store", "today"]);
  const { clinicDay } = given;
  assert.equal(clinicDay("2026-11-27T03:30:00.000Z"), "2026-11-26", "10:30 pm on the 26th at the clinic");
  assert.equal(clinicDay("2026-11-27T05:00:00.000Z"), "2026-11-27", "midnight at the clinic");
  assert.equal(clinicDay("2026-07-01T03:59:59Z"), "2026-06-30", "daylight saving time is followed");
  assert.equal(clinicDay("2026-11-27"), "2026-11-27", "a plain date is already the clinic's");
  for (const bad of [undefined, null, "", "not a date", "2026-13-45T99:00:00Z", {}, NaN, "2026-02-30", "2026-13-01", "2025-02-29"]) assert.equal(clinicDay(bad), "", `"" for ${JSON.stringify(bad)}`);
  assert.equal(clinicDay("2028-02-29"), "2028-02-29", "a leap day is a real date");
  assert.equal((await s.call("GET", "/api/admin/analytics/members", undefined, await s.ownerToken())).status, 200, "and Insights still answers");
});
