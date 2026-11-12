// Notes board (lib/board.js): a private two-person board behind one shared passcode.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;
delete process.env.BOARD_PASSCODE;

const CODE = "424242"; // dummy, test only

async function start(extra = {}, dir) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-board-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com",
    boardPasscode: CODE, ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) };
  };
  const enter = async () => (await call("POST", "/api/board/enter", { code: CODE })).body.token;
  const stop = () => server.close();
  return { call, enter, dataDir, stop, close: () => { stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const add = async (s, tok, kind = "note", body = "Check the booking page", who = "jared") =>
  (await s.call("POST", "/api/board", { who, kind, body }, tok)).body.item;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("no passcode configured: every board route answers 503", async (t) => {
  const s = await start({ boardPasscode: "" }); t.after(s.close);
  const msg = { error: "The notes board isn't set up yet." };
  for (const [m, u, b] of [["POST", "/api/board/enter", { code: CODE }], ["GET", "/api/board?who=dev"], ["POST", "/api/board", { who: "dev", kind: "note", body: "x" }],
    ["POST", "/api/board/abc/reply", { who: "dev", body: "x" }], ["POST", "/api/board/abc/share", { who: "dev" }], ["GET", "/api/board/shared/" + "k".repeat(24)]]) {
    const r = await s.call(m, u, b);
    assert.equal(r.status, 503, `${m} ${u}`);
    assert.deepEqual(r.body, msg);
  }
});

test("enter: wrong code 401, right code gives a 30-day board token", async (t) => {
  const s = await start(); t.after(s.close);
  for (const code of ["000000", "", undefined, "4242421", { a: 1 }]) {
    const r = await s.call("POST", "/api/board/enter", { code });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "That passcode isn't right." });
  }
  const ok = await s.call("POST", "/api/board/enter", { code: CODE });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ["expiresAt", "token"]);
  const payload = JSON.parse(Buffer.from(ok.body.token.split(".")[0], "base64url").toString());
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "role"]);
  assert.equal(payload.role, "board");
  const days = (payload.exp - Date.now()) / 864e5;
  assert.ok(days > 29.9 && days <= 30);
  assert.equal(new Date(ok.body.expiresAt).getTime(), payload.exp);
  assert.equal((await s.call("GET", "/api/board?who=jared", undefined, ok.body.token)).status, 200);
});

test("enter is rate limited: 8 attempts per 15 minutes", async (t) => {
  const s = await start(); t.after(s.close);
  for (let i = 0; i < 8; i++) assert.equal((await s.call("POST", "/api/board/enter", { code: "nope" + i })).status, 401);
  const r = await s.call("POST", "/api/board/enter", { code: CODE });
  assert.equal(r.status, 429, "even the right code is refused once the limit is hit");
  assert.equal(typeof r.body.error, "string");
  assert.equal(r.body.token, undefined);
});

test("a board token is required, and tokens don't cross between board, admin and member", async (t) => {
  const s = await start(); t.after(s.close);
  const again = { error: "Enter the passcode again." };
  const routes = [["GET", "/api/board?who=dev"], ["POST", "/api/board", { who: "dev", kind: "note", body: "x" }], ["POST", "/api/board/abc/reply", { who: "dev", body: "x" }],
    ["POST", "/api/board/abc/seen", { who: "dev" }], ["POST", "/api/board/abc/done", { who: "dev", done: true }],
    ["POST", "/api/board/abc/archive", { who: "dev", archived: true }], ["POST", "/api/board/abc/share", { who: "dev" }]];
  const admin = (await s.call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  const member = (await s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" })).body.token;
  assert.ok(admin && member);
  for (const tok of [undefined, "garbage", "a.b", admin, member]) {
    for (const [m, u, b] of routes) {
      const r = await s.call(m, u, b, tok);
      assert.equal(r.status, 401, `${m} ${u}`);
      assert.deepEqual(r.body, again);
    }
  }
  const board = await s.enter();
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, board)).status, 401);
  assert.equal((await s.call("GET", "/api/admin/stats", undefined, board)).status, 401);
  assert.equal((await s.call("GET", "/api/me", undefined, board)).status, 401);
  assert.equal((await s.call("GET", "/api/me/messages", undefined, board)).status, 401);
  // and the real ones still work where they belong
  assert.equal((await s.call("GET", "/api/admin/clients", undefined, admin)).status, 200);
  assert.equal((await s.call("GET", "/api/me", undefined, member)).status, 200);
});

