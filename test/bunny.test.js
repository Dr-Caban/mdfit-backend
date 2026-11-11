"use strict";
// Bunny Stream as the video host: with no Bunny credentials everything still goes to Cloudinary; with them, videos are
// created + streamed up to Bunny while images stay on Cloudinary, /api/videos publishes both maps, and an upload that
// fails is recorded and retried on the next run. A guid is published only once Bunny has encoded a 720p MP4, so the app
// never builds a play_720p.mp4 URL that 404s. No real network: a loopback server stands in for Bunny/Cloudinary/Drive.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
process.env.CLOUDINARY_CLOUD_NAME = "testcloud"; process.env.CLOUDINARY_API_KEY = "key"; process.env.CLOUDINARY_API_SECRET = "secret";
const { createApp } = require("../server");
const { createBunny } = require("../lib/bunny");
const { hashPassword } = require("../lib/auth");

const asset = (key, extra) => ({ key, source: "drive", drive_id: key, type: "video", purpose: "exercise-library", public_id: `mdfit/videos/exercise-library/Exercise/Hips/Strength/${key}`,
  display_name: key, tags: ["mdfit"], context: { name: key }, folder: "mdfit/videos/exercise-library/Exercise/Hips/Strength", ...extra });
const ASSETS = [
  asset("clip-one"), asset("clip-two"),
  asset("pain-pic", { type: "image", public_id: "mdfit/images/pain-patterns/Calf/pattern-1", folder: "mdfit/images/pain-patterns/Calf" })
];

async function fakes() {
  const seen = { cloudinary: [], bunnyCreate: [], bunnyUpload: [], bunnyDelete: [], bunnyCollList: [], bunnyCollCreate: [] };
  // encode: what Bunny reports for an uploaded video (status 4 = resolution finished, 2 = still encoding, 5 = failed)
  const state = { failUpload: new Set(), encode: { status: 4, encodeProgress: 100, availableResolutions: "360p,720p" },
    collections: [], failCollections: false };
  let guidSeq = 0;
  const titleOf = {}; // guid -> title, so the test can tell which asset an upload belongs to
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/data/media-manifest.json") return json(200, { version: "t", count: ASSETS.length, assets: ASSETS });
    if (u.pathname === "/public") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(96, 3)); }
    if (u.pathname === "/bunny/library/lib42/collections") {
      if (req.headers.accesskey !== "bunny-key") return json(401, { Message: "bad key" });
      if (state.failCollections) return json(500, { Message: "collections down" });
      if (req.method === "GET") {
        const q = u.searchParams.get("search") || "";
        seen.bunnyCollList.push(q);
        // Bunny's search is fuzzy: a near-miss comes back too, which is why the client matches the name exactly
        return json(200, { items: state.collections.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) });
      }
      let b = ""; for await (const c of req) b += c;
      const name = (JSON.parse(b || "{}") || {}).name;
      const guid = `coll-${state.collections.length + 1}`;
      state.collections.push({ guid, name });
      seen.bunnyCollCreate.push(name);
      return json(200, { guid, name });
    }
    if (u.pathname === "/bunny/library/lib42/videos") { // create
      let b = ""; for await (const c of req) b += c;
      const title = (JSON.parse(b || "{}") || {}).title;
      if (req.headers.accesskey !== "bunny-key") return json(401, { Message: "bad key" });
      const guid = `guid-${++guidSeq}`; titleOf[guid] = title;
      seen.bunnyCreate.push({ title, guid, auth: !!req.headers.accesskey, collectionId: (JSON.parse(b || "{}") || {}).collectionId });
      return json(200, { guid, title });
    }
    const m = u.pathname.match(/^\/bunny\/library\/lib42\/videos\/([^/]+)$/);
    if (m) {
      const guid = m[1];
      if (req.method === "DELETE") { seen.bunnyDelete.push(guid); return json(200, { success: true }); }
      if (req.method === "GET") { if (req.headers.accesskey !== "bunny-key") return json(401, { Message: "bad key" }); return json(200, { guid, ...state.encode }); }
      let bytes = 0; for await (const c of req) bytes += c.length;
      if (state.failUpload.has(titleOf[guid])) return json(500, { Message: "storage busy" });
      seen.bunnyUpload.push({ guid, title: titleOf[guid], bytes, length: Number(req.headers["content-length"] || 0), auth: req.headers.accesskey === "bunny-key" });
      return json(200, { success: true });
    }
    if (/^\/v1_1\/testcloud\/(video|image)\/upload$/.test(u.pathname)) {
      const ct = req.headers["content-type"] || "";
      let fields = {}, fileBytes = 0;
      if (ct.startsWith("multipart/")) {
        const fd = await new Response(Readable.toWeb(req), { headers: { "content-type": ct } }).formData();
        for (const [k, v] of fd.entries()) { if (typeof v === "string") fields[k] = v; else fileBytes = v.size; }
      } else { let b = ""; for await (const c of req) b += c; fields = Object.fromEntries(new URLSearchParams(b)); }
      seen.cloudinary.push({ ...fields, kind: u.pathname.split("/")[3] });
      return json(200, { public_id: fields.public_id, version: 7, bytes: fileBytes || 96, format: "mp4" });
    }
    res.writeHead(404); res.end();
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, state, close: () => srv.close() };
}

