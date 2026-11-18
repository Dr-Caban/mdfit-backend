// Business notifications: revenue-share payouts and payment notices, partner registrations, payments that need
// classifying, and affiliate payout failures. They go to BUSINESS_EMAILS (comma separated) when it is set, otherwise
// to the owner's usual alert address. They carry amounts, products and partner names only, never a patient's name or
// contact details, so they can go to an address with no business associate agreement.
"use strict";
function createBusinessNotify({ cfg, notify, logger }) {
  const list = () => String(cfg.businessEmails !== undefined ? cfg.businessEmails || "" : process.env.BUSINESS_EMAILS || "")
    .toLowerCase().split(/[\s,;]+/).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return function business(subject, text) {
    try {
      if (!notify) return;
      const to = list();
      const body = `${text}\n\nMD Fit Online · business notification`;
      if (to.length && notify.client) { for (const e of to) notify.client(e, subject, body); }
      else if (notify.owner) notify.owner(subject, body);
    } catch (e) { logger && logger.warn && logger.warn("business_notify_failed", { error: e.message }); }
  };
}
module.exports = { createBusinessNotify };
