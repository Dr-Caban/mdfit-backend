// End-to-end API tests against a real server on a random port, with a temp data folder and a fixed clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp, addDays, weekday, toCsv } = require("../server");
const { hashPassword } = require("../lib/auth");
const { logger } = require("../lib/logger");

if (process.env.NODE_ENV === "production") throw new Error("Refusing to run tests in production.");
logger.level = 99;

const PASSWORD = "test-pass-123";
// Monday 2026-11-02, 05:00 in Sarasota (10:00 UTC)
const NOW = new Date("2026-11-02T10:00:00Z");

async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdfit-"));
  const cfg = {
    adminEmail: "coach@example.com", adminPasswordHash: hashPassword(PASSWORD), sessionSecret: "s".repeat(40),
    dataDir, origins: ["https://mdfit.example.com"], tz: "America/New_York", now: () => NOW, ...extra
  };
  const server = createApp(cfg).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const login = async () => {
    const r = await call("POST", "/api/admin/login", { email: "coach@example.com", password: PASSWORD });
    token = r.body.token;
    return r;
  };
  const close = () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { call, login, close, dataDir, setToken: (t) => { token = t; } };
}

test("date helpers", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekday("2026-11-02"), 1);
  assert.equal(toCsv([{ a: "=SUM(1)", b: 'say "hi"' }], ["a", "b"]), "a,b\r\n'=SUM(1),\"say \"\"hi\"\"\"\r\n");
});

test("health, site and CORS", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("GET", "/api/health")).body.ok, true);
  const site = await s.call("GET", "/api/site", undefined, { origin: "https://mdfit.example.com" });
  assert.equal(site.body.settings.business.name, "MD Fit");
  assert.equal(site.body.settings.business.address, "3214 Clark Road, Sarasota, FL 34231");
  assert.ok(site.body.options.areas.includes("Knee"));
  assert.equal(site.body.settings.scheduling, undefined);
  assert.equal(site.headers.get("access-control-allow-origin"), "https://mdfit.example.com");
  const other = await s.call("GET", "/api/site", undefined, { origin: "https://evil.example.com" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  assert.equal((await s.call("GET", "/nope")).status, 404);
});

test("class schedule uses starter classes and skips past sessions", async (t) => {
  const s = await start(); t.after(s.close);
  const r = await s.call("GET", "/api/schedule?days=7");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions.map((x) => x.date), ["2026-11-03", "2026-11-05"]);
  const late = await start({ now: () => new Date("2026-11-03T15:00:00Z") }); t.after(late.close); // Tue 10:00 local
  assert.equal((await late.call("GET", "/api/schedule")).body.sessions[0].date, "2026-11-05");
});

test("consultation leads: validation, honeypot, admin workflow, CSV", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("POST", "/api/leads", { name: "A", email: "x" })).status, 400);
  assert.equal((await s.call("POST", "/api/leads", { name: "Sam Lee", email: "sam@example.com", service: "Yoga" })).status, 400);
  assert.equal((await s.call("POST", "/api/leads", { name: "Sam Lee", email: "sam@example.com", areas: ["Spleen"] })).status, 400);
  assert.equal((await s.call("POST", "/api/leads", { name: "Sam Lee", email: "sam@example.com", painLevel: 11 })).status, 400);
  assert.equal((await s.call("POST", "/api/leads", "not json")).status, 400);
  const ok = await s.call("POST", "/api/leads", { name: "Sam Lee", email: "Sam@Example.com", phone: "(941) 555-0100", service: "Injury rehabilitation", goal: "Get out of pain", areas: ["Knee", "Lower back"], painLevel: "6", duration: "More than 6 months", surgery: "No", message: "=cmd" });
  assert.equal(ok.status, 201);
  const bot = await s.call("POST", "/api/leads", { name: "Bot", email: "bot@example.com", company: "spam inc" });
  assert.equal(bot.status, 201);

  assert.equal((await s.call("GET", "/api/admin/leads")).status, 401);
  await s.login();
  const list = (await s.call("GET", "/api/admin/leads")).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].email, "sam@example.com");
  assert.equal(list[0].status, "new");
  assert.deepEqual(list[0].areas, ["Knee", "Lower back"]);
  assert.equal(list[0].painLevel, 6);
  const upd = await s.call("PATCH", `/api/admin/leads/${list[0].id}`, { status: "contacted", notes: "Called Tue" });
  assert.equal(upd.body.status, "contacted");
  assert.equal((await s.call("PATCH", `/api/admin/leads/${list[0].id}`, { status: "weird" })).status, 400);
  const csv = await s.call("GET", "/api/admin/leads.csv");
  assert.match(csv.text, /sam@example\.com/);
  assert.match(csv.text, /'=cmd/);
  assert.equal((await s.call("GET", "/api/admin/stats")).body.leadsTotal, 1);
  assert.equal((await s.call("DELETE", `/api/admin/leads/${list[0].id}`)).status, 200);
  assert.equal((await s.call("DELETE", `/api/admin/leads/${list[0].id}`)).status, 404);
});

