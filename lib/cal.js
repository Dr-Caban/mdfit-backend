// Cal.com API v2 client + webhook helpers. The API key lives only in the CAL_API_KEY env var on Railway.
// Docs: https://cal.com/docs/api-reference/v2
const crypto = require("crypto");

const EVENT_TYPES_VERSION = "2024-06-14";
const BOOKINGS_VERSION = "2024-08-13";

class CalError extends Error {}

function createCal({ apiKey, apiUrl = "https://api.cal.com/v2", fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, "");
  async function call(method, path, { version, body } = {}) {
    if (!apiKey) throw new CalError("Cal.com isn't connected (CAL_API_KEY is not set on the server).");
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(version ? { "cal-api-version": version } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
    } catch (err) {
      throw new CalError(`Couldn't reach Cal.com (${err.message}).`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new CalError("Cal.com rejected the API key. Create a new key in Cal.com → Settings → Developer → API keys.");
    if (!res.ok) throw new CalError(`Cal.com error ${res.status}: ${data?.error?.message || data?.message || "request failed"}`);
    return data.data ?? data;
  }

  return {
    enabled: Boolean(apiKey),
    me: () => call("GET", "/me"),
    eventTypes: (username) => call("GET", `/event-types${username ? `?username=${encodeURIComponent(username)}` : ""}`, { version: EVENT_TYPES_VERSION }),
    bookings: (status = "upcoming") => call("GET", `/bookings?status=${status}&take=100`, { version: BOOKINGS_VERSION }),
    cancel: (uid, reason) => call("POST", `/bookings/${encodeURIComponent(uid)}/cancel`, { version: BOOKINGS_VERSION, body: { cancellationReason: reason } })
  };
}

// Cal signs webhook bodies: X-Cal-Signature-256 = hex HMAC-SHA256(secret, raw body)
function verifySignature(rawBody, signature, secret) {
  if (!secret || !rawBody || typeof signature !== "string") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature.trim().toLowerCase()), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Webhook "responses" values come as { value } objects or plain strings depending on the field.
const answer = (r, key) => {
  const v = r && r[key];
  return v && typeof v === "object" && "value" in v ? v.value : v;
};

// Normalise a booking from either the API (start/end) or a webhook payload (startTime/endTime).
function normaliseBooking(b) {
  const r = b.responses || b.bookingFieldsResponses || {};
  const attendee = (b.attendees && b.attendees[0]) || {};
  const start = b.start || b.startTime, end = b.end || b.endTime;
  return {
    uid: String(b.uid || b.id || ""),
    title: b.title || b.eventTitle || b.type || "Appointment",
    eventSlug: b.eventType?.slug || b.type || "",
    start, end,
    minutes: start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 60000) : Number(b.duration || b.length || 0),
    name: String(answer(r, "name") || attendee.name || ""),
    email: String(answer(r, "email") || attendee.email || "").toLowerCase(),
    phone: String(answer(r, "attendeePhoneNumber") || attendee.phoneNumber || answer(r, "phone") || ""),
    notes: String(answer(r, "notes") || b.additionalNotes || b.description || ""),
    status: String(b.status || "").toLowerCase()
  };
}

module.exports = { createCal, verifySignature, normaliseBooking, CalError };