test("create each kind; list is newest first and never cached", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const made = [];
  for (const kind of ["note", "objective", "done"]) {
    const r = await s.call("POST", "/api/board", { who: "jared", kind, body: `  A ${kind} entry  ` }, tok);
    assert.equal(r.status, 201);
    const it = r.body.item;
    assert.deepEqual(Object.keys(it).sort(), ["archived", "at", "body", "by", "doneAt", "doneBy", "id", "kind", "replies", "seen", "shareKey"]);
    assert.equal(it.kind, kind); assert.equal(it.by, "jared"); assert.equal(it.body, `A ${kind} entry`);
    assert.match(it.at, ISO);
    assert.deepEqual(it.replies, []); assert.deepEqual(it.seen, { jared: it.at });
    assert.equal(it.doneAt, null); assert.equal(it.doneBy, null); assert.equal(it.archived, false); assert.equal(it.shareKey, null);
    made.push(it.id);
    await new Promise((r) => setTimeout(r, 3));
  }
  const list = await s.call("GET", "/api/board?who=dev", undefined, tok);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.match(list.body.now, ISO);
  assert.deepEqual(list.body.items.map((i) => i.id), made.slice().reverse());
  assert.deepEqual(list.body.items.map((i) => i.kind), ["done", "objective", "note"]);
});

test("validation: empty, too long, bad who, bad kind, unknown id", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const bad = async (m, u, b) => { const r = await s.call(m, u, b, tok); assert.equal(r.status, 400, `${m} ${u} ${String(JSON.stringify(b)).slice(0, 60)}`); assert.equal(typeof r.body.error, "string"); };
  await bad("POST", "/api/board", { who: "jared", kind: "note", body: "" });
  await bad("POST", "/api/board", { who: "jared", kind: "note", body: "   \n " });
  await bad("POST", "/api/board", { who: "jared", kind: "note" });
  await bad("POST", "/api/board", { who: "jared", kind: "note", body: 12 });
  await bad("POST", "/api/board", { who: "jared", kind: "note", body: "x".repeat(4001) });
  await bad("POST", "/api/board", { who: "Jared", kind: "note", body: "x" });
  await bad("POST", "/api/board", { who: "admin", kind: "note", body: "x" });
  await bad("POST", "/api/board", { kind: "note", body: "x" });
  await bad("POST", "/api/board", { who: "dev", kind: "task", body: "x" });
  await bad("POST", "/api/board", { who: "dev", body: "x" });
  await bad("POST", "/api/board", undefined);
  await bad("GET", "/api/board");
  await bad("GET", "/api/board?who=someone");
  assert.equal((await s.call("POST", "/api/board", { who: "dev", kind: "note", body: "x".repeat(4000) }, tok)).status, 201);

  const it = await add(s, tok);
  await bad("POST", `/api/board/${it.id}/reply`, { who: "dev", body: "" });
  await bad("POST", `/api/board/${it.id}/reply`, { who: "dev", body: "y".repeat(2001) });
  await bad("POST", `/api/board/${it.id}/reply`, { who: "nobody", body: "hi" });
  await bad("POST", `/api/board/${it.id}/seen`, {});
  await bad("POST", `/api/board/${it.id}/done`, { who: "dev", done: "yes" });
  await bad("POST", `/api/board/${it.id}/archive`, { who: "dev" });
  await bad("POST", `/api/board/${it.id}/share`, { who: "x" });
  assert.equal((await s.call("POST", `/api/board/${it.id}/reply`, { who: "dev", body: "y".repeat(2000) }, tok)).status, 200);

  for (const [act, b] of [["reply", { who: "dev", body: "hi" }], ["seen", { who: "dev" }], ["done", { who: "dev", done: true }], ["archive", { who: "dev", archived: true }], ["share", { who: "dev" }]]) {
    const r = await s.call("POST", `/api/board/nope/${act}`, b, tok);
    assert.equal(r.status, 404, act);
    assert.deepEqual(r.body, { error: "That entry isn't here any more." });
  }
  // nothing is ever deleted
  assert.equal((await s.call("DELETE", `/api/board/${it.id}`, undefined, tok)).status, 404);
  assert.equal((await s.call("GET", "/api/board?who=dev", undefined, tok)).body.items.length, 2);
});

