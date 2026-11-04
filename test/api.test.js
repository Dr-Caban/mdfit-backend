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
  assert.equal((await s.call("PATCH", `/api/admin/appointments/${list[0].id}`, { status: "maybe" })).status, 400);
  assert.equal((await s.call("GET", "/api/admin/appointments?all=1")).body.length, 3);
  const pat = (await s.call("GET", "/api/admin/appointments?all=1")).body.find((x) => x.email === "pat@example.com");
  assert.deepEqual(pat.areas, ["Knee"]);
  assert.equal(pat.painLevel, 5);
  assert.equal(pat.status, "cancelled");
  assert.match((await s.call("GET", "/api/admin/appointments.csv")).text, /c@example\.com/);
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
  await s.call("POST", "/api/appointments", { typeId: "eval", date: "2026-11-03", time: "09:00", name: "Pat Doe", email: "pat@example.com", phone: "941-555-0100", areas: ["Shoulder"], painLevel: 3 });
  await s.call("POST", "/api/leads", { name: "Sam Lee", email: "sam@example.com", areas: ["Neck"], painLevel: 4 });
  for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 3);
  assert.equal(sent[0].auth, "Bearer re_test");
  const owner = sent.filter((m) => m.to[0] === "owner@example.com");
  const client = sent.find((m) => m.to[0] === "pat@example.com");
  assert.equal(owner.length, 2);
  assert.match(client.subject, /Evaluation/);
  assert.match(client.text, /https:\/\/mdfit\.example\.com\/cancel\?kind=appointment&id=/);
  assert.ok(owner.some((m) => /Pain: 4\/10/.test(m.text))); // consult request (unchanged)
  const bookingMail = owner.find((m) => /New booking/.test(m.subject));
  assert.ok(!/Shoulder|Pain: 3/.test(bookingMail.text), "booking emails carry no health details");
  assert.match(bookingMail.text, /Admin → Appointments/);
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
  assert.deepEqual(types, { eval: 90, "eval-remote": 60, session: 60, "session-remote": 60, "followup-remote": 45, massage: 60, massage90: 90, call: 15 });
  await s.login();
  const r = await s.call("PUT", "/api/admin/settings", { services: [...site.settings.services, { id: "dry-needling", name: "Dry Needling", rate: 180, protocol: true, description: "" }], plans: { gold: 25 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await s.call("GET", "/api/site")).body.settings;
  assert.equal(after.services.length, 8); assert.equal(after.plans.gold, 25);
  assert.equal((await s.call("PUT", "/api/admin/settings", { services: [{ id: "Bad Id", name: "x", rate: 1 }] })).status, 400);
});

test("reviews: any rating earns a one-time plan review code, admin publishes only consenting reviews", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("POST", "/api/feedback", { name: "Al", email: "a@x.com", rating: 6, text: "great great great" })).status, 400);
  const low = await s.call("POST", "/api/feedback", { name: "Lou Low", email: "lou@example.com", rating: 2, text: "Helpful but slow progress so far.", publish: false });
  assert.equal(low.status, 201);
  assert.match(low.body.rewardCode, /^MDFIT-[0-9A-F]{6}$/, "a low rating still earns the reward");
  const hi = await s.call("POST", "/api/feedback", { name: "Hana Hill", email: "hana@example.com", rating: 5, text: "My shoulder finally feels normal again.", publish: true });
  assert.equal((await s.call("GET", "/api/feedback")).body.count, 0, "nothing public until approved");
  await s.login();
  const all = (await s.call("GET", "/api/admin/feedback")).body;
  assert.equal(all.length, 2);
  const lowId = all.find((f) => f.name === "Lou Low").id, hiId = all.find((f) => f.name === "Hana Hill").id;
  assert.equal((await s.call("PATCH", `/api/admin/feedback/${lowId}`, { status: "approved" })).status, 400, "private stays private");
  assert.equal((await s.call("PATCH", `/api/admin/feedback/${hiId}`, { status: "approved" })).status, 200);
  const pub = (await s.call("GET", "/api/feedback")).body;
  assert.deepEqual(pub.reviews.map((r) => r.name), ["Hana H."]);
  assert.equal(pub.reward.pct, 30);
  // redeem the code once
  const code = hi.body.rewardCode;
  assert.equal((await s.call("GET", `/api/feedback/reward/${code}`)).body.valid, true);
  const av = (await s.call("GET", "/api/availability?type=plan-review&days=14")).body;
  assert.equal(av.type.minutes, 30);
  const day = av.days.find((d) => d.slots.length);
  const book = (extra) => s.call("POST", "/api/appointments", { typeId: "plan-review", date: day.date, time: day.slots[0], name: "Hana Hill", email: "hana@example.com", phone: "941-555-0101", ...extra });
  assert.equal((await book({ rewardCode: "MDFIT-000000" })).status, 400);
  assert.equal((await book({ rewardCode: code.toLowerCase() })).status, 201);
  assert.equal((await s.call("GET", `/api/feedback/reward/${code}`)).body.used, true);
  const again = await s.call("POST", "/api/appointments", { typeId: "plan-review", date: day.date, time: day.slots[1], name: "Hana Hill", email: "hana@example.com", phone: "941-555-0101", rewardCode: code });
  assert.equal(again.status, 409);
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
