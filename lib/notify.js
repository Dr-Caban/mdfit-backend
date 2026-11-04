// Optional email notifications through Resend (resend.com). Off unless RESEND_API_KEY and NOTIFY_FROM are set.
// Never throws: a failed email must not fail the booking that triggered it.
const { logger, mask } = require("./logger");

function createNotifier({ apiKey, from, ownerEmail, apiUrl = "https://api.resend.com" }) {
  const enabled = Boolean(apiKey && from);
  async function send(to, subject, text) {
    if (!enabled || !to) return false;
    try {
      const res = await fetch(apiUrl.replace(/\/+$/, "") + "/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info("email_sent", { to: mask(to), subject });
      return true;
    } catch (err) {
      logger.warn("email_failed", { to: mask(to), subject, error: err.message });
      return false;
    }
  }
  return {
    enabled,
    owner: (subject, text) => send(ownerEmail, subject, text),
    client: (to, subject, text) => send(to, subject, text)
  };
}

module.exports = { createNotifier };
