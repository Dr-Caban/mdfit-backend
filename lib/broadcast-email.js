// A broadcast that goes straight to email (owner, Nov 2026): the message itself, with photos, in each person's inbox.
// This is separate from the "a message is waiting" notice, which never carries the message.
//
// What keeps it safe to send to many people:
//  - one email per person, addressed to that person only, so nobody sees who else received it
//  - every email carries a personal unsubscribe link (and the one-click header mail apps use); people who used it,
//    and people with no email on file, are skipped and counted
//  - photos are checked by their first bytes (JPEG or PNG only) and travel inside the email; none is kept afterwards
//  - the text is escaped before it becomes HTML; the subject is one line
// It is for announcements. A person's health details do not belong in it: the composer says so.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

const MAX_PHOTOS = 4;
const MIN_RECIPIENTS = 2;                 // an email to one person is a private letter, not a broadcast
const MAX_PHOTO_BYTES = 1500 * 1024;      // each photo, after the workspace has made it smaller
const MAX_SUBJECT = 120;
const MAX_EMAIL_BODY = 5000;
const STAGED_MINUTES = 60;                // a photo added to the composer waits this long to be sent
const STAGED_MAX = 48;                    // across everyone composing at once; the oldest is dropped first
const STAGED_EACH = 8;                    // per person, so one person adding photos cannot push out someone else's

const fail = (msg) => { throw new ValidationError(msg); };

// The type is read from the file's own first bytes, never from what the browser says it is.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

// One line, no control characters: a subject can never add a header to the email.
function subjectOf(v) {
  const s = (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) fail("Give the email a subject.");
  if (s.length > MAX_SUBJECT) fail(`The subject can be up to ${MAX_SUBJECT} characters.`);
  return s;
}

function emailBodyOf(v) {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
  if (!s) fail("Type a message first.");
  if (s.length > MAX_EMAIL_BODY) fail(`An email can be up to ${MAX_EMAIL_BODY} characters.`);
  return s;
}