function start(t, f, opt = {}) {
  const dataDir = opt.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-b-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: f.base, noVideoSync: true, cloudinaryApiUrl: f.base, bunnyApiUrl: f.base + "/bunny", drivePublicUrl: f.base + "/public?id=",
    ...("dual" in opt ? { bunnyDualWrite: opt.dual } : {}) });
  const server = app.listen(0);
  t.after(() => { server.close(); if (!opt.keepData) fs.rmSync(dataDir, { recursive: true, force: true }); });
  return new Promise((r) => server.once("listening", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (m, u, b, tok) => { const res = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: res.status, body: await res.json().catch(() => null) }; };
    r({ call, dataDir });
  }));
}
const login = async (call) => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
async function sync(call, adm, body) {
  const started = await call("POST", "/api/admin/videos/migrate", body || {}, adm);
  let st = { job: null };
  for (let i = 0; i < 200; i++) { st = (await call("GET", "/api/admin/videos/status", undefined, adm)).body; if (st.job && st.job.finishedAt) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(st.job && st.job.finishedAt, "job finished");
  return { started: started.body, st };
}
const withBunny = (on) => { if (on) { process.env.BUNNY_STREAM_API_KEY = "bunny-key"; process.env.BUNNY_STREAM_LIBRARY_ID = "lib42"; process.env.BUNNY_STREAM_HOSTNAME = "vz-test.b-cdn.net"; }
  else { delete process.env.BUNNY_STREAM_API_KEY; delete process.env.BUNNY_STREAM_LIBRARY_ID; delete process.env.BUNNY_STREAM_HOSTNAME; } };

test("bunny: the client talks to the Bunny API and builds playback URLs", async (t) => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    let body = opt.body;
    if (body && typeof body !== "string") { let n = 0; for await (const c of body) n += c.length; body = { streamedBytes: n }; } // read it like a real request would
    calls.push({ url, method: opt.method, key: opt.headers.AccessKey, length: opt.headers["content-length"], body });
    return { ok: true, status: 200, json: async () => ({ guid: "abc123" }), text: async () => "{}" };
  };
  const b = createBunny({ apiKey: "k", libraryId: "7", host: "vz.b-cdn.net", fetchImpl });
  assert.equal(b.ready(), true);
  assert.equal(createBunny({ apiKey: "k", libraryId: "7" }).ready(), false);
  assert.equal(await b.createVideo("Hip Switch"), "abc123");
  assert.deepEqual(calls[0], { url: "https://video.bunnycdn.com/library/7/videos", method: "POST", key: "k", length: undefined, body: JSON.stringify({ title: "Hip Switch" }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-u-")), tmp = path.join(dir, "in.bin");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(tmp, Buffer.alloc(10, 1));
  assert.deepEqual(await b.uploadBytes("abc123", tmp), { guid: "abc123", bytes: 10 });
  assert.equal(calls[1].url, "https://video.bunnycdn.com/library/7/videos/abc123"); assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].length, "10"); assert.deepEqual(calls[1].body, { streamedBytes: 10 }); // streamed, not buffered
  await b.remove("abc123"); assert.equal(calls[2].method, "DELETE");
  assert.deepEqual(b.urls("abc123"), { mp4720: "https://vz.b-cdn.net/abc123/play_720p.mp4", hls: "https://vz.b-cdn.net/abc123/playlist.m3u8", thumb: "https://vz.b-cdn.net/abc123/thumbnail.jpg" });
  // a non-ok answer becomes a short readable error, with Bunny's own message when it sends one
  // status() turns Bunny's video record into "is the 720p MP4 there yet"
  const st = (v) => createBunny({ apiKey: "k", libraryId: "7", host: "h", fetchImpl: async () => ({ ok: true, status: 200, json: async () => v, text: async () => "" }) }).status("g");
  assert.deepEqual(await st({ status: 4, encodeProgress: 100, availableResolutions: "360p,720p" }), { failed: false, encoded: true, progress: 100, resolutions: ["360p", "720p"], has720: true });
  assert.deepEqual(await st({ status: 2, encodeProgress: 40, availableResolutions: "" }), { failed: false, encoded: false, progress: 40, resolutions: [], has720: false });
  assert.deepEqual(await st({ status: 5, encodeProgress: 0 }), { failed: true, encoded: false, progress: 0, resolutions: [], has720: false });
  assert.equal((await st({ status: 4, mp4Resolutions: "480p" })).has720, false); // MP4 Fallback on, but no 720p
  const bad = createBunny({ apiKey: "k", libraryId: "7", host: "vz.b-cdn.net", fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ Message: "Unauthorized" }) }) });
  await assert.rejects(() => bad.createVideo("x"), /Bunny create: HTTP 403 Unauthorized/);
});

