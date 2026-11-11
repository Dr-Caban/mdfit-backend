"use strict";
// The Cloudinary byte-upload must stream the file, not buffer it: the migration pushes ~205 videos of up to 430 MB
// through a 1 GB container, and `new Blob([fs.readFileSync(out)])` cost one whole file of memory per upload. Here a
// 64 MB file goes up through the real code path - Cloudinary refuses the URL upload as too large, so the file is
// fetched and the bytes are posted - while this process watches its own memory.
//
// Three things make the measurement honest.
//  - The stand-in for Cloudinary/Drive runs in a CHILD process (it is handed the file and reports what it received
//    over /__seen); a loopback server in this process would pile up its own 64 MB of receive buffers and drown the
//    signal.
//  - One file goes through first as a warm-up, so the baseline is taken with the http pools already grown.
//  - The assertion is on rss, which is what the container's 1 GB limit counts. heapUsed alone misses the bug entirely
//    (readFileSync returns a Buffer, whose bytes live off-heap), and heapUsed + external is sticky: V8 and undici hold
//    freed off-heap pools for reuse, so after the warm-up a buffered upload can show no growth at all while sitting
//    200 MB above where it started. Both are logged; rss is what is asserted.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const vm = require("vm");
const { spawn } = require("child_process");
process.env.CLOUDINARY_CLOUD_NAME = "testcloud"; process.env.CLOUDINARY_API_KEY = "key"; process.env.CLOUDINARY_API_SECRET = "secret";
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

const SIZE = 64 * 1024 * 1024; // big enough that a buffered copy is unmistakable, small enough to stay quick
const MB = (n) => (n / 1048576).toFixed(1) + " MB";
// a gc handle without needing the --expose-gc flag on the test runner
v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose_gc");

// A deterministic file written a chunk at a time (nothing holds it whole), with its sha256
function makeFile(dir) {
  const file = path.join(dir, "big.mp4"), h = crypto.createHash("sha256"), fd = fs.openSync(file, "w"), chunk = Buffer.alloc(1 << 20);
  for (let i = 0; i < SIZE / chunk.length; i++) {
    chunk.fill(0); chunk.writeUInt32BE(i, 0); for (let j = 4; j < chunk.length; j += 4096) chunk[j] = i & 0xff;
    h.update(chunk); fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
  return { file, sha: h.digest("hex") };
}

// The child: the media manifest, Drive's public download, and a Cloudinary upload endpoint that refuses the URL
// upload and then checks the multipart body it gets instead - part headers kept, file bytes hashed as they arrive
// (only the closing boundary is ever held back), so the child doesn't buffer the file either.
const CHILD = String.raw`
"use strict";
const crypto = require("crypto"), fs = require("fs"), http = require("http");
const [file, size] = [process.argv[2], Number(process.argv[3])];
const throttle = Number(process.env.MDFIT_THROTTLE_MBPS || 0); // MB/s the upload endpoint will accept, 0 = as fast as it can
const asset = (key) => ({ key, source: "drive", drive_id: key, type: "video", purpose: "exercise-library",
  public_id: "mdfit/videos/exercise-library/Exercise/Hips/Strength/" + key, display_name: "Big Clip " + key,
  tags: ["mdfit"], context: { name: key }, folder: "mdfit/videos/exercise-library/Exercise/Hips/Strength" });
// The first sync carries one asset and the second carries both, so the test can take its baseline between them: the
// warm-up leaves undici's receive pools (the file also comes DOWN over http) at a steady size, and what the second
// run adds is the upload itself.
let manifestCalls = 0, rejectEarly = false;
const seen = { urlUploads: [], byteUploads: [] };
function readMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const tailLen = Buffer.byteLength("\r\n--" + boundary + "--\r\n"), h = crypto.createHash("sha256");
    let head = Buffer.alloc(0), hold = Buffer.alloc(0), inFile = false, fileBytes = 0, total = 0;
    req.on("data", (c) => {
      total += c.length;
      // a slow consumer: this is what an upload link far slower than the disk looks like, and it is where a body that
      // ignores backpressure piles up
      if (throttle) { req.pause(); setTimeout(() => req.resume(), (c.length / (throttle * 1024 * 1024)) * 1000); }
      if (!inFile) {
        head = Buffer.concat([head, c]);
        const i = head.indexOf('name="file"'); if (i < 0) return;
        const j = head.indexOf("\r\n\r\n", i); if (j < 0) return;
        inFile = true; c = head.subarray(j + 4); head = head.subarray(0, j + 4);
      }
      hold = Buffer.concat([hold, c]);
      if (hold.length > tailLen) {
        const flush = hold.subarray(0, hold.length - tailLen);
        h.update(flush); fileBytes += flush.length; hold = hold.subarray(hold.length - tailLen);
      }
    });
    req.on("error", reject);
    req.on("end", () => {
      const txt = head.toString("utf8"), fields = {};
      for (const part of txt.split("--" + boundary + "\r\n")) {
        const m = part.match(/^Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*)\r\n$/);
        if (m) fields[m[1]] = m[2];
      }
      resolve({ fields, filename: (txt.match(/name="file"; filename="([^"]*)"/) || [])[1],
        partType: (txt.match(/name="file";[\s\S]*?\r\nContent-Type: ([^\r]+)\r\n/) || [])[1],
        fileBytes, sha: h.digest("hex"), closing: hold.toString("utf8"), total });
    });
  });
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/__seen") return json(200, seen);
  if (u.pathname === "/__reject") { rejectEarly = true; return json(200, { ok: true }); }
  if (u.pathname === "/data/media-manifest.json") {
    const names = [["warm-clip"], ["warm-clip", "big-clip"]][manifestCalls++] || ["warm-clip", "big-clip", "reject-clip"];
    const assets = names.map(asset);
    return json(200, { version: "t", count: assets.length, assets });
  }
  if (u.pathname === "/public") { res.writeHead(200, { "content-type": "video/mp4", "content-length": String(size) }); return fs.createReadStream(file).pipe(res); }
  if (/^\/v1_1\/testcloud\/video\/upload$/.test(u.pathname)) {
    const ct = req.headers["content-type"] || "";
    if (!ct.startsWith("multipart/")) { // Cloudinary can't fetch a file this size from the URL
      let b = ""; for await (const c of req) b += c;
      seen.urlUploads.push(Object.fromEntries(new URLSearchParams(b)));
      return json(400, { error: { message: "File size too large. Got " + size + ". Maximum is 104857600." } });
    }
    // answers before reading the body, the way Cloudinary rejects an upload it won't take, and hangs up on it
    if (rejectEarly) { json(400, { error: { message: "Invalid video file" } }); return req.destroy(); }
    const boundary = (ct.match(/boundary=([^;]+)/) || [])[1];
    const got = await readMultipart(req, boundary);
    seen.byteUploads.push({ ...got, boundary, contentLength: Number(req.headers["content-length"] || 0), chunked: !!req.headers["transfer-encoding"] });
    return json(200, { public_id: got.fields.public_id, version: 7, bytes: got.fileBytes, format: "mp4" });
  }
  res.writeHead(404); res.end();
}).listen(0, "127.0.0.1", () => process.stdout.write("port " + srv.address().port + "\n"));
`;

async function startChild(t, dir, big, throttleMbps) {
  const script = path.join(dir, "fake-cloudinary.cjs");
  fs.writeFileSync(script, CHILD);
  const child = spawn(process.execPath, [script, big.file, String(SIZE)],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...(throttleMbps ? { MDFIT_THROTTLE_MBPS: String(throttleMbps) } : {}) } });
  t.after(() => child.kill());
  const port = await new Promise((ok, no) => {
    child.stdout.on("data", (d) => { const m = String(d).match(/port (\d+)/); if (m) ok(Number(m[1])); });
    child.once("exit", (c) => no(new Error("fake Cloudinary exited: " + c)));
  });
  return `http://127.0.0.1:${port}`;
}

