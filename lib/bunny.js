// Bunny Stream: where the videos live (images stay on Cloudinary). Bunny has no "fetch this URL" upload, so a video is
// created first (giving a guid) and the bytes are PUT to it. Playback is a plain URL off the pull zone hostname, so the
// app only needs the guid. The API key stays in Railway.
"use strict";
const fs = require("fs");

const API = "https://video.bunnycdn.com";

function createBunny({ apiKey, libraryId, host, fetchImpl, apiUrl } = {}) {
  const key = apiKey || "", lib = libraryId || "", cdn = (host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const base = (apiUrl || API).replace(/\/+$/, "") + `/library/${encodeURIComponent(lib)}/videos`;
  const call = (...a) => (fetchImpl || fetch)(...a);
  const ready = () => !!(key && lib && cdn);

  // Bunny answers errors as JSON ({Message}) but not always, so fall back to the raw body; keep it short and readable
  async function fail(r, what) {
    const txt = (await r.text().catch(() => "")) || "";
    let msg = txt.slice(0, 120);
    try { const j = JSON.parse(txt); msg = String(j.Message || j.message || "").slice(0, 120); } catch {}
    throw new Error(`Bunny ${what}: HTTP ${r.status}${msg ? " " + msg : ""}`);
  }

  async function createVideo(title) {
    const r = await call(base, { method: "POST", headers: { AccessKey: key, "content-type": "application/json" },
      body: JSON.stringify({ title: String(title || "untitled").slice(0, 200) }) });
    if (!r.ok) await fail(r, "create");
    const j = await r.json().catch(() => ({}));
    if (!j.guid) throw new Error("Bunny create: no guid in response");
    return j.guid;
  }

  // The file is streamed, not read into memory: a 1 GB container can't buffer a 500 MB clip (duplex "half" is what
  // fetch wants for a stream body).
  async function uploadBytes(guid, filePath) {
    const size = fs.statSync(filePath).size;
    const r = await call(`${base}/${encodeURIComponent(guid)}`, { method: "PUT", duplex: "half",
      headers: { AccessKey: key, "content-type": "application/octet-stream", "content-length": String(size) },
      body: fs.createReadStream(filePath) });
    if (!r.ok) await fail(r, "upload");
    return { guid, bytes: size };
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
    const r = await call(`${base}/${encodeURIComponent(guid)}`, { headers: { AccessKey: key } });
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

  return { ready, createVideo, uploadBytes, remove, info, status, urls, host: cdn };
}

module.exports = { createBunny };