test("media sync: with no Bunny credentials every asset still goes to Cloudinary", async (t) => {
  withBunny(false); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  const { call } = await start(t, f);
  const adm = await login(call);
  const { started, st } = await sync(call, adm);
  assert.deepEqual(started, { started: true, total: 3 });
  assert.equal(st.job.ok, 3); assert.equal(st.job.failed, 0);
  assert.deepEqual(st.providers, { cloudinary: true, bunny: false });
  assert.deepEqual(st.doneByProvider, { cloudinary: 3, bunny: 0 });
  assert.equal(f.seen.cloudinary.length, 3); assert.equal(f.seen.bunnyCreate.length, 0);
  const pub = (await call("GET", "/api/videos")).body;
  assert.equal(pub.cloud, "testcloud");
  assert.equal(pub.bunny.host, ""); assert.deepEqual(pub.bunny.map, {}); // paths/res are always present, see the publishing test
  assert.deepEqual(pub.map["clip-one"], ["mdfit/videos/exercise-library/Exercise/Hips/Strength/clip-one", "v", 7]);
  assert.deepEqual(pub.ids.sort(), ["clip-one", "clip-two", "pain-pic"]);
});

test("media sync: dual-write puts a video on both hosts and in both maps", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  const { call } = await start(t, f);
  const adm = await login(call);
  const { st } = await sync(call, adm);
  assert.equal(st.job.ok, 3); assert.equal(st.job.failed, 0);
  assert.deepEqual(st.providers, { cloudinary: true, bunny: true });
  assert.equal(st.dualWrite, true);
  assert.deepEqual(st.doneByProvider, { cloudinary: 3, bunny: 2 }); // every asset on Cloudinary, the two videos on Bunny too
  assert.equal(st.bunnyEncoding, 0);
  // the two videos were created and streamed up to Bunny with the access key and a content-length
  assert.deepEqual(f.seen.bunnyCreate.map((c) => c.title).sort(), ["clip-one", "clip-two"]);
  assert.equal(f.seen.bunnyUpload.length, 2);
  for (const up of f.seen.bunnyUpload) { assert.equal(up.auth, true); assert.equal(up.bytes, 96); assert.equal(up.length, 96); }
  // Cloudinary still got all three, so every video keeps a known-good MP4 behind the Bunny one
  assert.deepEqual(f.seen.cloudinary.map((c) => c.public_id).sort(), [
    "mdfit/images/pain-patterns/Calf/pattern-1", "mdfit/videos/exercise-library/Exercise/Hips/Strength/clip-one", "mdfit/videos/exercise-library/Exercise/Hips/Strength/clip-two"]);
  const pub = (await call("GET", "/api/videos")).body;
  assert.equal(pub.cloud, "testcloud");
  assert.equal(pub.bunny.host, "vz-test.b-cdn.net");
  assert.deepEqual(Object.keys(pub.bunny.map).sort(), ["clip-one", "clip-two"]);
  assert.match(pub.bunny.map["clip-one"], /^guid-\d$/);
  assert.deepEqual(pub.map["clip-one"], ["mdfit/videos/exercise-library/Exercise/Hips/Strength/clip-one", "v", 7]);
  assert.deepEqual(pub.map["pain-pic"], ["mdfit/images/pain-patterns/Calf/pattern-1", "i", 7]);
  assert.deepEqual(pub.ids.sort(), ["clip-one", "clip-two", "pain-pic"]);
  // nothing is copied twice
  const second = await sync(call, adm);
  assert.equal(second.st.job.total, 0);
  assert.deepEqual((await call("GET", "/api/videos")).body, pub);
});