test("class booking: capacity, duplicates, wrong day, cancel", async (t) => {
  const s = await start(); t.after(s.close);
  await s.login();
  const cls = (await s.call("POST", "/api/admin/classes", { title: "Tiny Class", day: 2, time: "18:00", durationMin: 45, capacity: 2, coach: "", location: "", description: "" })).body;
  assert.equal(cls.capacity, 2);
  s.setToken("");

  const date = "2026-11-03"; // Tuesday
  const book = (email) => s.call("POST", "/api/bookings", { classId: cls.id, date, name: "Pat Doe", email });
  const first = await book("a@example.com");
  assert.equal(first.status, 201);
  assert.ok(first.body.booking.cancelToken);
  assert.equal(first.body.message, "You're in: Tiny Class, Tue, Nov 3 at 6:00 PM.");
  assert.equal((await book("a@example.com")).status, 409);
  assert.equal((await book("b@example.com")).status, 201);
  const full = await book("c@example.com");
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full/);

  assert.equal((await s.call("POST", "/api/bookings", { classId: cls.id, date: "2026-11-04", name: "Pat", email: "d@example.com" })).status, 404);
  assert.equal((await s.call("POST", "/api/bookings", { classId: cls.id, date: "2026-12-29", name: "Pat", email: "d@example.com" })).status, 404); // too far ahead
  assert.equal((await s.call("POST", "/api/bookings", { classId: cls.id, date: "11/03/2026", name: "Pat", email: "d@example.com" })).status, 400);

  const sess = (await s.call("GET", "/api/schedule")).body.sessions.find((x) => x.classId === cls.id);
  assert.equal(sess.spotsLeft, 0);

  const { id: bid, cancelToken } = first.body.booking;
  assert.equal((await s.call("POST", `/api/bookings/${bid}/cancel`, { token: "wrong" })).status, 404);
  assert.equal((await s.call("POST", `/api/bookings/${bid}/cancel`, { token: cancelToken })).status, 200);
  assert.equal((await book("c@example.com")).status, 201);

  await s.login();
  const adminList = (await s.call("GET", "/api/admin/bookings")).body;
  assert.equal(adminList.length, 2);
  assert.equal(adminList[0].cancelToken, undefined);
  // Deactivated classes disappear from the schedule
  await s.call("PUT", `/api/admin/classes/${cls.id}`, { active: false });
  assert.equal((await s.call("GET", "/api/schedule")).body.sessions.some((x) => x.classId === cls.id), false);
  // Deleting a class removes its bookings
  await s.call("DELETE", `/api/admin/classes/${cls.id}`);
  assert.equal((await s.call("GET", "/api/admin/bookings")).body.length, 0);
});

test("class validation", async (t) => {
  const s = await start(); t.after(s.close);
  await s.login();
  assert.equal((await s.call("POST", "/api/admin/classes", { title: "X", day: 7, time: "06:00" })).status, 400);
  assert.equal((await s.call("POST", "/api/admin/classes", { title: "X", day: 1, time: "6am" })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/classes/nope", { title: "Y" })).status, 404);
  const list = (await s.call("GET", "/api/admin/classes")).body;
  assert.equal((await s.call("PUT", `/api/admin/classes/${list[0].id}`, {})).status, 400);
});

test("newsletter", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("POST", "/api/subscribe", { email: "bad" })).status, 400);
  assert.equal((await s.call("POST", "/api/subscribe", { email: "Fit@Example.com" })).status, 201);
  assert.equal((await s.call("POST", "/api/subscribe", { email: "fit@example.com" })).status, 201);
  await s.login();
  assert.equal((await s.call("GET", "/api/admin/subscribers")).body.length, 1);
  assert.match((await s.call("GET", "/api/admin/subscribers.csv")).text, /fit@example\.com/);
  assert.equal((await s.call("DELETE", "/api/admin/subscribers/fit@example.com")).status, 200);
});

