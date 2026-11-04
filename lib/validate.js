// Input validation for every public form and admin edit.

class ValidationError extends Error {}
const fail = (msg) => { throw new ValidationError(msg); };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SERVICES = ["Injury rehabilitation", "Post-surgical rehab", "Chronic pain", "Medical massage", "Functional mobility",
  "Strength & performance training", "Stability", "Cognitive fortitude", "Group classes", "Not sure yet"];
const GOALS = ["Get out of pain", "Recover from surgery", "Move better", "Get stronger", "Return to sport", "Lose weight", "Other"];
const AREAS = ["Neck", "Shoulder", "Upper back", "Lower back", "Hip", "Knee", "Ankle / foot", "Elbow / wrist / hand", "Other"];
const DURATIONS = ["Less than 6 weeks", "6 weeks to 6 months", "More than 6 months", "No pain, performance goal"];
const SURGERY = ["No", "Had surgery recently", "Surgery coming up"];
const LEAD_STATUSES = ["new", "contacted", "booked", "client", "closed"];
const APPT_STATUSES = ["booked", "completed", "no-show", "cancelled"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Defaults reflect MD Fit's public listings. Everything is editable in the admin portal.
function defaultSettings() {
  // Appointments start 8 AM to 4 PM (scheduling.lastStart); the day runs to 5:30 so a 4 PM visit can finish
  const weekday = [["08:00", "17:30"]];
  return {
    business: {
      name: "MD Fit",
      tagline: "Physical Rehabilitation & Fitness",
      phone: "941-313-0562",
      email: "",
      address: "3214 Clark Road, Sarasota, FL 34231",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=MD+Fit+3214+Clark+Road+Sarasota+FL+34231",
      hours: "Mon–Fri, appointments 8 AM – 4 PM",
      instagram: "", facebook: "https://www.facebook.com/MDFitSRQ/", tiktok: "",
      bookingNote: "Every plan starts with an evaluation so we treat the cause, not just the symptom."
    },
    rating: { score: "4.9", count: 61, source: "Birdeye", url: "https://reviews.birdeye.com/md-fit-168104670901999" },
    coach: {
      name: "Dr. Jared Caban",
      title: "MD, MSc, CCEP, LMT · Certified Clinical Exercise Physiologist · Licensed Massage Therapist",
      bio: "Dr. Jared Caban completed his medical doctorate in 2017 and holds a Master's degree in performance. He is a Certified Clinical Exercise Physiologist (CCEP) and a Licensed Massage Therapist (LMT).\n\nMD Fit is his answer to the gap between the clinic and the gym: a hybrid of rehabilitation, performance and recovery. Instead of chasing symptoms, he finds the muscle at the source of the pain, corrects the movement pattern behind it, and builds the strength to keep it from coming back.",
      photoUrl: ""
    },
    packages: [
      { name: "Initial Evaluation", price: "", unit: "60 minutes", features: ["Pain & movement assessment", "Posture, gait and muscle-balance screen", "Hands-on treatment", "Your personal recovery plan"] },
      { name: "Rehab & Recovery", price: "", unit: "per session", features: ["Post-surgical & injury rehab", "Neuromuscular re-education", "Movement correction", "Home program between visits"] },
      { name: "Strength & Performance", price: "", unit: "per session", features: ["1-on-1 coached training", "Built around your history", "Return-to-sport progressions", "Progress tracking"] }
    ],
    testimonials: [
      { name: "Google review", quote: "Dr. Jared Caban has literally changed my life! His knowledge and experience has made my life so much better. I can now walk without shooting pains down my leg." },
      { name: "Client review", quote: "Jared takes his time to find the muscle that is the problem and gives stretching exercises to solve the pain." },
      { name: "Class review", quote: "Smart, practical, and focused on helping you actually move and feel better." }
    ],
    // Services and pricing (admin-editable). rate = dollars per visit; protocol = sold in multi-visit plans;
    // withEval = the plan total includes the evaluation (Gold pays for the evaluation and every visit upfront)
    services: [
      { id: "eval", name: "Evaluation", rate: 300, unit: "90 minutes", protocol: false, description: "Rehabilitation, functional mobility, strength & performance, stability or cognitive fortitude: full assessment, hands-on treatment, your plan and your first homework." },
      { id: "eval-remote", name: "Online Evaluation (Telehealth)", rate: 300, unit: "60 minutes", protocol: false, remote: true, description: "A video evaluation with Dr. Jared when you can't come in. We'll review your history, assess movement on camera, and build your plan." },
      { id: "followup", name: "Follow-up Visit", rate: 150, unit: "60 minutes", protocol: true, withEval: true, description: "Treatment and progression. You leave with homework for the days before your next visit." },
      { id: "session-remote", name: "Remote Session (Telehealth)", rate: 200, unit: "60 minutes", protocol: true, remote: true, description: "A full 60-minute telehealth session with Dr. Jared: treatment, progression and homework, all on video." },
      { id: "followup-remote", name: "Online Follow-up (Telehealth)", rate: 150, unit: "45 minutes", protocol: true, remote: true, description: "A remote check-in: review your homework, progress your plan and answer questions on video." },
      { id: "massage", name: "Medical Massage", rate: 250, unit: "60 minutes", protocol: true, description: "Targeted soft-tissue treatment for the muscles driving your pain. No evaluation needed: just a short intake form." },
      { id: "massage90", name: "Medical Massage, Extended", rate: 300, unit: "90 minutes", protocol: true, description: "More time on more areas, for widespread or stubborn pain." }
    ],
    // Payment plans. Gold: everything upfront, % off. Silver: same total in N monthly payments, % off.
    // Bronze: pay as you go. Platinum: spread over 12 or 24 months for +ext12% / +ext24%.
    plans: {
      gold: 20, silver: 0, silverPayments: 3, ext12: 5, ext24: 10, packageSizes: [6, 12, 24], guaranteeMin: 12,
      reviewDiscountPct: 30
    },
    appointmentTypes: [
      { id: "eval", name: "In-Studio Evaluation", minutes: 90, description: "Rehab, functional mobility, strength & performance, stability or cognitive fortitude at the studio in Sarasota. $300." },
      { id: "eval-remote", name: "Online Evaluation (Telehealth)", minutes: 60, remote: true, description: "A video evaluation with Dr. Jared when you can't come in. $300." },
      { id: "session", name: "In-Studio Follow-up / Training Session", minutes: 60, description: "For existing clients continuing their plan. $150." },
      { id: "session-remote", name: "Remote Session (Telehealth)", minutes: 60, remote: true, description: "A full telehealth session with Dr. Jared. $200." },
      { id: "followup-remote", name: "Online Follow-up (Telehealth)", minutes: 45, remote: true, description: "A remote check-in by video. $150." },
      { id: "massage", name: "Medical Massage", minutes: 60, description: "No evaluation needed; you'll fill out a short intake form. $250." },
      { id: "massage90", name: "Medical Massage, 90 min", minutes: 90, description: "Extended session for more areas. $300." },
      { id: "call", name: "Free 15-Minute Phone Consult", minutes: 15, description: "Not sure where to start? Talk it through with Dr. Jared." }
    ],
    // provider "builtin" = MD Fit's own scheduler; "cal" = Cal.com embed (needs CAL_API_KEY or a username)
    booking: { provider: "builtin", calUsername: "", calEventSlugs: [] },
    scheduling: {
      hours: [[], weekday, weekday, weekday, weekday, weekday, []],
      slotStepMin: 30,
      lastStart: "16:00",
      minNoticeHours: 24,
      daysAhead: 30,
      blockedDates: []
    }
  };
}

function str(v, field, { max = 200, min = 0 } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") fail(`${field} must be text.`);
  const s = v.trim();
  if (s.length < min) fail(`${field} is required.`);
  if (s.length > max) fail(`${field} is too long (max ${max} characters).`);
  return s;
}

function email(v, field = "Email", { required = true } = {}) {
  const e = str(v, field, { max: 254, min: required ? 1 : 0 }).toLowerCase();
  if (e && !EMAIL_RE.test(e)) fail(`${field} is not valid.`);
  return e;
}

function phone(v, { required = false } = {}) {
  const p = str(v, "Phone", { max: 30, min: required ? 1 : 0 });
  if (p && !/^[0-9()+\-.\s]{7,30}$/.test(p)) fail("Phone number is not valid.");
  return p;
}

function url(v, field) {
  const s = str(v, field, { max: 600 });
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { fail(`${field} must be a full link starting with https://`); }
  if (u.protocol !== "https:") fail(`${field} must start with https://`);
  return u.toString();
}

function int(v, field, { min = 0, max = 1e6 } = {}) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${field} must be a whole number from ${min} to ${max}.`);
  return n;
}

function oneOf(v, list, field) {
  if (!list.includes(v)) fail(`Pick a ${field} from the list.`);
  return v;
}

function obj(v, field) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${field} must be an object.`);
  return v;
}

