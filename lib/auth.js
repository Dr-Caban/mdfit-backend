// Password hashing (scrypt) and signed session tokens (HMAC-SHA256). No passwords are stored in plain text.
const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const N = 16384, r = 8, p = 1;
  const key = crypto.scryptSync(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function isValidHash(stored) {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(String(stored || ""));
}

function verifyPassword(password, stored) {
  if (!isValidHash(stored)) return false;
  const [, N, r, p, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  try {
    const key = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload && typeof payload.exp === "number" && payload.exp > now ? payload : null;
  } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, isValidHash, signToken, verifyToken };