test("media sync: with dual-write off a video goes to Bunny only", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  const { call } = await start(t, f, { dual: false });
  const adm = await login(call);
  const { st } = await sync(call, adm);
  assert.equal(st.dualWrite, false);
  assert.deepEqual(st.doneByProvider, { cloudinary: 1, bunny: 2 });
  assert.deepEqual(f.seen.cloudinary.map((c) => c.public_id), ["mdfit/images/pain-patterns/Calf/pattern-1"]);
  assert.equal(f.seen.bunnyUpload.length, 2);
  const pub = (await call("GET", "/api/videos")).body;
  assert.deepEqual(Object.keys(pub.bunny.map).sort(), ["clip-one", "clip-two"]);
  assert.deepEqual(pub.map, { "pain-pic": ["mdfit/images/pain-patterns/Calf/pattern-1", "i", 7] });
  assert.deepEqual(pub.ids.sort(), ["clip-one", "clip-two", "pain-pic"]);
});

test("media sync: a failed Bunny upload keeps the Cloudinary copy serving and is retried on the next run", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  f.state.failUpload.add("clip-two");
  const { call } = await start(t, f);
  const adm = await login(call);
  const first = await sync(call, adm);
  assert.equal(first.st.job.ok, 2); assert.equal(first.st.job.failed, 1);
  assert.match(first.st.failed["clip-two"], /^Bunny: Bunny upload: HTTP 500 storage busy/);
  assert.deepEqual(first.st.doneByProvider, { cloudinary: 3, bunny: 1 }); // the Cloudinary leg still landed
  // the half-made video is cleaned up rather than left empty in the library
  assert.equal(f.seen.bunnyDelete.length, 1);
  const pub1 = (await call("GET", "/api/videos")).body;
  assert.equal(pub1.bunny.map["clip-two"], undefined);
  assert.deepEqual(pub1.map["clip-two"], ["mdfit/videos/exercise-library/Exercise/Hips/Strength/clip-two", "v", 7]); // member still gets a CDN MP4
  // a plain re-run leaves a failed asset alone; retryFailed picks up the Bunny leg only
  assert.equal((await sync(call, adm)).st.job.total, 0);
  f.state.failUpload.clear();
  const retry = await sync(call, adm, { retryFailed: true });
  assert.equal(retry.st.job.total, 1); assert.equal(retry.st.job.ok, 1);
  assert.deepEqual(retry.st.failed, {});
  assert.equal(f.seen.cloudinary.filter((c) => /clip-two$/.test(c.public_id)).length, 1, "the Cloudinary copy wasn't uploaded again");
  const pub2 = (await call("GET", "/api/videos")).body;
  assert.match(pub2.bunny.map["clip-two"], /^guid-\d$/);
  assert.deepEqual(pub2.map["clip-two"], pub1.map["clip-two"]);
});

