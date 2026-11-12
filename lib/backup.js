// The weekly client export: every Monday morning the owner is emailed ONE self-contained file holding all client
// records. The file is an HTML page with the encrypted zip inside it; opened on a computer it asks for the passphrase,
// decrypts in the browser and hands over the zip. It needs no internet connection and no server - once the email has
// arrived, the owner has the data even if this service is gone.
//
// What keeps that safe, because the file travels by email and sits in an inbox:
//  - The passphrase lives only in BACKUP_PASSPHRASE and is never in the file, the email, a log or the repo.
//  - It should be long. An emailed file can be attacked offline, as fast as the attacker's hardware allows and with no
//    lockout, so a short code protects little however slow the key derivation is: all 10,000 four-digit codes take
//    minutes. Under MIN_PASSPHRASE characters the job refuses to send unless the owner has switched on
//    BACKUP_ALLOW_SHORT_CODE, which is theirs to decide.
//  - AES-256-GCM, key from PBKDF2-SHA256 with a fresh salt per file - both things a browser can do offline.
//  - It goes to the owner's own address only, never to the extra alert addresses.
//  - The email body and the visible page carry counts and dates, never a name.
// The records are the ones Workspace -> Clients -> Export produces, with the same rule for restricted notes.
"use strict";
const crypto = require("crypto");
const zlib = require("zlib");

const MIN_PASSPHRASE = 12, ITERATIONS = 600000, MAX_EMAIL_BYTES = 25 * 1024 * 1024;