// The API under test, pointed at the child for the manifest, Drive and Cloudinary
async function startApi(t, base0) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-s-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: base0, noVideoSync: true, cloudinaryApiUrl: base0, drivePublicUrl: base0 + "/public?id=" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adm };
}

// One sync, run to completion
const runner = (call, adm) => async () => {
  await call("POST", "/api/admin/videos/migrate", {}, adm);
  let s = { job: null };
  for (let i = 0; i < 1200; i++) { s = (await call("GET", "/api/admin/videos/status", undefined, adm)).body; if (s.job && s.job.finishedAt) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(s.job && s.job.finishedAt, "job finished");
  return s;
};

test("cloudinary byte-upload: a 64 MB file is streamed, not buffered", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-big-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = makeFile(dir);
  const base0 = await startChild(t, dir, big);
  const { call, adm } = await startApi(t, base0);
  const run = runner(call, adm);

  // warm-up: one file all the way through, so the http pools are at a steady size before anything is measured
  const warm = await run();
  assert.equal(warm.job && warm.job.ok, 1, "warm-up upload failed: " + JSON.stringify(warm.failed));

  // baseline, then watch this process across the second file's whole download-and-upload
  await new Promise((r) => setTimeout(r, 100)); gc();
  const used = () => { const m = process.memoryUsage(); return m.heapUsed + m.external; };
  const before = used(), rssBefore = process.memoryUsage().rss;
  let peak = before, rssPeak = rssBefore;
  const watch = setInterval(() => { peak = Math.max(peak, used()); rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 20);
  const st = await run();
  clearInterval(watch);
  peak = Math.max(peak, used()); rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  gc();
  const settled = used();
  console.log(`file ${MB(SIZE)} | heap+external before ${MB(before)} peak ${MB(peak)} settled ${MB(settled)} | growth at peak ${MB(peak - before)}, settled ${MB(settled - before)} | rss growth ${MB(rssPeak - rssBefore)}`);

  assert.equal(st.job.failed, 0, "upload failed: " + JSON.stringify(st.failed));
  assert.equal(st.job.ok, 1);
  const seen = await fetch(base0 + "/__seen").then((r) => r.json());

  // (a) Cloudinary refused each URL upload, so each file's bytes went up once - all of them, unchanged
  assert.equal(seen.urlUploads.length, 2);
  assert.equal(seen.byteUploads.length, 2);
  const up = seen.byteUploads[1]; // the measured one
  assert.equal(up.fields.public_id, "mdfit/videos/exercise-library/Exercise/Hips/Strength/big-clip");
  assert.equal(up.fileBytes, SIZE);
  assert.equal(up.sha, big.sha, "the bytes Cloudinary received are the file, byte for byte");
  assert.equal(up.closing, `\r\n--${up.boundary}--\r\n`); // the body is properly terminated
  assert.equal(up.filename, "big-clip.mp4");
  assert.equal(up.partType, "video/mp4");

  // (b) a sane content-length: the fields plus the file, and exactly what arrived - not chunked, not a guess
  assert.equal(up.chunked, false);
  assert.equal(up.contentLength, up.total);
  assert.ok(up.contentLength > SIZE && up.contentLength < SIZE + 4096, "content-length is the file plus a little: " + up.contentLength);

  // the signed fields are the same ones the URL upload sends, so the signature contract is unchanged
  const url = seen.urlUploads[1];
  for (const k of ["public_id", "asset_folder", "display_name", "tags", "context", "overwrite", "eager", "eager_async", "api_key"]) assert.equal(up.fields[k], url[k], k);
  assert.match(up.fields.signature, /^[0-9a-f]{40}$/);
  assert.ok(up.fields.timestamp && !Number.isNaN(Number(up.fields.timestamp)));
  assert.equal(up.fields.file, undefined, "the bytes go up as the file part, not a URL");
  const pub = (await call("GET", "/api/videos")).body;
  assert.deepEqual(pub.map["big-clip"], ["mdfit/videos/exercise-library/Exercise/Hips/Strength/big-clip", "v", 7]);

  // (c) memory never grew by anything like the file. The threshold is generous on purpose - the same window also has
  // the file coming DOWN from Drive - but the measurements are not close to it: streaming through node:http grows rss
  // by a few MB, where the old readFileSync + Blob upload grew it by ~256 MB (the file twice over) and a
  // fetch-streamed body by ~290 MB (fetch queues what the socket has not taken yet).
  assert.ok(rssPeak - rssBefore < SIZE / 4, `rss grew ${MB(rssPeak - rssBefore)} uploading a ${MB(SIZE)} file - that looks buffered`);
});

// The migration's real condition: Cloudinary is at the far end of an upload link much slower than the disk. A body
// that reads ahead of the socket queues the difference, so this is where "streaming" either holds or does not. (Real
// fetch does not hold: handed the same multipart stream it grew rss by ~290 MB on a 128 MB file against this sink,
// which is why the upload goes through node:http and pipeline instead.)
test("cloudinary byte-upload: a slow upload link does not queue the file in memory", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-slow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = makeFile(dir);
  const base0 = await startChild(t, dir, big, 24); // 24 MB/s
  const { call, adm } = await startApi(t, base0);
  const run = runner(call, adm);
  await run(); // warm-up, as above
  await new Promise((r) => setTimeout(r, 100)); gc();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const watch = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 20);
  const st = await run();
  clearInterval(watch);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  console.log(`slow link: file ${MB(SIZE)} | rss growth ${MB(rssPeak - rssBefore)}`);
  assert.equal(st.job.failed, 0, "upload failed: " + JSON.stringify(st.failed));
  const seen = await fetch(base0 + "/__seen").then((r) => r.json());
  const up = seen.byteUploads[1];
  assert.equal(up.fileBytes, SIZE); assert.equal(up.sha, big.sha);
  assert.ok(rssPeak - rssBefore < SIZE / 4, `rss grew ${MB(rssPeak - rssBefore)} sending a ${MB(SIZE)} file to a slow link - the body is not waiting for the socket`);
});

// Cloudinary's own message has to survive the streaming write. It answers and hangs up while the body is still going
// out, so the write fails with EPIPE a moment later: if that error won, every refused upload would be recorded as
// "write EPIPE" instead of the reason, and the sync's failure list is what the migration is driven from.
test("cloudinary byte-upload: an upload Cloudinary refuses mid-body reports Cloudinary's reason", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-err-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = makeFile(dir);
  const base0 = await startChild(t, dir, big);
  const { call, adm } = await startApi(t, base0);
  const run = runner(call, adm);
  await run(); await run(); // the first two assets land normally
  await fetch(base0 + "/__reject");
  const st = await run(); // the third is refused the moment its body starts
  assert.equal(st.job.failed, 1);
  assert.equal(st.failed["reject-clip"], "Invalid video file"); // not "write EPIPE", not "socket hang up"
  assert.equal((await call("GET", "/api/videos")).body.map["reject-clip"], undefined);
});
