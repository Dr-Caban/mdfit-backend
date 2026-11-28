// Optional email notifications through Resend (resend.com). Off unless RESEND_API_KEY and NOTIFY_FROM are set.
// Never throws: a failed email must not fail the booking that triggered it.
//
// Resend allows only a few requests per second (2/s by default) and answers 429 beyond that. So:
//  - every request is retried on 429 (and on 5xx / network errors), waiting as long as Resend asks (retry-after),
//  - many emails at once (a group message) go through the batch endpoint: up to 100 emails per request,
//    one request at a time, instead of one request per email.
const crypto = require("crypto");
const { logger, mask } = require("./logger");

const MAX_TRIES = 8;
const BATCH_MAX = 100; // Resend's per-request limit for /emails/batch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ownerEmail: where owner alerts go; alertEmails: extra addresses that get every owner alert too.
// onResult({ ok, count, subject, to, error }): called after every send, for the admin's email-delivery log.
function createNotifier({ apiKey, from, ownerEmail, alertEmails = [], apiUrl = "https://api.resend.com", minGapMs = 600, onResult = () => {} }) {
  const enabled = Boolean(apiKey && from);
  const owners = [...new Set([ownerEmail, ...alertEmails].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  const report = (r) => { try { onResult(r); } catch {} };
  const base = apiUrl.replace(/\/+$/, "");

  // All requests go out one at a time, at least minGapMs apart, so bursts (a broadcast plus a booking email)
  // stay under the rate limit instead of failing.
  // When the provider says "too many" (429), the whole queue pauses for the time it asks (pauseUntil), so every
  // waiting email backs off together instead of each retry colliding with the others.
  let chain = Promise.resolve(), last = 0, pauseUntil = 0;
  const queued = (fn) => {
    const run = chain.then(async () => {
      const wait = Math.max(last + minGapMs, pauseUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { last = Date.now(); }
    });
    chain = run.catch(() => {});
    return run;
  };

  async function post(path, body, timeoutMs = 15000, key) {
    // One key for this message, the same on every try: when the provider took it but its answer was lost (a timeout,
    // a dropped connection), the next try is recognised as the same message and is not delivered a second time.
    // A caller that may send the same message again after a restart gives it a fixed key, so the provider recognises it.
    const idem = key || crypto.randomUUID();
    let lastErr;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const res = await queued(() => fetch(base + path, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idem },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        }));
        if (res.ok) return res;
        lastErr = new Error(`HTTP ${res.status}`);
        // 409: the provider is still working on an earlier try of this same message. Wait and ask again; it then
        // answers for that try. Treating it as refused could send the message a second time under a new key.
        if (res.status !== 429 && res.status !== 409 && res.status < 500) throw Object.assign(lastErr, { final: true }); // bad address etc.: don't retry
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : Math.min(1000 * 2 ** (attempt - 1), 15000);
        if (res.status === 429) pauseUntil = Math.max(pauseUntil, Date.now() + backoff); // everyone waits, not just this one
        else await sleep(backoff);
      } catch (err) {
        if (err.final) throw err;
        lastErr = err;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
      }
    }
    throw lastErr;
  }

  async function send(to, subject, text) {
    const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!enabled || !list.length) return false;
    const shown = list.map(mask).join(", ");
    try {
      await post("/emails", { from, to: list, subject, text });
      // Subjects often carry a patient's name and visit type, so they go to the admin's email log only, not stdout
      logger.info("email_sent", { to: shown });
      report({ ok: true, count: list.length, subject, to: shown });
      return true;
    } catch (err) {
      logger.warn("email_failed", { to: shown, error: err.message });
      report({ ok: false, count: list.length, subject, to: shown, error: err.message });
      return false;
    }
  }

  // One file to the owner's own address ONLY - not the extra alert addresses. Used for the weekly client export, whose
  // attachment (already encrypted) must not fan out to everyone who gets booking alerts. A large body needs longer than
  // the usual 15 seconds, so this does not go through post().
  const ownerAddress = String(ownerEmail || "").trim().toLowerCase();
  async function ownerFile(subject, text, file) {
    if (!enabled || !ownerAddress || !file || !file.content) return false;
    const shown = mask(ownerAddress);
    try {
      const res = await queued(() => fetch(base + "/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [ownerAddress], subject, text, attachments: [{ filename: file.filename, content: file.content }] }), signal: AbortSignal.timeout(120000) }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info("email_sent", { to: shown, attachment: true });
      report({ ok: true, count: 1, subject, to: shown });
      return true;
    } catch (err) {
      logger.warn("email_failed", { to: shown, error: err.message });
      report({ ok: false, count: 1, subject, to: shown, error: err.message });
      return false;
    }
  }

  // Many emails at once: [{ to, subject, text }] -> Set of addresses that were accepted.
  async function many(list) {
    const ok = new Set();
    if (!enabled) return ok;
    const items = list.filter((m) => m && m.to);
    for (let i = 0; i < items.length; i += BATCH_MAX) {
      const chunk = items.slice(i, i + BATCH_MAX);
      try {
        await post("/emails/batch", chunk.map((m) => ({ from, to: [m.to], subject: m.subject, text: m.text })));
        chunk.forEach((m) => ok.add(m.to));
        logger.info("email_batch_sent", { count: chunk.length });
        report({ ok: true, count: chunk.length, subject: chunk[0].subject, to: `${chunk.length} people` });
      } catch (err) {
        logger.warn("email_batch_failed", { count: chunk.length, error: err.message });
        // The batch endpoint refuses the whole batch if one address is malformed: nobody got it, so fall back to one
        // by one. Any other failure (no answer, the provider erroring after every try) may have reached everyone:
        // sending each again as a new message could deliver it twice, so those are reported as not sent instead.
        if (err.final) { for (const m of chunk) if (await send(m.to, m.subject, m.text)) ok.add(m.to); }
        else report({ ok: false, count: chunk.length, subject: chunk[0].subject, to: `${chunk.length} people`, error: err.message });
      }
    }
    return ok;
  }

  // An announcement to many people, each with their own copy (a personal unsubscribe link, so no two are the same):
  // [{ to, subject, text, html, headers, attachments, key }] -> Set of addresses that were accepted.
  // Without attachments it goes through the batch endpoint, like many(). With attachments it is one request per
  // person: the batch endpoint does not take them, and each request is given longer because it carries the photos.
  // key (per person) and group (for a batch) name the message at the provider, so a send picked up after a restart
  // does not deliver again what was already accepted. Subjects and bodies are never logged; onSent(address) is called
  // as each one is accepted, so progress can be kept.
  const STOP_AFTER = 5; // this many refused in a row means the provider is not taking them: stop, do not grind through everyone
  const shape = (m) => ({ from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.headers ? { headers: m.headers } : {}), ...(m.attachments && m.attachments.length ? { attachments: m.attachments } : {}) });
  async function campaign(list, { onSent = () => {}, group = "" } = {}) {
    const ok = new Set();
    if (!enabled) return ok;
    const items = list.filter((m) => m && m.to);
    const accepted = (m) => { ok.add(m.to); try { onSent(m.to); } catch {} };
    const one = async (m) => {
      try {
        await post("/emails", shape(m), m.attachments && m.attachments.length ? 60000 : 15000, m.key);
        accepted(m);
        return true;
      } catch (err) {
        logger.warn("email_failed", { to: mask(m.to), error: err.message });
        report({ ok: false, count: 1, subject: m.subject, to: mask(m.to), error: err.message });
        return false;
      }
    };
    const each = async (some) => {
      let sent = 0, missed = 0;
      for (let i = 0; i < some.length; i++) {
        if (await one(some[i])) { sent++; missed = 0; }
        else if (++missed >= STOP_AFTER) { logger.warn("email_campaign_stopped", { sent, left: some.length - i - 1 }); break; }
      }
      return sent;
    };
    if (items.some((m) => m.attachments && m.attachments.length)) {
      const sent = await each(items);
      if (sent) { logger.info("email_campaign_sent", { count: sent, attachments: true }); report({ ok: true, count: sent, subject: items[0].subject, to: `${sent} people` }); }
      return ok;
    }
    for (let i = 0; i < items.length; i += BATCH_MAX) {
      const chunk = items.slice(i, i + BATCH_MAX);
      try {
        const key = group ? `${group}-${crypto.createHash("sha256").update(chunk.map((m) => m.to).join("\n")).digest("hex").slice(0, 24)}` : undefined;
        await post("/emails/batch", chunk.map(shape), 15000, key);
        chunk.forEach(accepted);
        logger.info("email_batch_sent", { count: chunk.length });
        report({ ok: true, count: chunk.length, subject: chunk[0].subject, to: `${chunk.length} people` });
      } catch (err) {
        logger.warn("email_batch_failed", { count: chunk.length, error: err.message });
        // Same rule as many(): a refused batch reached nobody, so each is tried alone; any other failure may have
        // reached everyone, and sending again could deliver it twice.
        if (err.final) await each(chunk);
        else report({ ok: false, count: chunk.length, subject: chunk[0].subject, to: `${chunk.length} people`, error: err.message });
      }
    }
    return ok;
  }

  return {
    enabled,
    owners,
    ownerAddress, ownerFile,
    owner: (subject, text) => send(owners, subject, text),
    client: (to, subject, text) => send(to, subject, text),
    many, campaign
  };
}

module.exports = { createNotifier };
