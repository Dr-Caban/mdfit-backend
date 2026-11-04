// Tiny JSON-file store. On Railway, DATA_DIR must be a mounted Volume (/data).
// With DATA_ENC_KEY set, every file is encrypted at rest (AES-256-GCM, authenticated): a copy of the volume or a
// backup is unreadable without the key. Older plain files are read as-is and encrypted on their next write.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PREFIX = "enc:v1:";

function createStore(dir, { key = "" } = {}) {
  const K = key ? crypto.scryptSync(String(key), "mdfit-store-v1", 32) : null;
  const seal = (text) => {
    if (!K) return text;
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", K, iv);
    const out = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
  };
  const open = (raw) => {
    if (!raw.startsWith(PREFIX)) return raw;
    if (!K) throw new Error("Data is encrypted but DATA_ENC_KEY is not set.");
    const b = Buffer.from(raw.slice(PREFIX.length), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", K, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  };
  const file = (name) => path.join(dir, name + ".json");
  const read = (name, fallback) => {
    let raw;
    try { raw = fs.readFileSync(file(name), "utf8"); } catch { return fallback; }
    // A wrong or missing key must fail loudly, never look like an empty store (which could then be overwritten)
    if (raw.startsWith(PREFIX)) return JSON.parse(open(raw));
    try { return JSON.parse(raw); } catch { return fallback; }
  };
  const write = (name, data) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file(name) + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, seal(JSON.stringify(data, null, K ? 0 : 2)), { mode: 0o600 });
    fs.renameSync(tmp, file(name));
  };
  return { dir, read, write, encrypted: !!K };
}

module.exports = { createStore };
