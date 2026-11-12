// Media hosting. When Bunny Stream (lib/bunny.js) is configured it mirrors the whole video library: every video in the
// manifest, the ones already on Cloudinary included. While BUNNY_DUAL_WRITE is on a new video also goes to Cloudinary,
// so every video has a Cloudinary MP4 behind the Bunny one - the app prefers Bunny and falls back to Cloudinary, and a
// video Bunny is still encoding never drops a member back to the slow Google Drive iframe. Images are always
// Cloudinary's, and with no Bunny credentials everything stays on Cloudinary as before. The mirror is resumable: every
// key is written as it lands, a confirmed guid is never uploaded twice, and nothing here ever deletes a Cloudinary copy. The site publishes /data/media-manifest.json (scripts/build-media-manifest.js): every
// video and image with its organized Cloudinary path, display name, tags and metadata. This job copies each asset in,
// Cloudinary fetching it straight from Google Drive or the site. Files over the plan's 100 MB limit are shrunk to
// phone-friendly 720p H.264 first. The app then streams from Cloudinary. The API secret stays in Railway.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
const { createBunny } = require("./bunny");
const { idleAbort, meter } = require("./idle");
let FFMPEG = null; try { FFMPEG = require("ffmpeg-static"); } catch {}
const LIMIT = 100 * 1024 * 1024;
const b64u = (b) => Buffer.from(b).toString("base64url");

// Google service account (the same key Calendar sync uses). When a Drive file is shared with that account's email,
// the API downloads it through the Drive API instead of the public link: no "Anyone with the link" sharing needed,
// and none of Drive's public-download quota pages.
function parseServiceAccount(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();
  if (!txt.startsWith("{")) txt = Buffer.from(txt, "base64").toString("utf8");
  const j = JSON.parse(txt);
  return j.client_email && j.private_key ? j : null;
}

// A multipart/form-data body whose file part is a stream. The signed fields and part headers are small buffers; the
// file is piped from disk and never read into memory, and content-length is those byte sizes plus fs.statSync, so the
// request is not chunked (Cloudinary wants a length).
function multipartStream(fields, file, filename, type) {
  const b = "----MDFitBoundary" + crypto.randomBytes(16).toString("hex");
  const q = (s) => String(s).replace(/\r?\n/g, " ").replace(/"/g, "%22"); // a quote or newline in a name must not break the part header (what FormData does too)
  const head = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${q(k)}"\r\n\r\n${String(v)}\r\n`));
  head.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${q(filename)}"\r\nContent-Type: ${type}\r\n\r\n`));
  const tail = Buffer.from(`\r\n--${b}--\r\n`), size = fs.statSync(file).size;
  return { contentType: `multipart/form-data; boundary=${b}`, length: head.reduce((n, h) => n + h.length, 0) + size + tail.length,
    body: Readable.from(async function* () { for (const h of head) yield h; yield* fs.createReadStream(file); yield tail; }()) };
}

// POST a stream through node:http, not fetch. fetch (undici) does not pass the socket's backpressure back to a stream
// body: it reads the file as fast as the disk serves it and queues what the network hasn't taken yet, so a 430 MB
// video still costs ~430 MB of memory - measured at 137 MB of buffers for a 128 MB file against a slow consumer,
// against 19 MB here. req.write() backpressure, which pipeline honours, is what keeps it to a few MB. The container
// has 1 GB and the migration is ~205 files up to 430 MB (test/videos-stream.test.js).
function postStream(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request({ hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "POST", headers }, (res) => {
      let txt = ""; res.setEncoding("utf8");
      res.on("data", (c) => { txt += c; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: txt }));
    });
    // Cloudinary refuses an upload it won't take by answering and hanging up while the body is still going out, so the
    // write then fails with EPIPE. Settling on the answer first is what keeps its reason as the error (see the
    // refused-mid-body test); a write error that arrives afterwards lands on an already-settled promise.
    req.on("error", reject);
    pipeline(body, req).catch(reject);
  });
}