// ---- Unsubscribe links: a signature over the account id, made from the server's secret. Nothing to look up, nothing
// to expire (a link in an old email must keep working), and it cannot be guessed for another account.
const unsubKey = (secret) => crypto.createHmac("sha256", String(secret || "mdfit-dev-fallback-key")).update("mdfit-broadcast-unsubscribe-v1").digest();
const unsubToken = (secret, clientId) => crypto.createHmac("sha256", unsubKey(secret)).update(String(clientId)).digest("base64url").slice(0, 32);
function unsubOk(secret, clientId, token) {
  if (typeof clientId !== "string" || typeof token !== "string" || !clientId || token.length !== 32) return false;
  const want = Buffer.from(unsubToken(secret, clientId)), got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---- The email itself
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Links typed in the message become links; everything else stays text. Only http(s), and the address is escaped.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
function linkify(line) {
  let out = "", last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(line))) {
    out += esc(line.slice(last, m.index)) + `<a href="${esc(m[0])}" style="color:#1f5fa8;text-decoration:underline;">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}
const paragraphs = (body) => body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

const LINK_NOTE = "Each person's copy ends with their own unsubscribe link.";
// photos: [{ cid }] in the order they were added. clinic: { name, address, phone }.
function buildEmail({ firstName, body, photos = [], clinic = {}, unsubscribeUrl, test = false }) {
  const name = clinic.name || "MD Fit", hi = `Hi ${firstName || "there"},`;
  const foot = [name, clinic.address, clinic.phone].filter(Boolean);
  const why = `You are getting this because you are a client of ${name} or have an account with us.`;
  const lines = [];
  if (test) lines.push("[TEST: only you received this]", "");
  lines.push(hi, "", body, "");
  if (photos.length) lines.push(`(${photos.length} ${photos.length === 1 ? "photo is" : "photos are"} attached.)`, "");
  lines.push("--", foot.join(" · "), why);
  if (unsubscribeUrl) lines.push(`Stop these announcement emails: ${unsubscribeUrl}`);
  else if (test) lines.push(LINK_NOTE);
  const text = lines.join("\n");
  // The standard newsletter layout: tables, widths as attributes, every style written on the element itself, plain
  // web-safe fonts. That is the common ground of Gmail, Yahoo and AOL, Outlook (which draws email with Word and
  // ignores max-width, hence the fixed 600 table it alone is given), Apple Mail and the phone mail apps.
  const FONT = "font-family:Arial,Helvetica,sans-serif;";
  const P = 'style="margin:0 0 14px 0;"';
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>${esc(name)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f7;">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f3f5f7" style="background-color:#f3f5f7;">
<tr><td align="center" style="padding:24px 12px 24px 12px;">
<!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600"><tr><td><![endif]-->
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;">
<tr><td align="left" style="padding:22px 28px 6px 28px;${FONT}font-size:20px;line-height:24px;mso-line-height-rule:exactly;font-weight:bold;color:#1f3a5f;">${esc(name)}</td></tr>
${test ? `<tr><td align="left" style="padding:6px 28px 0 28px;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td bgcolor="#fbf3e2" style="padding:8px 12px 8px 12px;background-color:#fbf3e2;${FONT}font-size:13px;line-height:18px;color:#7a4b00;">Test: only you received this.</td></tr></table></td></tr>` : ""}
<tr><td align="left" style="padding:16px 28px 6px 28px;${FONT}font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:#1a1a1a;">
<p ${P}>${esc(hi)}</p>
${paragraphs(body).map((p) => `<p ${P}>${p.split("\n").map(linkify).join("<br />")}</p>`).join("\n")}
${photos.map((p, i) => `<p ${P}><img src="cid:${esc(p.cid)}" alt="Photo ${i + 1}" width="544" border="0" style="display:block;width:100%;max-width:544px;height:auto;border:0;" /></p>`).join("\n")}
</td></tr>
<tr><td align="left" style="padding:14px 28px 22px 28px;border-top:1px solid #e3e8ee;${FONT}font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:#5b6b7c;">
${esc(foot.join(" · "))}<br />${esc(why)}${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:#5b6b7c;text-decoration:underline;">Unsubscribe from announcements</a>.` : test ? ` ${esc(LINK_NOTE)}` : ""}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  return { html, text };
}

// ---- Photos waiting in the composer. Held in memory only: a restart (a deploy) forgets them and the composer asks
// for them again, and nothing a member did not receive is left on disk.
function createStaging({ now = () => Date.now(), minutes = STAGED_MINUTES, max = STAGED_MAX } = {}) {
  const held = new Map(); // id -> { buf, type, by, at }
  const sweep = () => { const t = now(); for (const [k, v] of held) if (t - v.at > minutes * 60000) held.delete(k); };
  return {
    add(buf, by) {
      const type = sniffImage(buf);
      if (!type) fail("Photos must be JPG or PNG.");
      if (buf.length > MAX_PHOTO_BYTES) fail("That photo is too large. The workspace makes photos smaller before sending; try adding it again.");
      sweep();
      const me = String(by || ""), mine = [...held].filter(([, v]) => v.by === me).map(([k]) => k);
      while (mine.length >= STAGED_EACH) held.delete(mine.shift());
      while (held.size >= max) held.delete(held.keys().next().value);
      const id = crypto.randomBytes(9).toString("hex");
      held.set(id, { buf, type, by: String(by || ""), at: now() });
      return { id, type, bytes: buf.length };
    },
    // Only the person who added a photo can send or remove it.
    take(ids, by) {
      sweep();
      const list = Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === "string"))] : [];
      if (list.length > MAX_PHOTOS) fail(`An email can carry up to ${MAX_PHOTOS} photos.`);
      return list.map((id) => {
        const p = held.get(id);
        if (!p || p.by !== String(by || "")) fail("A photo is no longer waiting (they are held for an hour). Add the photos again.");
        return { id, buf: p.buf, type: p.type };
      });
    },
    drop(ids, by) { (Array.isArray(ids) ? ids : [ids]).forEach((id) => { const p = held.get(id); if (p && p.by === String(by || "")) held.delete(id); }); },
    size: () => held.size
  };
}

module.exports = { MIN_RECIPIENTS, MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_SUBJECT, MAX_EMAIL_BODY, sniffImage, subjectOf, emailBodyOf, unsubToken, unsubOk, buildEmail, createStaging, esc };
