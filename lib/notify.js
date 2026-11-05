// Optional email notifications through Resend (resend.com). Off unless RESEND_API_KEY and NOTIFY_FROM are set.
// Never throws: a failed email must not fail the booking that triggered it.
//
// Resend allows only a few requests per second (2/s by default) and answers 429 beyond that. So:
//  - every request is retried on 429 (and on 5xx / network errors), waiting as long as Resend asks (retry-after),
//  - many emails at once (a group message) go through the batch endpoint: up to 100 emails per request,
//    one request at a time, instead of one request per email.
const { logger, mask } = require("./logger");

const MAX_TRIES = 8;
const BATCH_MAX = 100; // Resend's per-request limit for /emails/batch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createNotifier({ apiKey, from, ownerEmail, apiUrl = "https://api.resend.com", minGapMs = 600 }) {
  const enabled = Boolean(apiKey && from);
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

  async function post(path, body) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const res = await queued(() => fetch(base + path, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000)
        }));
        if (res.ok) return res;
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status !== 429 && res.status < 500) throw Object.assign(lastErr, { final: true }); // bad address etc.: don't retry
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
    if (!enabled || !to) return false;
    try {
      await post("/emails", { from, to: [to], subject, text });
      logger.info("email_sent", { to: mask(to), subject });
      return true;
    } catch (err) {
      logger.warn("email_failed", { to: mask(to), subject, error: err.message });
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
        logger.info("email_batch_sent", { count: chunk.length, subject: chunk[0].subject });
      } catch (err) {
        // The batch endpoint refuses the whole batch if one address is malformed: fall back to one by one
        logger.warn("email_batch_failed", { count: chunk.length, error: err.message });
        for (const m of chunk) if (await send(m.to, m.subject, m.text)) ok.add(m.to);
      }
    }
    return ok;
  }

  return {
    enabled,
    owner: (subject, text) => send(ownerEmail, subject, text),
    client: (to, subject, text) => send(to, subject, text),
    many
  };
}

module.exports = { createNotifier };