function date(v, field = "Date") {
  const d = str(v, field, { min: 1, max: 10 });
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z")) || new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d)
    fail(`${field} must look like 2026-11-02.`);
  return d;
}

function time(v, field = "Time") {
  const t = str(v, field, { min: 1, max: 5 });
  if (!TIME_RE.test(t)) fail(`${field} must be 24-hour like 09:00 or 17:30.`);
  return t;
}

function areasInput(v) {
  const areas = v === undefined || v === "" || v === null ? [] : Array.isArray(v) ? v : [v];
  if (areas.length > AREAS.length) fail("Too many areas.");
  areas.forEach((a) => oneOf(a, AREAS, "body area"));
  return [...new Set(areas)];
}
const painInput = (v) => (v === undefined || v === "" || v === null ? null : int(v, "Pain level", { min: 0, max: 10 }));

// Evaluation request / intake from the website
function leadInput(b) {
  obj(b, "Request");
  return {
    name: str(b.name, "Name", { min: 2, max: 100 }),
    email: email(b.email),
    phone: phone(b.phone),
    service: b.service ? oneOf(b.service, SERVICES, "service") : "Not sure yet",
    goal: b.goal ? oneOf(b.goal, GOALS, "goal") : "Other",
    areas: areasInput(b.areas),
    painLevel: painInput(b.painLevel),
    duration: b.duration ? oneOf(b.duration, DURATIONS, "how long") : "",
    surgery: b.surgery ? oneOf(b.surgery, SURGERY, "surgery answer") : "",
    preferredTime: str(b.preferredTime, "Preferred time", { max: 100 }),
    referral: str(b.referral, "How you heard about us", { max: 120 }),
    message: str(b.message, "Message", { max: 2000 })
  };
}