test("media sync: while Bunny is encoding the member is served from Cloudinary", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  f.state.encode = { status: 2, encodeProgress: 35, availableResolutions: "" }; // still encoding when the upload returns
  const { call } = await start(t, f);
  const adm = await login(call);
  const first = await sync(call, adm);
  assert.equal(first.st.job.ok, 3);
  assert.deepEqual(first.st.doneByProvider, { cloudinary: 3, bunny: 0 });
  assert.equal(first.st.bunnyEncoding, 2);
  assert.deepEqual(first.st.failed, {}); // encoding isn't a failure
  // no guid goes out yet, so the app plays the Cloudinary MP4 - never the Drive iframe
  const pub1 = (await call("GET", "/api/videos")).body;
  assert.equal(pub1.bunny.host, "vz-test.b-cdn.net"); assert.deepEqual(pub1.bunny.map, {});
  assert.deepEqual(Object.keys(pub1.map).sort(), ["clip-one", "clip-two", "pain-pic"]);
  // once the encode finishes, the next pass publishes both without re-uploading anything
  f.state.encode = { status: 4, encodeProgress: 100, availableResolutions: "360p,720p" };
  const after = await sync(call, adm);
  assert.equal(after.st.job.total, 0); assert.equal(f.seen.bunnyUpload.length, 2);
  assert.deepEqual(after.st.doneByProvider, { cloudinary: 3, bunny: 2 });
  const pub2 = (await call("GET", "/api/videos")).body;
  assert.deepEqual(Object.keys(pub2.bunny.map).sort(), ["clip-one", "clip-two"]);
  assert.deepEqual(pub2.map, pub1.map); // the Cloudinary safety net is untouched
});

test("media sync: an encoded video with no 720p MP4 is reported, not published", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  f.state.encode = { status: 4, encodeProgress: 100, availableResolutions: "" }; // MP4 Fallback off in the library
  const { call } = await start(t, f);
  const adm = await login(call);
  const { st } = await sync(call, adm);
  assert.deepEqual((await call("GET", "/api/videos")).body.bunny.map, {});
  assert.match(st.failed["clip-one"], /no MP4 renditions - turn on MP4 Fallback.*still serving from Cloudinary/);
  // and when it encodes to something other than 720p, the status says what it did get
  const g = await fakes(); t.after(g.close);
  g.state.encode = { status: 4, encodeProgress: 100, availableResolutions: "240p,480p" };
  const two = await start(t, g);
  const adm2 = await login(two.call);
  const st2 = (await sync(two.call, adm2)).st;
  assert.match(st2.failed["clip-two"], /no 720p MP4 \(only 240p, 480p\)/);
  assert.deepEqual((await two.call("GET", "/api/videos")).body.bunny.map, {});
});

test("media sync: videos already on Cloudinary are mirrored to Bunny by a normal sync", async (t) => {
  const f = await fakes(); t.after(f.close);
  // first, the world as it is today: no Bunny credentials, everything on Cloudinary
  withBunny(false); t.after(() => withBunny(false));
  const before = await start(t, f, { keepData: true });
  const adm0 = await login(before.call);
  assert.equal((await sync(before.call, adm0)).st.job.ok, 3);
  const was = (await before.call("GET", "/api/videos")).body.map;
  // now Bunny is configured, on the same store: an ordinary sync mirrors the whole library, no flag needed
  withBunny(true);
  const { call } = await start(t, f, { dataDir: before.dataDir });
  const adm = await login(call);
  const mirror = await sync(call, adm);
  assert.equal(mirror.st.job.total, 2); assert.equal(mirror.st.job.ok, 2); // the two videos; the image has nothing to do
  assert.equal(f.seen.bunnyUpload.length, 2);
  assert.equal(f.seen.cloudinary.length, 3, "no Cloudinary re-upload");
  assert.deepEqual(mirror.st.doneByProvider, { cloudinary: 3, bunny: 2 });
  assert.deepEqual(mirror.st.mirror, { videos: 2, onBoth: 2, bunnyPending: 0, bunnyMissing: 0, failed: 0 });
  const pub = (await call("GET", "/api/videos")).body;
  assert.deepEqual(pub.map, was); // the Cloudinary records are exactly as they were
  assert.deepEqual(Object.keys(pub.bunny.map).sort(), ["clip-one", "clip-two"]);
  // a video confirmed on Bunny is never uploaded again
  assert.equal((await sync(call, adm)).st.job.total, 0);
  assert.equal(f.seen.bunnyUpload.length, 2);
});