test("reply resets seen, is refused on non-notes, and doesn't reopen a done note", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const note = await add(s, tok);
  await s.call("POST", `/api/board/${note.id}/seen`, { who: "dev" }, tok);
  await s.call("POST", `/api/board/${note.id}/done`, { who: "jared", done: true }, tok);
  const r = await s.call("POST", `/api/board/${note.id}/reply`, { who: "dev", body: "  Looks fine to me " }, tok);
  assert.equal(r.status, 200);
  const it = r.body.item;
  assert.equal(it.replies.length, 1);
  assert.deepEqual(Object.keys(it.replies[0]).sort(), ["at", "body", "by"]);
  assert.equal(it.replies[0].by, "dev"); assert.equal(it.replies[0].body, "Looks fine to me"); assert.match(it.replies[0].at, ISO);
  assert.deepEqual(it.seen, { dev: it.replies[0].at }, "new again for jared");
  assert.ok(it.doneAt, "still done"); assert.equal(it.doneBy, "jared");
  const r2 = await s.call("POST", `/api/board/${note.id}/reply`, { who: "jared", body: "Thanks" }, tok);
  assert.deepEqual(r2.body.item.replies.map((x) => [x.by, x.body]), [["dev", "Looks fine to me"], ["jared", "Thanks"]]);
  assert.deepEqual(Object.keys(r2.body.item.seen), ["jared"]);

  for (const kind of ["objective", "done"]) {
    const o = await add(s, tok, kind);
    const x = await s.call("POST", `/api/board/${o.id}/reply`, { who: "dev", body: "hi" }, tok);
    assert.equal(x.status, 400, kind);
  }
});

test("seen is idempotent", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const note = await add(s, tok);
  const a = (await s.call("POST", `/api/board/${note.id}/seen`, { who: "dev" }, tok)).body.item;
  assert.match(a.seen.dev, ISO); assert.equal(a.seen.jared, note.seen.jared);
  await new Promise((r) => setTimeout(r, 5));
  const b = await s.call("POST", `/api/board/${note.id}/seen`, { who: "dev" }, tok);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.item.seen, a.seen, "the first time stands");
  const c = (await s.call("POST", `/api/board/${note.id}/seen`, { who: "jared" }, tok)).body.item;
  assert.equal(c.seen.jared, note.seen.jared, "the author's own timestamp doesn't move either");
});

test("done true/false on notes and objectives, refused on kind done", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  for (const kind of ["note", "objective"]) {
    const it = await add(s, tok, kind);
    const on = await s.call("POST", `/api/board/${it.id}/done`, { who: "dev", done: true }, tok);
    assert.equal(on.status, 200);
    assert.match(on.body.item.doneAt, ISO); assert.equal(on.body.item.doneBy, "dev");
    const off = await s.call("POST", `/api/board/${it.id}/done`, { who: "jared", done: false }, tok);
    assert.equal(off.body.item.doneAt, null); assert.equal(off.body.item.doneBy, null);
  }
  const d = await add(s, tok, "done");
  assert.equal((await s.call("POST", `/api/board/${d.id}/done`, { who: "dev", done: true }, tok)).status, 400);
  assert.equal((await s.call("POST", `/api/board/${d.id}/done`, { who: "dev", done: false }, tok)).status, 400);
});

test("archive and unarchive; archived entries stay in the list", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const it = await add(s, tok, "objective");
  const a = await s.call("POST", `/api/board/${it.id}/archive`, { who: "dev", archived: true }, tok);
  assert.equal(a.status, 200); assert.equal(a.body.item.archived, true);
  const list = (await s.call("GET", "/api/board?who=jared", undefined, tok)).body.items;
  assert.equal(list.length, 1); assert.equal(list[0].archived, true);
  assert.equal((await s.call("POST", `/api/board/${it.id}/archive`, { who: "jared", archived: false }, tok)).body.item.archived, false);
});