function bookingInput(b) {
  obj(b, "Booking");
  return {
    classId: str(b.classId, "Class", { min: 1, max: 40 }),
    date: date(b.date),
    name: str(b.name, "Name", { min: 2, max: 100 }),
    email: email(b.email),
    phone: phone(b.phone)
  };
}

function appointmentInput(b) {
  obj(b, "Appointment");
  return {
    typeId: str(b.typeId, "Appointment type", { min: 1, max: 30 }),
    date: date(b.date),
    time: time(b.time),
    name: str(b.name, "Name", { min: 2, max: 100 }),
    email: email(b.email),
    phone: phone(b.phone, { required: true }),
    notes: str(b.notes, "Notes", { max: 1000 }),
    areas: areasInput(b.areas),
    painLevel: painInput(b.painLevel)
  };
}

// On-site reviews: any rating earns the same reward, so the reward never depends on what people say
function feedbackInput(b) {
  obj(b, "Review");
  return {
    name: str(b.name, "Name", { min: 2, max: 80 }),
    email: email(b.email),
    rating: int(b.rating, "Star rating", { min: 1, max: 5 }),
    text: str(b.text, "Your review", { min: 10, max: 2000 }),
    publish: Boolean(b.publish)
  };
}

function classInput(b, { partial = false } = {}) {
  obj(b, "Class");
  const c = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has("title")) c.title = str(b.title, "Class name", { min: 1, max: 80 });
  if (!partial || has("day")) c.day = int(b.day, "Day", { min: 0, max: 6 });
  if (!partial || has("time")) c.time = time(b.time, "Start time");
  if (!partial || has("durationMin")) c.durationMin = int(b.durationMin ?? 60, "Length (minutes)", { min: 15, max: 240 });
  if (!partial || has("capacity")) c.capacity = int(b.capacity ?? 10, "Capacity", { min: 1, max: 100 });
  if (!partial || has("coach")) c.coach = str(b.coach, "Coach", { max: 80 });
  if (!partial || has("location")) c.location = str(b.location, "Location", { max: 120 });
  if (!partial || has("description")) c.description = str(b.description, "Description", { max: 500 });
  if (has("active")) { if (typeof b.active !== "boolean") fail("Active must be true or false."); c.active = b.active; }
  if (partial && !Object.keys(c).length) fail("Nothing to update.");
  return c;
}

