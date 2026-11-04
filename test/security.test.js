const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { createStore } = require("../lib/store");
const { createCalSync, parseIcs } = require("../lib/calsync");

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-sec-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, headers = {} } = {}) => {
    const r = await fetch(base + url, { method, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone) Safari", ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => undefined) };
  };
  return { call, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("edge gate: direct calls refused, edge calls and signed webhooks allowed", async (t) => {
  const s = await start({ edgeSecret: "edge-secret-xyz" }); t.after(s.close);
  assert.equal((await s.call("GET", "/api/site")).status, 403, "direct to the API host");
  assert.equal((await s.call("GET", "/api/site", { headers: { "x-mdfit-edge": "wrong" } })).status, 403);
  assert.equal((await s.call("GET", "/api/site", { headers: { "x-mdfit-edge": "edge-secret-xyz" } })).status, 200);
  assert.equal((await s.call("GET", "/api/health")).status, 200, "health stays open for uptime checks");
  assert.notEqual((await s.call("POST", "/api/stripe/webhook", { body: {} })).status, 403, "webhooks verify their own signatures");
});

test("bot filter, security headers, burst rate limit, real client IP from the edge", async (t) => {
  const s = await start({ botFilter: true, edgeSecret: "e" }); t.after(s.close);
  const edge = { "x-mdfit-edge": "e" };
  assert.equal((await s.call("GET", "/api/site", { headers: { ...edge, "user-agent": "python-requests/2.31" } })).status, 403);
  assert.equal((await s.call("GET", "/api/site", { headers: { ...edge, "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.0)" } })).status, 403);
  const ok = await s.call("GET", "/api/site", { headers: edge });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("strict-transport-security"), /max-age=63072000/);
  assert.equal(ok.headers.get("x-frame-options"), "DENY");
  assert.equal(ok.headers.get("x-powered-by"), null);
  // burst: 120 per 10 seconds per client IP (from the edge header), other IPs unaffected
  let last;
  for (let i = 0; i < 121; i++) last = await s.call("GET", "/api/content", { headers: { ...edge, "x-mdfit-client-ip": "203.0.113.7" } });
  assert.equal(last.status, 429);
  assert.equal((await s.call("GET", "/api/content", { headers: { ...edge, "x-mdfit-client-ip": "203.0.113.8" } })).status, 200);
});

test("data at rest: encrypted with DATA_ENC_KEY, plain files migrate, wrong key fails loudly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-store-"));
  const plain = createStore(dir);
  plain.write("clients", [{ email: "pat@example.com", painLog: [{ note: "left hip" }] }]);
  const enc = createStore(dir, { key: "k".repeat(32) });
  assert.equal(enc.read("clients", [])[0].email, "pat@example.com", "reads old plain files");
  enc.write("clients", enc.read("clients", []));
  const raw = fs.readFileSync(path.join(dir, "clients.json"), "utf8");
  assert.ok(raw.startsWith("enc:v1:") && !raw.includes("pat@example.com") && !raw.includes("left hip"));
  assert.equal(enc.read("clients", [])[0].painLog[0].note, "left hip");
  assert.throws(() => createStore(dir, { key: "wrong-key" }).read("clients", []));
  assert.throws(() => createStore(dir).read("clients", []), /DATA_ENC_KEY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const zonedToUtc = (date, time, tz) => {
  // test helper: America/New_York in November = UTC-5
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 5, mi));
};

test("SimplePractice feed: busy times parsed (UTC, TZID, all-day, cancelled skipped) and block booking slots", async (t) => {
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20261104T150000Z", "DTEND:20261104T160000Z", "SUMMARY:Busy", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;TZID=America/New_York:20261104T130000", "DTEND;TZID=America/New_York:20261104T140000", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106", "END:VEVENT",
    "BEGIN:VEVENT", "STATUS:CANCELLED", "DTSTART:20261104T190000Z", "DTEND:20261104T200000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const ev = parseIcs(ics, zonedToUtc);
  assert.equal(ev.length, 3);
  assert.equal(ev[1].start.toISOString(), "2026-11-04T18:00:00.000Z");
  assert.deepEqual(ev[2], { allDay: true, date: "2026-11-05" });
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => ics });
  const calsync = createCalSync({ icsUrl: "https://sp.example/feed.ics", tz: "America/New_York", zonedToUtc, fetchImpl });
  const s = await start({ calsync }); t.after(s.close);
  const site = (await s.call("GET", "/api/site")).body;
  const type = site.settings.appointmentTypes[0].id;
  const av = (await s.call("GET", `/api/availability?type=${type}&from=2026-11-04&days=2`)).body;
  const nov4 = av.days.find((d) => d.date === "2026-11-04").slots, nov5 = av.days.find((d) => d.date === "2026-11-05").slots;
  assert.ok(!nov4.includes("10:00") && !nov4.includes("13:00"), "10-11 (UTC event) and 1-2 (TZID event) are blocked");
  assert.ok(nov4.includes("15:00") || nov4.includes("16:00"), "other times stay open");
  assert.deepEqual(nov5, [], "all-day event blocks the whole day");
});

