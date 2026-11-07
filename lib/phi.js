// Field-level encryption for free-text health notes in the JSON store (defense in depth on top of DATA_ENC_KEY,
// which encrypts whole files). Wraps a store so these fields are AES-256-GCM encrypted (lib/messages cipher) when
// a collection is written and readable again when it is read. Every other collection and field passes through
// untouched, and the structured fields that lists and lookups need (names, emails, dates, body areas, 0-10 pain
// scores, statuses) stay readable.
//
//   appointments: notes (what the patient wrote when booking), adminNotes (Dr. Jared's visit notes)
//   clients:      painLog[].note (pain diary), plan.notes (treatment plan)
//   leads:        message (consult request), notes (follow-up notes)
//   feedback:     text (on-site reviews; private ones often mention a condition)
//
// Older plain values are read as-is and encrypted on the collection's next write.
"use strict";

const FIELDS = {
  appointments: { notes: 1, adminNotes: 1 },
  clients: { plan: { notes: 1 }, painLog: [{ note: 1 }] },
  leads: { message: 1, notes: 1 },
  feedback: { text: 1 }
};
const PREFIX = "v1:";
const CACHE_MAX = 20000;

// Apply fn to every leaf the spec names; copies objects/arrays on the way so the stored data is never mutated
function apply(spec, v, fn) {
  if (spec === 1) return fn(v);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(spec)) return Array.isArray(v) ? v.map((x) => apply(spec[0], x, fn)) : v;
  const out = { ...v };
  for (const k of Object.keys(spec)) if (k in out) out[k] = apply(spec[k], out[k], fn);
  return out;
}

function phiStore(store, C, fields = FIELDS) {
  const cache = new Map(); // ciphertext -> plaintext, so the same note isn't decrypted on every request
  // Already-encrypted values (e.g. ones a wrong key couldn't open) are written back as they are, never wrapped twice
  const enc = (v) => (typeof v === "string" && v && !v.startsWith(PREFIX) ? C.enc(v) : v);
  const dec = (v) => {
    if (typeof v !== "string" || !v.startsWith(PREFIX)) return v;
    let p = cache.get(v);
    if (p === undefined) {
      p = C.dec(v);
      if (p === "") return v; // wrong key: keep the stored value rather than lose it on the next write
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(v, p);
    }
    return p;
  };
  const each = (name, data, fn) => (fields[name] && Array.isArray(data) ? data.map((r) => apply(fields[name], r, fn)) : data);
  return {
    ...store,
    read: (name, fallback) => each(name, store.read(name, fallback), dec),
    write: (name, data) => store.write(name, each(name, data, enc))
  };
}

module.exports = { phiStore, FIELDS, apply };
