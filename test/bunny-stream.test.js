"use strict";
// The Bunny byte-upload is the path EVERY video in the mirror travels - ~205 files of up to 430 MB through a 1 GB
// container - so it must stream the file rather than hold it. test/bunny.test.js asserts against an injected fetchImpl
// and so never touches a real socket, which is exactly where a body gets buffered; this test does, with the sink in a
// CHILD process (a loopback server in this process would pile up its own receive buffers and drown the signal).
//
// Measured here, fetch + fs.createReadStream behaves: 11 MB of rss for a 64 MB file, and under 1 MB against a
// throttled sink, i.e. undici does honour the socket's backpressure for a plain stream body. (node:http + pipeline,
// which lib/videos.js uses for its multipart POST, measured 27 MB and 21 MB on the same file - no worse in kind.) The
// point of keeping this test is that nothing else would notice if that stopped being true.
//
// rss is what is asserted, because rss is what the container's 1 GB limit counts. heapUsed misses a buffered body
// entirely - a Buffer's bytes live off-heap - and heapUsed + external is sticky, since V8 and undici keep freed pools.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const vm = require("vm");
const { spawn } = require("child_process");
const { createBunny } = require("../lib/bunny");

const SIZE = 64 * 1024 * 1024; // big enough that a buffered copy is unmistakable, small enough to stay quick
const MB = (n) => (n / 1048576).toFixed(1) + " MB";
v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose_gc");

