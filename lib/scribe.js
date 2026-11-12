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
// What the model is asked to write. "patient" is the short note the patient reads; the rest are for the clinician.
const CLINICAL = [
  "You help a physical rehabilitation and fitness clinician write clinical documentation from their own rough notes or a transcript.",
  "Rules:",
  "- Use only what is in the text. Never add a diagnosis, a finding, a measurement, an exercise, a dose or a plan that the text does not contain.",
  "- If a section has nothing in the text to support it, write \"Not recorded.\" for that section. Do not guess.",
  "- Refer to the person as \"the patient\". No names, dates of birth, phone numbers, emails or addresses.",
  "- Plain, professional clinical language. No markdown symbols. Section names on their own line followed by a colon."
].join("\n");
const KINDS = {
  patient: { system: SYSTEM, lead: "Clinician's notes or transcript:" },
  soap: { system: CLINICAL + "\nWrite a SOAP note with exactly these sections: Subjective, Objective, Assessment, Plan. At most 300 words.", lead: "Clinician's notes or transcript:" },
  evaluation: { system: CLINICAL + "\nWrite an initial evaluation with these sections: Reason for visit, History, Findings, Assessment, Plan of care, Home program. At most 350 words.", lead: "Clinician's notes or transcript:" },
  followup: { system: CLINICAL + "\nWrite a follow-up visit note with these sections: Changes since last visit, Treatment today, Response, Plan and home program. At most 250 words.", lead: "Clinician's notes or transcript:" },
  discharge: { system: CLINICAL + "\nWrite a discharge summary with these sections: Reason for care, Course of care, Status at discharge, Home program, Follow-up advice. At most 300 words.", lead: "Clinician's notes or transcript:" },
  free: { system: CLINICAL + "\nTidy the text into a clear clinical note in short paragraphs, keeping every fact. At most 300 words.", lead: "Clinician's notes or transcript:" },
  "intake-summary": { system: CLINICAL + "\nSummarise this patient's intake answers for the clinician with these sections: Main complaint, History, Medications and red flags, Goals. At most 200 words.", lead: "Intake answers (identity fields already removed):" },
  "prep-brief": { system: CLINICAL + "\nWrite a short brief the clinician reads before the next visit, with these sections: Where things stand, What was done last time, What to check today. At most 160 words.", lead: "Record so far (identity fields already removed):" },
  "client-summary": { system: CLINICAL + "\nSummarise this patient's record for the clinician with these sections: Background, Care so far, Progress, Open items. At most 250 words.", lead: "Record so far (identity fields already removed):" },
  "treatment-plan": { system: CLINICAL + "\nDraft a treatment plan for the clinician to review, with these sections: Problems, Goals (taken from the patient's own stated goals), Planned treatment, Home program, Review point. Use only treatments and exercises that appear in the record. At most 250 words.", lead: "Record so far (identity fields already removed):" }
};

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
  const one = (x) => { const u = String((x && x.url) || "").trim().replace(/\/+$/, ""); let h = "", ok = false; try { const v = new URL(u); h = v.host; ok = v.protocol === "https:" || (v.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(v.hostname)); } catch {} return { url: u, key: String((x && x.key) || "").trim(), model: String((x && x.model) || "").trim(), host: h, ok }; };
  // Backups (as the owner's other products do it): another service to try, in order, when the first cannot answer
  const fallbacks = (Array.isArray(s.fallbacks) ? s.fallbacks : []).map(one).filter((f) => f.ok && f.key && f.model && !(f.url === url && f.model === model)).slice(0, 3);
  return { url, key, model, host, fallbacks, temperature: Number.isFinite(t) ? t : null, enabled: !!(okUrl && key && model) };
}

