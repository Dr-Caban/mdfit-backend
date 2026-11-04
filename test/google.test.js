// Google reviews: a fake Places API (New) on a random port.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const KEY = "AIza_test_key";

function fakeGoogle() {
  const calls = [];
  const state = { down: false, rating: 4.9 };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, key: req.headers["x-goog-api-key"], mask: req.headers["x-goog-fieldmask"], body: body && JSON.parse(body) });
      const send = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (state.down) return send(503, { error: { message: "unavailable" } });
      if (state.newDisabled && req.url.startsWith("/v1/")) return send(403, { error: { message: "Places API (New) has not been used in project 123 before or it is disabled." } });
      const u = new URL(req.url, "http://x");
      if (u.pathname.startsWith("/legacy/")) {
        if (u.searchParams.get("key") !== KEY) return send(200, { status: "REQUEST_DENIED", error_message: "The provided API key is invalid." });
        if (u.pathname === "/legacy/findplacefromtext/json") return send(200, { status: "OK", candidates: [{ place_id: "ChIJmdfit", name: "MD Fit", formatted_address: "3214 Clark Rd" }] });
        if (u.pathname === "/legacy/details/json") return send(200, { status: "OK", result: { place_id: "ChIJmdfit", name: "MD Fit", rating: 4.8, user_ratings_total: 70, url: "https://maps.google.com/?cid=2",
          reviews: [{ author_name: "Jo R.", author_url: "https://www.google.com/maps/contrib/9", profile_photo_url: "https://lh3.googleusercontent.com/a/9", rating: 5, relative_time_description: "a week ago", text: "Back pain gone.", time: 1790000000 }, { author_name: "Empty", rating: 5, text: "" }] } });
      }
      if (req.headers["x-goog-api-key"] !== KEY) return send(403, { error: { message: "API key not valid" } });
      if (req.method === "POST" && req.url === "/v1/places:searchText")
        return send(200, { places: [{ id: "ChIJmdfit", displayName: { text: "MD Fit" }, formattedAddress: "3214 Clark Rd, Sarasota, FL 34231" }] });
      if (req.method === "GET" && req.url === "/v1/places/ChIJmdfit")
        return send(200, {
          id: "ChIJmdfit", displayName: { text: "MD Fit" }, rating: state.rating, userRatingCount: 64, googleMapsUri: "https://maps.google.com/?cid=1",
          reviews: [
            { rating: 5, text: { text: "Changed my life." }, relativePublishTimeDescription: "a month ago", publishTime: "2026-09-01T00:00:00Z",
              authorAttribution: { displayName: "Pat D.", uri: "https://www.google.com/maps/contrib/1", photoUri: "https://lh3.googleusercontent.com/a/1" } },
            { rating: 5, originalText: { text: "Knows exactly which muscle." }, authorAttribution: { displayName: "Sam L." } },
            { rating: 4, authorAttribution: { displayName: "No text" } }
          ]
        });
      send(404, { error: { message: "not found" } });
    });
  }).listen(0);
  return { server, calls, state, url: () => `http://127.0.0.1:${server.address().port}/v1`, legacy: () => `http://127.0.0.1:${server.address().port}/legacy` };
}

async function start(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-g-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("test-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"),
    googleQuery: "MD Fit, 3214 Clark Road, Sarasota, FL 34231", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url) => {
    const res = await fetch(base + url, { method, headers: token ? { authorization: "Bearer " + token } : {} });
    return { status: res.status, body: await res.json() };
  };
  const login = async () => {
    const r = await fetch(base + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "coach@example.com", password: "test-pass-123" }) });
    token = (await r.json()).token;
  };
  return { call, login, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("no key: reviews endpoint says none, admin refresh explains", async (t) => {
  const s = await start({ googleKey: "" }); t.after(s.close);
  assert.deepEqual((await s.call("GET", "/api/reviews")).body, { source: "none" });
  await s.login();
  const r = await s.call("POST", "/api/admin/reviews/refresh");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /GOOGLE_PLACES_API_KEY/);
});