test("media sync: an interrupted mirror resumes where it stopped", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  f.state.failUpload.add("clip-two"); // stands in for the run dying part-way through
  const first = await start(t, f, { keepData: true });
  const adm0 = await login(first.call);
  const one = await sync(first.call, adm0);
  assert.equal(one.st.job.ok, 2); assert.equal(one.st.job.failed, 1);
  assert.deepEqual(one.st.mirror, { videos: 2, onBoth: 1, bunnyPending: 0, bunnyMissing: 1, failed: 1 });
  // the container restarts on the same store: only what's missing is picked up
  f.state.failUpload.clear();
  const { call } = await start(t, f, { dataDir: first.dataDir });
  const adm = await login(call);
  const two = await sync(call, adm, { retryFailed: true });
  assert.equal(two.st.job.total, 1); assert.equal(two.st.job.ok, 1);
  assert.deepEqual(two.st.mirror, { videos: 2, onBoth: 2, bunnyPending: 0, bunnyMissing: 0, failed: 0 });
  assert.deepEqual(f.seen.bunnyUpload.map((u) => u.title).sort(), ["clip-one", "clip-two"], "nothing uploaded twice");
  assert.deepEqual(Object.keys((await call("GET", "/api/videos")).body.bunny.map).sort(), ["clip-one", "clip-two"]);
});

// Dr. Jared files everything the app plays under a Bunny collection called "In app", so the library stays readable
// next to the raw footage he uploads by hand.
test("bunny client: the 'In app' collection is found or created, then reused", async () => {
  const calls = [];
  let coll = null;
  const fetchImpl = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || "GET", body: opt.body });
    if (/\/collections\?/.test(url)) return { ok: true, status: 200, json: async () => ({ items: coll ? [coll] : [] }), text: async () => "" };
    if (/\/collections$/.test(url)) { coll = { guid: "coll-1", name: JSON.parse(opt.body).name }; return { ok: true, status: 200, json: async () => coll, text: async () => "" }; }
    return { ok: true, status: 200, json: async () => ({ guid: "vid-1" }), text: async () => "" };
  };
  const b = createBunny({ apiKey: "k", libraryId: "7", host: "vz.b-cdn.net", fetchImpl });

  assert.equal(await b.collection("In app"), "coll-1", "created when the library has none");
  assert.equal(calls[0].url, "https://video.bunnycdn.com/library/7/collections?page=1&itemsPerPage=100&search=In%20app");
  assert.equal(calls[1].method, "POST");
  assert.equal(JSON.parse(calls[1].body).name, "In app");

  // a sync run creates hundreds of videos and must not ask hundreds of times
  assert.equal(await b.collection("In app"), "coll-1");
  assert.equal(calls.length, 2, "the second call is served from memory");

  // a fresh client finds the existing one instead of making a duplicate
  const b2 = createBunny({ apiKey: "k", libraryId: "7", host: "vz.b-cdn.net", fetchImpl });
  assert.equal(await b2.collection("In app"), "coll-1");
  assert.equal(calls.filter((c) => c.method === "POST" && /\/collections$/.test(c.url)).length, 1);

  // the guid rides along on create
  await b.createVideo("Hip Switch", "coll-1");
  const made = calls.find((c) => /\/videos$/.test(c.url) && c.method === "POST");
  assert.deepEqual(JSON.parse(made.body), { title: "Hip Switch", collectionId: "coll-1" });
});