// Why the AI service said no. Its own short reason is kept for the server log and the staff screen, with anything
// shaped like a key or an address removed. (The reply to a refused request never contains the note text.)
const RETRY_MIN_MS = 1500, RETRY_MAX_MS = 5000;
async function refusal(r) {
  let type = "", message = "";
  try {
    const body = JSON.parse((await r.text()).slice(0, 4000));
    const e = body && typeof body.error === "object" && body.error ? body.error : body || {};
    type = String(e.type || e.code || "").slice(0, 60);
    message = String(e.message || (typeof body.error === "string" ? body.error : "") || "");
  } catch {}
  message = message.replace(/\b(sk|pk|key|org|proj)[-_][\w-]{6,}/gi, "[removed]").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[removed]").replace(/\s+/g, " ").trim().slice(0, 200);
  return { type: type.replace(/[^\w.-]/g, ""), message };
}
function explain(status, why, S) {
  const said = why.message ? ` The service said: "${why.message}"` : "";
  if (status === 401 || status === 403) return `The AI service (${S.host}) did not accept the key. Check that the key on the server is current and belongs to this service.`;
  if (status === 404) return `The AI service (${S.host}) does not offer the model "${S.model}" to this key. Choose one it does offer with "Change model" on the AI scribe card.${said}`;
  if (status === 429) return /quota|balance|credit|billing|insufficient/i.test(why.type + " " + why.message)
    ? `The AI service (${S.host}) refused the request: the account behind the key has no credit or allowance left.${said}`
    : `The AI service (${S.host}) is turning requests away for now: this key is over its rate limit. Wait a minute and try again.${said}`;
  if (status >= 500) return `The AI service (${S.host}) is having trouble of its own (${status}). Try again shortly.`;
  return `The AI service answered with an error (${status}).${said}`;
}