test("finds the place, returns rating, count and reviews, caches, never leaks the key", async (t) => {
  const g = fakeGoogle(); t.after(() => g.server.close());
  const s = await start({ googleKey: KEY, googleUrl: g.url() }); t.after(s.close);
  const r = (await s.call("GET", "/api/reviews")).body;
  assert.equal(r.source, "google");
  assert.equal(r.name, "MD Fit");
  assert.equal(r.rating, 4.9);
  assert.equal(r.count, 64);
  assert.equal(r.url, "https://maps.google.com/?cid=1");
  assert.equal(r.reviews.length, 2, "reviews without text are dropped");
  assert.deepEqual(r.reviews[0], { author: "Pat D.", authorUrl: "https://www.google.com/maps/contrib/1", photo: "https://lh3.googleusercontent.com/a/1", rating: 5, text: "Changed my life.", relativeTime: "a month ago", publishTime: "2026-09-01T00:00:00Z" });
  assert.equal(r.reviews[1].text, "Knows exactly which muscle.");
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.equal(r.placeId, undefined);

  const search = g.calls.find((c) => c.url === "/v1/places:searchText");
  assert.equal(search.body.textQuery, "MD Fit, 3214 Clark Road, Sarasota, FL 34231");
  assert.equal(search.key, KEY);
  assert.match(g.calls.find((c) => c.url === "/v1/places/ChIJmdfit").mask, /reviews/);

  const before = g.calls.length;
  await s.call("GET", "/api/reviews");
  assert.equal(g.calls.length, before, "second request is served from cache");
});

test("Google down: last good copy is served; admin refresh reports the error", async (t) => {
  const g = fakeGoogle(); t.after(() => g.server.close());
  const s = await start({ googleKey: KEY, googleUrl: g.url() }); t.after(s.close);
  await s.login();
  assert.equal((await s.call("POST", "/api/admin/reviews/refresh")).body.count, 64);
  g.state.down = true;
  const r = await s.call("POST", "/api/admin/reviews/refresh");
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Google error 503/);
  const pub = (await s.call("GET", "/api/reviews")).body;
  assert.equal(pub.source, "google");
  assert.equal(pub.count, 64);
});

test("fixed GOOGLE_PLACE_ID skips the search; bad key is reported", async (t) => {
  const g = fakeGoogle(); t.after(() => g.server.close());
  const s = await start({ googleKey: KEY, googleUrl: g.url(), googlePlaceId: "ChIJmdfit" }); t.after(s.close);
  assert.equal((await s.call("GET", "/api/reviews")).body.rating, 4.9);
  assert.ok(!g.calls.some((c) => c.url.includes("searchText")));
  const bad = await start({ googleKey: "wrong", googleUrl: g.url() }); t.after(bad.close);
  await bad.login();
  const r = await bad.call("POST", "/api/admin/reviews/refresh");
  assert.equal(r.status, 502);
  assert.match(r.body.error, /API key not valid/);
  assert.deepEqual((await bad.call("GET", "/api/reviews")).body, { source: "none" });
});

test("falls back to the legacy Places API when Places API (New) isn't enabled for the key", async (t) => {
  const g = fakeGoogle(); g.state.newDisabled = true; t.after(() => g.server.close());
  const s = await start({ googleKey: KEY, googleUrl: g.url(), googleLegacyUrl: g.legacy() }); t.after(s.close);
  const r = (await s.call("GET", "/api/reviews")).body;
  assert.equal(r.source, "google");
  assert.equal(r.rating, 4.8);
  assert.equal(r.count, 70);
  assert.equal(r.url, "https://maps.google.com/?cid=2");
  assert.deepEqual(r.reviews, [{ author: "Jo R.", authorUrl: "https://www.google.com/maps/contrib/9", photo: "https://lh3.googleusercontent.com/a/9", rating: 5, text: "Back pain gone.", relativeTime: "a week ago", publishTime: new Date(1790000000 * 1000).toISOString() }]);
  await s.login();
  assert.equal((await s.call("POST", "/api/admin/reviews/refresh")).body.api, "legacy");
  const newCalls = g.calls.filter((c) => c.url.startsWith("/v1/")).length;
  await s.call("POST", "/api/admin/reviews/refresh");
  assert.equal(g.calls.filter((c) => c.url.startsWith("/v1/")).length, newCalls, "stays on legacy once detected");
});