// Written a chunk at a time, so nothing here holds the file whole either
function makeFile(dir) {
  const file = path.join(dir, "big.mp4"), h = crypto.createHash("sha256"), fd = fs.openSync(file, "w"), chunk = Buffer.alloc(1 << 20);
  for (let i = 0; i < SIZE / chunk.length; i++) {
    chunk.fill(0); chunk.writeUInt32BE(i, 0); for (let j = 4; j < chunk.length; j += 4096) chunk[j] = i & 0xff;
    h.update(chunk); fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
  return { file, sha: h.digest("hex") };
}

// The child stands in for Bunny: create answers a guid, PUT hashes the bytes as they arrive (never holding them), and
// /__seen reports what it got. MDFIT_THROTTLE_MBPS makes it a slow uplink, which is the case fetch actually fails.
const CHILD = String.raw`
"use strict";
const crypto = require("crypto"), http = require("http");
const throttle = Number(process.env.MDFIT_THROTTLE_MBPS || 0);
const seen = {};
http.createServer((req, res) => {
  const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__seen") return json(200, seen);
  if (req.method === "POST" && /\/videos$/.test(req.url)) { let b = ""; req.on("data", (c) => { b += c; }); return req.on("end", () => json(200, { guid: "guid-1" })); }
  const m = req.url.match(/\/videos\/([^/]+)$/);
  if (m && req.method === "PUT") {
    const h = crypto.createHash("sha256");
    let bytes = 0, started = Date.now();
    seen.put = { guid: m[1], key: req.headers.accesskey, length: req.headers["content-length"],
      type: req.headers["content-type"], chunked: req.headers["transfer-encoding"] === "chunked" };
    req.on("data", (c) => {
      h.update(c); bytes += c.length;
      if (!throttle) return;
      // hold the socket back to throttle MB/s - the sender must wait, which is what exposes a queueing body
      const owed = bytes / (throttle * 1048576) * 1000 - (Date.now() - started);
      if (owed > 0) { req.pause(); setTimeout(() => req.resume(), owed); }
    });
    return req.on("end", () => { seen.put.bytes = bytes; seen.put.sha = h.digest("hex"); json(200, { success: true }); });
  }
  json(404, { Message: "no" });
}).listen(0, "127.0.0.1", function () { process.stdout.write("PORT " + this.address().port + "\n"); });
`;

async function sink(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsink-")), js = path.join(dir, "sink.js");
  fs.writeFileSync(js, CHILD);
  const ch = spawn(process.execPath, [js], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { ch.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((res, rej) => {
    let b = ""; ch.stdout.on("data", (c) => { b += c; const m = b.match(/PORT (\d+)/); if (m) res(Number(m[1])); });
    ch.on("exit", (c) => rej(new Error("sink exited " + c)));
    setTimeout(() => rej(new Error("sink never reported a port")), 15000);
  });
  const base = `http://127.0.0.1:${port}`;
  return { base, seen: async () => (await fetch(`${base}/__seen`)).json() };
}

// rss while one 64 MB file goes up through the real client, after a warm-up so the http pools have already grown
async function measure(t, env) {
  const s = await sink(t, env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bfile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { file, sha } = makeFile(dir);
  const b = createBunny({ apiKey: "bunny-key", libraryId: "lib42", host: "vz.b-cdn.net", apiUrl: s.base });

  await b.uploadBytes(await b.createVideo("warm-up"), file); // warm-up: grow the pools before the baseline
  gc(); await new Promise((r) => setTimeout(r, 150)); gc();
  const before = process.memoryUsage();

  let peak = 0;
  const watch = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.rss); }, 20);
  const r = await b.uploadBytes(await b.createVideo("Big Clip"), file);
  clearInterval(watch);
  const after = process.memoryUsage();
  return { sha, size: SIZE, r, seen: await s.seen(), rssGrowth: Math.max(peak, after.rss) - before.rss,
    before, heapGrowth: (after.heapUsed + after.external) - (before.heapUsed + before.external) };
}

test("bunny byte-upload: a 64 MB file is streamed, not buffered", async (t) => {
  const m = await measure(t);
  console.log(`# file ${MB(m.size)} | rss growth ${MB(m.rssGrowth)} | heap+external growth ${MB(m.heapGrowth)}`);

  // it actually arrived, intact
  assert.equal(m.seen.put.bytes, SIZE, "every byte arrived");
  assert.equal(m.seen.put.sha, m.sha, "and they are the file's own bytes");
  assert.deepEqual(m.r, { guid: "guid-1", bytes: SIZE });
  // with the access key, the right content type, and a real length rather than chunked
  assert.equal(m.seen.put.key, "bunny-key");
  assert.equal(m.seen.put.type, "application/octet-stream");
  assert.equal(m.seen.put.chunked, false, "a chunked PUT means content-length was lost");
  assert.equal(m.seen.put.length, String(SIZE));
  // the point of the exercise: reading the file in whole would show up as a full 64 MB here, and does - swapping
  // uploadBytes for an fs.readFileSync body measured +258 MB on the equivalent Cloudinary test.
  assert.ok(m.rssGrowth < SIZE / 4, `rss grew ${MB(m.rssGrowth)}, which is not streaming`);
});

test("bunny byte-upload: a slow upload link does not queue the file in memory", async (t) => {
  // The case that catches a queueing body: the disk serves the file far faster than the socket drains it, so a sender
  // that reads ahead instead of waiting ends up holding the difference. 24 MB/s is roughly a good home uplink.
  const m = await measure(t, { MDFIT_THROTTLE_MBPS: "24" });
  console.log(`# slow link: file ${MB(m.size)} | rss growth ${MB(m.rssGrowth)}`);
  assert.equal(m.seen.put.bytes, SIZE);
  assert.equal(m.seen.put.sha, m.sha);
  assert.ok(m.rssGrowth < SIZE / 4, `rss grew ${MB(m.rssGrowth)} against a slow sink, so the body was queued`);
});

test("bunny byte-upload: an upload Bunny refuses reports Bunny's reason", async (t) => {
  const s = await sink(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bfile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "small.mp4");
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  const b = createBunny({ apiKey: "bunny-key", libraryId: "lib42", host: "vz.b-cdn.net", apiUrl: s.base });
  // the sink only answers /videos/<guid> for PUT; a GUID it has no route for comes back 404 with Bunny's shape
  await assert.rejects(() => b.uploadBytes("", file), /Bunny upload: HTTP 404 no/);
});