test("settings update is validated and public", async (t) => {
  const s = await start(); t.after(s.close);
  await s.login();
  assert.equal((await s.call("PUT", "/api/admin/settings", { bogus: 1 })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { business: { instagram: "http://insecure" } })).status, 400);
  const r = await s.call("PUT", "/api/admin/settings", {
    business: { phone: "941-555-0100", instagram: "https://instagram.com/example" },
    coach: { name: "Coach Example", bio: "NASM certified." },
    testimonials: [{ name: "Jo", quote: "Down 20 lbs." }]
  });
  assert.equal(r.status, 200);
  const pub = (await s.call("GET", "/api/site")).body.settings;
  assert.equal(pub.business.phone, "941-555-0100");
  assert.equal(pub.business.name, "MD Fit");
  assert.equal(pub.coach.name, "Coach Example");
  assert.equal(pub.testimonials.length, 1);
  assert.equal(pub.packages.length, 3);
});

test("login: wrong password, lockout, bad token, not configured", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("POST", "/api/admin/login", { email: "coach@example.com", password: "nope" })).status, 401);
  s.setToken("forged.token");
  assert.equal((await s.call("GET", "/api/admin/me")).status, 401);
  s.setToken("");
  for (let i = 0; i < 10; i++) await s.call("POST", "/api/admin/login", { email: "x@example.com", password: "nope" });
  assert.equal((await s.call("POST", "/api/admin/login", { email: "coach@example.com", password: PASSWORD })).status, 429);

  const bare = await start({ adminEmail: "", adminPasswordHash: "" }); t.after(bare.close);
  assert.equal((await bare.call("POST", "/api/admin/login", { email: "a@example.com", password: "x" })).status, 503);
});

test("appointments: availability, notice window, overlap, cancel, admin status", async (t) => {
  const s = await start(); t.after(s.close);
  const av = (await s.call("GET", "/api/availability?type=eval&days=3")).body;
  assert.equal(av.type.id, "eval");
  const byDate = Object.fromEntries(av.days.map((d) => [d.date, d.slots]));
  assert.deepEqual(byDate["2026-11-02"], []); // Monday 05:00 + 24h notice: nothing today
  assert.equal(byDate["2026-11-03"][0], "08:00"); // earliest start 8 AM
  assert.equal(byDate["2026-11-03"].at(-1), "16:00"); // latest start 4 PM (the 90-min eval runs to 5:30)
  assert.equal(byDate["2026-11-03"].length, 17);
  assert.equal(av.type.minutes, 90);

  const book = (body) => s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "10:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", ...body });
  assert.equal((await book({ phone: "" })).status, 400);
  assert.equal((await book({ typeId: "nope" })).status, 400);
  assert.equal((await book({ time: "07:30" })).status, 409); // before 8 AM
  assert.equal((await book({ time: "16:30" })).status, 409); // after the 4 PM latest start
  assert.equal((await book({ date: "2026-11-02", time: "18:00" })).status, 409);
  assert.equal((await book({ areas: ["Tail"] })).status, 400);
  assert.equal((await book({ painLevel: 12 })).status, 400);
  const ok = await book({ areas: ["Knee"], painLevel: 5 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.message, "You're booked: In-Studio Evaluation, Tue, Nov 3 at 10:00 AM.");
  assert.equal((await book({ email: "b@example.com", time: "11:00" })).status, 409); // overlaps 10:00-11:30
  assert.equal((await book({ email: "b@example.com", typeId: "call", time: "10:30" })).status, 409); // inside the eval
  const call = await book({ email: "b@example.com", typeId: "call", time: "09:30" }); // 09:30-09:45 fits before it
  assert.equal(call.status, 201);
  const slots = (await s.call("GET", "/api/availability?type=call&from=2026-11-03&days=1")).body.days[0].slots;
  assert.ok(!slots.includes("09:30") && !slots.includes("10:00") && !slots.includes("11:00") && slots.includes("11:30"));

  const { id, cancelToken } = ok.body.appointment;
  assert.equal((await s.call("POST", `/api/appointments/${id}/cancel`, { token: "x" })).status, 404);
  assert.equal((await s.call("POST", `/api/appointments/${id}/cancel`, { token: cancelToken })).status, 200);
  assert.equal((await s.call("POST", `/api/appointments/${id}/cancel`, { token: cancelToken })).status, 404);
  assert.equal((await book({ email: "c@example.com" })).status, 201); // slot freed

  await s.login();
  const list = (await s.call("GET", "/api/admin/appointments")).body;
  assert.equal(list.length, 2);
  assert.equal(list[0].cancelToken, undefined);
  assert.equal(list[0].time, "09:30");

  const upd = await s.call("PATCH", `/api/admin/appointments/${list[0].id}`, { status: "completed", adminNotes: "Left knee, VMO weak" });
  assert.equal(upd.body.status, "completed");
  assert.equal(upd.body.adminNotes, "Left knee, VMO weak");
  // visit notes are encrypted on disk, readable again through the admin API and CSV
  assert.ok(!fs.readFileSync(path.join(s.dataDir, "appointments.json"), "utf8").includes("VMO weak"), "admin notes are encrypted at rest");
  assert.equal((await s.call("GET", "/api/admin/appointments?all=1")).body.find((x) => x.id === list[0].id).adminNotes, "Left knee, VMO weak");
  // an old email cancel link can't turn a completed (or no-show) visit into "cancelled"
  assert.equal((await s.call("POST", `/api/appointments/${call.body.appointment.id}/cancel`, { token: call.body.appointment.cancelToken })).status, 409);
  assert.equal((await s.call("PATCH", `/api/admin/appointments/${list[0].id}`, { status: "maybe" })).status, 400);
  assert.equal((await s.call("GET", "/api/admin/appointments?all=1")).body.length, 3);
  const pat = (await s.call("GET", "/api/admin/appointments?all=1")).body.find((x) => x.email === "pat@example.com");
  assert.deepEqual(pat.areas, ["Knee"]);
  assert.equal(pat.painLevel, 5);
  assert.equal(pat.status, "cancelled");
  assert.match((await s.call("GET", "/api/admin/appointments.csv")).text, /c@example\.com/);
  assert.match((await s.call("GET", "/api/admin/appointments.csv")).text, /VMO weak/);
  const stats = (await s.call("GET", "/api/admin/stats")).body;
  assert.equal(stats.appointmentsWeek, 1); // the call was marked completed, the eval is still booked
});

