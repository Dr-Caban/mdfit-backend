// Trainers and clinicians (lib/pros.js): apply, owner approval, the member's choice, minimum-necessary views,
// the member's yes before a clinician sees pain check-ins (audited), and MD Fit-only assignments.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");
logger.level = 99;

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-pros-"));
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date(), siteUrl: "https://mdfit.example.com" });
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => undefined) }; };
  const admin = (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  let n = 0;
  const member = async (name, extra = {}) => (await call("POST", "/api/clients/signup", { name, email: `p${++n}@example.com`, phone: "941-555-0100", password: "pass-word-123", ...extra })).body;
  return { call, admin, member, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("apply, approve, choose, see only what each role may, assign MD Fit content only", async () => {
  const s = await start();
  try {
    const { call, admin } = s;
    // Sign-up records the answer to "How do you want to train?"
    const mem = await s.member("Mia Stone", { coachMode: "clinician" });
    assert.equal(mem.client.coachMode, "clinician");
    const mem2 = await s.member("Ty Ruiz", { coachMode: "trainer" });
    const solo = await s.member("Al Free", { coachMode: "nonsense" });
    assert.equal(solo.client.coachMode, null);

    // Applying: trainers accept the terms, clinicians the BAA and a license
    const tr = await s.member("Tom Trainer"), cl = await s.member("Cara Clinic");
    assert.equal((await call("POST", "/api/me/pro/apply", { type: "trainer", displayName: "Tom T.", specialty: "Strength" }, tr.token)).status, 400);
    assert.equal((await call("POST", "/api/me/pro/apply", { type: "trainer", displayName: "Tom T.", specialty: "Strength", acceptTerms: true }, tr.token)).status, 201);
    assert.equal((await call("POST", "/api/me/pro/apply", { type: "clinician", displayName: "Dr. Cara", acceptBaa: true }, cl.token)).status, 400);   // no license
    assert.equal((await call("POST", "/api/me/pro/apply", { type: "clinician", displayName: "Dr. Cara", license: "PT12345", licenseState: "FL" }, cl.token)).status, 400); // no BAA
    const ca = await call("POST", "/api/me/pro/apply", { type: "clinician", displayName: "Dr. Cara", specialty: "Pain rehab", license: "PT12345", licenseState: "FL", acceptBaa: true }, cl.token);
    assert.equal(ca.status, 201); assert.equal(ca.body.pro.status, "pending");

    // Not listed, and no portal, until the owner approves
    assert.equal((await call("GET", "/api/me/pros?type=trainer", undefined, mem2.token)).body.pros.length, 0);
    assert.equal((await call("GET", "/api/me/pro/members", undefined, tr.token)).status, 403);
    // Members can't reach the owner's review, nor approve themselves
    assert.equal((await call("GET", "/api/admin/pros", undefined, tr.token)).status, 401);
    const apps = (await call("GET", "/api/admin/pros", undefined, admin)).body.pros;
    assert.equal(apps.length, 2);
    for (const a of apps) assert.equal((await call("POST", `/api/admin/pros/${a.id}/decision`, { status: "approved" }, admin)).status, 200);
    const trId = apps.find((a) => a.type === "trainer").id, clId = apps.find((a) => a.type === "clinician").id;

    // The directory: the practice first among clinicians; never the license number or contact details
    const dir = (await call("GET", "/api/me/pros?type=clinician", undefined, mem.token)).body.pros;
    assert.equal(dir[0].id, "practice"); assert.equal(dir[1].name, "Dr. Cara");
    assert.ok(!JSON.stringify(dir).includes("PT12345") && !JSON.stringify(dir).includes("@example.com"));

    // Choosing: a trainer can't be picked as a clinician; sharing health is only for a clinician and only on a yes
    assert.equal((await call("PUT", "/api/me/coach", { mode: "clinician", proId: trId }, mem.token)).status, 404);
    const ch = await call("PUT", "/api/me/coach", { mode: "clinician", proId: clId, shareHealth: false }, mem.token);
    assert.equal(ch.status, 200); assert.equal(ch.body.coach.pro.name, "Dr. Cara"); assert.equal(ch.body.coach.shareHealth, false);
    assert.equal((await call("PUT", "/api/me/coach", { mode: "trainer", proId: trId, shareHealth: true }, mem2.token)).body.coach.shareHealth, false);
    await call("POST", "/api/me/pain", { area: "Knee", level: 6, note: "after stairs" }, mem.token);
    await call("POST", "/api/me/pain", { area: "Back", level: 3 }, mem2.token);

    // Clinician without the member's yes: names and assignments only
    const cm = (await call("GET", "/api/me/pro/members", undefined, cl.token)).body.members;
    assert.equal(cm.length, 1); assert.equal(cm[0].name, "Mia Stone"); assert.equal(cm[0].sharesHealth, false);
    assert.ok(!JSON.stringify(cm).includes("Knee"));
    assert.equal((await call("GET", `/api/me/pro/members/${mem.client.id}/pain`, undefined, cl.token)).status, 403);
    // Trainers never see health information, and never another pro's members
    assert.equal((await call("GET", `/api/me/pro/members/${mem2.client.id}/pain`, undefined, tr.token)).status, 403);
    assert.equal((await call("GET", `/api/me/pro/members/${mem.client.id}/pain`, undefined, tr.token)).status, 404);
    assert.ok(!JSON.stringify((await call("GET", "/api/me/pro/members", undefined, tr.token)).body).includes("Back"));

    // The member says yes: the clinician sees the check-ins, and the viewing is in the audit ledger
    await call("PUT", "/api/me/coach", { mode: "clinician", proId: clId, shareHealth: true }, mem.token);
    const pain = await call("GET", `/api/me/pro/members/${mem.client.id}/pain`, undefined, cl.token);
    assert.equal(pain.status, 200); assert.equal(pain.body.pain[0].area, "Knee"); assert.equal(pain.body.pain[0].level, 6);
    const audit = (await call("GET", "/api/admin/audit?action=pro.view_pain", undefined, admin)).body.entries;
    assert.ok(audit.some((e) => e.action === "pro.view_pain" && e.subject === mem.client.id), JSON.stringify(audit.map((e) => e.action)));
    assert.ok((await call("GET", "/api/admin/audit?action=pro.share_health_on", undefined, admin)).body.entries.length >= 1);
    // ...and taking it back ends it at once
    await call("PUT", "/api/me/coach", { mode: "clinician", proId: clId, shareHealth: false }, mem.token);
    assert.equal((await call("GET", `/api/me/pro/members/${mem.client.id}/pain`, undefined, cl.token)).status, 403);

    // Assign: only MD Fit's programs, Pain Tool protocols and library exercises, only to their own members
    const A = (b, t = tr.token) => call("POST", "/api/me/pro/assignments", { clientId: mem2.client.id, ...b }, t);
    assert.equal((await A({ kind: "program", ref: "hypertrophy-12", note: "Start Monday" })).status, 201);
    assert.equal((await A({ kind: "program", ref: "my-own-plan" })).status, 400);
    assert.equal((await A({ kind: "protocol", ref: "suboccipitals", title: "Suboccipitals" })).status, 201);
    assert.equal((await A({ kind: "protocol", ref: "made-up" })).status, 400);
    assert.equal((await A({ kind: "workout", title: "Legs", exercises: [{ id: "AAAAAAAAAAAAAAAAAAAAAAAAA", sets: 3, reps: 10 }] })).status, 400);
    const libId = require("../lib/exercises.json").exercises[0].id;
    const wk = await A({ kind: "workout", title: "Legs", exercises: [{ id: libId, sets: 3, reps: 12, repsBySet: [12, 10, 8] }] });
    assert.equal(wk.status, 201);
    assert.equal((await A({ kind: "link", ref: "https://example.com" })).status, 400);
    assert.equal((await call("POST", "/api/me/pro/assignments", { clientId: mem.client.id, kind: "program", ref: "hypertrophy-12" }, tr.token)).status, 404); // not theirs

    // The member sees them with progress from their own log
    await call("POST", "/api/me/workouts", { title: "PSG day 1", minutes: 40, exercises: 3, key: "prog-hypertrophy-12-d0" }, mem2.token);
    await call("POST", "/api/me/workouts", { title: "Legs", minutes: 10, exercises: 1, key: `assign-${wk.body.assignment.id}` }, mem2.token);
    const mine = (await call("GET", "/api/me/coach", undefined, mem2.token)).body.coach;
    assert.equal(mine.pro.name, "Tom T.");
    const byKind = Object.fromEntries(mine.assignments.map((a) => [a.kind, a]));
    assert.equal(byKind.program.sessions, 1); assert.equal(byKind.workout.sessions, 1); assert.equal(byKind.protocol.sessions, 0);
    assert.deepEqual(byKind.workout.workout.exercises[0].repsBySet, [12, 10, 8]);
    assert.equal(byKind.program.note, "Start Monday");

    // A pro can let a member go; the member is then independent
    assert.equal((await call("POST", `/api/me/pro/members/${mem2.client.id}/release`, undefined, tr.token)).status, 200);
    assert.equal((await call("GET", "/api/me/coach", undefined, mem2.token)).body.coach.mode, "independent");
    // Suspending a pro takes them out of the directory and the portal
    await call("POST", `/api/admin/pros/${trId}/decision`, { status: "suspended", reason: "test" }, admin);
    assert.equal((await call("GET", "/api/me/pros?type=trainer", undefined, mem.token)).body.pros.length, 0);
    assert.equal((await call("GET", "/api/me/pro/members", undefined, tr.token)).status, 403);
  } finally { s.close(); }
});
