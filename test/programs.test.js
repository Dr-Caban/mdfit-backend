// Dr. Jared assigns a program -> the client follows it: assignment notes, progress, program resources, and no health details in emails.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const { createApp } = require("../server");
const { hashPassword } = require("../lib/auth");
const { defaultContent, programsOf } = require("../lib/content");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-p-"));
  const app = createApp({
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword("admin-pass-123"), sessionSecret: "s".repeat(40),
    dataDir, origins: ["*"], tz: "America/New_York", now: () => new Date("2026-11-02T10:00:00Z"), siteUrl: "https://mdfit.example.com", ...extra
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const adminToken = async () => (await call("POST", "/api/admin/login", { email: "coach@example.com", password: "admin-pass-123" })).body.token;
  return { call, adminToken, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const signup = (s) => s.call("POST", "/api/clients/signup", { name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", password: "pat-pass-123" });

test("built-in programs: every program is assignable, levels are known, resources point at real Health Tips", () => {
  const d = defaultContent(), ids = d.programs.map((p) => p.id), recs = new Set(d.recommendations.map((r) => r.id));
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const p of d.programs) {
    assert.ok(["beginner", "intermediate", "advanced", "elite"].includes(p.level), p.id);
    for (const r of p.resources || []) assert.ok(recs.has(r), `${p.id} resource ${r} exists`);
  }
  assert.deepEqual(d.programs.find((p) => p.id === "dream-lean-12").resources, ["diet-health-shots", "bath-accu-mat"]);
  // sport levels are separate programs, so each can be assigned
  for (const id of ["golf", "golf-intermediate", "golf-advanced", "pickleball", "pickleball-intermediate", "pickleball-advanced"]) assert.ok(ids.includes(id), id);
  // a "Calf, foot & ankle" day really is calf, foot and ankle work
  for (const id of ["running", "marathon"]) {
    const day = d.programs.find((p) => p.id === id).days.find((x) => /calf/i.test(x.name));
    assert.ok(day.circuit.some((x) => /calf/i.test(x.ex)) && !day.circuit.some((x) => /squat|thrust/i.test(x.ex)), id);
  }
  assert.deepEqual(programsOf({}).map((p) => p.id), ids);
});

test("program resources survive an admin content save and are validated", async (t) => {
  const s = await start(); t.after(s.close);
  const A = await s.adminToken();
  const c = (await s.call("GET", "/api/admin/content", undefined, A)).body;
  const progs = c.programs.map((p) => (p.id === "knee-6" ? { ...p, resources: ["weekly-tracking", "weekly-tracking"] } : p));
  assert.equal((await s.call("PUT", "/api/admin/content", { programs: progs }, A)).status, 200);
  const after = (await s.call("GET", "/api/content")).body.programs;
  assert.deepEqual(after.find((p) => p.id === "knee-6").resources, ["weekly-tracking"], "deduplicated");
  assert.deepEqual(after.find((p) => p.id === "dream-lean-12").resources, ["diet-health-shots", "bath-accu-mat"], "kept through the save");
  const bad = c.programs.map((p) => (p.id === "knee-6" ? { ...p, resources: ["Not A Slug!"] } : p));
  assert.equal((await s.call("PUT", "/api/admin/content", { programs: bad }, A)).status, 400);
});

test("assign -> follow -> progress -> unassign -> re-assign keeps the note; the email carries no note", async (t) => {
  const sent = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { sent.push(JSON.parse(b)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => fake.once("listening", r)); t.after(() => fake.close());
  const s = await start({ resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>", notifyEmail: "owner@example.com" }); t.after(s.close);
  const A = await s.adminToken();
  const { token: T, client } = (await signup(s)).body;
  const put = (programs) => s.call("PUT", `/api/admin/clients/${client.id}/programs`, { programs }, A);
  const note = "Left knee after the meniscus repair: stop at 3/10 pain";
  let r = await put([{ id: "knee-6", note }, { id: "golf-intermediate", note: "Off-season" }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.programProgress["knee-6"], { sessions: 0, sinceAssigned: 0, weeksStarted: [], daysDone: [], lastWeek: "", firstDate: "", lastDate: "" });

  // The client follows them: week-by-week sessions use "prog-<id>-w<week>", day programs "prog-<id>-d<day>"
  const log = (key) => s.call("POST", "/api/me/workouts", { title: "Session", goal: "Rehab", minutes: 15, exercises: 4, key }, T);
  assert.equal((await log("prog-knee-6-w1")).status, 201);
  await log("prog-knee-6-w1"); await log("prog-knee-6-w2");
  await log("prog-golf-w1"); // the beginner golf program: not golf-intermediate
  await log("prog-golf-intermediate-w1");
  const prof = (await s.call("GET", `/api/admin/clients/${client.id}`, undefined, A)).body;
  assert.deepEqual(prof.programProgress["knee-6"].weeksStarted, ["1", "2"]);
  assert.equal(prof.programProgress["knee-6"].sessions, 3);
  assert.equal(prof.programProgress["knee-6"].lastWeek, "2");
  assert.equal(prof.programProgress["knee-6"].lastDate, "2026-11-02");
  assert.equal(prof.programProgress["golf-intermediate"].sessions, 1, "golf beginner sessions don't count toward intermediate");

  // Unassign knee-6: its note is kept on file, then comes back when it's re-assigned without a note
  r = await put([{ id: "golf-intermediate", note: "Off-season" }]);
  assert.deepEqual(r.body.assignedPrograms.map((x) => x.id), ["golf-intermediate"]);
  assert.equal(r.body.programHistory.find((x) => x.id === "knee-6").note, note);
  assert.deepEqual((await s.call("GET", "/api/me", undefined, T)).body.client.assignedPrograms.map((x) => x.id), ["golf-intermediate"]);
  r = await put([{ id: "golf-intermediate", note: "Off-season" }, { id: "knee-6" }]);
  assert.equal(r.body.assignedPrograms.find((x) => x.id === "knee-6").note, note, "re-assigning keeps the note");
  assert.ok(!r.body.programHistory.some((x) => x.id === "knee-6"));
  r = await put([{ id: "golf-intermediate", note: "" }, { id: "knee-6", note }]);
  assert.equal(r.body.assignedPrograms.find((x) => x.id === "golf-intermediate").note, "", "an empty note clears it");

  // Notes are encrypted at rest, including the kept ones
  await put([{ id: "golf-intermediate" }]);
  const raw = fs.readFileSync(path.join(s.dataDir, "clients.json"), "utf8");
  assert.ok(!raw.includes("meniscus"), "program notes are not stored in plain text");

  // Emails: the client hears a program was added, never the clinical note
  for (let i = 0; i < 300 && !sent.some((m) => /program/i.test(m.subject)); i++) await new Promise((res) => setTimeout(res, 20));
  const mails = sent.filter((m) => /program/i.test(m.subject));
  assert.ok(mails.length >= 1);
  for (const m of mails) assert.ok(!/meniscus|3\/10|Off-season/.test(JSON.stringify(m)), "no note text in the email");
});