test("Google Calendar: service-account token, freeBusy blocks slots, bookings become events", async (t) => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "mdfit@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || "GET", url, opts.body]);
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("oauth2.googleapis.com/token")) return json(200, { access_token: "ya29.test", expires_in: 3600 });
    if (url.endsWith("/freeBusy")) return json(200, { calendars: { "dr@example.com": { busy: [{ start: "2026-11-04T16:00:00Z", end: "2026-11-04T17:00:00Z" }] } } });
    if (url.includes("/events") && opts.method === "POST") return json(200, { id: "gevt123" });
    if (opts.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    return json(404, {});
  };
  const calsync = createCalSync({ serviceAccount: Buffer.from(sa).toString("base64"), calendarId: "dr@example.com", tz: "America/New_York", zonedToUtc, fetchImpl });
  const s = await start({ calsync }); t.after(s.close);
  const site = (await s.call("GET", "/api/site")).body, type = site.settings.appointmentTypes[0];
  const day = (await s.call("GET", `/api/availability?type=${type.id}&from=2026-11-04&days=1`)).body.days[0];
  assert.ok(!day.slots.includes("11:00"), "Dr. Jared's Google busy time (11-12) is blocked");
  const tokenCall = calls.find((c) => c[1].includes("oauth2"));
  assert.match(String(tokenCall[2]), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  const r = await s.call("POST", "/api/appointments", { body: { typeId: type.id, date: "2026-11-04", time: day.slots[0], name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", notes: "left hip pain" } });
  assert.equal(r.status, 201);
  await new Promise((ok) => setTimeout(ok, 100));
  const ev = calls.find((c) => c[0] === "POST" && c[1].includes("/events"));
  const body = JSON.parse(ev[2]);
  assert.match(body.summary, /^MD Fit: .* · Pat D\.$/);
  assert.ok(!JSON.stringify(body).includes("hip"), "no health details sent to Google");
  await s.call("POST", `/api/appointments/${r.body.appointment.id}/cancel`, { body: { token: r.body.appointment.cancelToken } });
  await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(calls.some((c) => c[0] === "DELETE" && c[1].endsWith("/events/gevt123")), "cancelling removes the Google event");
});

test("rate limits: signed-in users are limited per account, so many patients on one Wi-Fi aren't blocked", async (t) => {
  const s = await start({ edgeSecret: "e" }); t.after(s.close);
  const edge = { "x-mdfit-edge": "e", "x-mdfit-client-ip": "198.51.100.20" };
  const signup = async (n) => (await s.call("POST", "/api/clients/signup", { headers: edge, body: { name: "Gym User" + n, email: `gym${n}@example.com`, password: "gym-pass-123" } })).body.token;
  const a = await signup(1), b = await signup(2);
  let last;
  for (let i = 0; i < 125; i++) last = await s.call("GET", "/api/me/library", { headers: { ...edge, authorization: "Bearer " + a } });
  assert.equal(last.status, 200, "one account can make 125 calls (limit 240 per 10 s)");
  for (let i = 0; i < 125; i++) last = await s.call("GET", "/api/me/library", { headers: { ...edge, authorization: "Bearer " + b } });
  assert.equal(last.status, 200, "a second patient on the same Wi-Fi isn't affected");
  for (let i = 0; i < 121; i++) last = await s.call("GET", "/api/content", { headers: edge });
  assert.equal(last.status, 429, "anonymous traffic from that address is still capped at 120 per 10 s");
});