test("scheduling settings: hours, blocked dates, validation", async (t) => {
  const s = await start(); t.after(s.close);
  await s.login();
  const hours = [[], [], [["08:00", "12:00"], ["13:00", "15:00"]], [], [], [], []];
  assert.equal((await s.call("PUT", "/api/admin/settings", { scheduling: { hours: [[]] } })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { scheduling: { hours: [[], [], [["12:00", "09:00"]], [], [], [], []] } })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { scheduling: { blockedDates: ["2026-02-30"] } })).status, 400);
  assert.equal((await s.call("PUT", "/api/admin/settings", { appointmentTypes: [{ id: "a", name: "A", minutes: 30 }, { id: "a", name: "B", minutes: 30 }] })).status, 400);
  const r = await s.call("PUT", "/api/admin/settings", {
    scheduling: { hours, slotStepMin: 60, blockedDates: ["2026-11-10"] },
    appointmentTypes: [{ id: "eval", name: "Evaluation", minutes: 60, description: "" }]
  });
  assert.equal(r.status, 200);
  const days = (await s.call("GET", "/api/availability?type=eval&days=10")).body.days;
  const d = Object.fromEntries(days.map((x) => [x.date, x.slots]));
  assert.deepEqual(d["2026-11-03"], ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00"]);
  assert.deepEqual(d["2026-11-10"], []); // blocked
  assert.deepEqual(d["2026-11-04"], []); // closed
});

