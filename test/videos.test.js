"use strict";
// Cloudinary media sync: public Drive links are handed to Cloudinary; files Drive won't serve publicly (not shared /
// over quota) are fetched through the Drive API with the service account and uploaded as bytes; names with slashes
// are accepted; entries with no source fail with a clear reason.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
process.env.CLOUDINARY_CLOUD_NAME = "testcloud"; process.env.CLOUDINARY_API_KEY = "key"; process.env.CLOUDINARY_API_SECRET = "secret";
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");

const asset = (key, extra) => ({ key, source: "drive", drive_id: key, type: "video", purpose: "exercise-library", public_id: `mdfit/videos/exercise-library/Exercise/Hips/Strength/${key}`,
  display_name: key, tags: ["mdfit"], context: { name: key }, folder: "mdfit/videos/exercise-library/Exercise/Hips/Strength", ...extra });

async function fakes() {
  const seen = { cloudinary: [], driveApi: [] };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/data/media-manifest.json") return json(200, { version: "t", count: 4, assets: [
      asset("shared-clip"), asset("unshared-clip"),
      asset("no-id", { key: null, drive_id: null, purpose: "pain-track" }),
      asset("slash-pic", { type: "image", display_name: "Calf / soleus to calf", public_id: "mdfit/images/pain-patterns/Calf/pattern-1", folder: "mdfit/images/pain-patterns/Calf" })
    ] });
    if (u.pathname === "/public") { // Drive's public download link
      if (u.searchParams.get("id") === "shared-clip") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(64, 1)); }
      res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>Sign in</html>");
    }
    if (u.pathname === "/token") return json(200, { access_token: "sa-token", expires_in: 3600 });
    if (u.pathname.startsWith("/drive/files/")) {
      seen.driveApi.push({ id: decodeURIComponent(u.pathname.split("/").pop()), auth: req.headers.authorization, alt: u.searchParams.get("alt") });
      if (req.headers.authorization !== "Bearer sa-token") return json(401, { error: "no" });
      res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(128, 2));
    }
    if (/^\/v1_1\/testcloud\/(video|image)\/upload$/.test(u.pathname)) {
      const ct = req.headers["content-type"] || "";
      let fields = {}, fileBytes = 0;
      if (ct.startsWith("multipart/")) {
        const fd = await new Response(Readable.toWeb(req), { headers: { "content-type": ct } }).formData();
        for (const [k, v] of fd.entries()) { if (typeof v === "string") fields[k] = v; else fileBytes = v.size; }
      } else { let b = ""; for await (const c of req) b += c; fields = Object.fromEntries(new URLSearchParams(b)); }
      seen.cloudinary.push({ ...fields, fileBytes, multipart: ct.startsWith("multipart/") });
      if (!fileBytes && /unshared/.test(fields.file || "")) return json(404, { error: { message: `Resource not found - Error in loading ${fields.file} - HTML response` } });
      return json(200, { public_id: fields.public_id, version: 7, bytes: fileBytes || 64, format: "mp4" });
    }
    res.writeHead(404); res.end();
  }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

test("media sync: public link via Cloudinary, unshared file via the Drive API, slashes in names, missing source", async (t) => {
  const f = await fakes(); t.after(f.close);
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "media@mdfit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-v-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York",
    siteUrl: f.base, noVideoSync: true, cloudinaryApiUrl: f.base, driveApiUrl: f.base + "/drive", googleTokenUrl: f.base + "/token", drivePublicUrl: f.base + "/public?id=", googleServiceAccount: sa });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const adm = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  let st = (await call("GET", "/api/admin/videos/status", undefined, adm)).body;
  assert.equal(st.configured, true); assert.equal(st.driveAccount, "media@mdfit-test.iam.gserviceaccount.com");
  assert.deepEqual(await call("POST", "/api/admin/videos/migrate", {}, adm).then((r) => r.body), { started: true, total: 4 });
  for (let i = 0; i < 200 && !(st.job && st.job.finishedAt); i++) { await new Promise((r) => setTimeout(r, 50)); st = (await call("GET", "/api/admin/videos/status", undefined, adm)).body; }
  assert.ok(st.job.finishedAt, "job finished"); assert.equal(st.job.ok, 3); assert.equal(st.job.failed, 1);
  assert.match(st.failed["null"], /No source file/);
  // the shared clip went straight from its URL; the unshared one was fetched through the Drive API and uploaded as bytes
  const byId = (pid) => f.seen.cloudinary.filter((c) => c.public_id.split("/").pop() === pid);
  assert.equal(byId("shared-clip").length, 1); assert.equal(byId("shared-clip")[0].multipart, false);
  assert.equal(byId("shared-clip")[0].eager, "q_auto,vc_h264"); assert.equal(byId("pattern-1")[0].eager, undefined, "images get no video rendition");
  assert.equal(byId("unshared-clip").length, 2); assert.equal(byId("unshared-clip")[1].multipart, true); assert.equal(byId("unshared-clip")[1].fileBytes, 128);
  assert.deepEqual(f.seen.driveApi, [{ id: "unshared-clip", auth: "Bearer sa-token", alt: "media" }]);
  // the slash became a dash in the display name only; the path is unchanged
  assert.equal(byId("pattern-1")[0].display_name, "Calf - soleus to calf"); assert.equal(byId("pattern-1")[0].public_id, "mdfit/images/pain-patterns/Calf/pattern-1");
  // the app's public map lists both videos (with their Cloudinary version) and the image
  const pub = (await call("GET", "/api/videos")).body;
  assert.equal(pub.cloud, "testcloud");
  assert.deepEqual(pub.map["unshared-clip"], ["mdfit/videos/exercise-library/Exercise/Hips/Strength/unshared-clip", "v", 7]);
  assert.deepEqual(pub.map["slash-pic"], ["mdfit/images/pain-patterns/Calf/pattern-1", "i", 7]);
  assert.equal(pub.map["null"], undefined);
  // a second run copies nothing new (everything done or failed without retry)
  assert.deepEqual((await call("POST", "/api/admin/videos/migrate", {}, adm)).body, { started: true, total: 4 });
  for (let i = 0; i < 200; i++) { st = (await call("GET", "/api/admin/videos/status", undefined, adm)).body; if (st.job.finishedAt) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.job.total, 0);
});