// A plain zip (deflate, no encryption - the encryption wraps the whole archive). files: [{ name, data: Buffer|string }]
function zip(files, when = new Date()) {
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const body = zlib.deflateRawSync(raw, { level: 9 }), crc = zlib.crc32(raw) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8); // utf-8 names, deflate
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(head, name, body); central.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// Encrypt so that a browser's WebCrypto can undo it: PBKDF2-SHA256 -> AES-256-GCM, tag appended to the ciphertext
function seal(plain, passphrase, iterations = ITERATIONS) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(passphrase), salt, iterations, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, cipher: "AES-256-GCM", salt: salt.toString("base64"), iv: iv.toString("base64"), data: data.toString("base64") };
}
function unseal(box, passphrase) {
  const key = crypto.pbkdf2Sync(String(passphrase), Buffer.from(box.salt, "base64"), box.iterations, 32, "sha256");
  const raw = Buffer.from(box.data, "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The file that is emailed. Everything it needs is inside it: no fonts, scripts or requests to anywhere.
function page({ box, date, count, zipName }) {
  const payload = JSON.stringify({ box, zipName }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>MD Fit client export ${esc(date)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A1A2E;color:#fff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
  main{width:100%;max-width:420px;text-align:center}
  .k{color:#7AAFD7;font-size:12.5px;letter-spacing:.6px;text-transform:uppercase;font-weight:600}
  h1{font:700 26px Georgia,serif;margin:4px 0 6px}
  p{color:#c9d1dc;margin:0 0 18px;font-size:14.5px}
  input{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:2px solid #2a4162;background:#10233b;color:#fff;font:inherit}
  input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #7AAFD7;outline-offset:2px}
  button,a.btn{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:14px;border:0;border-radius:12px;background:#7AAFD7;color:#0A1A2E;font:700 16px system-ui,sans-serif;cursor:pointer;text-decoration:none}
  button:disabled{opacity:.5;cursor:wait}
  #msg{min-height:24px;margin-top:12px;font-size:14px;color:#ffb4ab}
  #msg.ok{color:#a8e0bd}
  small{display:block;margin-top:22px;color:#8fa0b5;font-size:12.5px}
  [hidden]{display:none!important}
</style></head><body><main>
  <div class="k">MD Fit</div>
  <h1>Client export</h1>
  <p>${esc(date)} &middot; ${esc(count)} client record${count === 1 ? "" : "s"}. Enter the passphrase to unlock the zip. This works with no internet connection.</p>
  <form id="f" autocomplete="off">
    <label for="pw" style="position:absolute;left:-9999px">Passphrase</label>
    <input id="pw" type="password" autocomplete="off" spellcheck="false" placeholder="Passphrase" aria-describedby="msg">
    <button id="go" type="submit">Unlock</button>
  </form>
  <a class="btn" id="dl" hidden>Save the zip again</a>
  <div id="msg" role="alert"></div>
  <small>This file holds private health information. Keep it, and the zip it produces, somewhere only you can reach.</small>
</main>
<script id="payload" type="application/json">${payload}</script>
<script>
(function () {
  var P = JSON.parse(document.getElementById("payload").textContent), box = P.box;
  var $ = function (id) { return document.getElementById(id); }, msg = $("msg");
  var say = function (t, ok) { msg.textContent = t; msg.className = ok ? "ok" : ""; };
  var bytes = function (b64) { var s = atob(b64), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
  if (!(window.crypto && crypto.subtle)) { $("go").disabled = true; say("This viewer can't unlock the file. Save it to a computer and open it in Chrome, Edge, Firefox or Safari."); return; }
  $("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("pw").value; if (!pw) return;
    $("go").disabled = true; say("Unlocking\\u2026", true);
    crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(box.salt), iterations: box.iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    }).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(box.iv) }, key, bytes(box.data));
    }).then(function (plain) {
      var url = URL.createObjectURL(new Blob([plain], { type: "application/zip" })), a = $("dl");
      a.href = url; a.download = P.zipName; a.hidden = false; $("f").hidden = true; $("pw").value = "";
      say("Unlocked. Your zip is saving now.", true); a.click();
    }).catch(function () { $("go").disabled = false; say("That passphrase isn't right."); $("pw").select(); });
  });
  $("pw").focus();
})();
</script>
</body></html>
`;
}

// Monday of the week a date falls in, as YYYY-MM-DD: one send per week is "one send per Monday key"
function weekKey(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z"), back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function mountBackup({ admin, store, cfg, audit, activity, limiter, notify, logger, exportApi, nowParts }) {
  const passphrase = () => String(cfg.backupPassphrase !== undefined ? cfg.backupPassphrase : process.env.BACKUP_PASSPHRASE || "");
  // The owner may decide a short code is enough. That is their call to make, knowingly: it has to be switched on, and
  // every send under a short code says so in the log, because such a file is only as private as the inbox it sits in.
  const allowShort = () => (cfg.backupAllowShort !== undefined ? !!cfg.backupAllowShort : /^(yes|true|1)$/i.test(process.env.BACKUP_ALLOW_SHORT_CODE || ""));
  const state = () => store.read("backupWeekly", {});
  const now = () => (cfg.now ? cfg.now() : new Date());
  const local = () => nowParts(cfg.tz, now()); // { date: "YYYY-MM-DD", time: "HH:MM", ... } in the practice's time zone
  // Why it can't run right now, in words the owner can act on; "" when it can
  function blocked() {
    const p = passphrase();
    if (!p) return "No passphrase is set (BACKUP_PASSPHRASE).";
    if (p.length < MIN_PASSPHRASE && !allowShort()) return `The passphrase is too short to protect an emailed file: use at least ${MIN_PASSPHRASE} characters, or set BACKUP_ALLOW_SHORT_CODE=yes to accept a short code.`;
    if (!notify || !notify.enabled) return "Email isn't set up on the server.";
    if (!notify.ownerAddress) return "There is no owner email address to send to.";
    return "";
  }

  function build() {
    const { date } = local(), out = exportApi.everyone();
    const readme = [`MD Fit client export, ${date}`, "", `${out.count} client records.`, "",
      "clients.csv            one row per client: contact details, status, membership, visit dates",
      "client-records.json    each client's full record: account, appointments, plan, chart, documents, notes", "",
      "Restricted clinical notes are listed without their text; open those in the workspace, where each opening is recorded.",
      "This archive holds private health information. Store it encrypted and share it with no one who is not entitled to it.", ""].join("\r\n");
    const archive = zip([{ name: "README.txt", data: readme }, { name: "clients.csv", data: out.csv }, { name: "client-records.json", data: out.json }], now());
    const html = page({ box: seal(archive, passphrase(), cfg.backupIterations || ITERATIONS), date, count: out.count, zipName: `mdfit-clients-${date}.zip` });
    return { date, count: out.count, html, zipBytes: archive.length };
  }

  let running = null;
  function send(trigger, ip) {
    if (running) return running;
    running = (async () => {
      const why = blocked(), startedAt = now().toISOString(), { date } = local();
      const done = (r) => { store.write("backupWeekly", { ...state(), lastAt: startedAt, lastDate: date, ...r, ...(r.ok ? { week: weekKey(date), okAt: startedAt } : {}) }); return { ok: r.ok, date, ...r }; };
      if (why) { logger.warn("backup_weekly_skipped", { reason: why }); return done({ ok: false, error: why }); }
      let b;
      try { b = build(); } catch (e) { logger.error("backup_weekly_failed", { error: e.message }); return done({ ok: false, error: "The export could not be built." }); }
      const bytes = Buffer.byteLength(b.html);
      if (bytes > MAX_EMAIL_BYTES) return done({ ok: false, count: b.count, bytes, error: `The export is ${Math.round(bytes / 1048576)} MB, too large to email.` });
      const ok = await notify.ownerFile(`MD Fit weekly client export, ${b.date}`,
        [`This week's client export is attached: ${b.count} client record${b.count === 1 ? "" : "s"}.`, "",
          "Save the attached file to a computer and open it in a browser. It asks for your passphrase and then saves a zip.",
          "It works with no internet connection. The passphrase is not in this email.", "",
          "The attachment holds private health information. Do not forward this email."].join("\n"),
        { filename: `mdfit-client-export-${b.date}.html`, content: Buffer.from(b.html, "utf8").toString("base64") });
      if (audit) audit.record({ actor: trigger === "admin" ? "admin" : "system", action: "export.weekly", subject: "", ip: ip || "", meta: { count: b.count, bytes, sent: ok, trigger } });
      if (activity) activity("clients_exported", { count: b.count, kind: "weekly" });
      logger[ok ? "info" : "warn"]("backup_weekly", { sent: ok, count: b.count, bytes });
      if (ok && passphrase().length < MIN_PASSPHRASE) logger.warn("backup_weekly_short_code", { note: "sent under a short code: the file can be opened by guessing" });
      return done(ok ? { ok: true, count: b.count, bytes, error: "" } : { ok: false, count: b.count, bytes, error: "The email could not be sent." });
    })().finally(() => { running = null; });
    return running;
  }

  // Mondays from 6 am practice time; if the service was down then, the first check afterwards in the same week sends it
  const DUE_HOUR = 6;
  function due() {
    const { date, time } = local(), s = state(), wk = weekKey(date);
    if (s.week === wk) return false;                                   // already sent this week
    if (date === wk && Number(String(time).slice(0, 2)) < DUE_HOUR) return false; // Monday, but before 6 am
    if (s.lastDate === date && !s.ok) return false;                    // tried and failed today: once a day, not once an hour
    return true;
  }
  const tick = () => { try { if (!blocked() && due()) send("schedule").catch(() => {}); } catch (e) { logger.warn("backup_weekly_tick", { error: e.message }); } };
  if (!cfg.noBackupSchedule) { setTimeout(tick, 90 * 1000).unref(); setInterval(tick, 60 * 60 * 1000).unref(); }

  const limit = limiter(6, 60 * 60 * 1000);
  admin.get("/export/weekly", (req, res) => {
    const s = state(), why = blocked();
    res.set("cache-control", "no-store").json({ ready: !why, blocked: why, minPassphrase: MIN_PASSPHRASE, shortCode: !why && passphrase().length < MIN_PASSPHRASE, schedule: "Mondays, 6 am", last: s.lastAt ? { at: s.lastAt, ok: !!s.ok, count: s.count || 0, bytes: s.bytes || 0, error: s.error || "" } : null, lastSentAt: s.okAt || null });
  });
  admin.post("/export/weekly/send", limit.mw, async (req, res) => {
    const r = await send("admin", req.ip);
    res.status(r.ok ? 200 : 409).set("cache-control", "no-store").json(r.ok ? { ok: true, count: r.count, bytes: r.bytes } : { error: r.error });
  });

  return { send, due, build, blocked, tick };
}

module.exports = { mountBackup, zip, seal, unseal, page, weekKey, MIN_PASSPHRASE };