test("email notifications go to owner and client when configured", async (t) => {
  const http = require("node:http");
  const sent = [];
  const fake = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { sent.push({ auth: req.headers.authorization, ...JSON.parse(body) }); res.end("{}"); });
  }).listen(0);
  await new Promise((r) => fake.once("listening", r));
  t.after(() => fake.close());
  const s = await start({
    resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>",
    notifyEmail: "owner@example.com", siteUrl: "https://mdfit.example.com"
  }); t.after(s.close);
  await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "09:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", areas: ["Shoulder"], painLevel: 3, notes: "Torn labrum last year" });
  await s.call("POST", "/api/leads", { name: "Sam Lee", email: "sam@example.com", areas: ["Neck"], painLevel: 4, surgery: "Had surgery recently", message: "Herniated disc C5-C6" });
  await s.call("POST", "/api/feedback", { name: "Lou Low", email: "lou@example.com", rating: 3, text: "My sciatica is better but not gone.", publish: false });
  for (let i = 0; i < 400 && sent.length < 5; i++) await new Promise((r) => setTimeout(r, 20)); // emails are paced ~0.6 s apart
  assert.equal(sent.length, 5);
  assert.equal(sent[0].auth, "Bearer re_test");
  const owner = sent.filter((m) => m.to[0] === "owner@example.com");
  const client = sent.find((m) => m.to[0] === "pat@example.com");
  assert.equal(owner.length, 3);
  assert.match(client.subject, /Evaluation/);
  assert.match(client.text, /https:\/\/mdfit\.example\.com\/cancel\?kind=appointment&id=/);
  assert.ok(!/labrum/.test(client.text), "the patient's own booking note isn't echoed back by email");
  const bookingMail = owner.find((m) => /New booking/.test(m.subject));
  assert.ok(!/Shoulder|Pain: 3|labrum/.test(bookingMail.text), "booking emails carry no health details");
  assert.match(bookingMail.text, /Admin → Appointments/);
  // consult requests: contact details and service only; pain, surgery and their message stay in Admin
  const leadMail = owner.find((m) => /evaluation request/.test(m.subject));
  assert.match(leadMail.text, /Sam Lee\nsam@example\.com/);
  assert.ok(!/Neck|Pain: 4|surgery recently|Herniated/.test(leadMail.text), "lead emails carry no health details");
  assert.match(leadMail.text, /Admin → Leads/);
  // reviews: the rating goes out, the text (often about a condition) does not
  const reviewMail = owner.find((m) => /New review/.test(m.subject));
  assert.match(reviewMail.subject, /3\/5 from Lou Low/);
  assert.ok(!/sciatica/.test(reviewMail.text), "review emails carry no review text");
  assert.match(reviewMail.text, /Admin → Reviews/);
  // and the same free text is encrypted where it's stored
  const disk = (f) => fs.readFileSync(path.join(s.dataDir, f), "utf8");
  assert.ok(!disk("appointments.json").includes("labrum"), "booking notes encrypted at rest");
  assert.ok(!disk("leads.json").includes("Herniated"), "lead message encrypted at rest");
  assert.ok(!disk("feedback.json").includes("sciatica"), "review text encrypted at rest");
  await s.login();
  assert.equal((await s.call("GET", "/api/admin/leads")).body[0].message, "Herniated disc C5-C6");
  assert.equal((await s.call("GET", "/api/admin/feedback")).body[0].text, "My sciatica is better but not gone.");
  assert.equal((await s.call("GET", "/api/admin/appointments")).body[0].notes, "Torn labrum last year");
});