function mountScribe({ admin, cfg, audit, limiter, logger, clients, store }) {
  const S = settingsFrom(cfg);
  // The model can be chosen in the workspace from the list the connected service offers this key. That choice is kept
  // here and wins over the server variable, so a renamed or retired model is fixed without a redeploy.
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
  const fromEnv = S.model;
  // (a model chosen in the workspace for one service is not carried over to another: the saved host must match)
  try { const saved = store ? store.read("scribe", {}) : {}; if (saved && typeof saved.model === "string" && MODEL_ID.test(saved.model) && saved.host === S.host && S.url && S.key) { S.model = saved.model; S.enabled = true; } } catch {}
  async function models() {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(S.url + "/models", { signal: ctl.signal, redirect: "error", headers: { authorization: "Bearer " + S.key } });
      if (!r.ok) return { error: explain(r.status, await refusal(r), S) };
      const j = await r.json();
      return { models: [...new Set((Array.isArray(j.data) ? j.data : []).map((m) => String((m && m.id) || "")).filter((id) => MODEL_ID.test(id)))].sort().slice(0, 2000) };
    } catch (err) { return { error: err.name === "AbortError" ? "The AI service took too long to answer." : "The AI service could not be reached." }; }
    finally { clearTimeout(timer); }
  }
  const limit = limiter(40, 60 * 60 * 1000);
  const status = () => ({ enabled: S.enabled, model: S.enabled ? S.model : "", host: S.enabled ? S.host : "", backups: S.fallbacks.map((f) => ({ host: f.host, model: f.model })) });

  admin.get("/scribe", (req, res) => res.json({ ...status(), kinds: Object.keys(KINDS) }));
  // Which models this key can use, asked of the service itself (the key never leaves the server)
  admin.get("/scribe/models", async (req, res) => {
    if (!S.url || !S.key) return res.status(503).json({ error: "The AI scribe is not connected." });
    const out = await models();
    if (out.error) return res.status(502).json({ error: out.error });
    res.json({ models: out.models, current: S.model, host: S.host });
  });
  admin.put("/scribe/model", async (req, res) => {
    if (!S.url || !S.key) return res.status(503).json({ error: "The AI scribe is not connected." });
    const model = String((req.body && req.body.model) || "").trim();
    if (!MODEL_ID.test(model)) fail("Pick a model from the list.");
    const out = await models();
    if (out.models && out.models.length && !out.models.includes(model)) fail("This key does not offer that model. Pick one from the list.");
    S.model = model; S.enabled = true;
    if (store) store.write("scribe", { model, host: S.host, at: new Date().toISOString() });
    if (audit) audit.record({ actor: "admin", action: "scribe.model", subject: "", ip: req.ip, meta: { model, was: fromEnv } });
    res.json(status());
  });

  admin.post("/scribe/draft", limit.mw, async (req, res) => {
    if (!S.enabled) return res.status(503).json({ error: "The AI scribe is not connected. Set SCRIBE_API_URL, SCRIBE_API_KEY and SCRIBE_MODEL on the server." });
    const b = req.body || {};
    const raw = typeof b.text === "string" ? b.text.trim() : "";
    const kind = b.kind === undefined ? "patient" : String(b.kind);
    if (!KINDS[kind]) fail("That kind of draft is not available.");
    if (raw.length < MIN_TEXT) fail("Paste or dictate a few sentences about the visit first.");
    if (raw.length > MAX_TEXT) fail(`That is too long (max ${MAX_TEXT.toLocaleString("en-US")} characters).`);
    const c = b.clientId ? clients().find((x) => x.id === String(b.clientId)) : null;
    if (b.clientId && !c) return res.status(404).json({ error: "Client not found." });
    const safe = redact(raw, c ? [c.name, c.firstName, c.lastName] : []);

    // One attempt at one service. Returns the draft, or why there is none.
    const attempt = async (P) => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const ask = () => fetch(P.url + "/chat/completions", {
          method: "POST", signal: ctl.signal, redirect: "error",
          headers: { "content-type": "application/json", authorization: "Bearer " + P.key },
          // No temperature unless the owner sets one: some models accept only their own fixed value and refuse others.
          // Room for a model that thinks before it answers; the note itself is capped by the instructions.
          body: JSON.stringify({ model: P.model, ...(S.temperature === null ? {} : { temperature: S.temperature }), max_tokens: 4000,
            messages: [{ role: "system", content: KINDS[kind].system }, { role: "user", content: KINDS[kind].lead + "\n\n" + safe.text }] })
        });
        let r = await ask();
        // "Too many requests" is often momentary on a free or shared plan: wait briefly and try once more
        if (r.status === 429) {
          const why = await refusal(r);
          if (!/quota|balance|credit|billing|insufficient/i.test(why.type + " " + why.message)) {
            const wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, (Number(r.headers.get("retry-after")) || 0) * 1000));
            await new Promise((go) => setTimeout(go, wait));
            r = await ask();
          } else r = { ok: false, status: 429, why };
        }
        if (!r.ok) {
          const why = r.why || await refusal(r);
          logger.warn("scribe_failed", { status: r.status, host: P.host, model: P.model, type: why.type, reason: why.message });
          return { error: explain(r.status, why, P) };
        }
        const out = await r.json();
        const text = String((((out.choices || [])[0] || {}).message || {}).content || "").replace(/\r/g, "").replace(/^[#*\s]+|[*\s]+$/g, "").replace(/\*\*/g, "").trim();
        if (!text) { logger.warn("scribe_failed", { host: P.host, model: P.model, error: "empty" }); return { error: `The AI service (${P.host}) sent back nothing.` }; }
        return { draft: text };
      } catch (err) {
        logger.warn("scribe_failed", { host: P.host, model: P.model, error: err.name === "AbortError" ? "timeout" : "network" });
        return { error: err.name === "AbortError" ? `The AI service (${P.host}) took too long.` : `The AI service (${P.host}) could not be reached.` };
      } finally { clearTimeout(timer); }
    };
    // The first service, then each backup in turn. The first one to answer wins; if none does, say why for each.
    let draft = "", used = S;
    const failed = [];
    for (const P of [S, ...S.fallbacks]) {
      const out = await attempt(P);
      if (out.draft) { draft = out.draft; used = P; break; }
      failed.push(out.error);
    }
    if (!draft) return res.status(502).json({ error: (failed.length > 1 ? failed.map((f, n) => (n ? "Backup: " : "") + f).join(" ") : failed[0]) + " Nothing was saved." });

    // What was drafted is never recorded; only that a draft was made, for which record and by which model
    if (audit) audit.record({ actor: "admin", action: "scribe.draft", subject: c ? c.id : "", ip: req.ip, meta: { model: used.model, kind, chars: raw.length, removed: safe.count, ...(used === S ? {} : { backup: used.host }) } });
    res.json({ draft: draft.slice(0, 8000), model: used.model, host: used.host, backup: used !== S, removed: safe.count, kind });
  });

  return { status };
}

module.exports = { mountScribe, redact, settingsFrom, KINDS };