test("bunny client: an exact name beats Bunny's fuzzy search, and no collection means no collectionId", async () => {
  const items = [{ guid: "coll-9", name: "In app archive" }, { guid: "coll-4", name: "In app" }];
  const bodies = [];
  const fetchImpl = async (url, opt = {}) => {
    bodies.push({ url, body: opt.body });
    if (/\/collections\?/.test(url)) return { ok: true, status: 200, json: async () => ({ items }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({ guid: "vid-1" }), text: async () => "" };
  };
  const b = createBunny({ apiKey: "k", libraryId: "7", host: "h", fetchImpl });
  assert.equal(await b.collection("In app"), "coll-4", "not the fuzzy 'In app archive' match");

  await b.createVideo("Hip Switch");
  const made = bodies.find((c) => /\/videos$/.test(c.url));
  assert.deepEqual(JSON.parse(made.body), { title: "Hip Switch" }, "no empty collectionId sent");
});

test("media sync: every mirrored video lands in the 'In app' collection", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  const { call } = await start(t, f);
  const adm = await login(call);
  const { st } = await sync(call, adm);

  assert.equal(st.job.failed, 0);
  assert.deepEqual(f.seen.bunnyCollCreate, ["In app"], "created once, not once per video");
  assert.equal(f.seen.bunnyCollList.length, 1, "and looked up once");
  assert.equal(f.seen.bunnyCreate.length, 2);
  for (const c of f.seen.bunnyCreate) assert.equal(c.collectionId, "coll-1", `${c.title} was filed`);
  // and the videos are still playable, i.e. the collection didn't disturb the readiness gate
  assert.deepEqual(Object.keys((await call("GET", "/api/videos")).body.bunny.map).sort(), ["clip-one", "clip-two"]);
});

test("media sync: a collection outage still gets the videos uploaded", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  f.state.failCollections = true; // the collection is cosmetic; the guid is not
  const { call } = await start(t, f);
  const adm = await login(call);
  const { st } = await sync(call, adm);

  assert.equal(st.job.failed, 0, "no video was lost to a folder error");
  assert.equal(f.seen.bunnyUpload.length, 2);
  for (const c of f.seen.bunnyCreate) assert.equal(c.collectionId, undefined, "unfiled rather than not uploaded");
  assert.deepEqual(Object.keys((await call("GET", "/api/videos")).body.bunny.map).sort(), ["clip-one", "clip-two"]);
});

// One upload has to serve web, Android and Apple. The backend therefore publishes the URL shape as templates and the
// renditions Bunny actually produced, so a native client neither hard-codes the host nor assumes 720p exists.
test("api: /api/videos publishes the playback shape every platform needs", async (t) => {
  withBunny(true); t.after(() => withBunny(false));
  const f = await fakes(); t.after(f.close);
  const { call } = await start(t, f);
  const adm = await login(call);
  await sync(call, adm);

  const pub = (await call("GET", "/api/videos")).body;
  assert.equal(pub.bunny.host, "vz-test.b-cdn.net");
  // the templates, not baked-in URLs: moving the pull zone must not need three app releases
  assert.deepEqual(pub.bunny.paths, { hls: "https://{host}/{guid}/playlist.m3u8",
    mp4: "https://{host}/{guid}/play_{res}.mp4", thumb: "https://{host}/{guid}/thumbnail.jpg", preferred: "720p" });
  // what Bunny really made, per key - a client picks a rendition instead of assuming one
  assert.deepEqual(pub.bunny.res["clip-one"], ["360p", "720p"]);

  // filling a template gives the same URLs lib/bunny.js builds, which is the contract that keeps them in step
  const guid = pub.bunny.map["clip-one"];
  const fill = (t2, res) => t2.replace("{host}", pub.bunny.host).replace("{guid}", guid).replace("{res}", res);
  const direct = createBunny({ apiKey: "k", libraryId: "l", host: pub.bunny.host }).urls(guid);
  assert.equal(fill(pub.bunny.paths.hls), direct.hls);
  assert.equal(fill(pub.bunny.paths.mp4, pub.bunny.paths.preferred), direct.mp4720);
  assert.equal(fill(pub.bunny.paths.thumb), direct.thumb);
});

test("api: with no Bunny configured the playback shape is still well formed", async (t) => {
  const f = await fakes(); t.after(f.close); // no Bunny credentials
  const { call } = await start(t, f);
  const pub = (await call("GET", "/api/videos")).body;
  assert.equal(pub.bunny.host, "", "nothing to play from");
  assert.deepEqual(pub.bunny.map, {});
  assert.deepEqual(pub.bunny.res, {}, "a client iterating res must not get undefined");
  assert.equal(typeof pub.bunny.paths, "object");
});

