// Bunny Stream: where the videos live (images stay on Cloudinary). Bunny has no "fetch this URL" upload, so a video is
// created first (giving a guid) and the bytes are PUT to it. Playback is a plain URL off the pull zone hostname, so the
// app only needs the guid. The API key stays in Railway.
"use strict";
const fs = require("fs");
const { idleAbort } = require("./idle");

const API = "https://video.bunnycdn.com";

function createBunny({ apiKey, libraryId, host, fetchImpl, apiUrl, timeoutMs, idleMs } = {}) {
  const key = apiKey || "", lib = libraryId || "", cdn = (host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const libBase = (apiUrl || API).replace(/\/+$/, "") + `/library/${encodeURIComponent(lib)}`;
  const base = `${libBase}/videos`;
  const call = (...a) => (fetchImpl || fetch)(...a);
  // Every request gets a deadline: an upload that hangs on an open socket would stop the whole mirror behind it.
  const sig = () => (timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {});
  const ready = () => !!(key && lib && cdn);

  // Bunny answers errors as JSON ({Message}) but not always, so fall back to the raw body; keep it short and readable
  async function fail(r, what) {
    const txt = (await r.text().catch(() => "")) || "";
    let msg = txt.slice(0, 120);
    try { const j = JSON.parse(txt); msg = String(j.Message || j.message || "").slice(0, 120); } catch {}
    throw new Error(`Bunny ${what}: HTTP ${r.status}${msg ? " " + msg : ""}`);
  }

  async function createVideo(title, collectionId) {
    const body = { title: String(title || "untitled").slice(0, 200) };
    if (collectionId) body.collectionId = collectionId;
    const r = await call(base, { method: "POST", headers: { AccessKey: key, "content-type": "application/json" },
      body: JSON.stringify(body), ...sig() });
    if (!r.ok) await fail(r, "create");
    const j = await r.json().catch(() => ({}));
    if (!j.guid) throw new Error("Bunny create: no guid in response");
    return j.guid;
  }

  // The file is streamed, not read into memory: a 1 GB container can't buffer a 500 MB clip (duplex "half" is what
  // fetch wants for a stream body).
  async function uploadBytes(guid, filePath) {
    const size = fs.statSync(filePath).size;
    // The body is the fs read stream itself, not a wrapper around it. Wrapping it in a Transform (to count bytes for
    // an idle watchdog) measurably costs memory - 12.9 MB against 5.2 MB for a 64 MB file in test/bunny-stream.test.js
    // - because undici can no longer treat it as a plain file stream. That is not enough to explain the OOM kills seen
    // in production, whose cause is still open, but there is no reason to pay it: the upload is not where transfers
    // stall. Drive downloads are, and those are metered (lib/videos.js), so this side takes the plain ceiling.
    const w = idleAbort(0, timeoutMs);
    try {
      const r = await call(`${base}/${encodeURIComponent(guid)}`, { method: "PUT", duplex: "half",
        headers: { AccessKey: key, "content-type": "application/octet-stream", "content-length": String(size) },
        body: fs.createReadStream(filePath), signal: w.signal });
      if (!r.ok) await fail(r, "upload");
      return { guid, bytes: size };
    } finally { w.stop(); }
  }

  // Bunny's "folders" are Collections. Dr. Jared wants everything the app plays in one called "In app", so the
  // library stays readable next to the raw footage he uploads by hand. Find-or-create, then remember it: a sync run
  // creates ~200 videos and must not ask 200 times. A library can hold two collections of the same name, so an exact
  // name match wins over Bunny's fuzzy search.
  let collCache = null;
  async function collection(name = "In app") {
    if (collCache && collCache.name === name) return collCache.guid;
    const url = `${libBase}/collections?page=1&itemsPerPage=100&search=${encodeURIComponent(name)}`;
    const r = await call(url, { headers: { AccessKey: key }, ...sig() });
    if (!r.ok) await fail(r, "collections");
    const j = (await r.json().catch(() => ({}))) || {};
    const hit = (j.items || []).find((c) => String(c.name) === name);
    let guid = hit && hit.guid;
    if (!guid) {
      const c = await call(`${libBase}/collections`, { method: "POST",
        headers: { AccessKey: key, "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!c.ok) await fail(c, "collection create");
      guid = ((await c.json().catch(() => ({}))) || {}).guid;
      if (!guid) throw new Error("Bunny collection create: no guid in response");
    }
    collCache = { name, guid };
    return guid;
  }

  // Videos uploaded before the collection existed get filed into it rather than re-uploaded.
  async function move(guid, collectionId) {
    const r = await call(`${base}/${encodeURIComponent(guid)}`, { method: "POST",
      headers: { AccessKey: key, "content-type": "application/json" }, body: JSON.stringify({ collectionId }) });
    if (!r.ok) await fail(r, "move");
    return true;
  }

  async function remove(guid) {
    const r = await call(`${base}/${encodeURIComponent(guid)}`, { method: "DELETE", headers: { AccessKey: key } });
    if (!r.ok) await fail(r, "delete");
    return true;
  }

  // Bunny encodes after the upload, so the playback files don't exist yet when the PUT returns: MP4 renditions appear
  // only once the encode finishes, and only if the library has MP4 Fallback on. Callers must wait for has720 before
  // publishing a URL, or members get a 404.
  async function info(guid) {
    const r = await call(`${base}/${encodeURIComponent(guid)}`, { headers: { AccessKey: key }, ...sig() });
    if (!r.ok) await fail(r, "info");
    return (await r.json().catch(() => ({}))) || {};
  }
  async function status(guid) {
    const v = await info(guid);
    // newer libraries report mp4Resolutions separately; older ones only availableResolutions ("360p,720p")
    const resolutions = String(v.mp4Resolutions || v.availableResolutions || "").split(",").map((x) => x.trim()).filter(Boolean);
    const code = Number(v.status);
    return { failed: code === 5, encoded: code >= 3 && code !== 5, progress: Number(v.encodeProgress) || 0, resolutions, has720: resolutions.includes("720p") };
  }

  const urls = (guid) => ({ mp4720: `https://${cdn}/${guid}/play_720p.mp4`, hls: `https://${cdn}/${guid}/playlist.m3u8`, thumb: `https://${cdn}/${guid}/thumbnail.jpg` });

  return { ready, collection, createVideo, move, uploadBytes, remove, info, status, urls, host: cdn };
}

module.exports = { createBunny };
