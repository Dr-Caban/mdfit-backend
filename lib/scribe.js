// AI scribe (Workspace → Notes). Owner, Nov 2026.
//
// Dr. Jared pastes or dictates what happened in a visit; a language model turns it into a draft of the note the
// patient reads. The draft goes back to the screen and nowhere else: it is not saved, not sent to the patient and
// not logged. Dr. Jared edits it and adds it himself, the same way as a note he typed.
//
// The model is any service that speaks the OpenAI "chat completions" format, set with three variables on the host:
//   SCRIBE_API_URL   the base address, e.g. https://api.example.com/v1   (https only, or http://localhost for a model
//                    running on the practice's own machine)
//   SCRIBE_API_KEY   the key for it (never sent to the browser, never logged)
//   SCRIBE_MODEL     the model's name
// or, for a provider this file knows by name: AI_PROVIDER (moonshot), AI_MODEL, and that provider's key variable
// (MOONSHOT_API_KEY). SCRIBE_API_URL overrides the address, e.g. for a provider's other region.
// Without an address, a key and a model the scribe is off and says so.
//
// Privacy handling:
//   - Visit text is health information. It may only go to a model provider that has signed a business associate
//     agreement and does not keep or train on what it is sent. The code cannot check that; the owner must.
//   - Before anything is sent, the patient's own name is replaced with "the patient", and emails and phone numbers
//     are removed. No client id, email or date of birth is ever added to the request.
//   - The audit ledger records that a draft was made, for which record, by which model and how long the text was.
//     It never records the text or the draft.
"use strict";
const { ValidationError } = require("./validate");

const MAX_TEXT = 20000, MIN_TEXT = 20, TIMEOUT_MS = 90000;
const fail = (m) => { throw new ValidationError(m); };

const SYSTEM = [
  "You help a physical rehabilitation and fitness clinician write the short note a patient reads in their app after a visit.",
  "You are given the clinician's own rough notes or a transcript of what was said. Write the note in the clinician's voice, addressed to the patient as \"you\".",
  "Rules:",
  "- Use only what is in the text. Never add a diagnosis, a finding, a number, an exercise, a dose or advice that the text does not contain.",
  "- If something needed for a section is not in the text, leave that section out. Do not guess and do not write placeholders.",
  "- Plain words a patient understands. Short sentences. No jargon without a few words of explanation.",
  "- Structure: one or two sentences on what was worked on today; then \"What to do before next time:\" as a short list, only if the text gives home instructions; then anything to watch for, only if the text mentions it; then the next step or next visit, only if the text mentions it.",
  "- Do not include names, dates of birth, phone numbers or emails. Refer to the patient as \"you\".",
  "- No greeting, no sign-off, no headings other than the one above, no markdown symbols. At most 180 words."
].join("\n");

// The patient's own name, emails and phone numbers are taken out before the text leaves the server
function redact(text, names = []) {
  let out = String(text), n = 0;
  const swap = (re, to) => { out = out.replace(re, (m) => { n++; return typeof to === "function" ? to(m) : to; }); };
  swap(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]");
  swap(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone removed]");
  // calendar dates (a birthday, a surgery date): "3 weeks ago" stays, "11/03/2026" and "March 3, 1961" go
  swap(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, "[date removed]");
  swap(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi, "[date removed]");
  const parts = [...new Set(names.flatMap((x) => String(x || "").split(/\s+/)).map((x) => x.replace(/[^\p{L}'-]/gu, "")).filter((x) => x.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const p of parts) swap(new RegExp(`(?<![\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'s)?(?![\\p{L}])`, "giu"), (m) => (/'s$/i.test(m) ? "the patient's" : "the patient"));
  return { text: out.replace(/the patient(?:\s+the patient)+/gi, "the patient"), count: n };
}

function settingsFrom(cfg = {}) {
  const s = cfg.scribe || {};
  const url = String(s.url || "").trim().replace(/\/+$/, ""), key = String(s.key || "").trim(), model = String(s.model || "").trim();
  let host = "", okUrl = false;
  try { const u = new URL(url); host = u.host; okUrl = u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)); } catch {}
  const t = s.temperature === undefined || s.temperature === "" ? null : Number(s.temperature);
  return { url, key, model, host, temperature: Number.isFinite(t) ? t : null, enabled: !!(okUrl && key && model) };
}

function mountScribe({ admin, cfg, audit, limiter, logger, clients }) {
  const S = settingsFrom(cfg);
  const limit = limiter(40, 60 * 60 * 1000);
  const status = () => ({ enabled: S.enabled, model: S.enabled ? S.model : "", host: S.enabled ? S.host : "" });

  admin.get("/scribe", (req, res) => res.json(status()));

  admin.post("/scribe/draft", limit.mw, async (req, res) => {
    if (!S.enabled) return res.status(503).json({ error: "The AI scribe is not connected. Set SCRIBE_API_URL, SCRIBE_API_KEY and SCRIBE_MODEL on the server." });
    const b = req.body || {};
    const raw = typeof b.text === "string" ? b.text.trim() : "";
    if (raw.length < MIN_TEXT) fail("Paste or dictate a few sentences about the visit first.");
    if (raw.length > MAX_TEXT) fail(`That is too long (max ${MAX_TEXT.toLocaleString("en-US")} characters).`);
    const c = b.clientId ? clients().find((x) => x.id === String(b.clientId)) : null;
    if (b.clientId && !c) return res.status(404).json({ error: "Client not found." });
    const safe = redact(raw, c ? [c.name, c.firstName, c.lastName] : []);

    let draft = "";
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(S.url + "/chat/completions", {
        method: "POST", signal: ctl.signal, redirect: "error",
        headers: { "content-type": "application/json", authorization: "Bearer " + S.key },
        // No temperature unless the owner sets one: some models accept only their own fixed value and refuse others.
        // Room for a model that thinks before it answers; the note itself is capped by the instructions.
        body: JSON.stringify({ model: S.model, ...(S.temperature === null ? {} : { temperature: S.temperature }), max_tokens: 2000,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "Clinician's notes or transcript:\n\n" + safe.text }] })
      });
      if (!r.ok) { logger.warn("scribe_failed", { status: r.status }); return res.status(502).json({ error: `The AI service answered with an error (${r.status}). Nothing was saved.` }); }
      const out = await r.json();
      draft = String((((out.choices || [])[0] || {}).message || {}).content || "").replace(/\r/g, "").replace(/^[#*\s]+|[*\s]+$/g, "").replace(/\*\*/g, "").trim();
    } catch (err) {
      logger.warn("scribe_failed", { error: err.name === "AbortError" ? "timeout" : "network" });
      return res.status(502).json({ error: err.name === "AbortError" ? "The AI service took too long. Nothing was saved." : "The AI service could not be reached. Nothing was saved." });
    } finally { clearTimeout(timer); }
    if (!draft) return res.status(502).json({ error: "The AI service sent back nothing. Nothing was saved." });

    // What was drafted is never recorded; only that a draft was made, for which record and by which model
    if (audit) audit.record({ actor: "admin", action: "scribe.draft", subject: c ? c.id : "", ip: req.ip, meta: { model: S.model, chars: raw.length, removed: safe.count } });
    res.json({ draft: draft.slice(0, 4000), model: S.model, removed: safe.count });
  });

  return { status };
}

module.exports = { mountScribe, redact, settingsFrom };
