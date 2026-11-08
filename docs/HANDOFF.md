# MD Fit — Engineering Hand-off & Native App Transition

**Practice:** MD Fit, Dr. Jared Caban, Sarasota FL · **Live site:** https://www.mymdfit.com
**Repos:** `Dr-Caban/mdfit-frontend` (Vercel) · `Dr-Caban/mdfit-backend` (Railway)
**Document date:** 2026-11-07 · frontend `b8f85c7` · backend `3168baf`

This document is the single source for a new team taking over: every page, endpoint, encryption layer, bot protection, auth layer, data record and content path, plus the plan for the iOS (Swift) and Android apps and store publishing. Part A is the transition plan; Parts B and C are the exact inventories of what exists today.

> **Secrets are never in this document.** Every environment variable is named with its purpose only. Values live in Railway (backend) and Vercel (frontend) and are handed over by the owner through those dashboards, never in chat, email or git.

---

## Contents

- **Part A — Transition plan** (above): architecture, iOS/Android build plans, server additions, content migration, store publishing, HIPAA vendors, open decisions, access hand-off.
- **Part B — Backend inventory**: runtime & env vars, request pipeline (edge gate, bot filter, rate limits, headers), auth layers, encryption/PHI/audit, all 169 endpoints, realtime events, data records & migrations, business rules, timers, tests.
- **Part C — Frontend inventory**: hosting/CSP/service worker, all 76 pages with their API calls (155 unique), member app internals, admin internals, public site, content & asset paths, design tokens, third-party domains, testing.
- **Part D — Known gaps found while writing this** (end of document).

---

## Part A — Transition plan

### A1. What the native apps are for

The member app at `/account` is already an API-driven single-page app: every screen reads and writes through `https://www.mymdfit.com/api/*` (which the Vercel edge proxies to Railway) with a Bearer token. The native apps are therefore **thin clients over the same API**. Nothing on the server changes shape for them; only three server-side additions are needed (A4).

| Surface | Today | Native plan |
|---|---|---|
| Public site + booking (`/`, `/book`) | Static Vercel pages, Cal.com embed, Stripe embedded checkout | Stays web. Apps deep-link to it for booking. |
| Member app (`/account`) | SPA, 12 tabs | **iOS + Android apps** (this project) |
| Admin (`/admin`) | SPA, owner-only | Stays web (phone-friendly already). Not in the apps. |
| Intake documents (`/intake`) | Web form, token or signed-in | In-app WebView of `/intake?me=1` with the member token injected (A5) |

### A2. Architecture (both platforms)

```
┌─────────────┐     HTTPS (Bearer token)      ┌───────────────┐      ┌─────────────┐
│ iOS / Andr. │ ───────────────────────────▶  │ Vercel edge   │ ───▶ │ Railway API │
│ app         │ ◀── socket.io (realtime) ──── │ (bot filter)  │      │ Express     │
└─────────────┘                               └───────────────┘      └─────────────┘
       │  Stripe SDK (PaymentSheet)                                    │  JSON store on
       │  Google Sign-In SDK                                           │  Railway volume
       │  Drive/Cloudinary video URLs (AVPlayer / ExoPlayer)           │  + encrypted PHI
```

- **Base URL:** `https://www.mymdfit.com` (same origin as the site; the edge adds the `EDGE_SECRET` header and drops bots). Do **not** call the Railway hostname directly from apps except for socket.io (`realtimeUrl`, see frontend inventory); keep that behind a config value so it can be moved behind the edge later.
- **Auth:** `POST /api/clients/login` → `{ token, expiresAt, client }`. Token is an HMAC-SHA256 signed payload `{ sub: clientId, role: "client", pwv, exp }`, **30-day TTL** (`SESSION_DAYS = 30`). Store in Keychain (iOS) / EncryptedSharedPreferences (Android). Send as `Authorization: Bearer <token>`. A 401 means re-login (password change bumps `pwv` and invalidates old tokens).
- **Google sign-in:** the web uses Google Identity Services with `GOOGLE_CLIENT_ID`. Native apps use the Google Sign-In SDKs and POST the ID token to the existing Google endpoint (see B-endpoints). Add the iOS/Android client IDs to the same Google Cloud project; the backend must accept all three audiences (A4-2).
- **Realtime:** socket.io client, member namespace, token in the handshake (see B6). Used for new messages, reactions, rewards toasts, online counts. Optional for v1; polling `/api/me/messages/unread-count` is acceptable.
- **Payments:** Stripe. Server creates Checkout Sessions with `ui_mode: "embedded_page"`. For native, add a **PaymentSheet** path (A4-3) or open the hosted Checkout URL in `SFSafariViewController` / Chrome Custom Tabs (the `url` branch already exists when `ui` is not `embedded`). Fulfilment is webhook-driven, so either works.
- **Video:** exercise videos are Google Drive files (ids in `app/exercises.js`), thumbnails from `lh3.googleusercontent.com/d/<id>=w<width>`, some on Cloudinary. Drive direct MP4 is unreliable (CORP/virus-scan page); the web falls back to Drive's iframe player. **For native, migrate all exercise videos to Cloudinary (or Mux) first** — this is the single biggest content task (A6).

### A3. iOS (Swift) build plan