test("share: stable key, public read without private fields, bad key 404, archived still works", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const note = await add(s, tok, "note", "Shared with the designer");
  await s.call("POST", `/api/board/${note.id}/reply`, { who: "dev", body: "On it" }, tok);
  const first = await s.call("POST", `/api/board/${note.id}/share`, { who: "jared" }, tok);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body), ["key"]);
  assert.match(first.body.key, /^[A-Za-z0-9_-]{24}$/);
  assert.equal((await s.call("POST", `/api/board/${note.id}/share`, { who: "dev" }, tok)).body.key, first.body.key);
  assert.equal((await s.call("GET", "/api/board?who=dev", undefined, tok)).body.items[0].shareKey, first.body.key);

  const pub = await s.call("GET", "/api/board/shared/" + first.body.key); // no token
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(pub.body), ["item"]);
  assert.deepEqual(Object.keys(pub.body.item).sort(), ["at", "body", "by", "doneAt", "doneBy", "kind", "replies"]);
  assert.equal(pub.body.item.body, "Shared with the designer");
  assert.deepEqual(pub.body.item.replies.map((x) => [x.by, x.body]), [["dev", "On it"]]);
  assert.equal(pub.body.item.kind, "note"); assert.equal(pub.body.item.by, "jared"); assert.equal(pub.body.item.doneAt, null);

  for (const k of ["nope", "x".repeat(24), note.id, "null", "undefined"]) {
    const r = await s.call("GET", "/api/board/shared/" + k);
    assert.equal(r.status, 404, k);
    assert.deepEqual(r.body, { error: "This link no longer works." });
  }
  // an entry that was never shared can't be reached, and another entry gets its own key
  const other = await add(s, tok, "objective", "Second");
  const k2 = (await s.call("POST", `/api/board/${other.id}/share`, { who: "dev" }, tok)).body.key;
  assert.notEqual(k2, first.body.key);

  await s.call("POST", `/api/board/${note.id}/archive`, { who: "dev", archived: true }, tok);
  assert.equal((await s.call("GET", "/api/board/shared/" + first.body.key)).status, 200);
});

test("shared reads are rate limited", async (t) => {
  const s = await start(); t.after(s.close);
  let last;
  for (let i = 0; i < 61; i++) last = await s.call("GET", "/api/board/shared/" + "z".repeat(24));
  assert.equal(last.status, 429);
});

test("entry and reply text is not stored in plain text, and survives a restart", async (t) => {
  const s = await start();
  const tok = await s.enter();
  const note = await add(s, tok, "note", "Zebra-crossing-secret-note");
  await s.call("POST", `/api/board/${note.id}/reply`, { who: "dev", body: "Walrus-reply-secret" }, tok);
  await s.call("POST", `/api/board/${note.id}/done`, { who: "dev", done: true }, tok);
  const key = (await s.call("POST", `/api/board/${note.id}/share`, { who: "dev" }, tok)).body.key;
  const before = (await s.call("GET", "/api/board?who=dev", undefined, tok)).body.items;

  const raw = fs.readFileSync(path.join(s.dataDir, "board.json"), "utf8");
  assert.ok(!raw.includes("Zebra-crossing-secret-note") && !raw.includes("Walrus-reply-secret"));
  assert.ok(!raw.includes(CODE), "the passcode is never stored");
  const stored = JSON.parse(raw);
  assert.equal(stored.length, 1);
  assert.match(stored[0].body, /^v1:/); assert.match(stored[0].replies[0].body, /^v1:/);
  for (const f of fs.readdirSync(s.dataDir)) {
    const p = path.join(s.dataDir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes("secret-note"), f + " holds no entry text");
  }

  s.stop();
  const s2 = await start({}, s.dataDir); t.after(s2.close);
  // the token outlives a restart too (same session secret)
  const after = await s2.call("GET", "/api/board?who=dev", undefined, tok);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.items, before);
  assert.equal(after.body.items[0].body, "Zebra-crossing-secret-note");
  assert.equal(after.body.items[0].replies[0].body, "Walrus-reply-secret");
  assert.equal((await s2.call("GET", "/api/board/shared/" + key)).body.item.body, "Zebra-crossing-secret-note");
});