// Partial settings update: only the sections/fields sent are changed.
function mergeSettings(current, body) {
  obj(body, "Settings");
  const known = ["business", "rating", "coach", "packages", "testimonials", "appointmentTypes", "scheduling", "booking", "services", "plans"];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length) fail(`Unknown setting: ${unknown[0]}`);
  if (!Object.keys(body).length) fail("Nothing to update.");
  const s = JSON.parse(JSON.stringify(current));

  if (body.business !== undefined) {
    const b = obj(body.business, "business");
    const text = { name: 60, tagline: 160, address: 200, hours: 300, bookingNote: 300 };
    for (const [k, max] of Object.entries(text)) if (b[k] !== undefined) s.business[k] = str(b[k], k, { max, min: k === "name" ? 1 : 0 });
    if (b.phone !== undefined) s.business.phone = phone(b.phone);
    if (b.email !== undefined) s.business.email = email(b.email, "Contact email", { required: false });
    for (const k of ["instagram", "facebook", "tiktok", "mapsUrl"]) if (b[k] !== undefined) s.business[k] = url(b[k], `${k} link`);
  }

  if (body.rating !== undefined) {
    const b = obj(body.rating, "rating");
    if (b.score !== undefined) {
      const sc = str(String(b.score), "Rating", { max: 3 });
      if (sc && !/^[1-5](\.\d)?$/.test(sc)) fail("Rating must look like 4.9.");
      s.rating.score = sc;
    }
    if (b.count !== undefined) s.rating.count = int(b.count, "Review count", { min: 0, max: 100000 });
    if (b.source !== undefined) s.rating.source = str(b.source, "Review source", { max: 40 });
    if (b.url !== undefined) s.rating.url = url(b.url, "Reviews link");
  }

  if (body.coach !== undefined) {
    const b = obj(body.coach, "coach");
    if (b.name !== undefined) s.coach.name = str(b.name, "Coach name", { max: 80 });
    if (b.title !== undefined) s.coach.title = str(b.title, "Coach title", { max: 120 });
    if (b.bio !== undefined) s.coach.bio = str(b.bio, "Coach bio", { max: 3000 });
    if (b.photoUrl !== undefined) s.coach.photoUrl = url(b.photoUrl, "Coach photo link");
  }

  if (body.packages !== undefined) {
    if (!Array.isArray(body.packages) || body.packages.length > 6) fail("Packages: up to 6.");
    s.packages = body.packages.map((p, i) => {
      obj(p, `Package ${i + 1}`);
      const features = Array.isArray(p.features) ? p.features.map((f) => str(f, "Feature", { max: 80 })).filter(Boolean) : [];
      if (features.length > 8) fail(`Package ${i + 1}: up to 8 features.`);
      return {
        name: str(p.name, `Package ${i + 1} name`, { min: 1, max: 60 }),
        price: str(p.price, `Package ${i + 1} price`, { max: 20 }),
        unit: str(p.unit, `Package ${i + 1} unit`, { max: 30 }),
        features
      };
    });
  }

  if (body.services !== undefined) {
    if (!Array.isArray(body.services) || body.services.length < 1 || body.services.length > 12) fail("Services: between 1 and 12.");
    s.services = body.services.map((v, i) => {
      obj(v, `Service ${i + 1}`);
      const id = str(v.id, `Service ${i + 1} id`, { min: 1, max: 30 });
      if (!/^[a-z0-9-]+$/.test(id)) fail(`Service id "${id}": lowercase letters, numbers and dashes only.`);
      return {
        id, name: str(v.name, `Service ${i + 1} name`, { min: 1, max: 60 }),
        rate: int(v.rate, `Service ${i + 1} rate`, { min: 0, max: 10000 }),
        unit: str(v.unit || "visit", `Service ${i + 1} unit`, { max: 20 }),
        protocol: Boolean(v.protocol),
        withEval: Boolean(v.withEval),
        remote: Boolean(v.remote),
        description: str(v.description, `Service ${i + 1} description`, { max: 300 })
      };
    });
    if (new Set(s.services.map((v) => v.id)).size !== s.services.length) fail("Service ids must be unique.");
  }

  if (body.plans !== undefined) {
    const b = obj(body.plans, "plans");
    const pct = (k, label, max = 50) => { if (b[k] !== undefined) s.plans[k] = int(b[k], label, { min: 0, max }); };
    pct("gold", "Gold discount"); pct("silver", "Silver discount"); pct("ext12", "12-month increase"); pct("ext24", "24-month increase");
    if (b.silverPayments !== undefined) s.plans.silverPayments = int(b.silverPayments, "Silver payments", { min: 2, max: 12 });
    if (b.guaranteeMin !== undefined) s.plans.guaranteeMin = int(b.guaranteeMin, "Guarantee minimum sessions", { min: 1, max: 100 });
    if (b.packageSizes !== undefined) {
      if (!Array.isArray(b.packageSizes) || !b.packageSizes.length || b.packageSizes.length > 6) fail("Package sizes: 1 to 6 numbers.");
      s.plans.packageSizes = [...new Set(b.packageSizes.map((n) => int(n, "Package size", { min: 1, max: 100 })))].sort((x, y) => x - y);
    }
    if (b.reviewDiscountPct !== undefined) s.plans.reviewDiscountPct = int(b.reviewDiscountPct, "Review discount", { min: 0, max: 100 });
  }

  if (body.testimonials !== undefined) {
    if (!Array.isArray(body.testimonials) || body.testimonials.length > 20) fail("Testimonials: up to 20.");
    s.testimonials = body.testimonials.map((t, i) => {
      obj(t, `Testimonial ${i + 1}`);
      return { name: str(t.name, `Testimonial ${i + 1} name`, { min: 1, max: 60 }), quote: str(t.quote, `Testimonial ${i + 1} quote`, { min: 1, max: 600 }) };
    });
  }

  if (body.appointmentTypes !== undefined) {
    const list = body.appointmentTypes;
    if (!Array.isArray(list) || list.length < 1 || list.length > 8) fail("Appointment types: between 1 and 8.");
    s.appointmentTypes = list.map((t, i) => {
      obj(t, `Appointment type ${i + 1}`);
      const id = str(t.id, `Appointment type ${i + 1} id`, { min: 1, max: 30 });
      if (!/^[a-z0-9-]+$/.test(id)) fail(`Appointment type id "${id}": lowercase letters, numbers and dashes only.`);
      return {
        id,
        name: str(t.name, `Appointment type ${i + 1} name`, { min: 1, max: 60 }),
        minutes: int(t.minutes, `Appointment type ${i + 1} minutes`, { min: 10, max: 240 }),
        description: str(t.description, `Appointment type ${i + 1} description`, { max: 200 })
      };
    });
    if (new Set(s.appointmentTypes.map((t) => t.id)).size !== s.appointmentTypes.length) fail("Appointment type ids must be unique.");
    s.massageAdded = true; // the admin now owns this list, so don't re-add Medical Massage
  }

  if (body.booking !== undefined) {
    const b = obj(body.booking, "booking");
    if (b.provider !== undefined) s.booking.provider = oneOf(b.provider, ["builtin", "cal"], "booking system");
    if (b.calUsername !== undefined) {
      const u = str(b.calUsername, "Cal.com username", { max: 80 }).replace(/^https?:\/\/(app\.)?cal\.com\//, "").replace(/\/+$/, "");
      if (u && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(u)) fail("Cal.com username: letters, numbers, dots, dashes (e.g. mdfit or team/mdfit).");
      s.booking.calUsername = u;
    }
    if (b.calEventSlugs !== undefined) {
      if (!Array.isArray(b.calEventSlugs) || b.calEventSlugs.length > 10) fail("Cal.com event types: up to 10.");
      s.booking.calEventSlugs = b.calEventSlugs.map((x) => str(x, "Event slug", { max: 80 })).filter(Boolean);
      if (s.booking.calEventSlugs.some((x) => !/^[a-z0-9-]+$/i.test(x))) fail("Event slugs look like initial-evaluation (letters, numbers, dashes).");
    }
  }

  if (body.scheduling !== undefined) {
    const b = obj(body.scheduling, "scheduling");
    if (b.hours !== undefined) {
      if (!Array.isArray(b.hours) || b.hours.length !== 7) fail("Hours must list all 7 days.");
      s.scheduling.hours = b.hours.map((day, d) => {
        if (!Array.isArray(day) || day.length > 4) fail(`${DAYS[d]}: up to 4 time windows.`);
        return day.map((w) => {
          if (!Array.isArray(w) || w.length !== 2) fail(`${DAYS[d]}: each window is a start and end time.`);
          const [a, z] = [time(w[0], `${DAYS[d]} start`), time(w[1], `${DAYS[d]} end`)];
          if (a >= z) fail(`${DAYS[d]}: end time must be after start time.`);
          return [a, z];
        });
      });
    }
    if (b.slotStepMin !== undefined) s.scheduling.slotStepMin = oneOf(int(b.slotStepMin, "Slot step"), [10, 15, 20, 30, 60], "slot step");
    if (b.lastStart !== undefined) {
      const t = str(b.lastStart, "Latest start time", { max: 5 });
      if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail("Latest start time must look like 16:00.");
      s.scheduling.lastStart = t;
    }
    if (b.minNoticeHours !== undefined) s.scheduling.minNoticeHours = int(b.minNoticeHours, "Minimum notice (hours)", { min: 0, max: 168 });
    if (b.daysAhead !== undefined) s.scheduling.daysAhead = int(b.daysAhead, "Days ahead", { min: 1, max: 90 });
    if (b.blockedDates !== undefined) {
      if (!Array.isArray(b.blockedDates) || b.blockedDates.length > 200) fail("Blocked dates: up to 200.");
      s.scheduling.blockedDates = [...new Set(b.blockedDates.map((d) => date(d, "Blocked date")))].sort();
    }
  }
  return s;
}

module.exports = {
  ValidationError, EMAIL_RE, GOALS, SERVICES, AREAS, DURATIONS, SURGERY, LEAD_STATUSES, APPT_STATUSES, DAYS,
  defaultSettings, leadInput, bookingInput, appointmentInput, classInput, mergeSettings, feedbackInput
};