| Item | Decision |
|---|---|
| Min target | iOS 16, SwiftUI, Swift 5.10 |
| Networking | `URLSession` + `Codable` models generated from Part B schemas; one `APIClient` with token injection + 401 handling |
| Storage | Keychain (token), `UserDefaults` for prefs that mirror `mdfit_prefs3` / `mdfit.player.v2`; no PHI on disk beyond the OS-protected cache |
| Realtime | `socket.io-client-swift` (optional v1) |
| Video | `AVPlayer` with HLS/MP4 from Cloudinary; `AVPictureInPictureController` off (no PHI, but keep UX focused) |
| Payments | `StripePaymentSheet` (needs A4-3) or `SFSafariViewController` on the hosted URL |
| Auth | Sign in with email/password; **Sign in with Apple is required by App Store rule 4.8 if Google sign-in is offered** → add Apple sign-in (A4-2) |
| Health | Optional `HealthKit` read for workouts/HR → `POST /api/me/workouts` metrics fields (`hrAvg`, `hrMax`, `calories`); HealthKit data must never be sent to analytics (App Review rule) |
| Push | APNs via a small push service (A4-4); payloads contain **no PHI** ("New message from Dr. Jared", never the text) |
| Deep links | Universal Links for `mymdfit.com/account#...` → `apple-app-site-association` on Vercel |
| Screens (map 1:1 to web tabs) | Home (gem card, daily activities, today's workout, From Dr. Jared, challenges), Workout (generator + builder + my workouts), Programs, Videos, Pain tool, Learn, Progress (one calendar), Leaders, Membership, Messages, Tips, Profile |

### A4. Server additions needed for native (small, backend repo)

1. **Bot filter / user agent:** CORS is not an issue (it only adds headers when a browser sends `Origin`). The blocker is the bot filter (`lib/security.js` `BAD_UA` list and the Vercel edge middleware): an empty UA, or one matching curl/wget/python-requests/axios/node-fetch/postman/headless/etc., gets 403 "Automated access isn't allowed." (B2 step 6). Native clients must set an explicit UA such as `MDFit-iOS/1.0 (iPhone; iOS 18)` / `MDFit-Android/1.0` — these are not on the list, so no server change is strictly required, but add an explicit allow for the `MDFit-` prefix in both the backend regex and the edge so a future list change can't break the apps. Also keep the edge path: apps call `www.mymdfit.com`, never the Railway host, because `EDGE_SECRET` gating returns 403 to direct calls.
2. **Google + Apple sign-in audiences:** accept iOS/Android Google client IDs; add `POST /api/clients/apple` verifying Apple identity tokens (JWKS at `https://appleid.apple.com/auth/keys`), creating/linking the client by email like the Google route does.
3. **Stripe PaymentSheet:** `POST /api/me/checkout/native` returning `{ customer, ephemeralKey, paymentIntent|setupIntent, publishableKey }` for memberships (subscription) and services (one-time). Fulfilment stays on the existing webhooks (`checkout.session.completed` won't fire; handle `invoice.paid` / `payment_intent.succeeded` with the same metadata keys).
4. **Push tokens:** `PUT/DELETE /api/me/push-token` storing `{ platform, token }` on the client record; send on `new_message`, consult scheduled, assigned program, challenge received. Use APNs + FCM directly (no third-party push vendor without a BAA).
5. **App version gate:** `GET /api/app/config` already exists; add `minAppVersion` so old builds can be told to update.

### A5. Android build plan

| Item | Decision |
|---|---|
| Min target | Android 8 (API 26), Kotlin, Jetpack Compose |
| Networking | Retrofit + OkHttp + Moshi; same `APIClient` contract as iOS |
| Storage | EncryptedSharedPreferences (token), DataStore for prefs |
| Video | ExoPlayer (Media3) |
| Payments | Stripe Android `PaymentSheet` or Chrome Custom Tabs on the hosted URL |
| Auth | Email/password, Google Sign-In (Credential Manager); Apple sign-in not required on Android |
| Push | FCM |
| Health | Health Connect (optional) |
| Deep links | App Links with `assetlinks.json` on Vercel |

### A6. Content migration checklist (before either app ships)

- [x] Exercise videos are on Cloudinary (278 of 279 assets as of Nov 8 2026; the sync runs 30 s after API start and every 6 h from `/data/media-manifest.json`, built by `scripts/build-media-manifest.js`). Drive files that aren't public are fetched through the Drive API as the service account: share the Drive folder with the account email shown in Admin → Home → Hours & sync (also `GET /api/admin/videos/status` → `driveAccount`). The app's map is `MDFitVideo.onCdn` (`GET /api/videos`).
- [ ] Re-upload the 0-byte plantar fasciitis videos; add the Drive videos not yet in the library (Cable Row, Walking Lunge, Dead Bug, Wall Posture, Deep Squat Hold, Scalene Release, GOSD intro); film single-leg RDL and wall sit.
- [ ] Resolve poster conflicts noted in the Tips articles (ice bath frequency, movement reset length, health-shot ratios, "ErG").
- [ ] Decide elbow program naming (tennis = extensors / golfer's = flexors) and supply the missing Golf week 4 and Pickleball Advanced week 5 sheets.
- [ ] Owner sets the Video visit (telehealth) room link in Admin → Home → Hours & sync.

### A7. Store publishing

**Apple App Store**
- Apple Developer Program (organization: MD Fit LLC — D-U-N-S required), App Store Connect app record, bundle id `com.mymdfit.app`.
- Category Health & Fitness. Because the app handles health data: Privacy Nutrition Labels (Health & Fitness, Contact Info, Identifiers, Usage Data, Purchases), a hosted Privacy Policy URL (`https://www.mymdfit.com/privacy` — create this page), and HealthKit usage strings if used.
- Rule 3.1.1: memberships and digital content bought in-app must use **In-App Purchase** unless the purchase is for *services consumed outside the app*. Telehealth visits, in-person protocols and 1-on-1 sessions qualify as real-world services (Stripe allowed, rule 3.1.3(e)). The $19.95 Accountability Membership unlocks digital programs/lectures → **this one needs StoreKit IAP on iOS** (or remove the purchase button on iOS and keep web purchase + "manage on the web" with no link, per 3.1.3(b)). Decide before submission.
- Sign in with Apple (rule 4.8) because Google sign-in is offered.
- TestFlight: internal testers (owner + staff), then external beta.
- Assets: 1024px icon, screenshots 6.7" and 6.5" (iPhone) and 12.9" (iPad only if iPad supported; recommend iPhone-only at first), app preview optional.
- Review notes: a demo member account (seeded via `/api/clients/signup` on production with a clearly fake name) and the note that admin features are web-only.

**Google Play**
- Play Console developer account (organization; D-U-N-S also required for orgs since 2024), app `com.mymdfit.app`.
- Data safety form (health & fitness, personal info, financial via Stripe, device IDs), Privacy Policy URL, Health apps declaration (fitness/wellness category; no "medical device" claims).
- Billing policy: same split as Apple — real-world services via Stripe allowed; digital membership must use Google Play Billing.
- Internal testing → closed testing (20 testers for 14 days is required for new personal accounts; org accounts are exempt) → production.
- Target API level: current year's requirement (API 35 as of 2026).
- Assets: 512px icon, feature graphic 1024×500, phone screenshots.

**Both:** Terms of Use, Privacy Policy and a HIPAA Notice of Privacy Practices page on the site; the Privacy Policy must name the vendors in A8.

### A8. HIPAA / vendor posture (carry into the apps)

| Vendor | Use | BAA status (owner to confirm) |
|---|---|---|
| Railway | API + encrypted JSON store on the service volume (`DATA_DIR`) | Needs BAA. Note: a `MONGODB_URI` variable exists in Railway but **nothing in the code reads it** — the store is JSON files only. A BAA-covered database is a future migration, not a switch. |
| Vercel | Static site + edge proxy (no PHI stored) | Pass-through only; confirm |
| Resend | Transactional email — **no PHI in bodies** by design | Confirm |
| Stripe | Payments (product names describe service + visit count only) | Stripe signs BAAs on request |
| Cal.com | Booking + telehealth links | Cal.com offers a BAA (owner screenshot 2026-11-06) |
| Google Workspace (Calendar service account) | Busy times only (free/busy) | Covered by Workspace BAA |
| Google Drive / lh3 | Exercise videos (not PHI) | n/a |
| Cloudinary | Exercise videos (not PHI) | n/a |
| Apple / Google push | Notification text only, no PHI | n/a |
| SimplePractice | ICS busy feed (times only) | Already HIPAA-covered |

Rules already enforced in code and to keep in the apps: no PHI in logs (emails masked), no PHI in analytics, no PHI in emails or push, PHI fields encrypted at rest (B4), audit ledger for admin reads of intake answers, owner-only admin.

### A9. Open decisions for the owner

1. iOS membership purchase: StoreKit IAP vs. web-only purchase.
2. Push notifications in v1, or email only.
3. Realtime chat in v1 (socket.io) or polling.
4. Keep Drive as the video source for a bit longer (web only) or block the app release on the Cloudinary migration (recommended: migrate first).
5. iPad support (recommend iPhone-only for v1).

### A10. Hand-off checklist (access to transfer)

- GitHub org `Dr-Caban`: both repos (admin).
- Railway project `a5871163-…` (service `bf11cde9-…`, env `production`): variables, volume, deploy settings (auto-deploy from GitHub is **off** — deploys are triggered manually; turn it on in Railway → Service → Settings → Source).
- Vercel project `mdfit-frontend` (team `md-fit`): domains, env, analytics.
- Stripe, Resend, Cal.com, Google Cloud project (service account `mdfit-calendar@…`, OAuth client, Places key — the Places key was once exposed in chat and should be rotated), Cloudinary, SimplePractice ICS link.
- Apple Developer + Google Play accounts (new).

---

# Part B — Backend inventory


Repo: `/home/user/dr-caban/mdfit-backend` (package name `mdfit-srq-api`, v1.0.0). Read-only inventory taken from the code on 2026-11-07 (git HEAD `3168baf`, branch `release/nov7` merges).

Entry point `server.js` (1,283 lines) builds an Express 5 app via `createApp(cfg)`; `lib/*.js` modules "mount" routes onto three routers (`app` public, `admin` → `/api/admin`, `me` → `/api/me`). All persistence is a JSON-file store (`lib/store.js`) in `DATA_DIR`. **There is no MongoDB and no `lib/db.js`**: `grep -ri mongo` over the repo (excluding node_modules) returns nothing.

---

## 1. Runtime & deploy

| Item | Value (from code) |
|---|---|
| Node | `package.json` `engines.node: ">=20"`; container here runs v22.23.4. No `.nvmrc`. |
| Start | `npm start` → `node server.js`. Listens on `Number(process.env.PORT) \|\| 3000`. |
| Railway | `railway.json`: `startCommand: "npm start"`, `healthcheckPath: "/api/health"`, `restartPolicyType: "ON_FAILURE"`. Comment in `server.js:2`: "Deploy on Railway with Root Directory = mdfit-srq/backend". `lib/store.js:2`: "On Railway, DATA_DIR must be a mounted Volume (/data)". |
| Dependencies | `express ^5.3.0`, `socket.io ^4.8.4`, `stripe ^23.1.0`, `ffmpeg-static ^5.3.0` (video compression only). No ORM, no helmet, no express-rate-limit (all hand-rolled). |
| Scripts | `npm test` → `node --test --test-concurrency=1 test/*.test.js`; `npm run hash-password -- '<pw>'` → `scripts/hash-password.js` prints an `ADMIN_PASSWORD_HASH` (min 8 chars). |
| Health | `GET /api/health` → `{ ok: true }`; `GET /` → `{ name: "MD Fit API", ok: true }`. Both exempt from edge gate, bot filter and global rate limits. |
| Trust proxy | `app.set("trust proxy", 1)`; `app.disable("x-powered-by")`. |
| Time zone | All "clinic dates" (`YYYY-MM-DD`) and times (`HH:MM`) are computed in `cfg.tz` (`TZ_NAME`, default `America/New_York`) via `nowParts()` / `zonedToUtc()` in `server.js`. |

### Environment variables (every `process.env` read; values never shown)

Read via `env(k, default)` in `loadConfig()` (`server.js:34-69`) unless noted. "Req" = server refuses related feature without it.

| Variable | Purpose | Req | Used in |
|---|---|---|---|
| `PORT` | HTTP port (default 3000) | opt | `server.js:1273` |
| `ADMIN_EMAIL` | Admin login identity (lower-cased); admin token `sub` must equal it | **yes** for admin | `server.js`, `lib/realtime.js` |
| `ADMIN_PASSWORD_HASH` | scrypt hash string from `npm run hash-password` | **yes** for admin | `server.js` (`authReady`) |
| `SESSION_SECRET` | HMAC key for all tokens (admin, client, reset); must be ≥32 chars or admin/client auth returns 503; also fallback encryption secret, IP-hash salt for audit, MFA code hash salt | **yes** | `server.js`, `lib/clients.js`, `lib/messages.js`, `lib/intake.js`, `lib/feedback-reports.js`, `lib/audit.js`, `lib/realtime.js` |
| `DATA_DIR` | JSON store directory (default `<repo>/data`); Railway volume | opt (prod: yes) | `lib/store.js` |
| `DATA_ENC_KEY` | Whole-file AES-256-GCM encryption of every store file | opt (strongly recommended) | `lib/store.js` |
| `MESSAGE_ENC_KEY` | Field-level cipher key (messages, PHI fields, intake, feedback reports); falls back to `SESSION_SECRET` | opt | `server.js:127`, `lib/messages.js:49`, `lib/intake.js:201`, `lib/feedback-reports.js:22` |
| `INTAKE_ENC_KEY` | Preferred key for intake answers (fallback chain: INTAKE → MESSAGE → SESSION_SECRET) | opt | `lib/intake.js:201` |
| `FEEDBACK_ENC_KEY` | Preferred key for bug/suggestion bodies (fallback chain: FEEDBACK → MESSAGE → SESSION_SECRET) | opt | `lib/feedback-reports.js:22` |
| `AUDIT_SIGNING_KEY` | Ed25519 private key (PKCS#8 PEM, or base64 of the PEM) for the audit ledger; if absent one is generated and stored in `audit-key` | opt | `lib/audit.js` |
| `ADMIN_MFA` | `off` = force-disable email MFA (emergency switch) | opt | `server.js` (`mfaForceOff`) |
| `ALLOWED_ORIGINS` | Comma list of CORS origins; default `*` | opt | `server.js` CORS middleware, `lib/realtime.js` socket.io cors |
| `SITE_URL` | Public site origin for links in emails (cancel/intake/reset/account), Stripe return URLs, media manifest | opt (links blank without it) | `server.js`, `lib/clients.js`, `lib/payments.js`, `lib/videos.js`, others |
| `EDGE_SECRET` | Shared secret for `x-mdfit-edge` header; when set, non-webhook API calls must come via the Vercel edge | opt | `lib/security.js` |
| `BOT_FILTER` | `off` disables user-agent bot filter (default on) | opt | `server.js:45` |
| `TZ_NAME` | Clinic IANA time zone (default `America/New_York`) | opt | everywhere dates are computed |
| `RESEND_API_KEY` | Resend email API key; email is "enabled" only with `NOTIFY_FROM` too | opt | `lib/notify.js` |
| `RESEND_URL` | Resend base URL (default `https://api.resend.com`; tests point at a fake) | opt | `lib/notify.js` |
| `NOTIFY_FROM` | From address for all email | opt | `lib/notify.js` |
| `NOTIFY_EMAIL` | Owner alert address (defaults to `ADMIN_EMAIL`) | opt | `server.js:129` |
| `ALERT_EMAILS` | Extra comma/space/semicolon-separated addresses that get every owner alert | opt | `server.js:55` |
| `CAL_API_KEY` | Cal.com API v2 key | opt | `lib/cal.js` |
| `CAL_API_URL` | Cal.com base (default `https://api.cal.com/v2`) | opt | `lib/cal.js` |
| `CAL_WEBHOOK_SECRET` | HMAC secret for `x-cal-signature-256`; webhook returns 503 without it | opt | `server.js` `/api/cal/webhook` |
| `CAL_WATCH_SECONDS` | Calendar watcher interval (default 60; `0` = off) | opt | `server.js:62,1279` |
| `GOOGLE_SERVICE_ACCOUNT` | Google service-account JSON (raw or base64) for Calendar | opt | `lib/calsync.js` |
| `GOOGLE_CALENDAR_ID` | Comma list of calendar ids; first receives bookings, all are read for busy times | opt | `lib/calsync.js` |
| `SIMPLEPRACTICE_ICS_URL` | SimplePractice calendar feed URL (admin-saved `calsync.icsUrl` overrides) | opt | `server.js` `spUrl()` |
| `GOOGLE_PLACES_API_KEY` | Google Places key for live reviews | opt | `lib/google.js` |
| `GOOGLE_PLACES_URL` / `GOOGLE_PLACES_LEGACY_URL` | Places API base URLs (defaults `https://places.googleapis.com/v1`, `https://maps.googleapis.com/maps/api/place`) | opt | `lib/google.js` |
| `GOOGLE_PLACE_ID` | Fixed place id (skips text search) | opt | `server.js` `googleReviews()` |
| `GOOGLE_PLACE_QUERY` | Text search query (default `"MD Fit, 3214 Clark Road, Sarasota, FL 34231"`) | opt | `server.js` |
| `GOOGLE_CLIENT_ID` | Google Sign-In OAuth client id (audience check); exposed in `/api/site` and `/api/app/config` | opt (501 without) | `lib/clients.js:249`, `server.js:526,606` |
| `STRIPE_SECRET_KEY` | Stripe secret (comment: use a restricted `rk_` key) | opt | `lib/payments.js:49`, `server.js:604` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret; checkout is only enabled when **both** Stripe vars are set | opt | `lib/payments.js:50`, `server.js:604` |
| `STRIPE_PUBLISHABLE_KEY` | Exposed to apps in `/api/app/config` | opt | `server.js:605` |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Media sync job | opt | `lib/videos.js:17` |
| `LEADERBOARD_PACERS` | `off` disables synthetic leaderboard pacers (default on) | opt | `lib/clients.js:584` |
| `MIN_IOS_BUILD` | Oldest supported iOS build reported by `/api/app/config` (default 1) | opt | `server.js:603` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `silent` (default info) | opt | `lib/logger.js:6` |
| `NODE_ENV` | Tests refuse to run when `production` | — | `test/*.js` |

Test-only `cfg` overrides (not env): `cfg.now`, `cfg.calsync`, `cfg.stripeClient`, `cfg.stripeSecretKey`, `cfg.stripeWebhookSecret`, `cfg.noVideoSync`.

### Logging (`lib/logger.js`)
- Structured JSON, one line per event to stdout: `{ time, level, msg, ...fields }`. Levels `debug 10, info 20, warn 30, error 40, silent 99`.
- `mask(email)` → `f**@example.com` (first char + `**` + domain). Used for every email that reaches a log line, MFA prompts, admin email-log.
- `requestLogger`: one line per request with `method`, `path` (no query string, so URL tokens never log), `status`, `ms`; level by status (≥500 error, ≥400 warn).
- `lib/notify.js` logs `email_sent {to: masked}` only; subjects (which carry names) go to the admin email-log store, not stdout.
- Audit entries hash the IP (`HMAC-SHA256(SESSION_SECRET, ip)[0:16]`), never store raw IPs.

### CORS
Middleware in `server.js:~462`: if request `Origin` is in `ALLOWED_ORIGINS` (or list contains `*`), sets `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Allow-Headers: Content-Type, Authorization`, `Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`. `OPTIONS` → 204. No credentials header. socket.io uses `origin: "*"` or the list, `credentials: true`.

---

## 2. Request pipeline (middleware order in `createApp`)

1. `app.disable("x-powered-by")`, `app.set("trust proxy", 1)`.
2. One-time store migrations run synchronously at boot (see §7).
3. `sec.clientIp` (`lib/security.js`): if `x-mdfit-edge` matches `EDGE_SECRET` (constant-time), `req.ip` is overridden with `x-mdfit-client-ip` (validated `/^[0-9a-fA-F:.]{3,45}$/`).
4. `sec.headers`: on every response `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`, `X-Robots-Tag: noindex, nofollow, noarchive`; `Cache-Control: no-store` when path matches `/^\/api\/(me|admin|clients|appointments|feedback\/reward)(\/|$)/`. No CSP header (API only).
5. `sec.edgeGate`: when `EDGE_SECRET` is set, any request not carrying the matching `x-mdfit-edge` header gets `403 {error:"Forbidden."}`, except EXEMPT paths `/api/stripe/webhook`, `/api/cal/webhook`, `/api/health`, `/` and `OPTIONS`. Logged as `edge_blocked`. **How the Vercel edge fronts the API** (per comment): the site's Vercel middleware adds the secret, geo-restricts to US, filters bots, forwards the real client IP in `x-mdfit-client-ip`; direct calls to the Railway URL are refused. Analytics also reads `x-vercel-ip-country`, `x-vercel-ip-country-region`, `x-vercel-ip-city` headers.
6. `sec.botFilter` (unless `BOT_FILTER=off`): 403 `"Automated access isn't allowed."` when UA is empty or matches `BAD_UA` (curl, wget, python-requests, axios, node-fetch, postman, headless, puppeteer, playwright, gptbot, claudebot, bytespider, semrush, ahrefs, masscan, nmap, sqlmap, …; full regex `lib/security.js:13`). Webhook/health paths exempt. Native apps must send a browser-like UA (or an app UA not in that list).
7. Global rate limits on `/api` (`sec.rateLimit`, in-memory, keyed per account when a valid Bearer token has `sub`, else per IP):
   - `burst`: 10 s window, **240** per account / **120** per IP.
   - `steady`: 10 min window, **3,000** per account / **1,500** per IP.
   - 429 body `"Too many requests. Slow down and try again shortly."`, `Retry-After` set. EXEMPT paths skipped. Map pruned on `max(windowMs, 60s)` interval.
8. Audit middleware: on `res.finish` for `/api/*` (not OPTIONS) records a ledger entry (see §4) keyed by route pattern.
9. `requestLogger`.
10. CORS middleware (above).
11. `express.json({ limit: "200kb", verify })` keeps `req.rawBody` for webhook signatures. Parse errors → 400 `"Invalid JSON."`, too large → 413.
12. Routes (public, then `/api/me` router mounted inside `mountClients`, then `/api/admin` router).
13. 404 `{error:"Not found."}`; error handler: `ValidationError` → 400 with message, else 500 `"Something went wrong. Try again."` (logged `server_error`).

### Per-route limiters (`limiter(max, windowMs)` in `server.js`, in-memory per `req.ip`; `mw` blocks when count ≥ max)

| Name | Limit | Routes |
|---|---|---|
| `formLimit` | 20 / hour | `POST /api/feedback`, `/api/appointments`, `/api/appointments/:id/cancel`, `/api/leads`, `/api/bookings`, `/api/bookings/:id/cancel`, `/api/subscribe` |
| `loginFails` (admin) | 10 failures / 15 min → 429 | `POST /api/admin/login` (counts failures only; reset on success) |
| `signupLimit` (`lib/clients.js`) | 10 / hour | `/api/clients/signup`, `/api/clients/google`, `/api/clients/forgot` |
| `resetLimit` | 6 / hour | `POST /api/me/password/code` |
| `loginFails` (client) | 10 failures / 15 min | `POST /api/clients/login` |
| intake `limit` | 60 / hour | all `/api/appointments/:id/intake*` and `/api/me/intake*` |
| messages `sendLimit` | 40 / hour | `POST /api/me/messages` |
| feedback-reports `limit` | 10 / hour | `POST /api/me/feedback-reports` |
| analytics `hit` | 60 / minute | `POST /api/hit` |
| search `logLimit` | 600 / minute | `POST /api/search/log` |

Honeypot: public forms return a fake `201 {ok:true}` if body has `mdfit_hp` or `company` (signup too).

---

## 3. Auth layers

### Tokens (`lib/auth.js`)
- Format: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(SESSION_SECRET, body))`. Not JWT (no header). `verifyToken` does constant-time compare and requires numeric `exp > now` (ms epoch).
- Sent as `Authorization: Bearer <token>`; socket.io as `handshake.auth.token`.

### Admin
- `POST /api/admin/login` `{ email, password, code? }`. Requires `authReady` = `ADMIN_EMAIL` set, `ADMIN_PASSWORD_HASH` valid, `SESSION_SECRET.length ≥ 32`; else 503 with setup message.
- Password hash format: `scrypt$N$r$p$<salt b64>$<key b64>` with N=16384, r=8, p=1, 64-byte key, verified with `timingSafeEqual` (`maxmem` 64 MB).
- MFA (email code): active when `ADMIN_MFA != off` AND email enabled AND store `admin-mfa` = `{enabled:true, method:"email"}`. Flow: password ok → 6-digit code emailed to `ADMIN_EMAIL` (subject `"<code> is your MD Fit admin code"`), response `401 {mfaRequired:true}`; client resubmits with `code`. Code: sha256(`"mdfa-mfa:"+SESSION_SECRET+":"+code`) in memory, 10-min expiry, 5 tries, single use, no resend within 30 s. Failed codes count toward `loginFails`.
- Token payload `{ sub: adminEmail, exp }`, **12 h** (`SESSION_HOURS`). Response `{ token, expiresAt }`.
- `requireAdmin`: payload.sub must equal `cfg.adminEmail` → `req.admin`. Admin tokens cannot pass `requireClient` (no `role`) and vice-versa.
- Admin MFA management: `GET /api/admin/mfa`, `POST /mfa/start`, `/mfa/confirm {code}`, `/mfa/disable {password}` (403 on wrong password so a typo doesn't log out).

### Client / member (`lib/clients.js`)
- Ready only if `SESSION_SECRET.length ≥ 32` (else 503).
- Token payload `{ sub: clientId, role: "client", pwv, exp }`, **30 days** (`SESSION_DAYS`). `pwv` = password version; bumped on password change/reset so older tokens are rejected. `requireClient` reloads the client record every request and checks `pwv` → `req.client`.
- Session response shape: `{ token, expiresAt, client: pub(c) }` where `pub` = `{ id, email, name, firstName, lastName, phone, createdAt, plan, membership (active only), referralCode, hasPassword, google, clientType ("inpatient"|"outpatient"), assignedPrograms, pinnedPrograms }`.
- Signup `POST /api/clients/signup` `{ email, name (2-100), phone?, password (8-200), referralCode? }` → 201 session; 409 on duplicate email.
- Login `POST /api/clients/login` `{ email, password, name? }`: wrong password 401 + lockout counter; **unknown email auto-creates an account** (201) with that password (name derived from email if absent).
- Google `POST /api/clients/google` `{ credential (Google ID token), referralCode? }`: verifies iss (`accounts.google.com`), aud = `GOOGLE_CLIENT_ID`, exp, RS256 signature against `https://www.googleapis.com/oauth2/v3/certs` (cached 1 h), requires `email_verified`. Links `googleSub`; creates account with `passwordHash: null`.
- Forgot/reset: `POST /api/clients/forgot {identifier|email}` always 200 (no enumeration); 6-digit code in memory (`resetCodes`, 10 min, 5 tries) emailed subject `"<code> is your MD Fit code"`. `POST /api/clients/verify-code {identifier, code}` → `{ resetToken }` (token `{sub, role:"reset", pwv, exp: 24h}`). `POST /api/clients/reset {token, password}` → bumps `pwv`, returns session. Admin can mint a reset link (`POST /api/admin/clients/:id/reset-link` → `SITE_URL/login?reset=<token>`) or email a code.
- Signed-in password: `POST /api/me/password/code` (emails code), `PUT /api/me/password {password, code?|current?}`.
- `hideRank` (`PUT /api/me/leaderboard/visibility {hidden}`): hides the member from leaderboard and challenge pool.

### Link tokens
- Every appointment and class booking gets `cancelToken` = 16 random bytes hex. Checked with `tokenMatches()` (`crypto.timingSafeEqual`, length-checked). Used by `POST /api/appointments/:id/cancel {token}`, `POST /api/bookings/:id/cancel {token}`, and the intake link (`?token=` or body `token`) on `/api/appointments/:id/intake*`. Admin and member responses strip `cancelToken`.
- Intake link privacy tradeoff documented in `lib/intake.js:216-223`: route returns only what the booking email contained; answers are never readable back out.

### Webhooks
- Stripe: `stripe.webhooks.constructEvent(req.rawBody, "stripe-signature", STRIPE_WEBHOOK_SECRET)`; 400 on bad signature; 503 if not configured.
- Cal.com: `X-Cal-Signature-256` = hex HMAC-SHA256(secret, raw body), constant-time compare (`lib/cal.js verifySignature`); 401 on bad signature, 503 without secret.

### Realtime (`lib/realtime.js`, socket.io path `/ws`)
- `/admin` namespace: `handshake.auth.token` verified; `sub` must equal `ADMIN_EMAIL`.
- `/member` namespace: token must have `role:"client"`; `findClient(sub)` must exist and `pwv` must match.
- `/public` namespace: no auth (booking pages).

---

## 4. Encryption / PHI / audit

### Store-level (`lib/store.js`)
- With `DATA_ENC_KEY`: key = `scryptSync(key, "mdfit-store-v1", 32)`; each file = `"enc:v1:" + base64(iv[12] + authTag[16] + ciphertext)`, AES-256-GCM. Plain legacy files read as-is and encrypted on next write. Encrypted file with missing/wrong key **throws** (never silently empty). Writes are atomic (tmp + rename, mode 0600).

### Field-level PHI (`lib/phi.js`, `phiStore` wraps the store in `server.js:127`)
- Cipher = `cipher([MESSAGE_ENC_KEY, SESSION_SECRET])` from `lib/messages.js`: AES-256-GCM, key `scryptSync(secret, "mdfit-msg-v1", 32)`, value = `"v1:" + base64(iv[12] + tag[16] + ct)`. Multiple keys: first encrypts, all are tried on decrypt (rotation). No secret at all → fixed dev fallback key.
- `FIELDS` encrypted at write / decrypted at read:
  - `appointments`: `notes`, `adminNotes`
  - `clients`: `plan.notes`, `painLog[].note`, `assignedPrograms[].note`, `programHistory[].note`
  - `leads`: `message`, `notes`
  - `feedback`: `text`
- Guards: a string already starting with `v1:` is never re-encrypted (no double wrap); on decrypt failure (wrong key) the stored ciphertext is kept as-is so it isn't lost on rewrite. Decrypt cache up to 20,000 entries. Test: `clients.test.js:740`.

### Other ciphers
- Messages (`lib/messages.js`): `body` encrypted with `cipher([MESSAGE_ENC_KEY, SESSION_SECRET])`.
- Intake answers (`lib/intake.js`): whole `data` JSON encrypted with `cipher([INTAKE_ENC_KEY, MESSAGE_ENC_KEY, SESSION_SECRET])`.
- Bug/suggestion bodies (`lib/feedback-reports.js`): `data` JSON with `cipher([FEEDBACK_ENC_KEY, MESSAGE_ENC_KEY, SESSION_SECRET])`.
- SimplePractice feed URL stored in `calsync` (whole-file encryption only), shown truncated in admin.

### Audit ledger (`lib/audit.js`)
- Entry `{ seq, ts, actor, action, subject, ip (hashed), meta, prev, hash, sig, kid }`. `hash` = SHA-256 of canonical JSON of (seq, ts, actor, action, subject, ip, meta, prev); genesis = sha256("MD Fit audit ledger · genesis"). `sig` = Ed25519 over hash; `kid` = first 16 hex of sha256(SPKI DER).
- Files: `audit-<YYYY-MM>` per month, `audit-state {seq,last,months}`, `audit-key` (generated private key when no env key), `audit-trusted-keys` (every public key ever used), `audit-anchors` (last 3650).
- Actors/actions recorded by `server.js` middleware: `auth.admin.login[_failed]`, `auth.client.login[_failed]`, `auth.client.signup`, `auth.client.password_reset`, `payments.webhook`, `admin.view <route>` / `admin.change <route>` (all admin 2xx/3xx except QUIET set: `GET /api/admin/me|messages|calsync|audit`), `client.<route>` for member non-GET; subject = `clientId`/`id` param or `req.client.id`. Intake adds `intake.open` / `intake.submit` for `patient` and `client:<id>` actors.
- Anchors: `publishAnchor()` emails owner (`"MD Fit audit anchor · entry #N"`) and logs `audit_anchor`; timer every 5 min fires once per day at ≥23:45 clinic time. Endpoints: `POST /api/admin/audit/anchor`, `GET /api/admin/audit?limit≤1000&before&subject&actor&action`, `GET /api/admin/audit/verify[?seq&head]` → `{ ok, entries, head, genesis, publicKeyFingerprint, anchor?, anchors }`.

### HIPAA posture (comments in code)
- Emails never carry health details: bookings/leads/reviews/intake/messages/feedback-reports emails say "read it in Admin" (`server.js` feedback/appointments/leads handlers, `lib/intake.js`, `lib/messages.js`, `lib/feedback-reports.js`).
- Google Calendar events contain only visit type + first name/last initial (`lib/calsync.js`); comment advises Google Workspace BAA.
- Stripe product names never include health details (`lib/payments.js` header).
- Analytics (`lib/analytics.js`) stores `sha256(ip+day)[0:12]` visitor ids only; search logs are anonymous.
- Realtime `sanitize()` strips `password`, `token`, `cancelToken` from activity payloads; challenges carry only workout name/exercises.
- Personal routes are `Cache-Control: no-store`; request log excludes query strings; `Referrer-Policy: no-referrer`.

---

## 5. HTTP endpoints

**Total: 169 route registrations** (33 on `app` incl. `/api/admin/login` and 2 webhooks; 73 on the admin router at `/api/admin/*`; 63 on the member router at `/api/me/*`). Counted with `grep -E '^\s*(app|admin|me)\.(get|post|put|patch|delete)\("'` over `server.js lib/*.js`.

Conventions: errors are `{ error: string }`; validation failures 400; `ValidationError` thrown by `lib/validate.js` helpers. "Activity" = `activity(type, detail)` which prepends to the `activity` store (cap 500), logs, and emits socket `activity`/`toast`.

### 5a. Public (no auth)

| Method | Path | Purpose | Request | Response | Side effects |
|---|---|---|---|---|---|
| GET | `/` | liveness | — | `{name:"MD Fit API", ok}` | — |
| GET | `/api/health` | Railway healthcheck | — | `{ok:true}` | — |
| GET | `/api/reviews` | Google reviews (cached 6 h on disk/mem) | — | `{source:"none"}` or `{source:"google", name, rating, count, url, reviews[{author,authorUrl,photo,rating,text,relativeTime,publishTime}]}`; `Cache-Control public, max-age=300` | may fetch Google Places |
| GET | `/api/site` | Site settings for the web/app | — | `{ settings (minus scheduling/booking/massageAdded/version), timeZone, googleClientId, booking:{provider:"builtin"\|"cal", cal:{origin,username,eventTypes}\|null}, options:{goals,services,areas,durations,surgery}, goals, services }` | may call Cal.com (`calInfo`, 5-min cache) |
| GET | `/api/app/config` | Native app launch config | — | `{ apiVersion:1, minIosBuild, timeZone, features:{payments, healthSync:true, liveQa:true, bluetoothHeartRate:true, googleCalendar:false}, stripePublishableKey, googleClientId }` | — |
| GET | `/api/availability` | Open 1-on-1 slots | query `type` (appointmentType id or `plan-review`), `from` (YYYY-MM-DD, future), `days` (1-31, default 14) | `{ timeZone, type, lastDate, days:[{date, slots:["HH:MM"]}] }` | reads Google/SimplePractice busy (3-min cache) |
| POST | `/api/appointments` | Book a 1-on-1 (formLimit, honeypot) | `appointmentInput`: `typeId` (1-30), `date`, `time` (HH:MM), `name` (2-100), `email`, `phone` (required, 7-30), `notes` (≤1000), `areas[]` (from AREAS), `painLevel` (0-10\|null); `rewardCode` when `typeId=plan-review`; optional Bearer client token links `clientId` when email matches | 201 `{ ok, appointment:{id,typeId,typeName,minutes,date,time,cancelToken,meetingLink,intake:true,intakeDocs,intakeDone}, message }`; 409 slot taken / code used | writes `appointments`, marks feedback `rewardUsedAt`, saves phone to member if missing; activity `appointment`; socket `slots_changed`; Google Calendar event; owner email `"New booking: <type>, <when>"`; client email `"You're booked: <type>, <when>"` (with intake link + cancel link + telehealth link/rules) |
| POST | `/api/appointments/:id/cancel` | Cancel via emailed link (formLimit) | `{ token }` | `{ok}`; 404 bad token/already cancelled; 409 if not `booked` or in the past | status `cancelled`, `cancelledAt`; Google event removed; activity `appointment_cancelled`; socket `slots_changed`; owner email `"Cancelled: …"` |
| GET | `/api/appointments/:id/intake` | Intake page data (limit 60/h) | query `token` | `{ name (first), typeName, date, time, cancelled, prefill:{name,email,phone}, docs:[DOC + done], done, total, completed, conditions, pressure }` | audit `intake.open` |
| POST | `/api/appointments/:id/intake/:doc` | Save one intake document | `{ token, ...fields per DOCS }` | 201 `{ok,total,completed,done}`; 409 if cancelled | writes `intakes` (encrypted), `appointments[].docs[doc]=iso`, `intakeAt` when complete; activity `intake`; audit `intake.submit`; owner email `"Documents completed: <name>, <when>"` once complete |
| POST | `/api/appointments/:id/intake` | Legacy single massage form | `{ token, focus (2-600), painLevel, pressure, goals, conditions[], medications, allergies, other, emergencyName, emergencyPhone, signature (2-80), consent }` | 201 `{ok}` | as above; owner email `"Massage intake received: …"` |
| GET | `/api/schedule` | Group class sessions | query `days` (1-14, default 7) | `{ timeZone, sessions:[{classId,date,dayName,time,durationMin,title,coach,location,description,capacity,spotsLeft}] }` | — |
| POST | `/api/bookings` | Book a class seat (formLimit, honeypot) | `bookingInput`: `classId`, `date`, `name`, `email`, `phone?` | 201 `{ ok, booking:{id,title,date,time,minutes,cancelToken}, message }`; 404 not open; 409 duplicate/full | writes `bookings`; activity `booking`; client email `"You're in: <title>, <when>"` |
| POST | `/api/bookings/:id/cancel` | Cancel class seat | `{ token }` | `{ok}` | deletes booking; activity `booking_cancelled` |
| POST | `/api/leads` | Evaluation request (formLimit, honeypot) | `leadInput`: `name`, `email`, `phone?`, `service` (SERVICES), `goal` (GOALS), `areas[]`, `painLevel`, `duration` (DURATIONS), `surgery` (SURGERY), `preferredTime` (≤100), `referral` (≤120), `message` (≤2000) | 201 `{ok, message}` | writes `leads` (status `new`); activity `lead`; owner email `"New evaluation request: <name>"` |
| POST | `/api/subscribe` | Newsletter (formLimit, honeypot) | `{ email }` | 201 `{ok, message}` | writes `subscribers`; activity `subscribe` |
| POST | `/api/feedback` | On-site review (formLimit, honeypot) | `feedbackInput`: `name` (2-80), `email`, `rating` (1-5), `text` (10-2000), `publish` (bool) | 201 `{ ok, rewardCode "MDFIT-XXXXXX", rewardPct, subscribeUrl, message }` | writes `feedback` (status `pending`); sets `clients[].reviewCode`; activity `feedback`; owner email `"New review: N/5 from <name>"`; client email `"Thank you! N% off your first month"` |
| GET | `/api/feedback` | Approved public reviews | — | `{ reviews:[{name "First L.", rating, text, date}] (≤30), count, average, reward:{pct,title} }` | — |
| GET | `/api/feedback/reward/:code` | Validate reward code | — | `{ valid, used, pct, name, email, type: PLAN_REVIEW }`; 404 | — |
| GET | `/api/content` | Programs/lectures/live/tiers/tips/tracks/events (public) | — | `{ programs[], lectures[], live, tiers[], recommendations[], tracks[], events[], categories, topics }` (all `locked:false`) | — |
| GET | `/api/videos` | Cloudinary asset map | — | `{ cloud, map:{key:[public_id,"i"\|"v",version]}, ids[] }`; `max-age=300` | — |
| POST | `/api/hit` | Page-view analytics (60/min) | `{ page, referrer, utm, w }` | `{ok}` | writes `analytics` (90-day retention) |
| POST | `/api/search/log` | Search telemetry (600/min) | `{ type:"query"\|"click"\|"noclick", q (≤120), resultCount, id, position }` | `{ok}` | writes `search-events` (ring 50,000) |
| GET | `/api/search/signals` | Click-through boosts | — | `{ generatedAt, boost:{"q\|docId": score} }`; cached 60 s | — |
| POST | `/api/clients/signup` | see §3 | | | owner email `"New client account: <name>"`; activity `client_signup` |
| POST | `/api/clients/login` | see §3 | | | auto-create → owner email; audit |
| POST | `/api/clients/google` | see §3 | | | |
| POST | `/api/clients/forgot` | see §3 | | `{ ok, emailed, via:"email", message }` | code email |
| POST | `/api/clients/verify-code` | see §3 | | `{ resetToken }` | |
| POST | `/api/clients/reset` | see §3 | | session | activity `client_password_reset` |
| POST | `/api/admin/login` | see §3 | | `{ token, expiresAt }` | activity `login`; MFA email |

### 5b. Webhooks

| Method | Path | Auth | Handles | Side effects |
|---|---|---|---|---|
| POST | `/api/cal/webhook` | `x-cal-signature-256` HMAC | `PING`; `BOOKING_CREATED`, `BOOKING_RESCHEDULED` (old uid cancelled), `BOOKING_CANCELLED`, `BOOKING_REJECTED`; others `{ok, ignored}` | `upsertCalBooking` → appointment with `source:"cal"`, `calUid`, `meetingLink`; activity `cal_<event>` |
| POST | `/api/stripe/webhook` | Stripe signature; idempotent via `stripeEvents` (last 1,000 ids) | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.{created,updated,deleted}`, `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created` | membership/protocol state on client; subscription schedules; accountability credit invoice item; owner/client emails; audit `payments.webhook` |

### 5c. Admin (`/api/admin/*`, all `requireAdmin`, all audited)

| Method | Path | Purpose | Request | Response / notes | Side effects |
|---|---|---|---|---|---|
| GET | `/me` | who am I | — | `{ email, emailNotifications, mfa }` | |
| GET | `/online` | live counts | — | `{ members:[{name,page}], memberCount, visitorCount }` | |
| GET | `/mfa` | MFA status | — | `{ enabled, method:"email", emailReady, forcedOff, sendsTo (masked) }` | |
| POST | `/mfa/start` | email enable code | — | `{ sent, to }` | email |
| POST | `/mfa/confirm` | enable | `{code}` | `{enabled:true}` | writes `admin-mfa` |
| POST | `/mfa/disable` | disable | `{password}` | `{enabled:false}` (403 wrong pw) | |
| GET | `/stats` | dashboard | — | `{ leadsNew, leadsTotal, leads30d, appointmentsToday, appointmentsWeek, subscribers, bookingsThisWeek, sessionsThisWeek, today[], nextAppointments[≤8], upcoming[≤10] }` | |
| GET | `/settings` | full settings | — | merged settings object | |
| PUT | `/settings` | partial update | any of `business, rating, coach, packages, testimonials, appointmentTypes, scheduling, booking, services, plans` (limits in `mergeSettings`, `lib/validate.js`) | saved settings | activity `settings` |
| POST | `/reviews/refresh` | force Google fetch | — | `{ ok, api, name, rating, count, reviews, fetchedAt }`; 503 no key; 502 error | |
| GET | `/cal/status` | Cal.com connection | — | `{ keySet, webhookSecretSet, provider, connected, username?, name?, timeZone?, eventTypes?, message? }` | Cal API |
| POST | `/cal/sync` | pull upcoming Cal bookings | — | `{ ok, synced }` | upserts appointments; activity `cal_sync` |
| GET | `/appointments` | list | query `all=1` (else upcoming non-cancelled) | appointments (no `cancelToken`) + `documents:{total,done,complete,docs}` | |
| PATCH | `/appointments/:id` | update | `{ status? (booked\|completed\|no-show\|cancelled), adminNotes? (≤4000), meetingLink? (https ≤500, "" clears) }` | appointment | cancel → Cal cancel (if `source:"cal"`) + Google remove; un-cancel → Google add; new link → client email `"Your video visit link: …"`; `meetingLinkSetByAdmin` |
| GET | `/appointments/:id/intake` | decrypted intake answers | — | `{ status, docs:[{id,title,createdAt,onFile,fields:[{label,value}]}], legacy fields… }`; 404 none | audited view |
| GET | `/appointments.csv` | CSV export | — | columns date,time,typeName,minutes,name,email,phone,areas,painLevel,notes,status,adminNotes,createdAt (formula-injection escaped) | |
| POST | `/clients/:id/send-booking-link` | email booking link | `{ typeId, message? (≤500) }` | `{ ok, link, message }`; 503 no email/SITE_URL; 400 remote type without `booking.telehealthUrl` | client email `"Book your <type> with Dr. Jared"`; activity `booking_link_sent` |
| POST | `/clients/:id/consult` | admin-scheduled video consult | `{ date, time, minutes (15\|30\|45\|60\|90, default 30), meetingLink? (blank → practice room), title? (≤80), message? (≤500), force? }` | 201 appointment (`typeId:"consult-video"`, `source:"admin"`, `payment:"exempt"` for inpatient else `"none"`); 409 overlaps calendar/appointment unless `force` | writes appointment; Google event; socket `slots_changed`; client email `"Video consultation with Dr. Jared: <when>"`; activity `consult_scheduled` |
| POST | `/audit/anchor` | publish anchor now | — | `{ anchors[≤5] }` | owner email |
| GET | `/audit` | ledger page | query `limit (1-1000, def 200)`, `before`, `subject`, `actor`, `action` (prefix) | `{ entries, nextBefore, publicKey, fingerprint }` | |
| GET | `/audit/verify` | verify chain | query `seq`, `head` | `{ ok, entries, head, genesis, publicKeyFingerprint, anchor?, anchors[≤30] }` | |
| GET | `/calsync` | sync status | — | `{ google, simplepractice, lastError, lastSync, serviceAccountEmail, calendarId, calendars, simplePracticeUrl (truncated), live:{everySec,lastCheck,lastChange} }` | |
| PUT | `/calsync` | set SimplePractice feed | `{ icsUrl }` (https/webcal) | `{ ok, simplepractice }` | writes `calsync`; clears caches; runs watcher |
| GET | `/busy` | busy blocks for admin calendar | query `from`, `days (1-42, def 7)` | `{ busy:[{date,start(min),end(min),allDay,source:"google"\|"simplepractice"}], ...status }` (MD Fit's own Google copies excluded) | |
| POST | `/calsync/test` | probe next 14 days | — | `{ ...status, busyNext14Days, bySource }` | |
| GET | `/feedback` | all reviews (newest first) | — | array | |
| PATCH | `/feedback/:id` | moderate | `{ status: pending\|approved\|hidden }` (approve refused if `!publish`) | review | |
| GET | `/leads` | leads | query `status` | array | |
| PATCH | `/leads/:id` | update | `{ status? (LEAD_STATUSES), notes? (≤4000) }` | lead | |
| DELETE | `/leads/:id` | delete | — | `{ok}` | |
| GET | `/leads.csv` | CSV | — | 15 columns | |
| GET | `/classes` | list | — | array | |
| POST | `/classes` | create | `classInput`: `title (1-80), day (0-6), time, durationMin (15-240, def 60), capacity (1-100, def 10), coach (≤80), location (≤120), description (≤500), active?` | 201 class | activity `class_created` |
| PUT | `/classes/:id` | partial edit | same, partial | class | |
| DELETE | `/classes/:id` | delete (+ its bookings) | — | `{ok}` | activity `class_deleted` |
| GET | `/bookings` | class bookings | query `all=1` | array (no cancelToken) | |
| DELETE | `/bookings/:id` | remove | — | `{ok}` | |
| GET | `/subscribers` | list | — | array | |
| DELETE | `/subscribers/:email` | remove | — | `{ok}` | |
| GET | `/subscribers.csv` | CSV | — | email,createdAt | |
| GET | `/activity` | last 200 activity events | — | array | |
| GET | `/email-log` | delivery log | — | `{ enabled, alertsTo (masked), days[≤30]:{date,sent,failed}, failures[≤20] }` | |
| GET | `/analytics` | site analytics | query `days (1-365, def 30)` | `{ summary:{totalViews,totalUnique,todayViews,todayUnique}, days[], pages[≤30], referrers[≤20], rangeDays, mix:{devices,os,browsers,sources,places,countries} }` | |
| GET | `/search-analytics` | search CTR | query `days (1-180)` | `{ days, totals, top[≤40], zeroResult[≤40], topCtr[≤20], bottomCtr[≤20] }` | |
| GET | `/clients` | client list | — | `[{ id,name,email,phone,createdAt,lastLoginAt,visits,next,lastPain,hasPlan,membership,requestedTier,clientType,documents }]` | |
| GET | `/clients/:id` | client detail | — | `pub(c)` + `lastLoginAt, painLog, documents, programProgress, programHistory, workouts[≤50], stats, rewards:{xp,level,title,gem,overall,badges}, appointments` | |
| PUT | `/clients/:id/plan` | treatment plan | `{ guides[] (GUIDE_IDS), exercises[≤30]{name (1-80), detail (≤300)}, notes (≤3000) }` | plan | client email `"Your MD Fit plan was updated"`; activity `client_plan` |
| PUT | `/clients/:id/type` | inpatient/outpatient | `{ type }` | `{clientType}` | activity `client_type`; audited |
| PUT | `/clients/:id/programs` | assign programs | `{ programs[≤12]:[{id, note? (≤300)}] }` | `{ assignedPrograms, programHistory, programProgress }` | client email `"Dr. Jared added a program for you"` when added; activity `client_programs` |
| POST | `/clients/:id/reset-link` | mint reset link | — | `{ url, hours:24 }` | |
| POST | `/clients/:id/send-reset-code` | email code | — | `{ ok, message }` | activity `admin_sent_reset_code` |
| DELETE | `/clients/:id` | delete client + their messages | — | `{ok}` | activity `client_deleted` |
| GET | `/clients/:id/intake` | docs on file | — | `{ status, docs }` | audited |
| PUT | `/clients/:id/membership` | grant/clear tier | `{ tier?, until? (YYYY-MM-DD) }` | `{ membership }` | consumes `membershipRequest.rewardCode` |
| PATCH | `/clients/:id/meetings/:mid` | 1-on-1 meeting | `{ status? (requested\|scheduled\|done\|cancelled), when? (≤80), link? }` | meeting | client email `"Your 1-on-1 with Dr. Jared is scheduled"` when scheduled+when |
| GET | `/content` | editable content | — | content object | |
| PUT | `/content` | save content | `{ programs[≤40], lectures[≤200], tiers[≤6], recommendations[≤100], live, tracks[≤80], events[≤50] }` (validators `programIn`, `lectureIn`, `tierIn`, `recIn`, `liveIn`, `trackIn`, `eventIn`) | content; sets `contentVersion:5`, `knownDefaults` | |
| GET | `/members` | members/requests/meetings | — | array | |
| GET | `/messages` | threads | — | `{ threads:[{clientId,name,email,member,tier,last:{from,body(140),at},unread}], unread }` | |
| GET | `/messages/broadcasts` | last 10 group messages | — | `[{broadcastId,at,preview,recipients,read,emailed,sending}]` | |
| GET | `/messages/:clientId` | thread (marks client msgs read) | — | `{ client, messages:[{id,from,body,at,read,reactions}] }` | |
| POST | `/messages/broadcast` | group message | `{ body (≤2000), to:"all"\|"members"\|"tier"\|"selected", tier?, clientIds[≤2000]?, email?:false }` | 201 `{ sent, emailing, broadcastId }` | one message per recipient; socket `new_message`; batched emails `"New message from Dr. Jared"`; owner summary email `"Group message sent to N people"` |
| POST | `/messages/broadcast/:broadcastId/remind` | re-email unread | — | `{ sent, failed, unread }` | emails `"Reminder: you have a message from Dr. Jared"` |
| POST | `/messages/:clientId/:id/react` | reaction | `{ emoji \| null }` (REACTIONS set) | message | socket `message_reaction` both sides |
| POST | `/messages/:clientId` | reply | `{ body }` | 201 message | client email `"Dr. Jared replied to your message"`; socket `new_message` |
| GET | `/feedback-reports` | bugs/suggestions | query `kind`, `status` | `{ reports, open }` | |
| PATCH | `/feedback-reports/:id` | update | `{ status? (new\|working\|resolved), adminNotes? (≤2000) }` | report | |
| DELETE | `/feedback-reports/:id` | delete | — | `{ok}` | |
| GET | `/habits` | activity config | — | `{ habits, dailyGoal, defaults, autoIds }` | |
| PUT | `/habits` | edit config | `{ habits[1-60]:{id,name (≤80),points (0-100),how (≤200),active}, dailyGoal (10-500) }` (auto ids must remain) | config | writes `habit-config` |
| GET | `/payments` | Stripe overview | — | `{ enabled, webhook, clients:[{id,name,email,stripeCustomerId,membership,protocols}] }` | |
| POST | `/videos/migrate` | start Cloudinary sync | `{ retryFailed? }` | `{ started, total }` or `{ running, job }` | background job |
| GET | `/videos/status` | job status | — | `{ configured, cloud, job, done, failed }` | |

### 5d. Member (`/api/me/*`, all `requireClient`)

| Method | Path | Purpose | Request | Response | Side effects |
|---|---|---|---|---|---|
| GET | `/` | profile | — | `{ client: pub }` | |
| PUT | `/` | edit | `{ name? (2-100), phone? }` | `{ client }` | |
| POST | `/password/code` | email code (6/h) | — | `{ ok, via, to }` | email |
| PUT | `/password` | set/change | `{ password, code? \| current? }` | session | `pwv++` |
| GET | `/appointments` | mine (by email) | — | `{ upcoming[], past[] }` (no cancelToken/adminNotes; telehealth types get room link) | |
| POST | `/appointments/:id/cancel` | cancel mine | — | `{ok}`; 400 not booked/past; 502 Cal failure | Cal cancel; Google remove; owner email; activity |
| GET | `/pain` | pain log | — | sorted array | |
| POST | `/pain` | add | `{ area (AREAS), level (0-10), date? (≤today), note? (≤500) }` | 201 entry | cap 1,000 entries |
| DELETE | `/pain/:id` | delete | — | `{ok}` | |
| POST | `/workouts` | log workout | `{ title (1-80), goal (≤40), minutes (1-300), exercises (0-50), key?, seconds?, hrAvg?, hrMax?, hrv?, vo2max?, rpe?, calories?, source?, lifts[≤40]? }` | 201 `{ workout (with kind/ref), stats }` | cap 2,000; `classifyWorkout` may mark challenge done |
| PATCH | `/workouts/:id` | add metrics | metrics subset | workout | |
| GET | `/workouts` | full log | — | array | |
| GET | `/stats` | streaks | — | `{ streak, bestStreak, workouts, hours, week[7], todayIndex, recent[10] }` | |
| GET | `/vitals` | readings | — | array | |
| POST | `/vitals` | one day | `{ date?, restingHr (25-150), hrv (5-300), vo2max (10-95), weight (50-800), sleep (0-24), source? }` | 201 vitals | cap 1,500 |
| POST | `/vitals/batch` | health-app import | `{ readings[1-400], source? }` | 201 `{ saved, total }` | |
| GET | `/referral` | code | — | `{ code, freeUntil, referrals, freeMonths:3 }` | |
| GET | `/leaderboard` | board | query `period` (day\|week\|month\|all, def week), `league` (pro\|olympic\|all) | `{ league, myLeague, olympicLevel, olympicXp, olympicGem, period, total, top[≤10/25], me, hidden, resetsOn, tz }` | |
| PUT | `/leaderboard/visibility` | hide | `{ hidden }` | `{ hidden }` | |
| POST | `/xp` | app action XP | `{ kind (ACTIONS except booking), ref? }` | `{ok}` | `xpLog` cap 3,000 |
| GET | `/rewards` | XP/badges | — | rewards object + `repairs`, `overall`, `olympicLevel` | |
| POST | `/repair-streak` | spend repair | `{ date }` | `{ ok, repairs }` | `repairsUsed` |
| GET | `/library` | favorites+programs | — | `{ favorites, programs }` | |
| PUT/DELETE | `/favorites/:id` | toggle (≤500) | — | library | |
| GET | `/access` | gating (ungated) | — | `{ member:true, tier, freeUsed:false, freeLeft:null, reviewCode }` | |
| POST | `/generations` | legacy | — | `{ member:true }` | |
| POST | `/programs` | save generated workout (≤50) | `programInput` | 201 library | |
| DELETE | `/programs/:id` | delete | — | library | |
| PUT/DELETE | `/pinned/:programId` | pin content program (≤12) | — | `{ pinnedPrograms }` | |
| GET | `/content` | content + access | — | view + `access ("free"\|"member"\|"premium"), membership` | |
| POST | `/membership/request` | ask for tier | `{ tier, note? (≤500), rewardCode? }` | 201 `{ ok, request }` | owner email `"Membership request: …"`; activity |
| GET | `/meetings` | 1-on-1s | — | `{ meetings, allowance, minutes, usedThisMonth }` | |
| POST | `/meetings` | request | `{ topic (3-500), times (3-300) }` | 201 meeting; 403 non-premium; 409 allowance used | owner email `"1-on-1 request from <name>"` |
| GET/POST/PUT/DELETE | `/custom-workouts[/:id]` | workout builder (≤50, ≤30 exercises) | `{ name (≤60), exercises:[{id, sets (1-10), reps (1-100) \| seconds (5-600)}] }` | `{ workouts, saved? }` | |
| GET | `/challenges/members` | pool | — | `{ members:[{id,name,gem}] }` | |
| GET | `/challenges` | inbox/sent | — | `{ open[≤20], done[≤10], sent[≤20], xp:{send,done} }` | |
| POST | `/challenges` | send (≤10/day) | `{ workoutId, toId }` | 201 `{ challenge, xpEarned }` | writes `challenges` (cap 5,000); activity `challenge_sent` |
| POST | `/feedback-reports` | bug/suggestion (10/h) | `{ kind, title (2-100), body (2-4000), page?, userAgent? }` | 201 `{ok}` | owner email; activity `bug_report`/`suggestion` |
| GET | `/feedback-reports` | mine | — | array (no admin notes) | |
| GET | `/habits/today` | daily checklist | — | `{ date, goal, goalLevel, goalLevels, points, workoutXp, total, remaining, qualifying, recoveryOnly, habits[], workoutRules, streak, repairs }` | |
| PUT | `/habits/goal` | norm | `{ level: beginner\|intermediate\|pro }` | today view | |
| POST | `/habits/checkin` | tick | `{ habitId }` | 201 today view + `checked`; 409 dup/auto | |
| DELETE | `/habits/checkin/:habitId` | undo today | — | today view | |
| GET | `/habits/history` | month | query `month` | `{ month, today, days[], qualifyingDays, streak, repairs }` | |
| GET | `/intake` | patient docs | — | like public intake | audit |
| POST | `/intake/:doc` | save doc | fields | 201 | owner email `"Documents completed: <name>"` |
| GET | `/messages` | thread | — | `{ member, messages, unread }` | |
| GET | `/messages/unread-count` | — | — | `{ unread }` | |
| POST | `/messages/read` | mark doctor msgs read | — | `{ ok, marked }` | |
| POST | `/messages/:id/react` | reaction | `{ emoji\|null }` | message | socket |
| POST | `/messages` | send (40/h) | `{ body (≤2000) }` | 201 message | owner email `"New message from <name>"`; socket `new_message` to admin |
| POST | `/checkout/membership` | Stripe subscription | `{ tier, rewardCode?, ui?:"embedded" }` | `{ url, id }` or `{ clientSecret, id }`; 409 already subscribed; 503 disabled | Stripe customer/product/price/coupon; activity `checkout_started` |
| POST | `/checkout/protocol` | plan purchase | `{ service, sessions (packageSizes), plan (gold\|silver\|ext12\|ext24\|payg), ui? }` | same | adds `protocols[]` entry (pending) |
| POST | `/checkout/service` | single visit | `{ service, ui? }` | same | |
| GET | `/checkout/session/:id` | status | — | `{ id, status, paymentStatus }` | |
| POST | `/billing-portal` | Stripe portal | — | `{ url }` | |
| GET | `/payments` | mine | — | `{ enabled, protocols, membership, hasBilling }` | |
| GET | `/accountability` | credit | — | `{ activeDays, threshold:20, price:19.95, credit, owed, free, month }` | |

---

## 6. Realtime events (socket.io, path `/ws`, transports websocket+polling, ping 25 s / timeout 20 s)

| Namespace | Event | Payload | Receivers | Trigger |
|---|---|---|---|---|
| `/admin` | `online_count` | `{ members, pages }` | room `admin` | on admin connect, and whenever a member/public socket connects/disconnects |
| `/admin` | `activity` | `{ time, ...detail (sanitized), type }` | admins | every `activity()` call |
| `/admin` | `toast` | `{ text, type }` | admins | activity types `appointment, appointment_cancelled, lead, booking, message, subscribe, bug_report, suggestion, feedback` |
| `/admin` | `calendar_changed` | `{ dates:[] }` | admins | calendar watcher detects change |
| `/admin` | `new_message` | `{ clientId, clientName, at }` | admins | member sends message |
| `/admin` | `message_reaction` | `{ clientId, id }` | admins | either side reacts |
| `/member` | `new_message` | `{ from:"doctor", at }` | room `client:<id>` | admin reply / broadcast |
| `/member` | `message_reaction` | `{ id }` | that client | reaction |
| `/member`, `/public` | `slots_changed` | `{ date }` | all sockets in both namespaces | booking created/cancelled, consult scheduled, calendar watcher |
| `/member` (inbound) | `viewing` | page string (≤60) | server | member app reports current page → shown in `/api/admin/online` |

Online tracking: `onlineMembers` (socket id → `{id,name,since,page}`) and `onlinePages` (public sockets) in memory; `onlineStats()` feeds `GET /api/admin/online`. Single-process only (no Redis adapter).

---

## 7. Data records (JSON store collections)

File per collection `DATA_DIR/<name>.json`. All lists are full-file read/modify/write (no concurrency control beyond "re-read after awaits" patterns). ENC = field-level encrypted (§4).

| Collection | Shape | Notes |
|---|---|---|
| `settings` | `defaultSettings()` merged: `business{name,tagline,phone,email,address,mapsUrl,hours,instagram,facebook,tiktok,bookingNote}`, `rating{score,count,source,url}`, `coach{name,title,bio,photoUrl}`, `packages[≤6]`, `testimonials[≤20]`, `services[1-12]{id,name,rate,unit,protocol,withEval,remote,description}`, `plans{gold,silver,silverPayments,ext12,ext24,packageSizes[],guaranteeMin,reviewDiscountPct}`, `appointmentTypes[1-8]{id,name,minutes,description,remote?}`, `booking{provider,calUsername,calEventSlugs[],telehealthUrl}`, `scheduling{hours[7][][2],slotStepMin,lastStart,minNoticeHours,daysAhead,blockedDates[]}`, flags `version`, `massageAdded`, `telehealthPrices2026`, `telehealthHourly150` | |
| `appointments` | `{ id, typeId, typeName, minutes, date, time, name, email, phone, notes ENC, areas[], painLevel, status (booked\|completed\|no-show\|cancelled), adminNotes ENC, cancelToken, createdAt, updatedAt?, cancelledAt?, meetingLink?, meetingLinkSetByAdmin?, clientId?, rewardCode?, source? ("cal"\|"admin"), calUid?, googleEventId?, docs?{docId:iso}, intakeAt?, payment? ("exempt"\|"none") }` | `clientId` set only when a signed-in member booked with their own email or admin scheduled; member views match by **email**; intake "on file" counts only via `clientId` |
| `clients` | `{ id, email, name, firstName?, lastName?, phone, passwordHash (null for Google-only), pwv, googleSub?, plan{guides[],exercises[],notes ENC,updatedAt}, painLog[≤1000]{id,date,area,level,note ENC,createdAt}, workouts[≤2000]{id,title,goal,minutes,exercises,date,completedAt,kind,ref?,key?,metrics…}, vitals[≤1500]{date,restingHr,hrv,vo2max,weight,sleep,source}, xpLog[≤3000]{date,kind,ref}, repairsUsed[], favorites[≤500], programs[≤50], pinnedPrograms[≤12], assignedPrograms[≤12]{id,note ENC,assignedAt}, programHistory[≤40]{…,removedAt}, customWorkouts[≤50], referralCode, referredBy, referrals, freeUntil, reviewCode?, membership{tier,since,until,via?,stripeSubscriptionId?,status?,cancelAtPeriodEnd?,firstMonthDiscountPct?}\|null, membershipRequest?{tier,note,at,rewardCode?,discountPct?}, meetings[≤200]{id,month,topic,times,status,when,link,minutes,createdAt}, stripeCustomerId?, protocols[]{id,service,serviceName,sessions,plan,label,total,payments,paid,status,guarantee,checkoutSessionId,subscriptionId?,paidAt?,createdAt}, clientType?, clientTypeAt?, hideRank?, docs?{docId:iso}, intakeAt?, createdAt, lastLoginAt }` | |
| `leads` | `{ id, name, email, phone, service, goal, areas[], painLevel, duration, surgery, preferredTime, referral, message ENC, status (new\|contacted\|booked\|client\|closed), notes ENC, createdAt, updatedAt? }` | unshift (newest first) |
| `feedback` | `{ id, name, email, rating, text ENC, publish, status (pending\|approved\|hidden), rewardCode, rewardPct, rewardUsedAt?, createdAt }` | |
| `bookings` | `{ id, classId, date, name, email, phone, title, time, cancelToken, createdAt }` | class seats |
| `classes` | `{ id, active, title, day (0-6), time, durationMin, capacity, coach, location, description }` | seeded with 2 `STARTER_CLASSES` on first read |
| `subscribers` | `{ email, createdAt }` | |
| `activity` | `{ time, type, ...detail }` | cap `ACTIVITY_MAX = 500` |
| `messages` | `{ id, clientId, from ("client"\|"doctor"), body ENC, at, readAt, reactions?{client?,doctor?}, broadcastId?, emailedAt? }` | cap `KEEP = 100000`; deleted with client |
| `intakes` | `{ id, appointmentId? \| clientId?, doc? (info\|pain\|massage\|history\|consent; absent = legacy massage form), createdAt, data ENC(JSON) }` | re-submit replaces |
| `feedbackReports` | `{ id, kind (bug\|suggestion), status (new\|working\|resolved), clientId, clientName, clientEmail, createdAt, resolvedAt, adminNotes, data ENC{title,body,page,userAgent} }` | cap 2,000 |
| `content` | `{ programs[], lectures[], tiers[], recommendations[], live{}, tracks[], events[], contentVersion:5, knownDefaults[] }` | merged with `defaultContent()` by `programsOf` / `recommendationsOf` |
| `habits` | per member `{ clientId, since, checks[]{date,habitId,points,at}, grants[]{date,reason,at}, goalLog[]{from,level} }` | checks older than `KEEP_DAYS = 800` dropped on save |
| `habit-config` | `{ version:2, habits[], dailyGoal }` | |
| `challenges` | `{ id, fromId, fromName, toId, toName, workoutId, workout{name,exercises}, date, createdAt, status (open\|done), doneAt?, doneDate? }` | cap 5,000 |
| `referrals` | `{ referrerId, … }` (read only; written cap 5,000) | `saveReferrals` defined but no caller writes (verify) |
| `analytics` | `{ days{date:{views,unique,_visitors[],mix{dev,os,br,src,geo,country}}}, pages{}, referrers{} }` | days older than 90 pruned |
| `search-events` | `{ t, ts, q, qh, n, id?, pos? }` | ring 50,000 |
| `email-log` | `{ days{date:{sent,failed}} (60 days), failures[≤50]{at,to(masked),subject,error} }` | |
| `admin-mfa` | `{ enabled, method?, enabledAt? }` | |
| `calsync` | `{ icsUrl }` | |
| `calCache` | `{ username, eventTypes[], fetchedAt }` | Cal.com last-good |
| `googlePlace` | `{ id, name, address }` | |
| `googleReviews` | Places details + `fetchedAt` | |
| `stripeEvents` | `[eventId]` last 1,000 | idempotency |
| `audit-<YYYY-MM>`, `audit-state`, `audit-key`, `audit-trusted-keys`, `audit-anchors` | see §4 | |
| `videos-<cloudName>` | `{ done{key:{pid,type,version,bytes,format,compressed?}}, failed{key:msg} }` | |

### One-time migrations in `createApp` (run at every boot, guarded by flags)
1. `migrateSettings()` — if saved `settings.version < 3`: replaces `services`, `appointmentTypes`, plan discounts (`gold, silver, silverPayments, ext12, ext24`), `scheduling.hours/lastStart/minNoticeHours`, `business.hours`, `coach.title` with defaults; sets `version = 3`.
2. `telehealthPrices2026()` — once (`settings.telehealthPrices2026`): eval-remote `$300 → $150`; followup-remote 45 min/`$150` → 30 min/`$80`.
3. `telehealthHourly150()` — once (`settings.telehealthHourly150`): telehealth types/services priced at `$150/h` prorated (60 → $150, 30 → $75), replacing only old defaults `$300/$200/$150/$80`.
4. `settings()` accessor adds the `massage` appointment type once if missing and `massageAdded` not set.
5. `classes()` seeds `STARTER_CLASSES` when `classes.json` absent.
6. `content()`: `programsOf` returns defaults unless `contentVersion ≥ 5`; adds new built-in programs not in `knownDefaults`; `recommendationsOf` upgrades old tip titles/bodies and injects `sections`.
7. `habit-config` with `version != 2` is ignored (defaults used).
8. `lib/store.js`: plain files become encrypted on next write when `DATA_ENC_KEY` is set; `phiStore` encrypts plaintext PHI fields on next write.

---

## 8. Business rules

### Rewards / XP (`lib/rewards.js`, recomputed from history on every read; no stored counters)
- `XP.workout`: normal 30, custom 35, challenge 30, program 50. **Only the day's most valuable workout earns base XP**; others 0 (still count for badges/streaks). `challengeDone` +10 (once per challenge, once/day), `challengeSent` +5 (once/day). `pain` 5 (first 3 logs/day). `visit` 50 (appointment `status:"completed"` matched by email). `badge` 25 per badge. `checkin` 5 per vitals reading, max 2/day (10).
- `ACTIONS` (via `POST /api/me/xp`, per-day caps, same `ref` once/day): video 2×10, lecture 10×3, message 3×3, reaction 1×3, favorite 2×5, program 5×3, generate 2×3, share 5×1, booking 15×2 (server-derived from non-cancelled appointments, not postable), profile 5×1. Server stores up to `cap*3` entries/day.
- `DAILY_GOAL = 30` (rewards card). Workout kinds decided by `classifyWorkout` (`lib/custom-workouts.js`): key `custom-<id>` on own account → custom; `challenge-<id>` sent to this member → challenge (marks done); `track-*`/`painproto-*` → program; `prog-<programId>-…` matching a content program → program; else normal.
- `GEMS` (level = index+1): Peridot 0, Amber 51, Amethyst 501, Emerald 2,501, Ruby 7,501, Sapphire 15,001, Diamond 30,001, Platinum 60,001 (owner's ladder, Nov 7 2026).
- `BADGES` (14): first-workout 1, workouts-10/50/100, streak-3/7/30, week-3, hours-10 (600 min), explorer (5 goals), checkin-7, pain-5, pain-down (drop ≥3), first-visit.
- Streak repairs (rewards view, `repairsFrom`): 1 token per completed 3-consecutive-workout-day block; `POST /api/me/repair-streak` records date in `repairsUsed`.

### Habits / daily activities (`lib/habits.js`)
- Default list (20) with points: sunlight 15, acupressure 15, foam-rolling 15, ice-bath 20, health-shot 5, prayer 10, meditation 10, grounding 5, box-breathing 5, walk 15, sauna 15, stretching 5, yoga 20, no-screens 15, massage 20, journaling 5, red-light 10, active-recreation 10, plus auto items `challenge-send` 5 and `challenge-do` 10 (earned only by the challenge flow). One check per activity per day; undo same day only; points frozen on check.
- Daily norms `GOAL_LEVELS`: beginner 50, intermediate 75, pro 100 (default beginner; `DEFAULT_GOAL = 50` in config). A day **qualifies** when activities XP + workout XP ≥ that day's goal. Timeline from first activity (max 800 days).
- Streaks: every 3rd consecutive qualifying day earns a repair; `grants` add repairs; a gap of N missed days is bridged in the *displayed* streak only if N repairs are available (never makes a day qualifying). Exports `qualifyingDays(client, "YYYY-MM")`, `grantRepair`.

### Leaderboard / leagues (`lib/clients.js`)
- `OLYMPIC_XP = 1250` (level 4 Emerald): lifetime XP ≥ 1,250 → `olympic`, else `pro`. Periods day/week(Mon)/month/all. Top 10 per league (25 for `league=all`, real members only). Names "First L.". Board cached 60 s, invalidated by a stamp of record counts.
- Pacers: synthetic competitors (`PACER_NAMES`, deterministic by week/name) fill a league up to 9 entries; `LEADERBOARD_PACERS=off` disables. Pacers never count toward "#N overall".
- Challenges: pool = leaderboard members with XP, not hidden, not self; ≤10 sends/day; duplicate open challenge to same person/workout → 409.

### Memberships / tiers (`lib/content.js` defaults)
- Tiers: `member` "Accountability Membership" $19.95/mo (0 meetings); `premium` "Premium 1-on-1" $200/mo (2×30 min); `premium-plus` "Premium Plus" $349/mo (4×30 min). Access level: no membership → free (0); tier with `meetings=0` → member (1); `meetings>0` → premium (2). Content is currently served unlocked to everyone (`locked:false`, `/api/me/access` returns `member:true`).
- Membership granted by admin (`PUT /clients/:id/membership`) or Stripe subscription webhook. Referral: new signup with a valid `referralCode` → referrer gets `membership {tier:"member", until: +30 days, via:"referral-reward"}`. `FREE_MONTHS = 3` reported in `/api/me/referral` (no code applies it; verify).
- 1-on-1 meetings limited per calendar month to the tier's `meetings`.
- Review reward: any on-site review → `MDFIT-XXXXXX` code, `plans.reviewDiscountPct` (default 30) off first month, single use; also unlocks the free "plan-review" 30-min appointment type.

### Payments (`lib/payments.js`, Stripe API version `2026-10-28.endive`)
- Enabled only when secret key **and** webhook secret are set; otherwise checkout endpoints 503.
- Customer per client (`stripeCustomerId`, metadata `clientId`). Tier Price looked up by `lookup_key = mdfit_tier_<tier>_<cents>_monthly` (Product `MD Fit <tier name>`). Review coupon id `mdfit-review-<pct>` (`percent_off`, `duration:"once"`).
- Protocol quotes (`protocolQuote`, base = `(withEval ? evalRate : 0) + rate × n`): gold = base × (1 − gold%) one payment; silver = base × (1 − silver%) in `silverPayments` installments; ext12 = base × (1 + ext12%) in 12; ext24 = base × (1 + ext24%) in 24; payg (Bronze) = one visit at `rate`. Defaults gold 20, silver 0 (3 payments), ext12 5, ext24 10, packageSizes [6,12,24], guaranteeMin 12. Installments are subscriptions ended by a `subscriptionSchedule` with `end_behavior:"cancel"` after N months.
- `ui: "embedded"` → `ui_mode: "embedded_page"` with `return_url` carrying `session_id={CHECKOUT_SESSION_ID}`; else hosted (`url`). `integration_identifier` prefixes `mdfit_membership_`, `mdfit_protocol_`, `mdfit_installments_`, `mdfit_service_`.
- Accountability credit (`invoice.created` on `member` tier): −$1 per active day (workout or pain log day) in the billing period, capped at invoice amount; threshold 20 days = free month; `GET /api/me/accountability` previews it.
- Idempotency: `stripeEvents` keeps last 1,000 event ids; duplicate → `{received, duplicate:true}`.

### Booking (built-in scheduler, `server.js`)
- `openSlots(type, date)`: date within `[today, today+daysAhead]`, not in `blockedDates`; windows from `scheduling.hours[weekday]`, step `slotStepMin` (10/15/20/30/60), nothing starts after `lastStart` (default 16:00), must be ≥ `minNoticeHours` (24) ahead; blocked by any non-cancelled appointment of any type (single practitioner) and by busy intervals from Google Calendar freeBusy (all listed calendars) and SimplePractice ICS (parsed in `lib/calsync.js`, cancelled/transparent events skipped, all-day blocks whole day).
- Cal.com mode (`booking.provider = "cal"`): `/api/site` returns embed info (`username`, event types filtered by `calEventSlugs`); bookings arrive by webhook or `POST /api/admin/cal/sync` and are stored as appointments (`source:"cal"`), so built-in slots and member dashboards still see them. Cancelling in admin/member cancels in Cal (`POST /bookings/:uid/cancel`).
- Telehealth: appointment types with `remote:true`; `booking.telehealthUrl` (https) is copied to `meetingLink` at booking and emailed; admin can set a per-visit link (`meetingLinkSetByAdmin` survives Cal re-sync); member view falls back to the room link for remote types lacking one.
- Client types: `inpatient` (in-clinic; never charged for consults/video → `payment:"exempt"`, booking-link email says nothing to pay) vs `outpatient` (default; `payment:"none"`, fees settled outside this flow).
- Admin consult: lengths 15/30/45/60/90, future only, 409 on calendar/appointment overlap unless `force`.
- Group classes: 14-day booking window, capacity check, one booking per email per session.

### Intake packet (`lib/intake.js` `DOCS`)
| id | title | when | fields (k: type) |
|---|---|---|---|
| `info` | Client information | always | name text*, dob date*, sex radio, phone tel*, email email*, address, city, contactBy radio, occupation, emergencyName*, emergencyRelation, emergencyPhone*, doctor, heardFrom select |
| `pain` | Pain Assessment Initial Intake | non-massage | complaint textarea*, areas checks* (14 AREAS), started select*, how radio, painNow scale*, painWorst, painBest, feels checks, spreads, worse, better, timeOfDay, limits, treated, imaging radio, goals* |
| `massage` | Massage preferences | `massage`, `massage90` | focus*, painLevel scale, pressure radio, goals, avoid |
| `history` | Health history | always | conditions checks (23), surgeries, medications, allergies, redFlags yesno*, redFlagsMore, exercise radio, other |
| `consent` | Consent & policies | always | treatment agree*, privacy agree*, financial agree*, messages agree, signature sign* (+ `signedAt`) |
Members can complete the standard (eval) packet from the dashboard (`/api/me/intake`); it then counts for every appointment linked by `clientId`.

### Programs / content merge
- Built-in programs (23 ids): hypertrophy-12, dream-lean-12, shoulder-6, hip-6, low-back-6, knee-6, plantar-4, tennis-elbow-4, golfers-elbow-4, posterior-chain-6, mobility-12, mobility-ladder, anti-inflammatory, golf, pickleball, running, marathon, pickleball-intermediate, pickleball-advanced, golf-intermediate, golf-advanced, ski-advanced, marathon-extension. Categories `PROGRAM_CATS` (9), levels beginner/intermediate/advanced/elite, locations home/gym/outdoor/office, day goals upper/lower/full/core/mobility, lengths 15/20/25/30/45/60/90.
- `programsOf(saved)`: saved list only if `contentVersion ≥ 5`, plus built-ins newer than `knownDefaults`. `recommendationsOf`: 6 Health Tips (`diet-health-shots`, `bath-accu-mat`, `fitness-erg`, `mobility-diet-ratios`, `psg-protocol`, `weekly-tracking`) with `sections` from `lib/tips.js` (block types text/list/groups/table/facts/steps/callout/motto).
- Program progress (`programProgress`): workouts keyed `prog-<id>-w<week>` or `prog-<id>-d<day>`.

### Notifications (Resend via `lib/notify.js`)
- Enabled iff `RESEND_API_KEY` and `NOTIFY_FROM`. Serialised queue (≥600 ms gap), up to 8 tries, honours `retry-after`, batch endpoint for ≤100 recipients. Owner alerts go to `NOTIFY_EMAIL || ADMIN_EMAIL` plus `ALERT_EMAILS`.
- Subjects (owner): `New booking: <type>, <when>`; `Cancelled: <type>, <when>`; `New evaluation request: <name>`; `New review: N/5 from <name>`; `New client account: <name>`; `Membership request: <tier> ($X/mo)`; `1-on-1 request from <name>`; `New message from <name>`; `Group message sent to N people`; `New bug report from <name>` / `New suggestion from <name>`; `Documents completed: <name>[, <when>]`; `Massage intake received: …`; `Protocol purchased: <name>`; `Payment failed: <name>`; `Stripe alert: <event>`; `MD Fit audit anchor · entry #N`.
- Subjects (client): `You're booked: <type>, <when>`; `You're in: <class>, <when>`; `Thank you! N% off your first month`; `Your video visit link: <type>, <when>`; `Book your <type> with Dr. Jared`; `Video consultation with Dr. Jared: <when>`; `<code> is your MD Fit code`; `<code> is your MD Fit admin code`; `Your MD Fit plan was updated`; `Dr. Jared added a program for you`; `Your 1-on-1 with Dr. Jared is scheduled`; `Dr. Jared replied to your message`; `New message from Dr. Jared` / `Reminder: you have a message from Dr. Jared`; `Your MD Fit payment didn't go through`.

### Analytics
- `POST /api/hit` + `GET /api/admin/analytics` (page views, uniques by hashed IP+day, device/OS/browser/source/geo mix from UA and Vercel geo headers; 90-day retention). `GET /api/admin/search-analytics` (CTR per query). `GET /api/admin/email-log`.

---

## 9. Scheduled / background work (all in-process timers; `unref()`)

| What | Where | Interval |
|---|---|---|
| Calendar watcher `watchCalendar()`: re-reads Google/SimplePractice busy for `today..today+min(60,daysAhead)`, diffs per-day signature, emits `slots_changed` + `calendar_changed` | `server.js:1096-1125, 1279` | first run 5 s after boot, then every `CAL_WATCH_SECONDS` (60 s; 0 = off); only when Google configured or an ICS URL exists |
| Audit anchor | `server.js:452` | checks every 5 min; publishes once/day at ≥23:45 clinic time |
| Cloudinary media sync `autoSync` | `lib/videos.js:110-111` | 30 s after boot, then every 6 h (when Cloudinary configured); retries 5 min after a manifest failure |
| Rate-limit map pruning | `lib/security.js:68` | every `max(windowMs, 60 s)` per limiter |
| Caches | `calMem` Cal.com info 5 min (`CAL_CACHE_MS`), disk `calCache`; Google reviews 6 h (`REVIEWS_CACHE_MS`), retry 10 min, disk `googleReviews`; `calsync.busy` 3 min per range; leaderboard `board` 60 s + stamp; search signals 60 s; Stripe `priceCache`; Google certs 1 h; Google OAuth token until expiry−60 s; PHI decrypt cache 20,000 entries; in-memory MFA/reset codes (lost on restart) |

---

## 10. Tests (`node --test --test-concurrency=1 test/*.test.js`; each spins a real server on a random port with a temp `DATA_DIR` and fixed clock `2026-11-02T10:00Z`; refuse to run with `NODE_ENV=production`; `logger.level = 99`)

| File | Covers |
|---|---|
| `test/api.test.js` | date helpers; health/site/CORS; class schedule & booking; leads (validation, honeypot, admin workflow, CSV); newsletter; settings validation; admin login lockout; appointments availability/notice/overlap/cancel; scheduling settings; email notifications; services/plans/massage; reviews reward flow; analytics mix; intake packet; telehealth links; telehealth price migration |
| `test/clients.test.js` | signup/login/profile; token role separation; member appointments; pain log; admin client list/plan; reset link & pwv; lockout; streak math; workouts/stats; rewards math; library; metrics/vitals; appointment-type remote flag; content editor round-trip; member content/tiers/meetings; batch vitals/app config; pain tracks; access/review discount; messaging encryption/unread; broadcast audiences; Stripe checkout + webhooks + idempotency; checkout off without webhook secret; embedded checkout; referral code; password codes; leaderboard periods; become-a-patient docs; client type/programs/booking link/consult; PHI no double-wrap; intake-link docs on profile; glitchy sensor reading; health tips |
| `test/xp.test.js` | gem boundaries; workout XP rules; workout builder; challenges; hidden members; overall ranking |
| `test/habits.test.js` | activity list XP; admin edits don't rewrite history; daily norms 50/75/100; streak repairs; month history; track/painproto 50 XP |
| `test/audit.test.js` | hash chain + signatures, tamper detection; server records logins/admin views; admin email MFA; anchors + key rotation |
| `test/security.test.js` | edge gate; bot filter/headers/burst limit/client IP; no-store; store encryption + migration + wrong key; SimplePractice ICS parsing; Google Calendar service-account token/freeBusy/events; per-account rate limits; live calendar socket push; multi-calendar busy |
| `test/cal.test.js` | Cal.com signature/normalisation; builtin→cal switch; Cal down fallback; webhooks create/reschedule/cancel/forged; no secret; admin sync & cancel; bad key message; Cal video link; admin link survives re-sync |
| `test/google.test.js` | Places reviews: no key, find/cache/no key leak, Google down fallback, fixed place id, legacy API fallback |
| `test/notify.test.js` | Resend rate-limit queueing, 429 retry, batch of 100, group message notices/reminders, rejected address logged |
| `test/endpoints.test.js` | regression sweep: new built-in program pin/assign; membership save keeps Stripe id; name change clears first/last; feedback-report notes hidden from members; booking phone saved to account; short password doesn't burn code; installment paid during schedule setup; Cal cancel race; concurrent webhook ids; blank consult link uses room; stable referral code |
| `test/programs.test.js` | built-in programs assignable; resources validated; assign→progress→unassign→reassign keeps note, email has no note |
| `test/activity.test.js` | activity feed keeps event `type`; realtime activity event |
| `test/debug.test.js` | admin consult overlaps; reward-code race; program note encrypted; admin busy blocks |
| `test/search.test.js` | search logging/signals; invalid types/long queries |

Uncertain items flagged "(verify)": `referrals` collection has no writer; `FREE_MONTHS` is reported but not applied; `mdfit-srq/backend` root-directory comment vs. this repo layout.


# Part C — Frontend inventory


Repo: `Dr-Caban/mdfit-frontend` (local checkout `/home/user/mdfit-frontend`, branch `main`, HEAD `b8f85c7`, 2026-11-07). Static HTML/CSS/JS, no bundler, no framework, no npm dependencies at runtime. Backend is a separate repo (`Dr-Caban/mdfit-backend`, Node/Express on Railway). All facts below are read from the code; items marked **(verify)** could not be confirmed from the repo alone.

Sizes: 76 HTML files; 155 unique API method+path pairs across the site (68 member app, 71 admin, the rest public pages); largest scripts `account.js` 224 KB (2,788 lines), `musclereports.js` 297 KB (data), `admin.js` 124 KB (1,534 lines), `app/app.css` 126 KB.

---

## 1. Hosting & build

### 1.1 Vercel project
| Item | Value |
| --- | --- |
| Production domain | `https://www.mymdfit.com` (canonical links, sitemap, `check-live-build.js` uses `https://mymdfit.com`) |
| Vercel project name | `mdfit-srq` (named in `admin.html` analytics note: "Vercel Dashboard → mdfit-srq → Analytics"); `mdfit-srq.vercel.app` also named in `privacy-policy.html`. The www/apex redirect is Vercel-side configuration, not in the repo **(verify)** |
| Build | None. `vercel.json` has no `builds`/`framework`; files are served as-is with `cleanUrls: true` (so `/account` serves `account.html`) |
| Deploy ignore | `.vercelignore`: `scripts`, `.github` |
| Env vars read by the edge | `API_ORIGIN` (optional, overrides the Railway origin), `EDGE_SECRET` (value sent as the `x-mdfit-edge` header), `VERCEL_GIT_COMMIT_SHA` (first 12 chars returned as `x-mdfit-build`) |
| Web Analytics | Vercel Web Analytics via `/_vercel/insights/script.js` on every page |

### 1.2 `vercel.json` headers (exact)
Applies to `/(.*)`:

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy` | `default-src 'self' https://js.stripe.com; frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com https://accounts.google.com https://drive.google.com https://cal.com https://app.cal.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.googletagmanager.com https://va.vercel-scripts.com https://cdn.jsdelivr.net https://accounts.google.com https://apis.google.com https://app.cal.com; connect-src 'self' https://api.stripe.com https://amiable-peace-production-e382.up.railway.app https://*.vercel.app https://va.vercel-scripts.com https://vitals.vercel-insights.com wss://amiable-peace-production-e382.up.railway.app https://app.cal.com https://accounts.google.com https://oauth2.googleapis.com; img-src 'self' data: https:; media-src 'self' blob: https://res.cloudinary.com https://drive.usercontent.google.com https://drive.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; upgrade-insecure-requests` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |

Path-specific headers:

| Source | Headers |
| --- | --- |
| `/data/(.*)\.json` | `Cache-Control: no-cache` |
| `/:page(account\|book\|login\|admin\|cancel\|intake)` | `Cache-Control: no-cache` |
| `/` | `Cache-Control: no-cache` |
| `/(.*)\.(js\|css\|html)` | `Cache-Control: no-cache` |
| `/sw.js` | `Cache-Control: no-cache` |
| `/account`, `/admin`, `/cancel` | `X-Robots-Tag: noindex, nofollow` |
| `/intake` | `X-Robots-Tag: noindex, nofollow` + `Cache-Control: no-store` |

Cache strategy: everything text is `no-cache` (revalidate every time); freshness of CSS/JS is guaranteed by `?v=<hash>` stamping (1.4) rather than long-lived caching. Images under `/assets/` use Vercel defaults.

### 1.3 Redirects (`vercel.json`) and the edge proxy (`middleware.js`)
Redirects:

| Source | Destination | Permanent |
| --- | --- | --- |
| `/privacy` | `/privacy-policy` | yes (308) |
| `/evaluation` | `/book?type=eval` | no |
| `/call` | `/book?type=call` | no |
| `/consult` | `/#intake` | no |
| `/assets/pain/guide-:id-thumb.webp` | `/assets/guides/:id-thumb.webp` | no |
| `/assets/pain/guide-:id.webp` | `/assets/guides/:id-anatomy.webp` | no |
| `/assets/pain/body-map:size.webp` | `/assets/pain/body-figures.webp` | no |

There are **no `rewrites`** in `vercel.json` and **no `api/` directory**. The API proxy is a Vercel Routing Middleware, `middleware.js` (`export const config = { matcher: "/((?!_vercel).*)" }`), which runs before every page and API request:

1. **Country lock**: `x-vercel-ip-country` must be in `US, PR, GU, VI, AS, MP, UM`, else a 403 HTML page ("Not available in your region").
2. **Bot filter**: empty UA or a UA matching `BAD_UA` (curl, wget, python-requests, axios, headless, playwright, GPTBot, ClaudeBot, Bytespider, PerplexityBot, etc.) gets 403. Search engines (`googlebot|bingbot|duckduckbot|applebot`) are allowed except on `PRIVATE = /^\/(account|admin|api|login|cancel|intake)/`.
3. **`/api/*` proxy**: forwards method, body and headers to `API_ORIGIN || "https://amiable-peace-production-e382.up.railway.app"` + path + query, after deleting `host`, `x-mdfit-edge`, `x-mdfit-client-ip`, `cookie` from the inbound headers and setting `x-mdfit-edge: <EDGE_SECRET>` (the backend refuses requests without it) and `x-mdfit-client-ip: <first of x-real-ip / x-forwarded-for>` (for rate limiting). Response is streamed back with `content-encoding`, `content-length`, `transfer-encoding`, `connection` stripped and `x-mdfit-build` added. `redirect: "manual"`.
4. Otherwise returns `x-middleware-next: 1` with `x-mdfit-build`.

`config.js` sets `window.MDFIT_CONFIG = { apiUrl, realtimeUrl }`: on `localhost`/`127.0.0.1` both are `http://localhost:3000`; in production `apiUrl = location.origin` (so every API call goes through the edge proxy) and `realtimeUrl = "https://amiable-peace-production-e382.up.railway.app"` (WebSockets cannot pass the edge proxy, so socket.io connects directly to Railway with a login token).

### 1.4 `scripts/version-assets.js` (run before every commit that touches CSS/JS)
- Rewrites every `src="…js"`/`href="…css"` in root `*.html` and `guides/*.html` to `…?v=<sha1 of file, 8 hex>` when the file exists locally (external and `/_vercel/` URLs untouched).
- Builds `build = sha1(all css/js/html except sw.js, walking the repo skipping dot dirs, node_modules, scripts)` (10 hex) and rewrites `sw.js`: `const CACHE = "mdfit-<build>"` and `const SHELL = [...]` where SHELL = `"/account"` + every local CSS/JS that `account.html` loads + `"/assets/logo.webp"`.
- Current values: `CACHE = "mdfit-558b5038fc"`; SHELL = `/account, /nozoom.js, /app/app.css, /account.css, /guides.css, /config.js, /analytics.js, /realtime.js, /common.js, /search.js, /app/exercises.js, /app/library.js, /app/generator.js, /painmuscles.js, /painpatterns.js, /paintracks.js, /painmap.js, /musclereports.js, /guides.js, /stripe-checkout.js, /account.js, /account-xp.js, /account-habits.js, /assets/logo.webp`.
- Companion: `node scripts/site-header.js && node scripts/version-assets.js` regenerates the shared public header (between `<!-- site-header -->` markers; skips `account.html` and `admin.html`).

### 1.5 Service worker (`sw.js`)
- Registered only by `account.js`: `navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })`; `reg.update()` on every `visibilitychange` to visible; on `controllerchange` (when a controller already existed) the page reloads once.
- `install`: `caches.open(CACHE).addAll(SHELL)` then `skipWaiting()`. `activate`: delete every cache whose name is not `CACHE`, then `clients.claim()`.
- `fetch`: only same-origin GET. **Network first** (`fetch(req, { cache: "no-cache" })`); successful responses for SHELL paths are copied into the cache; on network failure falls back to `caches.match(req, { ignoreSearch: true })`. API calls are never cached.

### 1.6 PWA manifest (`manifest.webmanifest`)
`name`/`short_name` "MD Fit"; `start_url: "/account"`; `scope: "/"`; `display: "standalone"`; `background_color`/`theme_color` `#0A1A2E`; icons `/assets/app-icon-192.png` and `/assets/app-icon-512.png` (`purpose: "any maskable"`). Linked only from `account.html`, which also sets `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title: MD Fit`, `apple-touch-icon: assets/app-icon-192.png`, and `viewport … maximum-scale=1, user-scalable=no, viewport-fit=cover`. `nozoom.js` (every page) sets `touch-action: manipulation` and cancels `gesturestart/gesturechange/gestureend` and multi-touch `touchmove` (iOS pinch zoom).

### 1.7 `analytics.js`
- Defines the `window.va` queue stub and registers `va("beforeSend", fn)`: returns `null` (drops the event) when the path matches `/^\/(admin|intake|cancel|account)/`; otherwise strips `search` and `hash` from the URL. Vercel's `/_vercel/insights/script.js` is loaded `defer` after it.
- Sends a first-party page-view beacon: `navigator.sendBeacon(API + "/api/hit", Blob{ page: location.pathname, referrer: <origin+pathname of document.referrer, no query>, utm: utm_source || ref_src || "", w: innerWidth })` (fetch keepalive fallback). Admin "Analytics" reads these.

### 1.8 CI (`.github/workflows`, git-tracked but Vercel-ignored)
- `layout.yml` ("Mobile layout"): on push/PR, checks out `Dr-Caban/mdfit-backend` into `_backend`, `npm ci`, installs `playwright@1.63.0` + Chromium in `scripts/`, runs `node layout-check.js` with `BACKEND_DIR=../_backend`.
- `live-build.yml` ("Live site is current"): on push to `main`, runs `scripts/check-live-build.js` with `SITE=https://mymdfit.com`, `EXPECTED_SHA=${{ github.sha }}`, `WAIT_MINUTES=6`: polls `/` until the `x-mdfit-build` header equals (or is a descendant of) the pushed commit.

---

## 2. Every page

Common to all public pages: `/nozoom.js`, Google Fonts (`Libre Baskerville` + `Montserrat`), `/site-header.css` + `/site-header.js` (shared header generated by `scripts/site-header.js`), `/config.js`, `/analytics.js` (defer), `/_vercel/insights/script.js`. Pages that include `common.js` also fire `GET /api/videos` on load (Cloudinary map cache, key `mdfit-cdn2`) and set the header "Log in"/"My account" link from `mdfit_client`.

| Path | File | Purpose | Auth | Scripts / styles beyond the common set | API calls (method path) |
| --- | --- | --- | --- | --- | --- |
| `/` | `index.html` | Marketing home (see §5) | none; `/#pricing` buy buttons redirect to `/login?next=/#pricing` | `styles.css`, `guides.css`; `realtime.js`, `common.js`, `booking.js`, `stripe-checkout.js`, `pricing.js`, `app.js`, `painmuscles.js`, `painpatterns.js`, `paintracks.js`, `guides.js`, `painmap.js`; inline `MDFitRT.connect({namespace:"/public"})` | GET `/api/site`; GET `/api/reviews`; GET `/api/videos`; GET `/api/content` (paintracks); GET `/api/feedback`; GET `/api/feedback/reward/:code` (when `?reward=`); POST `/api/feedback`; POST `/api/leads`; POST `/api/subscribe`; GET `/api/availability?type&from&days=7`; POST `/api/appointments`; GET `/api/app/config`; POST `/api/me/checkout/protocol`; POST `/api/me/checkout/service`; POST `/api/hit`; socket `/public` (`slots_changed`) |
| `/book` | `book.html` | Standalone booking page, `?type=eval\|call\|session` | none (member token used if present) | `styles.css`, `book.css`; `realtime.js`, `common.js`, `booking.js`; inline mount | GET `/api/site`; GET `/api/reviews`; GET `/api/videos`; GET `/api/availability?…`; POST `/api/appointments`; POST `/api/hit`; socket `/public` |
| `/login` | `login.html` | Log in / create account / forgot / code / reset; Google Sign-In | none (redirects to `next` if already logged in) | `styles.css`, `account.css`; `https://accounts.google.com/gsi/client` (tag in head, and again injected when `googleClientId` exists); `common.js`; inline | POST `/api/clients/login`; POST `/api/clients/signup`; POST `/api/clients/forgot`; POST `/api/clients/verify-code`; POST `/api/clients/reset`; GET `/api/app/config`; POST `/api/clients/google`; GET `/api/videos`; POST `/api/hit` |
| `/account` | `account.html` | Member app (§3) | required: `mdfit_client` else `location.replace("/login?next=/account"+hash)` | `app/app.css`, `account.css`, `guides.css`; `realtime.js`, `common.js`, `search.js` (defer), `app/exercises.js`, `app/library.js`, `app/generator.js`, `painmuscles.js`, `painpatterns.js`, `paintracks.js`, `painmap.js`, `musclereports.js`, `guides.js`, `stripe-checkout.js`, `account.js`, `account-xp.js`, `account-habits.js`; manifest + SW | see §3.13 (68 endpoints) |
| `/admin` | `admin.html` | Admin portal (§4) | required: `sessionStorage.mdfit_token` (admin JWT), else login form | `styles.css`, `admin.css`; `realtime.js`, `painmuscles.js`, `paintracks.js`, `admin-habits.js`, `admin.js` | see §4.11 (71 endpoints) |
| `/intake` | `intake.html` | Intake document packet. Modes: `?id=<12 hex>&token=` (private link from booking email) or `?me=1` (signed-in member, "Become a patient") | token mode: none; member mode: `mdfit_client` else redirect to `/login?next=/intake?me=1` | `styles.css` + inline styles; inline script (no `common.js`) | GET `/api/appointments/:id/intake?token=` or GET `/api/me/intake`; POST `/api/appointments/:id/intake/:docId` (body includes `token`) or POST `/api/me/intake/:docId`; POST `/api/hit` |
| `/cancel` | `cancel.html` | One-click cancel from email: `?kind=appointment\|class&id=<12 hex>&token=` | token in URL | `styles.css`; inline | POST `/api/appointments/:id/cancel` or POST `/api/bookings/:id/cancel` `{ token }`; POST `/api/hit` |
| `/events` | `events.html` | Upcoming events list | none | `styles.css`; `common.js`; inline | GET `/api/content` (`events[]`); GET `/api/videos`; POST `/api/hit` |
| `/privacy-policy`, `/terms` | `privacy-policy.html`, `terms.html` | Legal | none | `styles.css`, `legal.css` (no config/analytics beacon) | none |
| `/best-rehab-near-me-sarasota`, `/chronic-pain-sarasota`, `/golf-performance-sarasota`, `/medical-massage-sarasota`, `/pickleball-injury-rehab-sarasota`, `/post-op-knee-rehab-sarasota`, `/post-op-shoulder-rehab-sarasota`, `/running-injury-sarasota`, `/sciatica-treatment-sarasota` | 9 SEO landing pages | Static SEO landers | none | `/guides.css`, `/conditions.css` | POST `/api/hit` only |
| `/conditions/` + 25 pages (`achilles-tendon-pain`, `balance-fall-prevention`, `carpal-tunnel-wrist-pain`, `chronic-pain`, `frozen-shoulder`, `golfers-elbow`, `herniated-disc`, `hip-pain`, `it-band-syndrome`, `jaw-tmj-pain`, `knee-pain`, `low-back-pain`, `medical-massage`, `neck-pain`, `pelvic-floor-rehab`, `piriformis-syndrome`, `plantar-fasciitis`, `post-surgical-rehab`, `rotator-cuff-tear`, `sciatica`, `scoliosis-support`, `shin-splints`, `shoulder-pain`, `sports-injury-rehab`, `tennis-elbow`) | `conditions/*.html` | Static condition pages | none | `/guides.css`, `/conditions.css` | POST `/api/hit` |
| `/treatments/` + 7 (`chronic-pain-program`, `clinical-exercise-physiology`, `functional-mobility`, `medical-massage`, `post-op-rehab-timelines`, `strength-and-performance`) | `treatments/*.html` | Static | none | same | POST `/api/hit` |
| `/areas/` + 5 (`bradenton`, `lakewood-ranch`, `osprey`, `sarasota`, `venice`) | `areas/*.html` | Static local-SEO | none | same | POST `/api/hit` |
| `/blog/` + 10 posts (`desk-worker-5-fixes`, `golf-back-pain-hip-problem`, `knee-replacement-12-week-comeback`, `low-back-pain-hips`, `pickleball-injuries-sarasota`, `running-over-50`, `sciatica-or-glute`, `shoulder-clicks-when-to-worry`, `three-muscles-knee-pain`, `what-is-a-cep`) | `blog/*.html` | Static articles | none | same | POST `/api/hit` |
| `/guides/calf`, `/guides/iliopsoas`, `/guides/lateral-hip`, `/guides/posterior-neck`, `/guides/quads`, `/guides/rotator-cuff`, `/guides/scalenes` | `guides/*.html` | Standalone referred-pain guide pages | none | `/guides.css`; `/guides.js` (no config/analytics) | none |

`robots.txt` disallows `/account`, `/admin`, `/api/`, `/login`, `/cancel`, `/intake`, `/data/` for all agents and blocks GPTBot/ChatGPT-User/OAI-SearchBot/CCBot/ClaudeBot/anthropic-ai/Google-Extended/Bytespider/PerplexityBot/Amazonbot entirely. `sitemap.xml` lists 71 URLs.

`index.html` also contains a `<dialog id="book-dialog">` with `#book-form` ("Reserve my spot", class booking) that **no script references** (dead markup) **(verify)**.

---

## 3. Member app in depth (`/account`)

Scripts: `account.js` (core), `account-xp.js` (gem card, workout builder, challenges), `account-habits.js` (daily activities + calendar paint). `account.js` exposes `window.MDFitApp = { startPlayer, go, loadRewards, toast, celebrateToast, exMeta, byId, gemIcon, rewards(), showBoard(period, league) }` for the add-ons; `account-habits.js` exposes `window.MDFitHabits = { reload }`.

### 3.1 Storage keys (all `localStorage` unless noted)
| Key | Owner | Shape |
| --- | --- | --- |
| `mdfit_client` | `common.js` `MDFit.auth` | `{ token: <Bearer JWT>, expiresAt: <ISO>, client: { id, name, email, phone, referralCode, hasPassword, plan{notes,exercises[],guides[],updatedAt}, assignedPrograms[{id,note}], pinnedPrograms[], membershipRequest, … } }`. `auth.get()` returns null when `Date.parse(expiresAt) <= now`. Updated via `auth.set({...auth.get(), client})` after `/api/me`, profile and password saves (password save stores the whole new session `r`). Cleared on 401 (then redirect to `/login?next=<path>`) and on Log out. |
| `mdfit-cdn2` | `common.js` | `{ cloud: <cloudinary cloud name>, map: { <driveId>: [public_id, "v"\|"i", version] } }` from `GET /api/videos` |
| `mdfit_prefs3` | `account.js` (`PREFS_KEY`) | last generator choices merged over `Gen.DEFAULTS` (type, goal, location, level, length, perRound, rounds, restEx, restRound, addons{}) |
| `mdfit_today3` | `account.js` (`TODAY_KEY`) | `{ date: <YYYY-MM-DD clinic tz>, workout: <generator output> }` — "Today's workout" |
| `mdfit.player.v2` | `account.js` (`PLAY_KEY`) | `{ breaks: bool, sound: bool, soundSet: bool }` player options (defaults: breaks off, sound on unless `soundSet`) |
| `mdfit_review_code` | `account.js` (paywall) and `app.js` (homepage review) | JSON string of the review reward code (30% off first month) |
| `mdfit-seen-inbox`, `mdfit-seen-inbox-unseen`, `mdfit-seen-badges`, `mdfit-seen-level`, `mdfit-seen-ms-count`, `mdfit-seen-visits` | `account.js` `seenStore` | notification inbox (max 25 items), unseen count, earned badge ids, last level, milestone counter, `{ "<apptId>:<date>": 1 }` |
| `mdfit-device` | `account.js` `HR` | name of the paired Bluetooth HR device (unlocks HR/HRV/VO2 fields) |
| `mdfit_prefs`, `mdfit_prefs1`, `mdfit_prefs2`, `mdfit_today`, `mdfit_today1`, `mdfit_today2` | `account.js` | legacy keys, deleted on load |
| `sessionStorage.mdfit_token` | `admin.js`, `admin-habits.js` | admin bearer token (admin only) |

### 3.2 Navigation
- `TABS = ["home","generate","programs","videos","pain","learn","progress","leaders","premium","messages","tips","profile"]`; each is `<section class="view" data-view="…" id="view-…">`; bottom `<nav class="tabbar">` with `[data-tab]` buttons; tabs with class `ov` (programs, learn, leaders, premium, messages, tips) live behind the "More" sheet (`#more-sheet`) on phones, which also lists "Pain Tool", "Video Library" and a `data-action="book"` shortcut.
- Hash routing: `show(hash)` parses `"<tab>/<sub>/<arg>"`. `go(tab)` does `history.pushState(null,"","#"+tab)` then `show(tab)` (no `hashchange` fires; `account-habits.js` therefore watches the views' `hidden` attribute with a `MutationObserver`). `hashchange` → `show`. Any `[data-goto]` click → `go()`.
- Deep links: `#pain/muscle/<muscleId>` (muscle report), `#pain/track/<trackId>` (starts the track in the player, then `replaceState` to `#pain` on close), `#programs/<id>`, `#programs/<id>/<weekKey>`, `#programs/sport/<Sport>[/<level>]`, `#tips/<tipId>`, `#messages/dr` (thread), `#guide/<id>` (guides.js), `?checkout=success` (Stripe return: toast, `replaceState` to `/account#…`, re-fetch `/api/me/access` after 4 s).
- Login redirect allows `next` only matching `/^\/[a-z]*(\?me=1)?(#[a-z0-9/-]*)?$/`.

### 3.3 Boot sequence (`account.js` tail)
`show(hash)` → `GET /api/me` (store client) → `Promise.allSettled([GET /api/me/stats, loadAppointments, loadPain, GET /api/me/workouts, GET /api/me/library, loadReferral])` → `GET /api/me/vitals`, `pollUnread()`, `loadPatientDocs()` (`GET /api/me/intake`), `GET /api/me/access`, `loadContent()` (`GET /api/me/content`, fallback `GET /api/content` with `access:"free"`), `loadRewards()` (`GET /api/me/rewards`), `loadSite()`. Socket: `MDFitRT.connect({ namespace: "/member", token })` immediately.

### 3.4 Workout player (`startPlayer(w)`)
- Input workout shape: `{ title, key, goal, goalId, location, level, levelLabel, rounds, restEx, restRound, minutes, warmup[], circuit[], cooldown[], exercises[], perRound, noRest?, chipper? }`; each exercise is a library entry plus `sets` (text like "10 reps", "30 sec", "3 × 8 slow") and `block` ("Warm-up" / "Circuit" / "Cool-down" / custom label).
- `buildSteps`: warm-up once → for each round every circuit move (label `Round r of n`, or the move's `block` when rounds===1 and block≠"Circuit") with `{rest: restEx}` between moves unless `noRest` → `{rest: restRound}` between rounds → cool-down.
- Options (`#p-opts`): `breaks` (when off, `skipRests()` jumps over rest steps) and `sound` (video `muted = !opt.sound`; a `NotAllowedError` autoplay falls back to muted and marks the Sound button `blocked`). `#p-fs` fullscreen; `#p-hr` Web Bluetooth `heart_rate` service (Chrome only) → `HR.samples`.
- Per-move timer: `Gen.stepSecs(sets)` (timed holds as written; reps×4 s, slow/gentle ×6 s, min 30; default 45). Video `ended` → `advance()`; steps without a video id or using the Drive iframe fallback auto-advance after `max(total, 20)` s. Video src = `MDFitVideo.mp4(id)`; on `error` or no frame within 6 s → `<iframe src="https://drive.google.com/file/d/<id>/preview">`. Next video is pre-warmed (`warmVideo(nextId,"auto")`).
- Circuit moves show a "Weight used" input → `P.log[exId] = { name, weight }`.
- **Finish** → `POST /api/me/workouts` `{ title (≤80), goal, minutes (1–300, rounded from elapsed), exercises (≤50), key, seconds (1–18000), lifts: [{name, weight}], hrAvg?, hrMax?, source? }`; response `{ workout, stats }`; then `numbersForm` (RPE 1–10 auto-saves `PATCH /api/me/workouts/:id {rpe}`; HR/HRV/VO2/calories via the same PATCH), `loadRewards(true)`, and `document.dispatchEvent(new CustomEvent("mdfit:workout", {detail: workout}))`.
- Workout `key` values (the server uses them for XP rules and progress): generated workouts have no key (falls back to slugified title); saved program `program-<id>`; premade program day `prog-<programId>-d<i>`; protocol week `prog-<programId>-w<weekKey>`; pain track `track-<trackId>`; muscle protocol `painproto-<muscleId>`; builder workout `custom-<id>`; challenge `challenge-<id>`.

### 3.5 Workout generator (`app/generator.js`, `window.MDFitGen`)
Inputs (`generate(input)`): `type` ("workout"\|"rehab"), `goal` (`upper`, `lower`, `full`, `core`, `mobility`), `location` (`home`, `gym`, `outdoor`, `office`), `level` (`beginner` 1–3, `intermediate` 2–6, `advanced` 4–8, `elite` 6–9 — library level bands), `length` (10/15/20/30/45/60/90; 25 used by programs), `perRound` (2–10), `rounds` (1–10), `restEx` (0/15/20/30/45/60/90), `restRound` (0–180), `addons { warmup, cooldown, mobility, core, balance, sport, bodyweight }`, `seed`, `fixed` (program days). `DEFAULTS = { type:"workout", goal:"full", location:"home", level:"intermediate", length:45, perRound:8, rounds:5, restEx:0, restRound:0, addons:{warmup:false,cooldown:false} }`. `PRESETS[length] = [perRound, rounds, restEx, restRound]` (e.g. 45 → `[8,5,15,45]`).

Output: `{ title ("<Goal> <Foundations|Strength|Power|Performance>", "Rehab Session: …", "Mobility & Recovery Flow"), type, note, goal, goalId, location, level, levelLabel, perRound, rounds, restEx, restRound, addons, chipper, chipSecs, warmup, circuit, cooldown, exercises, warmupOpt, cooldownOpt, prep, extraMin{warmup,cooldown}, minutes, seed, createdAt }`. Prescriptions from `PRESCRIBE[cat][level]`; rehab moves use `rehabRx(name)`; one-round "chipper" workouts compute high reps from `chipperRx`. Also `swap(w, block, index, seed)`, `estimate()`, `presetFor()`, `byLocation()`, `needsGym()` (EQUIP regex), `stepSecs()`. Seeded LCG RNG so program days repeat deterministically. Home "Today's workout" seed = `daySeed(date + clientId)`; "10-minute" variant seed suffix `-10`. Free accounts: first generation calls `POST /api/me/generations { workout: compactW }` (server returns `member` or saves it as the free program with `free:true`); further generation opens the paywall.

### 3.6 Programs / protocols
- Content from `GET /api/me/content` (`C`): `programs[] { id, title, category, level, location, weeks, seed, access, locked, summary, notes, image, sport, days[{name,goal,length,rounds?,restEx?,restRound?,circuit?[{ex,sets}],seedOffset?}], resources[] }`, `categories[]`, `lectures[]`, `topics[]`, `live{}`, `tiers[]`, `recommendations[]`, `membership`, `access` ("free"\|"member"\|"premium"), `tracks[]`.
- `programWorkout(p)` = saved "My Programs" entry (`lib.programs`, key `program-<id>`); `progDayWorkout(p,i)` = `Gen.generate({fixed:true, seed: p.seed + seedOffset + i*101, …})` with a fixed circuit when `d.circuit` is set (names resolved via `VIDEO_ALIAS`, ~70 entries mapping sheet names to library names); `protoWorkout(p, pr, wk, group)` builds a week (or one "Workout A/B" group) from `/data/protocols/<id>.json` using `libMatch()` (exact → alias → `VIDEO_FIX` → ≥0.6 word overlap).
- `LEVEL_NAMES = { beginner:"Beginner", intermediate:"Intermediate", advanced:"Expert", elite:"Pro" }` (stored ids stay beginner/intermediate/advanced/elite); `LEVEL_ORDER`. Sport Performance programs are grouped into sport "folders" (`sportOf`).
- Protocols: `/data/protocols/index.json` `{ version, ids[], weeks{id:n} }` (17 protocols), each file `{ id, title, tagline, goal, principles[], dailyBasics[], progression{overview[],guidelines[],expect[],callouts[],remember,footer}, weeks[{ key, label, driveId, focus, goal, principles, notes, editorNotes, exercises[{ n, printedNumber, name, isNew, dailyBasic, whenToUse, howTo[], why, focus[], dosage{sets,reps,tempo,hold,frequency,other{}}, steps[], proTip, workout?, workoutNote? }] }] }`. Sheet images: `assets/protocols/<id>/<weekKey>-960.webp` / `-1600.webp` (zoom dialog `#sheet-dialog`). `protoCurrentWeek()` suggests the week from the first logged `prog-<id>-w*` date.
- Program posters: `assets/programs/<name>.png` with web variants `assets/programs/web/<name>-{192,640,1200}.webp` and square `-thumb-{192,384}.webp` (`progImg`), `PROG_ART` regex fallbacks, `progPoster` draws the title text in HTML.
- "Save to my dashboard" = `PUT/DELETE /api/me/pinned/:id` → `client.pinnedPrograms`; assigned programs come from `client.assignedPrograms[{id,note}]` ("From Dr. Jared" on Home, `#my-plans`).

### 3.7 Pain tool
- Active UI (`#view-pain`): `painmap.js` `MDFitPainMap.init([data-painmap="app"])` draws SVG regions from `MDFitMuscles.BODY_REGIONS` (32 regions: 16 pairs/centers mirrored, ids like `f-head`, `f-chest-r`, `f-chest-l`, with `view`, `side`, `spots[]`, `tracks[]`) over `assets/pain/body-figures.webp` (1182×1073) masked by `assets/pain/body-mask.png`. Tap → `<dialog class="pm-sheet">` "Tap the pattern that matches your pain" listing the region's tracks (or `MUS.rank(spots)` top muscles' tracks) drawn by `painpatterns.js` (`MDFitPatterns.html(trackId)`: red ellipses = pain, × = trigger point, on fixed 4:5 crops `f-up, f-arm, f-trunk, f-hip, f-knee, b-up, b-arm, b-low, b-leg, b-calf`). In the app a track tap sets `location.hash = "pain/track/<id>"` → player; on the homepage it opens `MDFitTracks.open(id, { startLabel, onStart → /account#pain/track/<id> })`.
- `paintracks.js` (`window.MDFitTracks`): 26 built-in `TRACKS` (`scalene-chest, pec-major, pec-minor-rib, scalenes, supraspinatus, subscapularis, anterior-deltoid, levator, infraspinatus, triceps, serratus, extensor-radialis, medial-forearm, radialis-general, foot, calf-soleus, iliacus, psoas, ql, hip-general, glute-max, glute-min, groin-rotational, pectineus, external-oblique, knee`), fields `{ id, title, region, img[driveIds], pts[muscleIds], note, levels[{ title, videos[{ file, id|null, name }] }] }` (139 video entries, 25 with `id: null` = "coming soon"). Regions: Chest, Neck & shoulder, Shoulder, Upper arm, Ribs, Forearm, Foot, Calf, Hip & groin, Low back & hip, Low back, Hip, Glutes, Abdomen, Knee. `ready` = `GET /api/content` → `setTracks(c.tracks)` (admin edits override; empty = built-in). Own `<dialog class="tk-dialog">` player (loops each clip `LOOPS` times, "Play the whole track").
- `painmuscles.js` (`window.MDFitMuscles`): `MUSCLES` (67 ids, `{ name, does, refers, worse[], videos[], attach }`), `AGGRAVATORS` (14: sitting, standing, screens, overhead, reaching-back, gripping, sleeping, stairs, running, breathing, turning, lifting, stress, clenching), `SPOTS` per area id (`head, neck, shoulder, chest, elbow, wrist, hip, thigh, knee, ankle, head-b, neck-b, upper-back, shoulder-b, low-back, glute, hamstring, calf, heel`), `MAPS` (`body-front`, `body-back`, `shoulder-front`, `shoulder-back` crops with points), `rank(spotKeys, aggravators)`, `areaOf`.
- `musclereports.js` (`window.MDFIT_MUSCLE_REPORTS`, 67 reports): `{ origin, insertion, action, nerve, symptoms[], questions[{q,w}], tests[{name,how,positive}], causes[], mimics[], redFlags[], protocol{ calm[], restore[], strengthen[] } (steps { name, video, dose, how }), habits[], expect, seePro }`. `openReport(id)` renders the report at `#pain/muscle/<id>`; self-check verdict ≥60% strong / ≥30% possible; "Start" a phase → `protocolWorkout([phase])` (key `painproto-<id>`, restEx 15); "Save to My Programs" → `POST /api/me/programs`; "Log it" → `POST /api/me/pain { area, level, note }`.
- `account.js` also still contains an older area-chip flow (`PAIN.front/back`, `#areas`, `#pain-refine`, `#mode-area/#mode-muscle`, `#muscle-map`, `GROUPS`) guarded by `if ($("#areas"))`; those elements are **not in `account.html`**, so that code is dormant.
- Pain tracker (Progress tab): `#pain-form` → `POST /api/me/pain`; `GET /api/me/pain` → table + SVG line chart per area (`#chart-area`); `DELETE /api/me/pain/:id`.

### 3.8 Videos (`#view-videos`)
- Library = `window.MDFIT_EXERCISES` (155, §6.1) classified by `app/library.js` (`MDFitLib`): `kind` (Exercise\|Rehab from `cc`), `category` (5: Strength training, Stretching, Rehabilitation, Specialty movements, Mobility; `CAT_BY_KIND`), `joint` (11 `JOINTS`), `muscle` (15 `MUSCLES`). Filters: kind (`#vid-kind`), category chips (`All`, `♥ Favorites`, …), location (`#vid-locs` from `Gen.LOCATIONS` + `Gen.byLocation`), group by joint/muscle (`#vid-by`, `#vid-region`), search (`MDFitSearch.search(q,{kinds:["exercise"]})` ranking when ≥2 chars). Favorites: `PUT/DELETE /api/me/favorites/:id` → `lib.favorites`.
- `window.MDFitVideo` (`common.js`): `onCdn(id)`; `mp4(id)` → Cloudinary `https://res.cloudinary.com/<cloud>/video/upload/q_auto,vc_h264/v<ver>/<public_id>.mp4` when mapped, else `https://drive.usercontent.google.com/download?id=<id>&export=download&authuser=<owner-google-account>`; `thumb(id,w)` → Cloudinary `so_1,w_<w>,c_limit,q_auto` jpg (video) or `f_auto,q_auto,w_<w>,c_limit` (image), else `https://drive.google.com/thumbnail?id=<id>&sz=w<w>`; `preview(id)` → `https://drive.google.com/file/d/<id>/preview`.
- Playback (`playVideo`): earns XP (`POST /api/me/xp {kind:"video", ref:id}`); if the clip is on Cloudinary a warmed `<video>` plays inline (IntersectionObserver pre-warms visible cards, max 8 elements, 3 concurrent); otherwise, or on error / no frame in 6 s, falls back to the Drive preview `<iframe id="vd-frame">`. Thumbnail failures (`MDFitThumbFail`) swap in a `<video … #t=0.8>` still frame. Intro clips: `MDFIT_INTROS = { library, generator, pain }` (Drive ids).

### 3.9 Gem card / XP / daily activities / builder / challenges
- Rewards (`GET /api/me/rewards`): `{ xp, level, title, levelStart, nextLevel, todayXp, dailyGoal, todayParts, week[{date,xp}], badges[{id,title,desc,icon,earned,earnedOn,progress,target}], gems[{id,name,color,xp}], rank{current{id,name,color},next,xpToNext,progress}, overall{rank,hidden}, repairs{available,earned,usedDates[]}, olympicLevel }`. `renderRewards` fills `#chip-lv/#chip-xp`, `#goal-ring`, `#xp-week`, `#badges`, streak repair chip. `loadRewards(true)` diff → `celebrateToast` (`+N XP`, new gem, badge, daily goal). `notifyRewards` → bottom pop-ups (`notify`) + milestone overlay `#ms` (coin, vibrate) and a leaderboard pop-up `#ms-lb` on level-ups / every 3rd badge. Dispatches `mdfit:rewards`.
- XP earn calls (`earn(kind, ref)` → `POST /api/me/xp`): `video`, `generate`, `program`, `favorite`, `profile`, `share`, `booking`, `reaction`, `message`, `lecture`. Server decides all values.
- `account-xp.js`: inserts `#gem-card` (gem icon, level N of gems.length, lifetime XP, `#overall` rank button → `A.showBoard("all","all")`, progress bar, "Today" row merged with `mdfit:habits` data, gem ladder, buttons `[data-activities]` → `mdfit:habits-open`, `[data-build-workout]`) before `.streak` on Home, and `#prof-gem` on Profile. "My workouts" cards (`#home-my-workouts`, `#gen-my-workouts`): `GET /api/me/custom-workouts` → `{ workouts[{ id, name, exercises[{ id, sets, reps? | seconds? }] }] }`; builder `<dialog id="builder">` (search/region/category, ≤30 items, sets 1–10, reps 1–100 or seconds 5–600; timed default for stretch/hold/plank/breath/release) → `POST /api/me/custom-workouts` or `PUT …/:id` → `{ workouts, saved }`; `DELETE …/:id`. Start = `playerWorkout(w, "custom-"+id)` (35 XP). Challenges: `GET /api/me/challenges/members` → `{ members[{id,name,gem}] }`; `POST /api/me/challenges { workoutId, toId }` → `{ challenge{to}, xpEarned }` (+5 XP once a day); `GET /api/me/challenges` → `{ open[], done[], sent[] }`; "Challenges for you" card plays `challenge-<id>` (40 XP). Reloads on `mdfit:workout` and `visibilitychange`.
- `account-habits.js`: `#habits-card` ("Daily activities", collapsible) from `GET /api/me/habits/today` → `{ habits[{id,name,points,how,done,auto}], points, goal, goalLevel, goalLevels{beginner,intermediate,pro}, qualifying, remaining, streak{current}, repairs{available}, workoutRules{normal,custom,program,challengeSent,challengeBonus} }`; check = `POST /api/me/habits/checkin { habitId }`, uncheck = `DELETE /api/me/habits/checkin/:id`; goal level = `PUT /api/me/habits/goal { level }`; dispatches `mdfit:habits`. Progress calendar paint: `GET /api/me/habits/history?month=YYYY-MM` → `{ days[{date,qualifying,repaired,missed,future,today,points}], qualifyingDays, streak{best,lifetimeQualifying} }` adds classes `goal-q` / `goal-r` / `goal-m` to `#cal [data-day]` (listens to `mdfit:calendar`).
- Streak repairs: `POST /api/me/repair-streak { date }` from the Progress calendar day panel.
- Leaderboard (`#view-leaders`): `GET /api/me/leaderboard?period=day|week|month|all[&league=pro|olympic|all]` → `{ period, league, myLeague, top[{rank,name,score,level,gem,me}], me{rank,score}, total, hidden, resetsOn, olympicXp|olympicGem|olympicLevel }`; `PUT /api/me/leaderboard/visibility { hidden }`.

### 3.10 Messages (`#view-messages`)
Inbox (`#convos`: Dr. Jared thread, Live Q&A row → learn, 1-on-1 row → premium) and thread (`#messages/dr`). `GET /api/me/messages` → `{ messages[{id,from:"client"|"doctor",body,at,read,reactions{client,doctor}}], unread, member }`; `POST /api/me/messages { body }` (non-member → paywall "Messaging Dr. Jared is part of membership."); `POST /api/me/messages/read`; `GET /api/me/messages/unread-count` (every 60 s when the tab is hidden; badge `#msg-badge`); `POST /api/me/messages/:mid/react { emoji }` (`REACTS = 👍 ❤️ 😂 🙏 💪 😮`). Polling every 20 s while open; socket `new_message` and `message_reaction` refresh live. Cmd/Ctrl+Enter sends.

### 3.11 Membership & Stripe (`#view-premium`, `stripe-checkout.js`)
- `renderPremium`: `C.membership { tier, since, until }`, `C.tiers[{ id, name, price, meetings, meetingMinutes, perks[] }]`; "member" tier shows the accountability tracker (`GET /api/me/accountability` → `{ month, activeDays, threshold, free, credit, owed }`); `GET /api/me/payments` → `{ hasBilling, enabled, protocols[{ serviceName, sessions, label, total, payments, paid, status, guarantee }] }`; `POST /api/me/billing-portal` → `{ url }`; premium shows `#meetings-card` (`GET /api/me/meetings` → `{ allowance, usedThisMonth, minutes, meetings[{topic,status,when,times,link}] }`, `POST /api/me/meetings { topic, times }`).
- `GET /api/app/config` → `{ stripePublishableKey, googleClientId, features{ payments } }`. When payments are on: tier button → `POST /api/me/checkout/membership { tier, ui:"embedded", rewardCode? }` → `{ clientSecret }` (or `{ url }` fallback) → `MDFitStripe.open({ clientSecret, publishableKey })`. Otherwise "Request" → `POST /api/me/membership/request { tier, note }`.
- `window.MDFitStripe = { open, close, loadStripe }`: lazily loads `https://js.stripe.com/v3/`, creates `<dialog class="stripe-dlg">` with `#stripe-mount`, uses `stripe.createEmbeddedCheckoutPage` if present else `stripe.initEmbeddedCheckout`, `.mount()`; `close()` destroys. Server never passes `payment_method_types`, so Apple Pay / Google Pay / Link / card come from Stripe dynamic methods.
- Paywall `<dialog id="paywall">`: reason text, `C.tiers[0].price`, review form (`POST /api/feedback { name, email, rating, text, publish }` → `rewardCode` 30% off, saved to `mdfit_review_code`), "See memberships" → `go("premium")`. `GET /api/me/access` → `{ member, freeUsed, freeLeft, reviewCode }` drives `#free-badge`.

### 3.12 Tips, Learn, Profile, notifications, realtime
- **Tips** (`#view-tips`): `C.recommendations[{ id, area, title, body, image(driveId), link, sections[] }]`. Articles rendered by `tipBlock` with block types `list` (styles bullet/check/…), `groups`, `table` (2-col → `<dl class="ta-kv">`, wide → stacked cards), `facts`, `steps`, `callout` (tones `important|remember|tip|warning` → `TONE`), `motto`. `TIP_PHOTOS` maps 6 ids (`diet-health-shots`, `bath-accu-mat`, `fitness-erg`, `mobility-diet-ratios`, `psg-protocol`, `weekly-tracking`) to `assets/tips/*.webp` with `{ alt, by, url, lic, licUrl }` credits (CC BY 2.0 / CC0; `assets/tips/CREDITS.md`). Poster images: `https://lh3.googleusercontent.com/d/<driveId>=w<width>` (`driveImg`), lightbox `#tip-lightbox`.
- **Learn** (`#view-learn`): `C.live { title, date, time, minutes, joinUrl, locked, notes, recordings[{title,date,url}] }` (ICS download), lectures filtered by `C.topics`, `embedUrl()` supports YouTube (`youtube-nocookie.com/embed`), Drive preview, Vimeo; `#lecture-dialog` iframe; `MDFitGuides.mountLibrary(#learn-guides)` (7 poster guides + one "protocol guide" per pain track, grouped by `GROUPS`).
- **Profile** (`#view-profile`): `PUT /api/me { name, phone }`; password (`POST /api/me/password/code` → emailed code; `PUT /api/me/password { password, current | code }`); referral (`GET /api/me/referral` → `{ code, referrals }`, share URL `/login?signup&ref=<code>`); appointments (`GET /api/me/appointments` → `{ upcoming[], past[] }`, `POST /api/me/appointments/:id/cancel`, ICS, "Join video visit" from `meetingLink`); in-app booking `<dialog id="book-dialog">` (types from `GET /api/site`.settings.appointmentTypes, `GET /api/availability?type=&days=21`, `POST /api/appointments { typeId, date, time, name, email, phone, notes }`); bug/suggestion form (`GET/POST /api/me/feedback-reports { kind, title, body, page, userAgent }`); install-app card (`beforeinstallprompt` or per-platform steps, `#a2hs` iOS sheet); Log out.
- **Progress** (`#view-progress`): daily check-in (`POST /api/me/vitals { weight?, sleep? }`), device vitals (`restingHr, hrv, vo2max`), compare two workouts table, month calendar (`#cal`, Monday first, dots `k-workout|k-visit|k-pain`), badges, pain tracker.
- **Notifications**: bell `#bell` + panel `#notes` (live rows: visit ≤2 days, plan updated ≤7 days, streak at risk; history from `seenStore` inbox), bottom pop-ups `#notifs` (kinds `reward, level, message, visit`; max 3; swipe to dismiss; 8 s). Custom DOM events: `mdfit:rewards` (detail = rewards), `mdfit:habits` (detail = habits today), `mdfit:habits-open`, `mdfit:calendar` (`{month}`), `mdfit:workout` (detail = saved workout), `mdfit:connected`, `mdfit:disconnected`.
- **`realtime.js`** (`window.MDFitRT`): lazy-loads `https://cdn.jsdelivr.net/npm/socket.io-client@4.8.1/dist/socket.io.min.js`; `connect({ namespace, token })` → `io(realtimeUrl + ns, { path: "/ws", transports: ["websocket","polling"], auth: { token } })`; namespaces `/public` (no token; booking pages, homepage), `/member`, `/admin` (token required). `on/off/disconnect/connected`. Member events used: `slots_changed`, `new_message`, `message_reaction`. Admin events: `activity`, `new_message`, `message_reaction`, `toast`, `calendar_changed`, `online_count`.

### 3.13 Member-app API inventory (unique method + path)
GET `/api/me`; PUT `/api/me`; GET `/api/me/stats`; GET `/api/me/appointments`; POST `/api/me/appointments/:id/cancel`; GET `/api/me/pain`; POST `/api/me/pain`; DELETE `/api/me/pain/:id`; GET `/api/me/workouts`; POST `/api/me/workouts`; PATCH `/api/me/workouts/:id`; GET `/api/me/library`; GET `/api/me/vitals`; POST `/api/me/vitals`; GET `/api/me/referral`; GET `/api/me/access`; GET `/api/me/content`; GET `/api/content` (fallback + paintracks); GET `/api/me/rewards`; POST `/api/me/xp`; GET `/api/me/leaderboard`; PUT `/api/me/leaderboard/visibility`; POST `/api/me/repair-streak`; GET `/api/me/intake`; POST `/api/me/generations`; POST `/api/me/programs`; DELETE `/api/me/programs/:id`; PUT `/api/me/favorites/:id`; DELETE `/api/me/favorites/:id`; PUT `/api/me/pinned/:id`; DELETE `/api/me/pinned/:id`; POST `/api/me/password/code`; PUT `/api/me/password`; GET `/api/availability`; POST `/api/appointments`; GET `/api/me/feedback-reports`; POST `/api/me/feedback-reports`; GET `/api/me/messages`; POST `/api/me/messages`; POST `/api/me/messages/read`; GET `/api/me/messages/unread-count`; POST `/api/me/messages/:mid/react`; GET `/api/me/meetings`; POST `/api/me/meetings`; GET `/api/me/accountability`; GET `/api/app/config`; GET `/api/me/payments`; POST `/api/me/billing-portal`; POST `/api/me/checkout/membership`; POST `/api/me/membership/request`; POST `/api/feedback`; GET `/api/me/custom-workouts`; POST `/api/me/custom-workouts`; PUT `/api/me/custom-workouts/:id`; DELETE `/api/me/custom-workouts/:id`; GET `/api/me/challenges`; GET `/api/me/challenges/members`; POST `/api/me/challenges`; GET `/api/me/habits/today`; PUT `/api/me/habits/goal`; POST `/api/me/habits/checkin`; DELETE `/api/me/habits/checkin/:id`; GET `/api/me/habits/history`; GET `/api/site`; GET `/api/videos`; GET `/api/search/signals`; POST `/api/search/log` (beacon); POST `/api/hit` (beacon). Static: `/data/protocols/index.json`, `/data/protocols/<id>.json`, `/data/search-index.json`. (68 unique method+path pairs.)

---

## 4. Admin app in depth (`/admin`, `admin.js`, `admin-habits.js`)

### 4.1 Shell, auth, navigation
- Token: `sessionStorage.mdfit_token` (cleared on tab close). `api(method, path, body)` adds `Authorization: Bearer`; 401 (except on login) → `logout()`. Login form: `email`, `password`, optional `code` (`#code-row` shown when the error mentions "code" — email MFA). `POST /api/admin/login` → `{ token }`. `GET /api/admin/me` on load validates the token and returns `emailNotifications`.
- `logout()` empties every rendered list (HIPAA automatic logoff) and disconnects the socket; idle timer `IDLE_MS = 15 min` (pointerdown/keydown/scroll/touchstart reset).
- `NAV` (sidebar groups → sub-tabs, each tab is a `#hash` and a `[data-panel]`):

| Group (`data-nav`) | Tabs (`data-tab` → label) | Loader |
| --- | --- | --- |
| `home` "Home" | `dash` Calendar, `appts` Appointments, `classes` Classes, `bookings` Class bookings, `hours` Hours & sync | `loadDash`, `loadAppts`, `loadClasses`, `loadBookings`, `loadHours` |
| `people` "Clients" | `clients` Clients, `leads` Leads, `members` Members, `subs` Newsletter | `loadClients`, `loadLeads`, `loadMembers`, `loadSubs` |
| `inbox` "Inbox" | `messages` Messages, `reviews` Reviews, `feedback` Bug reports & ideas | `loadThreads`, `loadReviews`, `loadFeedback` |
| `insights` "Insights" | `analytics` Analytics, `audit` Audit | `loadAnalyticsWithSearch`, `loadAudit` |
| `settings` "Settings" | `settings` Settings, `content` Content, `habits` Activities | `loadSettings`, `loadContent`, `window.loadHabits` (admin-habits.js) |

Default tab `dash`; `openTab(name)` pushes `#name`, `popstate` re-opens. Sidebar slides in on phones (`#menu-btn`, `#sb-scrim`). Badges: `#admin-msg-count`, `#admin-fb-count` via `pollBadges()` (60 s; `GET /api/admin/messages`.unread, `GET /api/admin/feedback-reports`.open). Realtime (`/admin` namespace): `activity` prepends to the bell list and refreshes the open tab; `new_message`; `message_reaction`; `toast` (`rtToast` + browser `Notification` when granted); `calendar_changed` → reload busy blocks/appts; `online_count` → `#online-bar` "N members and M visitors online now".

### 4.2 Bell / notifications
`GET /api/admin/activity` → `notes[]` `{ type, time, email, id, appointmentId, total, completed }`. `NOTE` map (type → [icon, label, target tab]): `appointment` 📅 "New booking" → dash; `appointment_cancelled` ❌ → dash; `intake` 📝 "Intake documents" → appts; `lead` 🎯 "New evaluation request" → leads; `booking` 🏋️ "Class spot booked" → bookings; `booking_cancelled` ❌ → bookings; `message` 💬 → messages; `subscribe` 📧 → subs; `bug_report` 🐛 → feedback; `suggestion` 💡 → feedback; `feedback` ⭐ "New review" → reviews; `client_signup` 👤 → clients; `meeting_request` 🗓️ → members; `membership_request` 💳 → members; `cal_booking*` → "Cal.com booking". `groupNotes` dedupes: intake by `intake|<appointmentId|email>|<day>`, others by `type|email|id|<minute>`. Unread = `time > localStorage[SEEN_KEY="mdfit_admin_seen"]`; "Mark all read" sets it to now; clicking an item sets it to that item's time and navigates (`openIntake` opens the visit's documents in Appointments or the client's profile docs; message → `goThread`; client → `goClient`). Shows the newest 40.

### 4.3 Home (`dash`)
`GET /api/admin/stats` (`appointmentsToday, appointmentsWeek, leadsNew, leads30d, bookingsThisWeek, subscribers, today[], nextAppointments[], upcoming[]`), `GET /api/admin/me`, `GET /api/admin/settings` (banners: `#video-banner` when a remote type exists but `booking.telehealthUrl` is empty; `#email-banner` when `emailNotifications` is false). Calendar: `GET /api/admin/appointments?all=1` + `GET /api/schedule?days=14` (classes) + `GET /api/admin/busy?from=<monday|day>&days=7` (Google Calendar / SimplePractice busy blocks, `source: "google"|"simplepractice"`, `allDay`). `calView` week/day (day by default ≤700 px), 7 AM–7 PM grid stretched to fit, 52 px/hour, "now" line, classes `cal-ev class`, appointments `cal-ev booked|video|completed|noshow` (`VIDEO_TYPES = eval-remote, followup-remote, session-remote` or any `meetingLink`). Tap → `<dialog id="cal-pop">`: details, docs chip, "Join video", "Open client", "Message", "All appointments", status buttons (`PATCH /api/admin/appointments/:id { status }`), video link save (`{ meetingLink }`, emails the patient). Home inbox beside the calendar: `GET /api/admin/messages` threads (8), open thread `GET /api/admin/messages/:cid`, reply `POST /api/admin/messages/:cid { body }`; drafts kept per client in a `Map`. Booking link copier: `<origin>/book` and `/book?type=call`.

### 4.4 Appointments / Classes / Class bookings / Hours & sync
- `appts`: `GET /api/admin/appointments[?all=1]` cards (status badge, Video badge, Cal.com badge, intake areas/pain, documents chip + "View documents" → `GET /api/admin/appointments/:id/intake` rendered by `showDocs` (`docs[{title,createdAt,onFile,fields[{label,value}]}]`), video link input, private `adminNotes`, status select `booked|completed|no-show|cancelled`, Save → `PATCH /api/admin/appointments/:id { status, adminNotes, meetingLink? }`). CSV: `GET /api/admin/appointments.csv`.
- `classes`: form `title, day, time, durationMin, capacity, coach, location, description` → `POST /api/admin/classes`; table actions `PUT /api/admin/classes/:id { active | capacity }`, `DELETE`.
- `bookings`: `GET /api/admin/bookings[?all=1]`, `DELETE /api/admin/bookings/:id`.
- `hours`: `#cal-form` booking provider (`provider` builtin\|cal, `calUsername`, `telehealthUrl`, `calEventSlugs`) → `PUT /api/admin/settings { booking }`; Cal.com `GET /api/admin/cal/status`, `POST /api/admin/cal/sync`; webhook URL shown = `API + "/api/cal/webhook"`. `#sync-form` SimplePractice ICS link `PUT /api/admin/calsync { icsUrl }` (empty string = remove), `GET /api/admin/calsync` status (google/simplepractice configured, `serviceAccountEmail`, `live{everySec,lastCheck,lastChange}`, `lastSync`, `busyNext14Days`), `POST /api/admin/calsync/test`. `#hours-form`: per-day hours (`HH:MM-HH:MM, …`), `slotStepMin`, `minNoticeHours`, `daysAhead`, `lastStart`, `blockedDates`, `appointmentTypes` (`id | name | minutes | description` per line; hidden fields like `remote` preserved from `origApptTypes`) → `PUT /api/admin/settings { scheduling, appointmentTypes }`.

### 4.5 Clients
- `GET /api/admin/clients` + `GET /api/admin/content` (tiers). Totals chips: `all, today, week, month, inpatient, plan, subscribed, tier:<id>`. Table columns: Client (name/email), Type (toggle badge → `PUT /api/admin/clients/:id/type { type }`), Membership (`<select>` → `PUT /api/admin/clients/:id/membership { tier, until }`), Phone, Next visit, Last pain log, Plan, Docs, Joined. Search by name/email/phone.
- Profile `openClient(id)`: `GET /api/admin/clients/:id`, `GET /api/admin/settings`, content, `/data/protocols/index.json`. Header actions: Message (`goThread`), Send reset code (`POST …/send-reset-code`), Delete account (`DELETE /api/admin/clients/:id`). `clientOverview` cards: Next visit, Visits done, Pain (sparkline), Membership, Activity (streak/workouts), Gem & XP (`rewards`), Last login. Documents chip + viewer (`GET /api/admin/clients/:id/intake`). `careBox`: client type radio; "Send booking link" (`POST …/send-booking-link { typeId, message }`); "Schedule video consultation" (`POST …/consult { date, time, minutes, meetingLink, message }`, prefilled with `booking.telehealthUrl`); "Programs for <first>" picker grouped by `PROG_CATS` (`Rehabilitation, Mobility, Desk & posture, Anti-inflammatory, Weight loss, Hypertrophy, Strength, Performance, Sport Performance`) with a note per program and progress line → `PUT …/programs { programs[{id,note}] }` → `{ assignedPrograms, programHistory, programProgress }`. Plan form → `PUT …/plan { notes, exercises[{name,detail}], guides[] }` (`GUIDES` = the 7 poster guides). Tables: appointments, pain log (last 50).

### 4.6 Leads / Members / Newsletter
- `leads`: `GET /api/admin/leads[?status=]`, statuses `new, contacted, booked, client, closed`; status select saves immediately (`PATCH /api/admin/leads/:id { status }`), Save (`{ status, notes }`), Delete; CSV `GET /api/admin/leads.csv`.
- `members`: `GET /api/admin/members` + content tiers; per member: tier select + "Paid through" → `PUT /api/admin/clients/:id/membership { tier|null, until }`; 1-on-1 meetings (`when`, `link`, status `requested|scheduled|done|cancelled`) → `PATCH /api/admin/clients/:id/meetings/:mid { when, link, status }`.
- `subs`: `GET /api/admin/subscribers`, `DELETE /api/admin/subscribers/:email`, CSV `GET /api/admin/subscribers.csv`.

### 4.7 Inbox
- `messages`: threads `GET /api/admin/messages` → `{ threads[{clientId,name,unread,last{from,body,at},member}], unread }`; thread `GET /api/admin/messages/:cid` → `{ client{name,email,phone,member,tier}, messages[] }`; reply `POST /api/admin/messages/:cid { body }`; reactions `POST /api/admin/messages/:cid/:mid/react { emoji }`. Broadcast: `GET /api/admin/messages/broadcasts` (recent group messages: recipients/read/emailed/sending), `POST /api/admin/messages/broadcast { to: all|members|tier|selected, tier, clientIds[], body, email }`, reminder `POST /api/admin/messages/broadcast/:bid/remind`.
- `reviews`: `GET /api/admin/feedback` (website reviews with reward code use), `PATCH /api/admin/feedback/:id { status: approved|hidden|pending }`.
- `feedback`: `GET /api/admin/feedback-reports[?kind=bug|suggestion&status=new|working|resolved]` → `{ reports[], open }`; `PATCH …/:id { status }`; `DELETE …/:id`.

### 4.8 Insights
- `analytics`: `GET /api/admin/analytics?days=7|30|90` → `{ summary{todayViews,todayUnique,totalViews,totalUnique}, days[], pages[], referrers[], mix{devices,sources,places,os,browsers,countries}, rangeDays }`; email delivery `GET /api/admin/email-log` → `{ enabled, alertsTo[], days[{date,sent,failed}], failures[] }`; in-app search `GET /api/admin/search-analytics?days=` → `{ totals{events,uniqueQueries}, top[], zeroResult[], topCtr[], bottomCtr[] }`.
- `audit`: `GET /api/admin/audit?limit=300[&action=auth.|admin.view|admin.change|client.…]` → `{ publicKey, fingerprint, entries[{seq,ts,actor,action,subject,hash}] }`; "Verify chain" `GET /api/admin/audit/verify` → `{ ok, entries, head, error }`; anchor check `GET /api/admin/audit/verify?seq=&head=` → `{ anchor{ok,seq,error}, ok }`; `POST /api/admin/audit/anchor` emails the current head (nightly anchors are emailed by the server).

### 4.9 Settings
- `settings` panel: MFA box (`GET /api/admin/mfa` → `{ emailReady, forcedOff, enabled, sendsTo }`; `POST /api/admin/mfa/start`, `POST /api/admin/mfa/confirm { code }`, `POST /api/admin/mfa/disable { password }`); `business.*` (name, tagline, phone, email, address, hours, mapsUrl, instagram, facebook, tiktok, bookingNote), `rating.*` (score, count, source, url), `coach.*` (name, title, photoUrl, bio), services rows (`id, name, rate, protocol, description`; `unit`, `withEval`, `remote` preserved), plans (`plan_gold, plan_silver, plan_silverPayments, plan_ext12, plan_ext24, plan_packageSizes, plan_guaranteeMin`), testimonials (`Name | Quote`) → `PUT /api/admin/settings { business, rating, coach, services, plans, testimonials }`.
- `content` panel (`PUT /api/admin/content`): live Q&A (`live_title, live_date, live_time, live_minutes, live_joinUrl, live_access, live_notes, live_recordings`), and row editors (`FIELDS`) for `lectures` (title, topic from 7 fixed topics, url, downloadUrl, minutes, access free\|member\|premium, summary), `recommendations` (area, title, body, link; `sections` preserved), `tiers` (name, price, meetings, meetingMinutes, perks), `programs` (title, category from 9 fixed categories, level, location, weeks, seed, access, summary, notes, resources multi-select, days `name | goal | minutes | rounds`; hidden day fields preserved), `events` (title, date, time, location, description, link, free), `tracks` (title, region, note, pts multi-select from `MDFitMuscles.MUSCLES`, img Drive links, levels text `Level title` / `Video name | Drive link`; only sent when edited; "Reset" sends `tracks: []`). `loadContent` = `GET /api/admin/content`.
- `habits` panel (`admin-habits.js`): `GET /api/admin/habits` → `{ habits[{id,name,points,how,active,auto}], dailyGoal, defaults{habits,dailyGoal} }`; edit table + add/reset → `PUT /api/admin/habits { habits, dailyGoal }`.

### 4.10 Realtime and misc
`MDFitRT.connect({ namespace: "/admin", token })` on `show()`. Browser `Notification.requestPermission()` asked once. `GET /api/admin/clients` cached in `clientList` for bell/calendar lookups.

### 4.11 Admin API inventory (unique method + path)
POST `/api/admin/login`; GET `/api/admin/me`; GET `/api/admin/activity`; GET `/api/admin/stats`; GET `/api/admin/settings`; PUT `/api/admin/settings`; GET `/api/admin/appointments`; GET `/api/admin/appointments.csv`; PATCH `/api/admin/appointments/:id`; GET `/api/admin/appointments/:id/intake`; GET `/api/schedule`; GET `/api/admin/busy`; GET `/api/admin/messages`; GET `/api/admin/messages/:cid`; POST `/api/admin/messages/:cid`; POST `/api/admin/messages/:cid/:mid/react`; GET `/api/admin/messages/broadcasts`; POST `/api/admin/messages/broadcast`; POST `/api/admin/messages/broadcast/:bid/remind`; GET `/api/admin/cal/status`; POST `/api/admin/cal/sync`; GET `/api/admin/calsync`; PUT `/api/admin/calsync`; POST `/api/admin/calsync/test`; GET `/api/admin/clients`; GET `/api/admin/clients/:id`; DELETE `/api/admin/clients/:id`; GET `/api/admin/clients/:id/intake`; POST `/api/admin/clients/:id/send-reset-code`; PUT `/api/admin/clients/:id/type`; PUT `/api/admin/clients/:id/membership`; POST `/api/admin/clients/:id/send-booking-link`; POST `/api/admin/clients/:id/consult`; PUT `/api/admin/clients/:id/programs`; PUT `/api/admin/clients/:id/plan`; PATCH `/api/admin/clients/:id/meetings/:mid`; GET `/api/admin/content`; PUT `/api/admin/content`; GET `/api/admin/leads`; GET `/api/admin/leads.csv`; PATCH `/api/admin/leads/:id`; DELETE `/api/admin/leads/:id`; GET `/api/admin/classes`; POST `/api/admin/classes`; PUT `/api/admin/classes/:id`; DELETE `/api/admin/classes/:id`; GET `/api/admin/bookings`; DELETE `/api/admin/bookings/:id`; GET `/api/admin/subscribers`; GET `/api/admin/subscribers.csv`; DELETE `/api/admin/subscribers/:email`; GET `/api/admin/audit`; GET `/api/admin/audit/verify`; POST `/api/admin/audit/anchor`; GET `/api/admin/feedback`; PATCH `/api/admin/feedback/:id`; GET `/api/admin/feedback-reports`; PATCH `/api/admin/feedback-reports/:id`; DELETE `/api/admin/feedback-reports/:id`; GET `/api/admin/members`; GET `/api/admin/mfa`; POST `/api/admin/mfa/start`; POST `/api/admin/mfa/confirm`; POST `/api/admin/mfa/disable`; GET `/api/admin/email-log`; GET `/api/admin/analytics`; GET `/api/admin/search-analytics`; GET `/api/admin/habits`; PUT `/api/admin/habits`; GET `/api/content` (paintracks.js); POST `/api/hit` (beacon). Displayed, not called: `/api/cal/webhook`. Static: `/data/protocols/index.json`. (71 unique method+path pairs.)

---

## 5. Public site

### 5.1 `index.html` sections (in order)
`header.sh#top` (shared header: Conditions, Treatments, Areas, Blog, Dr. Jared `/#dr`, Reviews `/#reviews`, Events, Log in/My account `[data-account-link]`, phone, "Book evaluation") → `section.hero` (h1 "Fix the source. Move without pain.", CTAs, `#rating`, `#quick-start` body-area chips form → scrolls to `#intake` with areas pre-checked) → `section.trust` (MD, MSc / CCEP / LMT / 1-on-1) → `#pain-map` ("Tap where it hurts.", homepage pain map, see §3.7) → `#method` ("Five steps, in this order.") → `#how` ("From your first visit to the last.") → `#services` ("One place from injured to unstoppable.") → `#treat` ("If it hurts to move, start here.") → `#book` ("Pick a time that works.", `.booker`) → `#pricing` ("Services, protocols and payment plans", `.pricing-app`) → `#dr` (bio `.coach-bio`, `.coach-photo`) → `#reviews` ("Real people. Real relief.", Google reviews + `#review-form`) → `#intake` ("Tell us what's going on.", `#lead-form`) → `#visit` ("On Clark Road, Sarasota.") → `footer.footer` (`#news-form`, contact, socials). `app.js` binds `[data-bind="business.*|coach.*|rating.*"]` from `GET /api/site`.settings and uses `data.options` (`areas, services, goals, durations, surgery`) for the lead form. Lead form fields: `areas[]`, `painLevel` (0–10, omitted until touched), `duration`, `surgery`, `service`, `goal`, `name`, `phone`, `email`, `message`, `referral`, honeypot `mdfit_hp` → `POST /api/leads`. Newsletter → `POST /api/subscribe`. Review form (`rating`, `name`, `email`, `text`, `publish`, `mdfit_hp`) → `POST /api/feedback` → `rewardCode` shown and saved to `mdfit_review_code`; `?reward=<code>` on `/` → `GET /api/feedback/reward/:code` → remounts the booker with the free 30-minute plan-review type.

### 5.2 Booking flow (`booking.js`, `MDFit.mountBooker(root, site, opts)`)
- Site data from `GET /api/site` → `{ settings{ appointmentTypes[{id,name,minutes,description,remote}], business{name,tagline,phone,address,hours,mapsUrl,…}, rating, coach, services, plans, testimonials }, options{areas,…}, booking{ provider, cal{ username, origin, eventTypes[{slug,title,minutes,description}] } }, timeZone }`.
- Built-in scheduler steps: 1 type (`[data-type]`, remote types show a telehealth note) → 2 day (7-day window from `GET /api/availability?type=<id>&from=<YYYY-MM-DD>&days=7` → `{ days[{date,slots[]}], lastDate }`; auto-jumps to the first week with openings) → 3 time → 4 details form (`name`, `phone`, `email`, optional `areas[]`, `painLevel`, `notes`, honeypot `mdfit_hp`) → `bookAs("/api/appointments", { …, typeId, date, time, rewardCode? })`. `bookAs` sends the member's Bearer token when `mdfit_client` is valid (links the booking to the account; intake-on-file counts), else anonymous `MDFit.api`. 409 → reload slots and show "just taken". Live: `MDFitRT.on("slots_changed")` + `connect({namespace:"/public"})`.
- Booked panel: ICS blob (2-hour alarm), Google Calendar link, Directions (`business.mapsUrl`), "Join at your appointment time" link when `meetingLink`, intake link `/intake?id=<appointment.id>&token=<cancelToken>` (or "Documents on file ✓" when `intakeDone`), "My account" link for members.
- Cal.com mode (`site.booking.provider === "cal"`): loads `https://app.cal.com/embed/embed.js`, `Cal("init", ns, { origin })`, inline embed `calLink = <username>/<slug>`, `layout: "month_view"`, brand color from CSS `--accent`, `bookingSuccessfulV2` callback; `?type=` accepts a slug or alias `eval|session|call`.
- Member in-app booking (account.js) reuses `GET /api/availability?type=&days=21` and `POST /api/appointments`.

### 5.3 Pricing (`pricing.js`, `window.MDFitPricing = { quote, mount, money }`)
`quote(svc, sessions, plans, evalRate)`: `ev = svc.withEval ? evalRate : 0`; `base = ev + svc.rate × sessions`; `gold = base × (1 − plans.gold/100)`; `silver = base × (1 − plans.silver/100)` paid in `plans.silverPayments` monthly payments; `payg` ("Bronze") = `svc.rate` per visit (+ evaluation on day one); `ext12 = base × (1 + plans.ext12/100)` /12 per month; `ext24 = base × (1 + plans.ext24/100)` /24; `guarantee = sessions >= plans.guaranteeMin`. Option ids: `gold, silver, payg, ext12, ext24` (names Gold, Silver, Bronze, Platinum · 12 months, Platinum · 24 months). `mount(root, settings)` renders service rate cards, Platinum banner (`minMonthly` across protocol services at the smallest package), calculator chips (`svc`, `n` from `plans.packageSizes`, default 12 when present), money-back guarantee block. When `GET /api/app/config`.features.payments and `stripePublishableKey` are set: "Pay $X" per service → `POST /api/me/checkout/service { service, ui:"embedded" }`, "Start this plan" → `POST /api/me/checkout/protocol { service, sessions, plan, ui:"embedded" }` → `MDFitStripe.open`; not logged in → `/login?next=/#pricing`. Server mirror: `backend/lib/payments.js`.

### 5.4 `login.html`
Tabs `login` / `signup`; panels `forgot` → `code` → `reset`. `next` rule: `/^\/[a-z]*(\?me=1)?(#[a-z0-9/-]*)?$/`, default `/account`; already logged in (and no `?reset=`) → `location.replace(next)`. `?signup` or `?ref=<code>` opens sign-up with the referral prefilled; `?reset=<token>` clears the session and opens the reset panel. Login form has an optional `name` ("Required for new accounts"). Google Identity Services: `GET /api/app/config`.googleClientId → `google.accounts.id.initialize({ client_id, callback })` → `POST /api/clients/google { credential, referralCode? }`; buttons rendered into `#google-btn-login` / `#google-btn-signup` (`theme: outline, size: large, width: 320, text: continue_with`). Every success → `auth.set(session)` → `location.replace(next)`.

### 5.5 `intake.html`
Member mode (`?me=1` or no `id`): requires `mdfit_client`; `GET /api/me/intake` → `{ name, docs[{ id, title, intro, minutes, done, fields[] }], prefill{} }`; save `POST /api/me/intake/:docId`. Token mode (`?id=<12 hex>&token=`): `GET /api/appointments/:id/intake?token=` (also returns `date, time, typeName, cancelled`), save `POST /api/appointments/:id/intake/:docId` with `token` in the body. Field types rendered: `textarea, text, tel, email, date, sign, select, radio, yesno, checks, scale (0–10), agree`. Each document saves on its own; after a save the next unfinished doc opens; all done → "Thank you" panel ("Back to my dashboard" in member mode). Document ids seen in tests: `info, pain, history, consent` (4 docs) **(verify against backend)**.

### 5.6 `cancel.html`
`?kind=appointment|class&id=<12 hex>&token=` → `POST /api/appointments/:id/cancel` or `POST /api/bookings/:id/cancel` `{ token }`; shows "Book a new time" on success.

---

## 6. Content & asset paths

### 6.1 Exercise library (`app/exercises.js`)
`window.MDFIT_EXERCISES`: **155** exercises, fields `{ id, name, region, rc, cat, cc, level, loc, seated }`. `id` = Google Drive file id of the video (e.g. `108rqCigYY-88hJo3QQTANQtb9qcalFYG`), shared "anyone with the link". `rc` region codes: `AN, EL, CO, ERG, FB, HP, KN, LB, NK, SH, SP, UB, WR`; `cat`: Mobility 59, Strength 40, Activation 24, Rehab 15, Power 10, Neuroglide 2, Posture 2, Lifestyle 2, Desk & posture 1; `cc` codes `MOB, STR, ACT, RHB, PWR, NG, POS, LIF, ERG` (from Dr. Jared's file-name suffixes); `level` 1–9; `loc`: any 89, gym 34, home 30, outdoor 2; `seated` 16 true. `window.MDFIT_INTROS = { library, generator, pain }` (3 Drive ids). Generated from the Drive "MDFIT IMAGES" folder (header comment); no folder id in the repo. `VIDEO_ALIAS` (program sheet name → library name) and `VIDEO_FIX` live in `account.js`. `data/catalog.json` (`version b8669107938b`, 2026-11-03) is a derived catalog with `kind/category/joint/muscle` and `video.preview/mp4/thumbnail` URLs; `data/media-manifest.json` (275 assets) maps Drive ids to Cloudinary `public_id` (`mdfit/videos/exercise-library/<Kind>/<Region>/<Category>/<slug>`) with tags/context; `data/catalog-version.json`; `data/google-reviews.json` (snapshot: rating 5, count 89, `maps.google.com/?cid=18426672193642042879`); `data/search-index.json` (254 docs, BM25 index for `search.js`).

### 6.2 Programs
Built-in premade programs are **not in the frontend**: they come from the backend (`content.js` **(verify name)**) via `GET /api/content` / `GET /api/me/content` and are editable in Admin → Content. Frontend renders them in `account.js` (`renderProgramsView`, `renderProgram`, `renderProgramDays`, `renderProtocol`, `renderFeaturedPrograms`, `renderMyPlans`). Week-by-week protocol text lives in the frontend at `data/protocols/*.json` (17 files; ids: `golf-advanced, golf-intermediate, golf, golfers-elbow-4, hip-6, knee-6, low-back-6, marathon-extension, mobility-12, pickleball-advanced, pickleball-intermediate, pickleball, plantar-4, posterior-chain-6, shoulder-6, ski-advanced, tennis-elbow-4`), built by `scripts/build-protocols.py` (downloads each week's sheet by `driveId` via `drive.google.com/thumbnail?…&sz=w2400`, writes `assets/protocols/<id>/<key>-960.webp` and `-1600.webp`, writes `index.json`). Program posters: `assets/programs/*.png` (23 files, e.g. `golf-new.png`, `low-back-new.png`, `mobility-ladder-new.png`, `pickleball.png`) and `assets/programs/web/` (55 WebP variants from `scripts/program-images.py`).

### 6.3 Pain, guides, tips
- Pain figures: `assets/pain/body-figures.webp` (1182×1073), `body-figures-760.webp`, `body-figures-gray.webp`, `body-mask.png`, `openstax-muscles.jpg`; `assets/pain/clean/` (23 PNG anatomy/pain crops, e.g. `calf-anatomy.png`, `calf-pain.png`, `guide-calf-clean.png`).
- Guides (`guides.js`, `window.MDFitGuides`; ids `posterior-neck, scalenes, rotator-cuff, iliopsoas, lateral-hip, quads, calf`): per guide `{ title, subtitle, intro, quote, muscles[{name,origin,insertion,action,nerve,blood}], pattern, … }`; images `assets/guides/<id>-anatomy.webp`, `<id>-referral.webp`, `<id>-thumb.webp` (21 files). Also "protocol guides" per pain track (`openTrackGuide`), groups `GROUPS = Neck & head, Shoulder & arm, Chest & ribs, Back, Hip & glutes, Knee & thigh, Calf & foot`. Standalone pages `guides/<id>.html`.
- Tips photos: `assets/tips/{diet-health-shots,bath-accu-mat,fitness-erg,mobility-diet-ratios,psg-protocol,weekly-tracking}.webp` + `assets/tips/CREDITS.md` (Openverse/Flickr/StockSnap, CC BY 2.0 and CC0).
- Logos/icons: `assets/logo.webp` (header/app logo, 160×160 box), `assets/icon-64.png` (favicon), `assets/app-icon-192.png`, `assets/app-icon-512.png` (PWA), `assets/dr-jared.jpg`.
- Google Drive: no folder ids are in the repo; individual file ids appear in `app/exercises.js`, `paintracks.js` (`img`, video `id`), `data/protocols/*.json` (`driveId`), `data/catalog.json`, `data/media-manifest.json`. Drive URL patterns used: `drive.google.com/file/d/<id>/preview`, `drive.google.com/thumbnail?id=<id>&sz=w<n>`, `drive.usercontent.google.com/download?id=<id>&export=download[&authuser=<owner-google-account>]`, `lh3.googleusercontent.com/d/<id>=w<n>`.
- Cloudinary: cloud name is **not hard-coded**; it arrives from `GET /api/videos` (`{ cloud, map }`) and is cached in `localStorage.mdfit-cdn2`. Only `res.cloudinary.com` appears in code/CSP.
- Fonts: Google Fonts `Libre Baskerville` (400, 700, some pages italic 400) and `Montserrat` (400–800), `display=swap`; preconnects to `fonts.googleapis.com` / `fonts.gstatic.com`.

---

## 7. Design tokens

### 7.1 CSS custom properties
`styles.css` `:root` (public site):
`--ink: #0A1A2E` (brand navy), `--ink-2: #10233b`, `--ink-3: #1d3352`, `--cream: #F6F4EE`, `--paper: #ffffff`, `--paper-2: #EFEBE1`, `--line: #e4ded1`, `--text: #424244`, `--heading: #0A1A2E`, `--muted: #6b6a6e`, `--accent: #7AAFD7` (light blue), `--accent-hover: #6AA2CD`, `--accent-ink: #0A1A2E`, `--accent-text: #2F6E9E` (AA blue on light), `--accent-bright: #8EC0E6`, `--accent-soft: #EAF3FA`, `--gold: #C8A763`, `--star: #C8A763`, `--ok: #2e7d4f`, `--err: #c62828`, `--radius: 14px`, `--shadow: 0 12px 30px -14px rgba(10,26,46,.28)`, `--display: "Libre Baskerville", Georgia, "Times New Roman", serif`, `--body: "Montserrat", system-ui, -apple-system, sans-serif`.

`app/app.css` `:root` (member app):
`--navy: #0A1A2E`, `--navy-2: #10233b`, `--navy-3: #1d3352`, `--bg: #F6F4EE`, `--card: #ffffff`, `--card-2: #F3EFE6`, `--line: #e4ded1`, `--text: #424244`, `--heading: #0A1A2E`, `--muted: #6b6a6e`, `--accent: #7AAFD7`, `--accent-hover: #6AA2CD`, `--accent-text: #2F6E9E`, `--accent-bright: #8EC0E6`, `--accent-soft: #EAF3FA`, `--gold: #C8A763`, `--gold-hover: #b8954f`, `--gold-soft: #f6efdf`, `--ok: #2e7d4f`, `--err: #c62828`, `--on-navy: #c9d1dc`, `--radius: 16px`, `--shadow` (same), `--display`, `--body` (same). `account.css` and `admin.css` define no `:root` tokens (they consume the above; admin loads `styles.css`). Theme color everywhere: `#0A1A2E`. Edge 403 pages use navy `#0A1A2E`, text `#c9d1dc`, accent `#7AAFD7`.

### 7.2 Breakpoints
- Public (`styles.css`, `site-header.css`): header collapses to the hamburger at `max-width: 960px`; other steps at 1100, 1000, 860, 700, 640, 600 px; desktop tweaks `961–1200` and `961–1440`; `(hover: none), (pointer: coarse)`.
- Member app (`app/app.css`): mobile-first; `min-width: 1000px` switches the bottom `.tabbar` (fixed, `grid-template-columns: repeat(6,1fr)`, `width: min(600px,100%)`, `padding-bottom: calc(8px + env(safe-area-inset-bottom))`, 13 `safe-area` uses) into a 248 px left sidebar (`.long` labels, `.side-brand`, `.side-foot`); other steps at 1240, 900, 700, 640, 560, 500 (min) and 999, 820, 600, 380 (max); `account.css` adds 900/700 (min) and 999/860/820/600/520/420/400 (max). Layout CI checks 320/375/390/430/768/1366/2560 px.
- Admin (`admin.css`): 1100, 900, 860, 800, 760, 640, 600 px (sidebar becomes a slide-in; calendar day view default ≤700 px).

### 7.3 Component classes a native app should mirror
| Class | Where | Role |
| --- | --- | --- |
| `.btn`, `.btn-lg`, `.btn-sm`, `.btn-block`, `.btn-ghost`, `.btn-line` | `styles.css` | Public pill buttons: light-blue fill `--accent` with navy text, 999px radius, 2px border; ghost = transparent/white border; line = outlined |
| `.btn-blue` | `app/app.css` | Primary app action: navy `--navy` fill, white text (Start/Watch/Subscribe) |
| `.btn-gold` | `app/app.css`, `account.css` | Secondary app action: brand gold with navy text (Save, Send, Generate, Log it) |
| `.btn-ghost`, `.btn-outline-light` | `app/app.css` | Tertiary (card background, navy text) / outline on navy |
| `.card`, `.card.gold-edge`, `.card-head` | app + public + admin | White surface, `--radius`, 1px `--line` border, 18 px padding (app) / 28 px (public) |
| `.label`, `.label.accent`, `.label.blue`, `.eyebrow` | app/public | Small uppercase kicker |
| `.badge` | `app/app.css` (achievement tile), `admin.css` (status pill: `booked/completed/no-show/cancelled/new/contacted/client/closed/docs/remote/cal/ctype in|out`) | |
| `.pill` | app + admin | Chip-style status (`pending/approved/hidden/bug/suggestion/new/working/resolved`) and generator number chips |
| `.chip` | public + app | Rounded filter chip (`aria-selected`) |
| `.tabbar` + `[data-tab]`, `.more-btn`, `.tab-badge` | app | Bottom tab bar / sidebar, "More" sheet, unread badge |
| `.sheet`, `.sheet-wide`, `.sheet-head`, `.pm-sheet`, `.tk-dialog`, `.gd-dialog`, `.stripe-dlg` | app | Bottom-sheet style `<dialog>`s |
| `.toast`, `.toast.celebrate`, `.notif`, `.ms` | app | Toasts, pop-up notifications, milestone overlay |
| `.seg` / `.mode-seg`, `.opt-cards .opt`, `.pills .pill`, `.toggle` | app | Segmented controls, generator option tiles/pills, switches |
| `.tile`, `.stat`, `.vital`, `.stats3` | app/admin | KPI tiles |
| `.vcard`, `.thumb`, `.heart`, `.vgroup` | app | Video cards |
| `.prog-card`, `.prog-poster`, `.pp-text`, `.level-card`, `.proto-wk`, `.pex` | app | Program cards/posters, level folders, protocol week rows, exercise cards |
| `.gem-card`, `.gc-*`, `.hb-card`, `.hb-item`, `.ch-card`, `.my-workouts`, `.bw-sheet` | account.css | Gem card, daily activities, challenges, builder |
| `.player`, `.p-opts`, `.p-ring`, `.p-rest`, `.p-done` | app | Workout player |
| `.mini`, `.link`, `.link-sm`, `.form-msg.ok|.err`, `.banner.ok|.bad` | admin/app | Small buttons, inline status |

Typography: display = Libre Baskerville (serif, headings, `h1.name`, program titles), body = Montserrat (weights 400–800).

---

## 8. Third-party scripts & domains

| Service | Domains (CSP directive) | Loaded by |
| --- | --- | --- |
| Stripe.js v3 / Embedded Checkout | `js.stripe.com` (default/script/frame), `checkout.stripe.com`, `hooks.stripe.com` (frame), `api.stripe.com` (connect), `checkout.stripe.com`, `billing.stripe.com` (form-action) | `stripe-checkout.js` (lazy), billing portal redirect |
| Google Identity Services | `accounts.google.com` (script/frame/connect/style), `apis.google.com` (script), `oauth2.googleapis.com` (connect) | `login.html` |
| Cal.com embed | `app.cal.com` (script/frame/connect), `cal.com` (frame) | `booking.js` `mountCal` (only when `booking.provider === "cal"`) |
| socket.io client 4.8.1 | `cdn.jsdelivr.net` (script); sockets to `wss://amiable-peace-production-e382.up.railway.app` (connect) | `realtime.js` |
| Vercel Web Analytics / Speed Insights | `va.vercel-scripts.com` (script/connect), `vitals.vercel-insights.com` (connect), `/_vercel/insights/script.js` (self) | every page |
| Google Tag Manager | `*.googletagmanager.com` (script) allowed in CSP; no GTM snippet in the repo **(verify)** | — |
| Google Fonts | `fonts.googleapis.com` (style), `fonts.gstatic.com` (font) | every page |
| Google Drive media | `drive.google.com` (frame, media), `drive.usercontent.google.com` (media), `lh3.googleusercontent.com` (img via `https:`) | videos, thumbnails, posters, protocol sheets (build time) |
| Cloudinary | `res.cloudinary.com` (media; images via `img-src https:`) | `MDFitVideo` when `/api/videos` maps an id |
| Railway API | `amiable-peace-production-e382.up.railway.app` (connect, https + wss) | direct only for sockets; HTTP goes via the edge proxy (`'self'`) |
| Other `*.vercel.app` | `https://*.vercel.app` (connect) | preview deployments |
| Embedded lecture players | `www.youtube-nocookie.com`, `player.vimeo.com` (frame) — **not in `frame-src`** of the CSP; `drive.google.com` is. YouTube/Vimeo lecture embeds would be blocked by the current CSP **(verify)** | `account.js` `embedUrl` |
| Outbound links only | `maps.google.com`, `calendar.google.com`, `zoom.us`, `meet.google.com`, `instagram.com`, `facebook.com`, `tiktok.com`, `flickr.com`, `stocksnap.io`, `creativecommons.org` | — |

---

## 9. Testing

### 9.1 Layout guard (`scripts/layout-check.js`, run in CI)
Serves the repo with a tiny Node static server on **port 8080** and starts the backend (`node server.js` in `BACKEND_DIR`, `PORT=3000`, temp `DATA_DIR`, `SESSION_SECRET`, `ALLOWED_ORIGINS=http://localhost:8080`, `BOT_FILTER=off`, `LOG_LEVEL=error`), waits for `GET /api/health`. Seeds a hostile client (name/notes containing `<img onerror>` / `<script>` and unbreakable words) through `/api/clients/login`, `/api/me/pain`, `/api/me/workouts`. Loads every HTML route at `PAGE_WIDTHS = 320×568, 390×844, 768×1024, 1366×900, 2560×1440` and the account screens `VIEWS = home, generate, videos, programs, programs:first, learn, premium, messages, tips, pain, progress, profile` at `APP_WIDTHS = 320, 375, 390, 430, 768, 1366, 2560` (mobile emulation under 1024, `serviceWorkers: "block"`), again with `account.css` blocked. Fails on horizontal overflow, elements outside their card, program images > 60% of the viewport, page errors, user text rendered as HTML (`window.__pwn`), or links to missing CSS/JS files.

### 9.2 E2E tours (Playwright, scratchpad only, not in the repo)
Located under `/tmp/claude-0/-home-user/b829c0ee-8398-5d77-a955-b752b208bfdc/scratchpad/`:
- `e2e/harness.js` / `harness2.js` / `harness-tips.js`: `start()` serves the frontend dir on a port (8095 in `harness.js`; `H_WEBPORT` default 8395 in `harness2.js`) and spawns the backend (`PORT` 3000 / `H_APIPORT` default 3300) with a temp data dir, `ADMIN_EMAIL=coach@example.com`, `ADMIN_PASSWORD_HASH` from `scripts/hash-password.js "admin-pass-123"`, `NODE_ENV=test`, `BOT_FILTER=off`; `config.js` is served with `localhost:3000` rewritten to the API port. Returns `{ call(method,url,body,token), adminToken(), base, dataDir, stop() }` and `adminPage(browser, h, viewport)` (logs into `/admin.html`, aborts `/api/hit`). `admin-e2e/harness.js` (8105/3105) and `habits-e2e/harness.js` (8113/3113) are the same pattern pointed at git worktrees (`/home/user/wt/admin`, `/home/user/wt2/habits`).
- Tours (`e2e/*.js`): `adminshell.js` (every admin tab in chromium/firefox/webkit, desktop + phone), `tour.js`, `bell.js`, `bellcss.js`, `busycal.js`, `care.js`, `clientcards.js`, `homeinbox.js`, `homecons.js`, `onecal.js`, `goalpick.js`, `progs.js`, `progshot.js`, `sound.js`, `stripeembed.js`, `subs.js`, `tips.js`, `tips-rel.js`, `typetoggle.js`, `overflow.js`, `profilefix.js`, `meet.js`, `intake.js`, `wide.js`, `xb.js`; screenshots to `scratchpad/portal/`. `e2e.js` is an API-level contract test that imports the backend's `createApp` directly on an ephemeral port (admin GETs 401 without a token, member routes, plan/programs/pinned/settings/booking persistence). Playwright is loaded from `/opt/node-tools/node_modules/playwright`; Firefox/WebKit builds under `scratchpad/pw/`.
- Harness checks typically assert "no `pageerror`", presence of DOM ids listed in §3/§4, and viewport-specific screenshots at 390×844 and 1366×900.

### 9.3 Pre-commit step
After editing any CSS/JS: `node scripts/version-assets.js` (and `node scripts/site-header.js` first if the shared header changed); commit the rewritten `?v=` hashes in the HTML plus the new `CACHE`/`SHELL` in `sw.js`. After a push to `main`, `live-build.yml` verifies `https://mymdfit.com` serves the commit (`x-mdfit-build`). Content pipelines: `python3 scripts/build-protocols.py` (Pillow) after editing `data/protocols/*.json`; `python3 scripts/program-images.py` (Pillow, numpy) after adding a poster.

---

# Part D — Known gaps found while writing this document

| Area | Finding | Suggested action |
|---|---|---|
| Frontend `common.js` | The Drive direct-download URL hard-codes the owner's personal Google account in an `authuser=` parameter (masked in this document). | Remove once videos move to Cloudinary (A6); until then it is harmless but exposes the account name in page source. |
| Railway variables | `MONGODB_URI` is set but nothing in the backend reads it; `CLIENT_IMPORT` likewise should be checked. | Delete unused variables after confirming. |
| Backend `referrals` collection | Read in code but never written (verify). | Dead code or an unfinished feature; decide. |
| `FREE_MONTHS=3` (membership) | Reported in config but never applied (verify). | Implement or remove from the UI copy. |
| Rate limits | Booking/cancel/lead/review share 20/hour per IP; intake allows 60/hour per IP. A front-desk tablet or clinic Wi-Fi can trip these. | Raise or key by account when the apps launch (apps share carrier NAT IPs). |
| CSP (Vercel) | `frame-src` lacks YouTube/Vimeo although lecture embeds use them (verify); GTM is allowed but no tag is installed. | Fix `vercel.json` before adding lectures from those hosts; drop GTM if unused. |
| `index.html` | Dead `#book-dialog` markup. | Remove. |
| Google Places API key | Was exposed in a chat transcript during development. | Rotate in Google Cloud and update Railway `GOOGLE_PLACES_API_KEY`. |
| Railway deploys | Auto-deploy from GitHub is off; every deploy was triggered by hand. | Enable in Railway → Service → Settings → Source, or document the manual step. |
| Telehealth | The practice's video room link is not yet set (Admin → Home → Hours & sync); video bookings carry no join link until it is. | Owner action. |
| Content | Poster conflicts in Tips (ice-bath frequency, reset length, health-shot ratios, "ErG"); elbow program naming; missing Golf wk 4 and Pickleball Advanced wk 5 sheets; 0-byte plantar videos; ~550 protocol exercise names with no library video. | Owner/clinical decisions (see A6). |
| Stripe | `ui_mode: "embedded_page"` fix and in-app checkout are deployed but were only exercised against a Stripe stand-in. | Run one real test-mode payment per flow (membership, service, protocol) before the apps ship. |