test("the board is refused new entries once full, rather than dropping old ones", async (t) => {
  const s = await start(); t.after(s.close);
  const tok = await s.enter();
  const { MAX_ITEMS } = require("../lib/board");
  const row = (i) => ({ id: "seed" + i, kind: "done", by: "dev", at: new Date(1e12 + i).toISOString(), body: "seed", replies: [], seen: {}, doneAt: null, doneBy: null, archived: true, shareKey: null });
  fs.writeFileSync(path.join(s.dataDir, "board.json"), JSON.stringify(Array.from({ length: MAX_ITEMS }, (_, i) => row(i))));
  const r = await s.call("POST", "/api/board", { who: "dev", kind: "note", body: "one more" }, tok);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /full/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, "board.json"), "utf8")).length, MAX_ITEMS);
});

test("board routes sit behind the same edge gate and bot filter as the rest of /api", async (t) => {
  const s = await start({ edgeSecret: "edge-secret-for-tests", botFilter: true }); t.after(s.close);
  const browser = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" }, edge = { "x-mdfit-edge": "edge-secret-for-tests" };
  // straight to the API, not through the site's edge
  assert.equal((await s.call("POST", "/api/board/enter", { code: CODE }, undefined, browser)).status, 403);
  assert.equal((await s.call("GET", "/api/board/shared/" + "z".repeat(24), undefined, undefined, browser)).status, 403);
  // through the edge, but a script
  assert.equal((await s.call("POST", "/api/board/enter", { code: CODE }, undefined, { ...edge, "user-agent": "curl/8.0" })).status, 403);
  // through the edge, from a browser: same answer /api/videos gets
  assert.equal((await s.call("GET", "/api/videos", undefined, undefined, { ...edge, ...browser })).status, 200);
  const ok = await s.call("POST", "/api/board/enter", { code: CODE }, undefined, { ...edge, ...browser });
  assert.equal(ok.status, 200);
  assert.equal((await s.call("GET", "/api/board?who=dev", undefined, ok.body.token, { ...edge, ...browser })).status, 200);
});

test("nothing from the board reaches the logs or the audit ledger", async (t) => {
  const lines = [], sink = logger.sink, level = logger.level;
  logger.sink = (l) => lines.push(l); logger.level = 10;
  t.after(() => { logger.sink = sink; logger.level = level; });
  const s = await start(); t.after(s.close);
  await s.call("POST", "/api/board/enter", { code: "135790" });
  const tok = await s.enter();
  const note = await add(s, tok, "note", "Quokka-private-text");
  await s.call("POST", `/api/board/${note.id}/reply`, { who: "dev", body: "Numbat-private-reply" }, tok);
  await new Promise((r) => setTimeout(r, 30));
  const out = lines.join("\n");
  assert.ok(out.includes("/api/board") || out.includes("board_enter_failed"), "the requests were logged");
  for (const secret of [CODE, "135790", "Quokka-private-text", "Numbat-private-reply", tok]) assert.ok(!out.includes(secret));
  for (const f of fs.readdirSync(s.dataDir, { recursive: true })) {
    const p = path.join(s.dataDir, String(f));
    if (!fs.statSync(p).isFile()) continue;
    const raw = fs.readFileSync(p, "utf8");
    for (const secret of [CODE, "135790", "Quokka-private-text", "Numbat-private-reply"]) assert.ok(!raw.includes(secret), `${f}`);
  }
});

// The key in a shared link is the only thing protecting that note, so the request log must not record it
test("board: a shared link's key is kept out of the request log", (t) => {
  const { requestLogger, logger } = require("../lib/logger");
  const seen = [], real = logger.log;
  logger.log = (level, msg, fields) => { seen.push(fields); };
  t.after(() => { logger.log = real; });
  for (const path of ["/api/board/shared/SECRETKEY123", "/shared/SECRETKEY123", "/api/board"]) {
    const handlers = {};
    const res = { statusCode: 200, on: (ev, fn) => { handlers[ev] = fn; }, once: (ev, fn) => { handlers[ev] = fn; } };
    requestLogger({ method: "GET", path, originalUrl: path, url: path }, res, () => {});
    (handlers.finish || handlers.close || (() => {}))();
  }
  assert.ok(seen.length >= 3, "each request was logged");
  assert.ok(!JSON.stringify(seen).includes("SECRETKEY123"), "the key is not in the log");
  assert.ok(seen.some((f) => f && f.path === "/api/board"), "ordinary paths are logged as they are");
});