// A transfer with no deadline can sit on an open socket forever, and the run is one loop: a single stuck asset stops
// every asset behind it. This happened in production - the mirror went quiet mid-run with the CPU idle and no bytes
// moving, and ~50 videos never went up. A stalled request must fail its own asset and let the loop carry on.
test("bunny client: an upload that hangs is given up on, it does not wait forever", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-h-")), tmp = path.join(dir, "in.bin");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(tmp, Buffer.alloc(32, 1));

  // a stand-in that never answers, exactly like the socket that stalled
  const hang = (url, opt = {}) => new Promise((_, reject) => {
    if (opt.signal) opt.signal.addEventListener("abort", () => reject(opt.signal.reason || new Error("aborted")));
  });
  const b = createBunny({ apiKey: "k", libraryId: "7", host: "h", apiUrl: "http://x", fetchImpl: hang, timeoutMs: 150 });
  // AbortSignal.timeout's timer is unref'd, so with nothing else pending the loop would empty and cancel this test
  const keep = setInterval(() => {}, 25);
  t.after(() => clearInterval(keep));

  const started = Date.now();
  await assert.rejects(() => b.uploadBytes("guid-1", tmp), /gave up|stalled|abort/i, "a hung upload must reject");
  const waited = Date.now() - started;
  assert.ok(waited < 5000, `gave up after ${waited}ms`);
  // the same deadline covers the JSON calls, so a hung create cannot wedge the run either
  await assert.rejects(() => b.createVideo("x"), /abort|timeout|TimeoutError/i);
});

// Drive does not go slow, it goes silent: part way through a bulk mirror it stops sending with the socket still open.
// So the guard that matters is "no bytes for a while", not "too long in total" - a 430 MB file that keeps trickling
// must be left alone while a quiet one is dropped in seconds.
test("idle watchdog: a stream that goes quiet is dropped, one that keeps moving is not", async (t) => {
  // the watchdog's timers are unref'd on purpose (it must never hold the process open), so in a test with nothing
  // else pending the loop would empty and cancel this
  const keep = setInterval(() => {}, 25); t.after(() => clearInterval(keep));
  const { idleAbort, meter } = require("../lib/idle");
  const { Readable } = require("stream");

  // keeps trickling, slower than the idle window but never silent: must survive
  const w1 = idleAbort(120, 5000);
  const slow = Readable.from((async function* () {
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 60)); yield Buffer.alloc(16, i); }
  })());
  let got = 0;
  for await (const c of meter(slow, w1)) got += c.length;
  w1.stop();
  assert.equal(got, 128, "a slow but live transfer is not interrupted");
  assert.equal(w1.signal.aborted, false);

  // sends a little, then goes silent: must abort on the idle window, well before the ceiling
  const w2 = idleAbort(120, 60000);
  const stalls = Readable.from((async function* () { yield Buffer.alloc(16, 1); await new Promise(() => {}); })());
  const t0 = Date.now();
  await new Promise((res) => { w2.signal.addEventListener("abort", res); meter(stalls, w2).resume(); });
  const waited = Date.now() - t0;
  w2.stop();
  assert.ok(w2.signal.aborted, "a silent socket is given up on");
  assert.ok(waited < 2000, `aborted after ${waited}ms, not on the 60s ceiling`);
  assert.match(String(w2.signal.reason && w2.signal.reason.message || ""), /stalled: no data/);
});

// The meter must not change how the stream behaves: a "data" listener would switch the source into flowing mode and
// race whatever reads it next, silently losing bytes from an upload.
test("idle watchdog: metering does not drop bytes or break backpressure", async (t) => {
  // the watchdog's timers are unref'd on purpose (it must never hold the process open), so in a test with nothing
  // else pending the loop would empty and cancel this
  const keep = setInterval(() => {}, 25); t.after(() => clearInterval(keep));
  const { idleAbort, meter } = require("../lib/idle");
  const { Readable } = require("stream");
  const w = idleAbort(5000, 20000);
  const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(1024, i % 256));
  const want = Buffer.concat(chunks);
  const out = [];
  // consume slowly, so the source must wait rather than run ahead
  for await (const c of meter(Readable.from(chunks), w)) { await new Promise((r) => setImmediate(r)); out.push(c); }
  w.stop();
  assert.equal(Buffer.concat(out).length, want.length, "every byte arrived");
  assert.ok(Buffer.concat(out).equals(want), "and in order, unchanged");
});
