// Media hosting on Cloudinary. The site publishes /data/media-manifest.json (scripts/build-media-manifest.js): every
// video and image with its organized Cloudinary path, display name, tags and metadata. This job copies each asset in,
// Cloudinary fetching it straight from Google Drive or the site. Files over the plan's 100 MB limit are shrunk to
// phone-friendly 720p H.264 first. The app then streams from Cloudinary. The API secret stays in Railway.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
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

function mountVideos({ app, admin, store, cfg, logger }) {
  const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "", KEY = process.env.CLOUDINARY_API_KEY || "", SECRET = process.env.CLOUDINARY_API_SECRET || "";
  const CLD_API = (cfg.cloudinaryApiUrl || "https://api.cloudinary.com").replace(/\/+$/, "");
  const DRIVE_API = (cfg.driveApiUrl || "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
  const TOKEN_URL = cfg.googleTokenUrl || "https://oauth2.googleapis.com/token";
  let sa = null; try { sa = parseServiceAccount(cfg.googleServiceAccount); } catch { sa = null; }
  const ready = () => !!(CLOUD && KEY && SECRET);
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
  function paramsFor(a) {
    return { public_id: a.public_id, asset_folder: a.folder, display_name: displayName(a.display_name), tags: a.tags.join(",").slice(0, 2000),
      context: ctxString(a.context), overwrite: "true", timestamp: Math.floor(Date.now() / 1000) };
  }
  async function post(a, body) {
    const r = await fetch(`${CLD_API}/v1_1/${CLOUD}/${rtype(a)}/upload`, { method: "POST", body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    return { pid: j.public_id, type: a.type, version: j.version, bytes: j.bytes, format: j.format };
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
  async function download(a, dest) {
    const r = await fetch(sourceUrl(a)).catch(() => null);
    if (r && r.ok && !/html/.test(r.headers.get("content-type") || "")) { await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest)); return "public"; }
    if (a.source !== "drive" || !sa) throw new Error(r ? "Download failed (Drive returned a web page, not the file)" : "Download failed");
    const d = await fetch(`${DRIVE_API}/files/${encodeURIComponent(a.drive_id)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${await driveToken()}` } });
    if (!d.ok) throw new Error(d.status === 404 || d.status === 403 ? `Drive: not shared with ${sa.client_email} (HTTP ${d.status})` : `Drive download HTTP ${d.status}`);
    await pipeline(Readable.fromWeb(d.body), fs.createWriteStream(dest));
    return "service-account";
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
    const p = paramsFor(a), form = new FormData();
    for (const [k, v] of Object.entries(p)) form.append(k, String(v));
    form.append("api_key", KEY); form.append("signature", sign(p));
    form.append("file", new Blob([fs.readFileSync(out)], { type: a.type === "image" ? "application/octet-stream" : "video/mp4" }), path.basename(a.public_id) + (a.type === "image" ? "" : ".mp4"));
    return { ...(await post(a, form)), ...(compressed ? { compressed: true } : {}) };
  }
  async function downloadAndUpload(a) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-")), src = path.join(dir, "in.bin");
    try { const via = await download(a, src); return { ...(await uploadFile(a, src, dir)), via }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

  async function run(assets, retryFailed) {
    const d = read();
    const todo = assets.filter((a) => {
      const done = d.done[a.key];
      if (done && done.pid === a.public_id) return false;
      return retryFailed || !d.failed[a.key];
    });
    job = { total: todo.length, ok: 0, failed: 0, current: "", startedAt: new Date().toISOString() };
    for (const a of todo) {
      job.current = a.public_id;
      try {
        if (a.source === "drive" ? !a.drive_id : !a.url) throw new Error("No source file (missing Drive id)");
        const prev = d.done[a.key];
        if (prev && !prev.pid) await destroyOld(a.key, a.type);
        let info;
        try { info = await upload(a); }
        catch (e) {
          // Cloudinary couldn't take it straight from the URL: too big, or Drive handed it a web page (not shared
          // publicly / over quota). Fetch the file ourselves (public link, else the Drive API) and upload the bytes.
          if (/too large/i.test(e.message) || (a.source === "drive" && /html|not found|resource/i.test(e.message))) info = await downloadAndUpload(a);
          else throw e;
        }
        d.done[a.key] = info; delete d.failed[a.key]; job.ok++;
      } catch (e) { d.failed[a.key] = e.message.slice(0, 200); job.failed++; warn("media upload failed", { key: a.key, path: a.public_id, error: e.message }); }
      write(d);
    }
    job.current = ""; job.finishedAt = new Date().toISOString();
    logger && logger.info && logger.info("media sync finished", { ok: job.ok, failed: job.failed, total: job.total });
  }

  // Keep Cloudinary in sync on its own: shortly after start-up, then every 6 hours (only copies what's missing or moved)
  const autoSync = () => { if (!ready() || (job && !job.finishedAt) || cfg.noVideoSync) return; manifest().then((a) => run(a, true)).catch((e) => { job = { error: e.message, finishedAt: new Date().toISOString() }; warn("media sync failed", { error: e.message }); setTimeout(autoSync, 5 * 60e3).unref(); }); };
  if (ready() && !cfg.noVideoSync) { setTimeout(autoSync, 30000).unref(); setInterval(autoSync, 6 * 3600 * 1000).unref(); }

  admin.post("/videos/migrate", async (req, res) => {
    if (!ready()) return res.status(400).json({ error: "Cloudinary isn't configured on the API (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET)." });
    if (job && !job.finishedAt) return res.json({ running: true, job });
    let assets; try { assets = await manifest(); } catch (e) { return res.status(502).json({ error: "Couldn't read the media list from the site: " + e.message }); }
    run(assets, !!(req.body && req.body.retryFailed)).catch((e) => { job.error = e.message; job.finishedAt = new Date().toISOString(); });
    res.json({ started: true, total: assets.length });
  });
  admin.get("/videos/status", (req, res) => {
    const d = read();
    res.json({ configured: ready(), cloud: CLOUD, job, done: Object.keys(d.done).length, failed: d.failed, driveAccount: sa ? sa.client_email : null });
  });

  // Public: which assets are on Cloudinary (key -> [path, type, version]) so the app streams them from there
  app.get("/api/videos", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    if (!ready()) return res.json({ cloud: "", map: {}, ids: [] });
    const done = read().done, map = {};
    for (const [k, v] of Object.entries(done)) if (v && v.pid) map[k] = [v.pid, v.type === "image" ? "i" : "v", v.version || 0];
    res.json({ cloud: CLOUD, map, ids: Object.keys(map) });
  });
}

module.exports = { mountVideos };
