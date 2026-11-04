// Google Places: MD Fit's live Google rating, review count and recent reviews.
// Tries Places API (New) first and falls back to the legacy Places API when the key's Google Cloud
// project only has the legacy one enabled. The key lives only in GOOGLE_PLACES_API_KEY on Railway.
class GoogleError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Google's "this API isn't enabled for your project" answers
const notEnabled = (err) => err instanceof GoogleError && (err.status === 403 || err.status === "REQUEST_DENIED") &&
  /not been used|disabled|not authorized to use this API|legacy API/i.test(err.message);

function createPlaces({ apiKey, baseUrl = "https://places.googleapis.com/v1", legacyUrl = "https://maps.googleapis.com/maps/api/place", fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, ""), legacyBase = legacyUrl.replace(/\/+$/, "");
  let mode = "new";

  async function request(url, init) {
    if (!apiKey) throw new GoogleError("GOOGLE_PLACES_API_KEY is not set on the server.");
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }); }
    catch (err) { throw new GoogleError(`Couldn't reach Google (${err.message}).`); }
    return { res, data: await res.json().catch(() => ({})) };
  }

  // ---- Places API (New)
  async function callNew(method, path, fieldMask, body) {
    const { res, data } = await request(base + path, {
      method,
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fieldMask, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new GoogleError(`Google error ${res.status}: ${data?.error?.message || "request failed"}`, res.status);
    return data;
  }
  const newApi = {
    async findPlaceId(query) {
      const d = await callNew("POST", "/places:searchText", "places.id,places.displayName,places.formattedAddress", { textQuery: query, maxResultCount: 1 });
      const p = d.places && d.places[0];
      if (!p) throw new GoogleError(`Google found no place for "${query}".`);
      return { id: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "" };
    },
    async details(placeId) {
      const d = await callNew("GET", `/places/${encodeURIComponent(placeId)}`, "id,displayName,rating,userRatingCount,googleMapsUri,reviews");
      return {
        placeId: d.id, name: d.displayName?.text || "",
        rating: typeof d.rating === "number" ? d.rating : null, count: d.userRatingCount || 0, url: d.googleMapsUri || "",
        reviews: (d.reviews || []).map((r) => ({
          author: r.authorAttribution?.displayName || "Google user",
          authorUrl: r.authorAttribution?.uri || "",
          photo: r.authorAttribution?.photoUri || "",
          rating: r.rating || 0,
          text: r.text?.text || r.originalText?.text || "",
          relativeTime: r.relativePublishTimeDescription || "",
          publishTime: r.publishTime || ""
        }))
      };
    }
  };

  // ---- Legacy Places API
  async function callLegacy(path, params) {
    const qs = new URLSearchParams({ ...params, key: apiKey });
    const { res, data } = await request(`${legacyBase}${path}?${qs}`, { method: "GET" });
    if (!res.ok) throw new GoogleError(`Google error ${res.status}: ${data?.error_message || "request failed"}`, res.status);
    if (data.status !== "OK") throw new GoogleError(`Google error ${data.status}: ${data.error_message || "no result"}`, data.status);
    return data;
  }
  const legacyApi = {
    async findPlaceId(query) {
      const d = await callLegacy("/findplacefromtext/json", { input: query, inputtype: "textquery", fields: "place_id,name,formatted_address" });
      const p = d.candidates && d.candidates[0];
      if (!p) throw new GoogleError(`Google found no place for "${query}".`);
      return { id: p.place_id, name: p.name || "", address: p.formatted_address || "" };
    },
    async details(placeId) {
      const d = await callLegacy("/details/json", { place_id: placeId, fields: "place_id,name,rating,user_ratings_total,url,reviews", reviews_sort: "most_relevant" });
      const r = d.result || {};
      return {
        placeId: r.place_id || placeId, name: r.name || "",
        rating: typeof r.rating === "number" ? r.rating : null, count: r.user_ratings_total || 0, url: r.url || "",
        reviews: (r.reviews || []).map((x) => ({
          author: x.author_name || "Google user",
          authorUrl: x.author_url || "",
          photo: x.profile_photo_url || "",
          rating: x.rating || 0,
          text: x.text || "",
          relativeTime: x.relative_time_description || "",
          publishTime: x.time ? new Date(x.time * 1000).toISOString() : ""
        }))
      };
    }
  };

  async function run(name, ...args) {
    if (mode === "new") {
      try { return await newApi[name](...args); }
      catch (err) {
        if (!notEnabled(err)) throw err;
        mode = "legacy"; // remember: this key's project only has the legacy API
      }
    }
    return legacyApi[name](...args);
  }

  return {
    enabled: Boolean(apiKey),
    get mode() { return mode; },
    findPlaceId: (query) => run("findPlaceId", query),
    details: async (placeId) => {
      const d = await run("details", placeId);
      return { ...d, reviews: d.reviews.filter((r) => r.text) };
    }
  };
}

module.exports = { createPlaces, GoogleError };