function mountVideos({ app, admin, store, cfg, logger }) {
  const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "", KEY = process.env.CLOUDINARY_API_KEY || "", SECRET = process.env.CLOUDINARY_API_SECRET || "";
  const CLD_API = (cfg.cloudinaryApiUrl || "https://api.cloudinary.com").replace(/\/+$/, "");
  const BUNNY_HOST = process.env.BUNNY_STREAM_HOSTNAME || "";
  const BUNNY_COLLECTION = process.env.BUNNY_STREAM_COLLECTION || "In app";
  // A transfer with no timeout can hang on an open socket forever, and the run is one loop: a single stuck asset
  // stops every asset behind it. Seen in production - the mirror went quiet mid-run with the CPU idle and no bytes
  // moving, and the remaining videos never went up. The cap is per request and deliberately generous (a 430 MB clip
  // at 1 MB/s is about 7 minutes); a request that trips it is recorded as a failed asset and the loop carries on,
  // and the next sync retries it.
  const XFER_MS = Number(process.env.MEDIA_TIMEOUT_MS) || 15 * 60e3;
  // Drive stalls far more often than it is slow, so the useful guard is "no bytes for a while", not "too long in
  // total" - the ceiling stays as a backstop. 90s is comfortably longer than any pause seen on a healthy transfer.
  const IDLE_MS = Number(process.env.MEDIA_IDLE_MS) || 90e3;
  const watchdog = () => idleAbort(IDLE_MS, XFER_MS);
  const bunny = createBunny({ timeoutMs: XFER_MS, idleMs: IDLE_MS, apiKey: process.env.BUNNY_STREAM_API_KEY || "", libraryId: process.env.BUNNY_STREAM_LIBRARY_ID || "",
    host: BUNNY_HOST, apiUrl: cfg.bunnyApiUrl });
  const DRIVE_API = (cfg.driveApiUrl || "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
  const TOKEN_URL = cfg.googleTokenUrl || "https://oauth2.googleapis.com/token";
  let sa = null; try { sa = parseServiceAccount(cfg.googleServiceAccount); } catch { sa = null; }
  // Dual-write is on unless switched off: it costs Cloudinary credits, but it's what keeps a new video's fallback MP4
  // there. It says nothing about the mirror - an existing video is copied to Bunny either way.
  const DUAL = !/^(0|false|off|no)$/i.test(String(cfg.bunnyDualWrite ?? process.env.BUNNY_DUAL_WRITE ?? "on").trim());
  const cldReady = () => !!(CLOUD && KEY && SECRET);
  // Either host is enough to be worth syncing: Bunny takes the videos, Cloudinary the images
  const ready = () => cldReady() || bunny.ready();
  const isVideo = (a) => bunny.ready() && a.type === "video";
  // Upload records are kept per Cloudinary account, so switching accounts starts a fresh copy
  const KEY_NAME = () => "videos-" + (CLOUD || "none").replace(/[^\w-]/g, "");
  const read = () => store.read(KEY_NAME(), { done: {}, failed: {} });
  const write = (d) => store.write(KEY_NAME(), d);
  let job = null;
  const warn = (msg, data) => logger && logger.warn && logger.warn(msg, data);

  const DRIVE_PUB = cfg.drivePublicUrl || "https://drive.usercontent.google.com/download?id=";
  const driveUrl = (id) => `${DRIVE_PUB}${encodeURIComponent(id)}&export=download&confirm=t`;
  const sourceUrl = (a) => (a.source === "drive" ? driveUrl(a.drive_id) : a.url);
  const sign = (params) => crypto.createHash("sha1").update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&") + SECRET).digest("hex");
  const ctxString = (o) => Object.entries(o || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${String(v).replace(/([=|])/g, "\\$1").slice(0, 250)}`).join("|");
  const rtype = (a) => (a.type === "image" ? "image" : "video");

  // Cloudinary refuses a display name with "/" in it (e.g. "90/90 Hip Switch"), so slashes become a dash in the name only;
  // the public_id keeps the real folder path.
  const displayName = (s) => String(s || "").replace(/\s*\/\s*/g, " - ").trim().slice(0, 200) || "untitled";
  // Videos also get the rendition the app plays (q_auto,vc_h264, see frontend common.js MDFitVideo.mp4) made at upload
  // time, in the background; otherwise the first member to open a new video gets "423 processing" until it exists.
  function paramsFor(a) {
    return { public_id: a.public_id, asset_folder: a.folder, display_name: displayName(a.display_name), tags: a.tags.join(",").slice(0, 2000),
      context: ctxString(a.context), overwrite: "true", timestamp: Math.floor(Date.now() / 1000),
      ...(a.type === "video" ? { eager: "q_auto,vc_h264", eager_async: "true" } : {}) };
  }
  const uploadUrl = (a) => `${CLD_API}/v1_1/${CLOUD}/${rtype(a)}/upload`;
  function record(a, ok, status, txt) {
    let j = {}; try { j = JSON.parse(txt) || {}; } catch {}
    if (!ok) throw new Error((j.error && j.error.message) || `HTTP ${status}`);
    return { pid: j.public_id, type: a.type, version: j.version, bytes: j.bytes, format: j.format };
  }
  async function post(a, body) {
    const r = await fetch(uploadUrl(a), { method: "POST", body, signal: AbortSignal.timeout(XFER_MS) });
    return record(a, r.ok, r.status, await r.text().catch(() => ""));
  }
  async function upload(a) {
    const p = paramsFor(a);
    return post(a, new URLSearchParams({ ...p, file: sourceUrl(a), api_key: KEY, signature: sign(p) }));
  }

  // ---- Downloading the file ourselves (when Cloudinary can't fetch the URL, or the file is too big as-is)
  let gtoken = { value: "", exp: 0 };
  async function driveToken() {
    if (gtoken.value && Date.now() < gtoken.exp - 60e3) return gtoken.value;
    const iat = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claim}`), sa.private_key).toString("base64url");
    const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google token: ${j.error_description || j.error || r.status}`);
    gtoken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return gtoken.value;
  }
  // Public link first; for a Drive file that isn't publicly shared (or is over its public-download quota), the Drive
  // API with the service account, which works as long as the file or its folder is shared with that account.
  // Every byte that arrives resets the watchdog, so a slow file is fine and a silent one is dropped (lib/idle.js)
  const toFile = async (webStream, dest, w) => {
    await pipeline(meter(Readable.fromWeb(webStream), w), fs.createWriteStream(dest));
  };
  async function download(a, dest) {
    const w = watchdog();
    try {
      const r = await fetch(sourceUrl(a), { signal: w.signal }).catch(() => null);
      if (r && r.ok && !/html/.test(r.headers.get("content-type") || "")) { await toFile(r.body, dest, w); return "public"; }
      if (a.source !== "drive" || !sa) throw new Error(r ? "Download failed (Drive returned a web page, not the file)" : "Download failed");
      const d = await fetch(`${DRIVE_API}/files/${encodeURIComponent(a.drive_id)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${await driveToken()}` }, signal: w.signal });
      if (!d.ok) throw new Error(d.status === 404 || d.status === 403 ? `Drive: not shared with ${sa.client_email} (HTTP ${d.status})` : `Drive download HTTP ${d.status}`);
      await toFile(d.body, dest, w);
      return "service-account";
    } finally { w.stop(); }
  }
  const ff = (args) => new Promise((ok, no) => execFile(FFMPEG, args, { maxBuffer: 1 << 20 }, (e) => (e ? no(e) : ok())));
  // Upload a local copy; videos over the plan's 100 MB limit are shrunk to phone-friendly H.264 first
  async function uploadFile(a, src, dir) {
    let out = src, compressed = false;
    if (fs.statSync(src).size >= LIMIT) {
      if (!FFMPEG || a.type !== "video") throw new Error("Too large and can't be compressed here");
      for (const [h, crf, ab] of [[720, 28, "96k"], [540, 32, "64k"], [432, 36, "48k"]]) {
        out = path.join(dir, `out${h}.mp4`);
        await ff(["-y", "-i", src, "-vf", `scale=-2:'min(${h},ih)'`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-preset", "veryfast", "-crf", String(crf), "-c:a", "aac", "-b:a", ab, "-movflags", "+faststart", out]);
        if (fs.statSync(out).size < LIMIT * 0.95) break;
      }
      const size = fs.statSync(out).size;
      if (size >= LIMIT) throw new Error(`Still ${Math.round(size / 1048576)} MB after compression`);
      compressed = true;
    }
    const p = paramsFor(a);
    const m = multipartStream({ ...p, api_key: KEY, signature: sign(p) }, out,
      path.basename(a.public_id) + (a.type === "image" ? "" : ".mp4"), a.type === "image" ? "application/octet-stream" : "video/mp4");
    const r = await postStream(uploadUrl(a), { body: m.body, headers: { "content-type": m.contentType, "content-length": String(m.length) } });
    return { ...record(a, r.ok, r.status, r.text), ...(compressed ? { compressed: true } : {}) };
  }
  async function downloadAndUpload(a) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-")), src = path.join(dir, "in.bin");
    try { const via = await download(a, src); return { ...(await uploadFile(a, src, dir)), via }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // Bunny has no fetch-by-URL upload, so the file always comes down here first and is streamed up (see lib/bunny.js)
  async function bunnyUpload(a) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdb-")), src = path.join(dir, "in.bin");
    try {
      const via = await download(a, src);
      // Everything the app plays is filed under the "In app" collection so the library stays readable beside the raw
      // footage uploaded by hand. A failure here must not cost us the upload, so an unfiled video is still better
      // than none - the collection is cosmetic, the guid is not.
      const coll = await bunny.collection(BUNNY_COLLECTION).catch((e) => {
        logger && logger.warn && logger.warn("bunny collection", { err: String(e && e.message || e) });
        return "";
      });
      const guid = await bunny.createVideo(displayName(a.display_name), coll);
      try { await bunny.uploadBytes(guid, src); }
      catch (e) { await bunny.remove(guid).catch(() => {}); throw e; } // don't leave an empty video in the library
      logger && logger.info && logger.info("bunny upload", { key: a.key, guid, via });
      // ready:false until Bunny has finished encoding - /api/videos must not hand out a URL that 404s (see bunnyReady)
      return { guid, type: "video", provider: "bunny", ready: false, resolutions: [] };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // Does each uploaded Bunny video have the 720p MP4 the app plays yet? Entries stay out of the public map until it
  // does; the resolutions Bunny reported are kept on the record so a missing rendition is debuggable.
  async function bunnyReady(d) {
    const pending = Object.entries(d.done).filter(([, v]) => v && v.guid && !v.ready);
    for (const [k, v] of pending) {
      try {
        const s = await bunny.status(v.guid);
        v.resolutions = s.resolutions;
        const where = v.pid ? " (still serving from Cloudinary)" : ""; // with a fallback it's a note, not an outage
        if (s.has720) { v.ready = true; v.progress = 100; delete d.failed[k]; }
        else if (s.failed) d.failed[k] = "Bunny couldn't encode this video" + where;
        else if (s.encoded) d.failed[k] = (s.resolutions.length ? `Bunny has no 720p MP4 (only ${s.resolutions.join(", ")})` : "Bunny made no MP4 renditions - turn on MP4 Fallback for the library") + where;
        else { v.progress = s.progress; delete d.failed[k]; } // still encoding: not a failure, the next pass picks it up
      } catch (e) { warn("bunny status failed", { key: k, guid: v.guid, error: e.message }); }
    }
    if (pending.length) write(d);
  }

  // Remove an asset stored under the old flat name (mdfit/<driveId>) before re-filing it in the organized tree
  async function destroyOld(id, type) {
    const p = { public_id: `mdfit/${id}`, invalidate: "true", timestamp: Math.floor(Date.now() / 1000) };
    await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/${type === "image" ? "image" : "video"}/destroy`, { method: "POST", body: new URLSearchParams({ ...p, api_key: KEY, signature: sign(p) }) }).catch(() => {});
  }

  async function manifest() {
    const site = (cfg.siteUrl || "https://www.mymdfit.com").replace(/\/+$/, "");
    const r = await fetch(site + "/data/media-manifest.json", { headers: { "user-agent": "MDFit-API/1.0" } });
    if (!r.ok) throw new Error("manifest HTTP " + r.status);
    return (await r.json()).assets || [];
  }

  // What each asset still owes, per host. Bunny wants every video in the manifest, whether or not Cloudinary already
  // has it - that's the mirror, and it isn't behind a flag. A guid is proof enough that Bunny holds the file, so an
  // interrupted run resumes instead of uploading it again. Cloudinary counts as done at the manifest path (so a moved
  // file is re-filed) and keeps taking new videos while dual-write is on; images are Cloudinary's alone.
  function plan(a, done) {
    const cldDone = !!(done && done.pid === a.public_id), bunnyDone = !!(done && done.guid);
    const needBunny = isVideo(a), needCld = !isVideo(a) || DUAL;
    return { needCld, needBunny, cldDone, bunnyDone, todo: (needCld && !cldDone) || (needBunny && !bunnyDone) };
  }

  async function run(assets, retryFailed) {
    const d = read();
    const todo = assets.filter((a) => {
      if (!plan(a, d.done[a.key]).todo) return false;
      return retryFailed || !d.failed[a.key];
    });
    job = { total: todo.length, ok: 0, failed: 0, current: "", startedAt: new Date().toISOString() };
    for (const a of todo) {
      job.current = a.public_id;
      try {
        if (a.source === "drive" ? !a.drive_id : !a.url) throw new Error("No source file (missing Drive id)");
        const prev = d.done[a.key], p = plan(a, prev), rec = { ...prev }, errs = [];
        // Each host is tried on its own: a Bunny failure must not cost the asset its Cloudinary fallback, or the reverse
        if (p.needCld && !p.cldDone) {
          try {
            if (!cldReady()) throw new Error("Cloudinary isn't configured on the API");
            if (prev && !prev.pid && !prev.guid) await destroyOld(a.key, a.type);
            let info;
            try { info = await upload(a); }
            catch (e) {
              // Cloudinary couldn't take it straight from the URL: too big, or Drive handed it a web page (not shared
              // publicly / over quota). Fetch the file ourselves (public link, else the Drive API) and upload the bytes.
              if (/too large/i.test(e.message) || (a.source === "drive" && /html|not found|resource/i.test(e.message))) info = await downloadAndUpload(a);
              else throw e;
            }
            Object.assign(rec, info);
          } catch (e) { errs.push((p.needBunny ? "Cloudinary: " : "") + e.message); }
        }
        if (p.needBunny && !p.bunnyDone) {
          try { Object.assign(rec, await bunnyUpload(a)); }
          catch (e) { errs.push((p.needCld ? "Bunny: " : "") + e.message); }
        }
        rec.provider = rec.guid ? (rec.pid ? "both" : "bunny") : "cloudinary";
        if (rec.pid || rec.guid) d.done[a.key] = rec;
        if (errs.length) throw new Error(errs.join("; "));
        delete d.failed[a.key]; job.ok++;
      } catch (e) { d.failed[a.key] = e.message.slice(0, 200); job.failed++; warn("media upload failed", { key: a.key, path: a.public_id, error: e.message }); }
      write(d);
    }
    if (bunny.ready()) { await bunnyReady(d); pollReady(20); }
    job.current = ""; job.finishedAt = new Date().toISOString();
    logger && logger.info && logger.info("media sync finished", { ok: job.ok, failed: job.failed, total: job.total });
  }

  // Encoding takes minutes, not the six hours between syncs, so videos waiting on their 720p MP4 are re-checked for a
  // while after a run; the app picks them up as soon as /api/videos lists them.
  function pollReady(left) {
    if (cfg.noVideoSync || !bunny.ready() || left <= 0) return;
    setTimeout(() => {
      const d = read();
      if (!Object.values(d.done).some((v) => v && v.guid && !v.ready)) return;
      bunnyReady(d).then(() => pollReady(left - 1)).catch(() => pollReady(left - 1));
    }, cfg.bunnyPollMs || 60e3).unref();
  }

  // Keep Cloudinary in sync on its own: shortly after start-up, then every 6 hours (only copies what's missing or moved)
  const autoSync = () => { if (!ready() || (job && !job.finishedAt) || cfg.noVideoSync) return; manifest().then((a) => run(a, true)).catch((e) => { job = { error: e.message, finishedAt: new Date().toISOString() }; warn("media sync failed", { error: e.message }); setTimeout(autoSync, 5 * 60e3).unref(); }); };
  // (cfg.videoSyncHold: the server has been restarting over and over, so the start-up run is skipped; see server.js)
  if (ready() && !cfg.noVideoSync) { if (!cfg.videoSyncHold) setTimeout(autoSync, 30000).unref(); setInterval(autoSync, 6 * 3600 * 1000).unref(); }

  admin.post("/videos/migrate", async (req, res) => {
    if (!ready()) return res.status(400).json({ error: "No media host is configured on the API (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET, or BUNNY_STREAM_API_KEY / _LIBRARY_ID / _HOSTNAME)." });
    if (job && !job.finishedAt) return res.json({ running: true, job });
    let assets; try { assets = await manifest(); } catch (e) { return res.status(502).json({ error: "Couldn't read the media list from the site: " + e.message }); }
    run(assets, !!(req.body && req.body.retryFailed)).catch((e) => { job.error = e.message; job.finishedAt = new Date().toISOString(); });
    res.json({ started: true, total: assets.length });
  });
  admin.get("/videos/status", (req, res) => {
    const d = read(), rows = Object.values(d.done).filter(Boolean), vids = rows.filter((v) => v.type !== "image");
    // How far through the Bunny mirror we are: a 14 GB run takes a while, so this is what to watch while it works
    const mirror = { videos: vids.length, onBoth: vids.filter((v) => v.pid && v.guid && v.ready).length,
      bunnyPending: vids.filter((v) => v.guid && !v.ready).length, bunnyMissing: vids.filter((v) => !v.guid).length,
      failed: Object.keys(d.failed).length };
    res.json({ configured: ready(), cloud: CLOUD, job, done: Object.keys(d.done).length, failed: d.failed, driveAccount: sa ? sa.client_email : null,
      providers: { cloudinary: cldReady(), bunny: bunny.ready() }, dualWrite: DUAL,
      doneByProvider: { cloudinary: rows.filter((v) => v.pid).length, bunny: rows.filter((v) => v.guid && v.ready).length },
      bunnyEncoding: rows.filter((v) => v && v.guid && !v.ready).length, mirror });
  });

  // Public: where each asset lives - Cloudinary (key -> [path, type, version]) and Bunny (key -> guid), so the app can
  // build the stream URL itself. Both maps are always present and a key can be in both (Bunny preferred, Cloudinary
  // the fallback).
  app.get("/api/videos", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    if (!ready()) return res.json({ cloud: "", map: {}, bunny: { host: "", map: {} }, ids: [] });
    const done = read().done, map = {}, bmap = {}, bres = {};
    // A dual-written video is in both maps: the app prefers Bunny and falls back to the Cloudinary MP4. Only encoded
    // videos are listed under bunny - the app builds play_720p.mp4 from the guid without checking, so an unready guid
    // would 404 and drop the member to the Drive iframe.
    for (const [k, v] of Object.entries(done)) {
      if (!v) continue;
      if (v.pid) map[k] = [v.pid, v.type === "image" ? "i" : "v", v.version || 0];
      if (v.guid && v.ready) { bmap[k] = v.guid; if (v.resolutions && v.resolutions.length) bres[k] = v.resolutions; }
    }
    // paths: the URL shape, as templates, so web / Android / Apple don't each hard-code it. Moving the pull zone or
    // taking HLS up should be one change here, not three app releases. hls is what Apple wants for long-form over
    // cellular; mp4 is what a plain <video> takes. res says which renditions Bunny actually produced for a key, so a
    // client can pick one instead of assuming 720p exists.
    const paths = { hls: "https://{host}/{guid}/playlist.m3u8", mp4: "https://{host}/{guid}/play_{res}.mp4",
      thumb: "https://{host}/{guid}/thumbnail.jpg", preferred: "720p" };
    res.json({ cloud: CLOUD, map, bunny: { host: bunny.ready() ? BUNNY_HOST : "", map: bmap, res: bres, paths },
      ids: [...new Set([...Object.keys(map), ...Object.keys(bmap)])] });
  });
}

module.exports = { mountVideos };