test("services, payment plans and Medical Massage are public and admin-editable", async (t) => {
  const s = await start(); t.after(s.close);
  const site = (await s.call("GET", "/api/site")).body;
  const svc = Object.fromEntries(site.settings.services.map((v) => [v.id, v]));
  assert.equal(svc.eval.rate, 300); assert.equal(svc.followup.rate, 150); assert.equal(svc.massage.rate, 250); assert.equal(svc.massage90.rate, 300); assert.equal(svc["eval-remote"].remote, true); assert.equal(svc["followup-remote"].remote, true);
  assert.equal(svc.followup.withEval, true);
  assert.equal(site.settings.plans.gold, 20); assert.equal(site.settings.plans.silver, 0); assert.equal(site.settings.plans.silverPayments, 3);
  assert.equal(site.settings.plans.ext12, 5); assert.equal(site.settings.plans.ext24, 10); assert.equal(site.settings.plans.guaranteeMin, 12);
  assert.ok(site.settings.appointmentTypes.some((a) => a.id === "massage"));
  assert.ok(site.options.services.includes("Medical massage"));
  assert.ok(!site.options.services.includes("Group classes"), "classes are off the public site for now");
  const types = Object.fromEntries(site.settings.appointmentTypes.map((a) => [a.id, a.minutes]));
  assert.deepEqual(types, { eval: 90, "eval-remote": 60, session: 60, "session-remote": 60, "followup-remote": 30, massage: 60, massage90: 90, call: 15 });
  await s.login();
  const r = await s.call("PUT", "/api/admin/settings", { services: [...site.settings.services, { id: "dry-needling", name: "Dry Needling", rate: 180, protocol: true, description: "" }], plans: { gold: 25 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await s.call("GET", "/api/site")).body.settings;
  assert.equal(after.services.length, 8); assert.equal(after.plans.gold, 25);
  assert.equal((await s.call("PUT", "/api/admin/settings", { services: [{ id: "Bad Id", name: "x", rate: 1 }] })).status, 400);
});

test("reviews: plain feedback with no reward; admin publishes only consenting reviews", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("POST", "/api/feedback", { name: "Al", email: "a@x.com", rating: 6, text: "great great great" })).status, 400);
  const low = await s.call("POST", "/api/feedback", { name: "Lou Low", email: "lou@example.com", rating: 2, text: "Helpful but slow progress so far.", publish: false });
  assert.equal(low.status, 201);
  assert.equal(low.body.rewardCode, undefined, "no reward of any kind for a review"); assert.equal(low.body.rewardPct, undefined);
  const hi = await s.call("POST", "/api/feedback", { name: "Hana Hill", email: "hana@example.com", rating: 5, text: "My shoulder finally feels normal again.", publish: true });
  assert.equal(hi.status, 201); assert.equal(hi.body.rewardCode, undefined);
  assert.equal((await s.call("GET", "/api/feedback")).body.count, 0, "nothing public until approved");
  await s.login();
  const all = (await s.call("GET", "/api/admin/feedback")).body;
  assert.equal(all.length, 2); assert.ok(all.every((f) => !f.rewardCode));
  const lowId = all.find((f) => f.name === "Lou Low").id, hiId = all.find((f) => f.name === "Hana Hill").id;
  assert.equal((await s.call("PATCH", `/api/admin/feedback/${lowId}`, { status: "approved" })).status, 400, "private stays private");
  assert.equal((await s.call("PATCH", `/api/admin/feedback/${hiId}`, { status: "approved" })).status, 200);
  const pub = (await s.call("GET", "/api/feedback")).body;
  assert.deepEqual(pub.reviews.map((r) => r.name), ["Hana H."]);
  assert.equal(pub.reward, null);
  // the old reward lookups and the free plan review are gone
  assert.equal((await s.call("GET", "/api/feedback/reward/MDFIT-000000")).status, 404);
  const av = (await s.call("GET", "/api/availability?type=plan-review&days=14")).body;
  const day = av.days.find((d) => d.slots.length);
  const booked = await s.call("POST", "/api/appointments", { typeId: "plan-review", date: day.date, time: day.slots[0], name: "Hana Hill", email: "hana@example.com", phone: "941-555-0101", rewardCode: "MDFIT-000000" });
  assert.equal(booked.status, 400); assert.match(booked.body.error, /no longer offered/);
});

