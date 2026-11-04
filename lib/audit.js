// AUDIT LEDGER: tamper-evident record of who touched patient data (same design as omniverse-core's Conscience Ledger).
// - Append-only, one entry per event: actor, action, subject, time, hashed IP.
// - SHA-256 hash chain: every entry's hash covers its contents + the previous entry's hash, starting from a genesis hash.
//   Changing, deleting or reordering any entry breaks every hash after it.
// - Ed25519 signature on every entry hash: only this server (holding the private key) can produce valid entries.
// - Stored in the encrypted store (AES-256-GCM, like SQLCipher in omniverse-core), one file per month.
// Keys: AUDIT_SIGNING_KEY (Ed25519 private key, PKCS#8 PEM or base64) if set; otherwise one is generated on first run
// and kept in the encrypted store. The public key is shown in Admin so anyone can verify the chain independently.
"use strict";
const crypto = require("crypto");

const GENESIS = crypto.createHash("sha256").update("MD Fit audit ledger · genesis").digest("hex");
// Canonical JSON (sorted keys) so a hash never depends on property order
const canon = (v) => (v === null || typeof v !== "object") ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`;
const hashOf = (e) => crypto.createHash("sha256").update(canon({ seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, subject: e.subject, ip: e.ip, meta: e.meta, prev: e.prev })).digest("hex");

function createAudit({ store, signingKey = "", ipSalt = "", logger, now = () => new Date() }) {
  // ---- Keys. Preferred: AUDIT_SIGNING_KEY in the host's secret variables, kept apart from the data it protects.
  // Without it, a key is generated and kept in the encrypted store. Entries carry the key id (kid) that signed them,
  // and older keys stay trusted for verification after a rotation.
  const fp = (pubKey) => crypto.createHash("sha256").update(pubKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
  const stored = store.read("audit-key", null);
  let priv;
  if (signingKey) priv = crypto.createPrivateKey(signingKey.includes("BEGIN") ? signingKey : Buffer.from(signingKey, "base64").toString("utf8"));
  else if (stored && stored.privatePem) priv = crypto.createPrivateKey(stored.privatePem);
  else {
    priv = crypto.generateKeyPairSync("ed25519").privateKey;
    store.write("audit-key", { privatePem: priv.export({ type: "pkcs8", format: "pem" }), createdAt: now().toISOString() });
  }
  const pub = crypto.createPublicKey(priv);
  const publicPem = pub.export({ type: "spki", format: "pem" });
  const fingerprint = fp(pub);
  const trusted = new Map([[fingerprint, pub]]);
  if (stored && stored.privatePem) { const old = crypto.createPublicKey(crypto.createPrivateKey(stored.privatePem)); trusted.set(fp(old), old); }
  for (const pem of (store.read("audit-trusted-keys", []) || [])) { try { const k = crypto.createPublicKey(pem); trusted.set(fp(k), k); } catch {} }
  // Remember every key that has ever signed, so a later rotation never orphans old entries
  const known = store.read("audit-trusted-keys", []);
  if (!known.includes(publicPem)) store.write("audit-trusted-keys", [...known, publicPem]);
  const sigOk = (e) => {
    const keys = e.kid && trusted.has(e.kid) ? [trusted.get(e.kid)] : [...trusted.values()];
    return keys.some((k) => crypto.verify(null, Buffer.from(e.hash, "hex"), k, Buffer.from(e.sig || "", "base64")));
  };

  const monthOf = (iso) => iso.slice(0, 7);
  const fileFor = (month) => `audit-${month}`;
  const hashIp = (ip) => (ip ? crypto.createHmac("sha256", ipSalt || "mdfit-audit").update(String(ip)).digest("hex").slice(0, 16) : "");

  function state() { return store.read("audit-state", { seq: 0, last: GENESIS, months: [] }); }

  // ---- Append (synchronous, so entries are written in order)
  function record({ actor, action, subject = "", ip = "", meta = {} }) {
    try {
      const st = state(), ts = now().toISOString(), month = monthOf(ts);
      const e = { seq: st.seq + 1, ts, actor: String(actor || "system"), action: String(action), subject: String(subject || ""), ip: hashIp(ip), meta: meta || {}, prev: st.last };
      e.hash = hashOf(e);
      e.sig = crypto.sign(null, Buffer.from(e.hash, "hex"), priv).toString("base64");
      e.kid = fingerprint;
      const list = store.read(fileFor(month), []);
      list.push(e);
      store.write(fileFor(month), list);
      store.write("audit-state", { seq: e.seq, last: e.hash, months: st.months.includes(month) ? st.months : [...st.months, month] });
      return e;
    } catch (err) {
      logger && logger.error("audit_write_failed", { action, error: err.message });
      return null;
    }
  }

  // ---- Verify the whole chain: links, hashes and signatures, across every month
  function verify() {
    const st = state();
    let prev = GENESIS, n = 0;
    for (const month of st.months) {
      for (const e of store.read(fileFor(month), [])) {
        n++;
        if (e.seq !== n) return { ok: false, entries: n, error: `Entry ${n} is missing or out of order (found #${e.seq}).`, at: e.seq };
        if (e.prev !== prev) return { ok: false, entries: n, error: `Chain broken at entry #${e.seq}: it doesn't link to the entry before it.`, at: e.seq };
        if (hashOf(e) !== e.hash) return { ok: false, entries: n, error: `Entry #${e.seq} was altered after it was written.`, at: e.seq };
        if (!sigOk(e)) return { ok: false, entries: n, error: `Entry #${e.seq} has an invalid signature.`, at: e.seq };
        prev = e.hash;
      }
    }
    if (n !== st.seq || prev !== st.last) return { ok: false, entries: n, error: "The newest entries are missing (ledger was truncated)." };
    return { ok: true, entries: n, head: prev, genesis: GENESIS, publicKeyFingerprint: fingerprint };
  }

  // ---- Read: newest first, optional filters
  function list({ limit = 200, subject, actor, action } = {}) {
    const st = state(), out = [];
    for (const month of [...st.months].reverse()) {
      const entries = store.read(fileFor(month), []);
      for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        const e = entries[i];
        if (subject && e.subject !== subject) continue;
        if (actor && e.actor !== actor) continue;
        if (action && !e.action.startsWith(action)) continue;
        out.push(e);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- Anchors: the chain head published OUTSIDE this server (emailed to the owner, written to the host's logs).
  // Hash chaining alone can't stop someone with full server access from rebuilding the whole chain; an anchor they
  // can't reach (your inbox) can. Check any anchor against the live ledger with checkAnchor().
  function anchor() {
    const st = state();
    if (!st.seq) return null;
    const a = { seq: st.seq, head: st.last, at: now().toISOString(), kid: fingerprint };
    const list = store.read("audit-anchors", []);
    if (list.length && list[list.length - 1].seq === a.seq) return null; // nothing new since the last anchor
    store.write("audit-anchors", [...list, a].slice(-3650));
    return a;
  }
  function checkAnchor(seq, head) {
    const st = state();
    for (const month of st.months) {
      const e = store.read(fileFor(month), []).find((x) => x.seq === Number(seq));
      if (e) return { ok: e.hash === String(head).trim().toLowerCase(), seq: e.seq, ts: e.ts };
    }
    return { ok: false, error: `Entry #${seq} isn't in the ledger.` };
  }
  const anchors = () => store.read("audit-anchors", []);

  return { record, verify, list, anchor, checkAnchor, anchors, publicPem, fingerprint, GENESIS };
}

module.exports = { createAudit, hashOf, canon, GENESIS };