test("analytics: device, source and location mix with percentages", async (t) => {
  const s = await start(); t.after(s.close);
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const geo = { "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "FL", "x-vercel-ip-city": "Sarasota" };
  await s.call("POST", "/api/hit", { page: "/", referrer: "https://www.google.com/" }, { "user-agent": iphone, ...geo });
  await s.call("POST", "/api/hit", { page: "/book", referrer: "" }, { "user-agent": iphone, ...geo });
  await s.call("POST", "/api/hit", { page: "/", referrer: "https://l.instagram.com/" }, { "user-agent": mac, "x-vercel-ip-city": "Bradenton", "x-vercel-ip-country-region": "FL" });
  await s.call("POST", "/api/hit", { page: "/", utm: "newsletter" }, { "user-agent": mac });
  await s.login();
  const m = (await s.call("GET", "/api/admin/analytics?days=7")).body.mix;
  const pct = (list, name) => (list.find((x) => x.name === name) || {}).pct;
  assert.equal(pct(m.devices, "Mobile"), 50);
  assert.equal(pct(m.devices, "Desktop"), 50);
  assert.equal(pct(m.sources, "Google"), 25);
  assert.equal(pct(m.sources, "Instagram"), 25);
  assert.equal(pct(m.sources, "Newsletter"), 25);
  assert.equal(pct(m.sources, "Direct / typed / bookmark"), 25);
  assert.equal(m.places[0].name, "Sarasota, FL");
  assert.equal(pct(m.os, "iOS"), 50);
});

test("intake documents: every booking gets a packet; each document saves on its own; Admin sees status and answers", async (t) => {
  const s = await start(); t.after(s.close);
  const ok = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "10:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" });
  assert.equal(ok.status, 201); assert.equal(ok.body.appointment.intake, true);
  const { id, cancelToken: token } = ok.body.appointment;
  assert.equal(ok.headers.get("cache-control"), "no-store", "booking reply (carries the private token) is never cached");
  assert.equal((await s.call("GET", `/api/appointments/${id}/intake?token=nope`)).status, 404, "token required");
  const pr = await s.call("GET", `/api/appointments/${id}/intake?token=${token}`), p = pr.body;
  assert.equal(pr.headers.get("cache-control"), "no-store");
  assert.deepEqual(p.docs.map((d) => d.id), ["info", "pain", "history", "consent"], "evaluation packet (no massage form)");
  assert.equal(p.prefill.email, "pat@example.com"); assert.equal(p.done, false); assert.equal(p.completed, 0);
  const save = (doc, body) => s.call("POST", `/api/appointments/${id}/intake/${doc}`, { token, ...body });
  assert.equal((await save("massage", {})).status, 404, "massage form isn't part of an evaluation");
  assert.equal((await save("info", { name: "Pat Doe" })).status, 400, "required fields enforced");
  assert.equal((await save("info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199", sex: "Robot" })).status, 400, "options enforced");
  assert.equal((await save("info", { name: "Pat Doe", dob: "1980-02-03", phone: "941-555-0100", email: "pat@example.com", emergencyName: "Sam Doe", emergencyPhone: "941-555-0199" })).status, 201);
  assert.equal((await save("pain", { complaint: "Right knee hurts on stairs", areas: ["Right knee", "Tail"], started: "2 to 6 weeks ago", painNow: 6, goals: "Hike again" })).status, 201);
  assert.equal((await save("history", { redFlags: "No", medications: "Ibuprofen" })).status, 201);
  assert.equal((await save("consent", { treatment: true, privacy: true, signature: "Pat Doe" })).status, 400, "payment policy must be agreed");
  const last = await save("consent", { treatment: true, privacy: true, financial: true, signature: "Pat Doe" });
  assert.equal(last.status, 201); assert.deepEqual(last.body, { ok: true, total: 4, completed: 4, done: true });
  // the link holder never gets saved answers back, only which documents are done
  const again = (await s.call("GET", `/api/appointments/${id}/intake?token=${token}`));
  assert.ok(again.body.docs.every((d) => d.done), "all marked done");
  assert.ok(!again.text.includes("Right knee hurts") && !again.text.includes("Ibuprofen"), "answers are never echoed to the intake link");
  await s.login();
  const appt = (await s.call("GET", "/api/admin/appointments")).body.find((a) => a.id === id);
  assert.deepEqual([appt.documents.done, appt.documents.total, appt.documents.complete], [4, 4, true]);
  const vr = await s.call("GET", `/api/admin/appointments/${id}/intake`), v = vr.body;
  assert.equal(vr.headers.get("cache-control"), "no-store");
  assert.deepEqual(v.docs.map((d) => d.title), ["Client information", "Pain Assessment Initial Intake", "Health history", "Consent & policies"]);
  const pain = v.docs[1].fields;
  assert.equal(pain.find((f) => f.label.startsWith("Where do you feel")).value, "Right knee", "unknown options dropped");
  assert.equal(pain.find((f) => f.label === "Pain right now").value, "6/10");
  assert.ok(v.docs[3].fields.some((f) => f.label === "Signed"));
  // answers are encrypted at rest
  const raw = fs.readFileSync(path.join(s.dataDir, "intakes.json"), "utf8");
  assert.ok(!raw.includes("Right knee hurts"), "intake answers are encrypted on disk");
  // audit ledger: the patient's submissions and the admin's view are recorded by appointment id, without answers
  await new Promise((r) => setTimeout(r, 50));
  const audit = (await s.call("GET", `/api/admin/audit?subject=${id}`)).body.entries;
  const acts = audit.map((e) => e.action);
  assert.ok(acts.includes("intake.open") && acts.filter((a) => a === "intake.submit").length === 4 && acts.includes("admin.view /appointments/:id/intake"), acts.join(","));
  const sub = audit.find((e) => e.action === "intake.submit" && e.meta.doc === "pain");
  assert.equal(sub.actor, "patient"); assert.equal(sub.subject, id);
  assert.ok(!JSON.stringify(audit).match(/Right knee|Ibuprofen|Pat Doe|pat@example/), "audit entries hold ids, never answers, names or emails");
});

test("video visits: the telehealth room link goes out with the booking; a per-visit link is emailed when it changes", async (t) => {
  const http = require("node:http");
  const sent = [];
  const fake = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { sent.push(JSON.parse(body)); res.end("{}"); }); }).listen(0);
  await new Promise((r) => fake.once("listening", r)); t.after(() => fake.close());
  const s = await start({ resendKey: "re_test", resendUrl: `http://127.0.0.1:${fake.address().port}`, notifyFrom: "MD Fit <hello@example.com>", notifyEmail: "owner@example.com", siteUrl: "https://mdfit.example.com" });
  t.after(s.close);
  await s.login();
  assert.equal((await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: "http://zoom.us/j/1" } })).status, 400, "https only");
  assert.equal((await s.call("PUT", "/api/admin/settings", { booking: { telehealthUrl: "https://zoom.us/j/5551234567" } })).status, 200);
  s.setToken("");
  const v = await s.call("POST", "/api/appointments", { typeId: "eval-remote", date: "2026-11-03", time: "10:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" });
  assert.equal(v.status, 201); assert.equal(v.body.appointment.meetingLink, "https://zoom.us/j/5551234567");
  const inPerson = await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "13:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100" });
  assert.equal(inPerson.body.appointment.meetingLink, "", "in-studio visits get no video link");
  const wait = async (n) => { for (let i = 0; i < 400 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
  await wait(4);
  const conf = sent.find((m) => m.to.includes("pat@example.com") && /You're booked: Online/.test(m.subject));
  assert.ok(conf && conf.text.includes("https://zoom.us/j/5551234567"), "confirmation carries the join link");
  await s.login();
  const id = v.body.appointment.id;
  assert.equal((await s.call("PATCH", `/api/admin/appointments/${id}`, { meetingLink: "javascript:alert(1)" })).status, 400);
  const before = sent.length;
  assert.equal((await s.call("PATCH", `/api/admin/appointments/${id}`, { meetingLink: "https://zoom.us/j/999" })).body.meetingLink, "https://zoom.us/j/999");
  await wait(before + 1);
  const upd = sent.slice(before).find((m) => /Your video visit link/.test(m.subject));
  assert.ok(upd && upd.text.includes("https://zoom.us/j/999") && upd.to.includes("pat@example.com"));
  assert.ok(!/pain|knee|back/i.test(upd.text), "no health details");
});

test("telehealth prices: saved old defaults move to $150 evaluation and 30-minute $80 follow-up, once; custom values stay", async () => {
  const fs2 = require("fs"), os2 = require("os"), path2 = require("path");
  const dataDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "mdfit-price-"));
  const { createStore } = require("../lib/store");
  const st = createStore(dataDir);
  const types = require("../lib/validate").defaultSettings().appointmentTypes.map((t) => ({ ...t }));
  const ev = types.find((t) => t.id === "eval-remote"), fu = types.find((t) => t.id === "followup-remote");
  ev.description = "A video evaluation with Dr. Jared when you can't come in. $300."; fu.minutes = 45; fu.description = "A remote check-in by video. $150.";
  const sess = types.find((t) => t.id === "session-remote"); sess.description = "Custom text $300.";
  st.write("settings", { version: 3, appointmentTypes: types, services: [{ id: "eval-remote", rate: 300, unit: "60 minutes" }, { id: "followup-remote", rate: 150, unit: "45 minutes" }] });
  const app = createApp({ adminEmail: "coach@example.com", adminPasswordHash: hashPassword(PASSWORD), sessionSecret: "s".repeat(40), dataDir, origins: ["*"], tz: "America/New_York", now: () => NOW });
  const saved = createStore(dataDir).read("settings", {});
  const e2 = saved.appointmentTypes.find((t) => t.id === "eval-remote"), f2 = saved.appointmentTypes.find((t) => t.id === "followup-remote");
  assert.match(e2.description, /\$150\./); assert.equal(f2.minutes, 30); assert.match(f2.description, /\$75\./);
  assert.equal(saved.services.find((v) => v.id === "eval-remote").rate, 150); assert.equal(saved.services.find((v) => v.id === "followup-remote").rate, 75);
  assert.equal(saved.appointmentTypes.find((t) => t.id === "session-remote").description, "Custom text $150.", "telehealth at $150 an hour");
  assert.equal(saved.appointmentTypes.find((t) => t.id === "eval").description, require("../lib/validate").defaultSettings().appointmentTypes.find((t) => t.id === "eval").description, "in-studio types untouched");
  assert.equal(saved.telehealthPrices2026, true);
  fs2.rmSync(dataDir, { recursive: true, force: true }); void app;
});
