// Member content: premade programs, lectures, monthly live Q&A, membership tiers with 1-on-1 meetings, health recommendations.
// Everything is admin-editable; links to members-only content are only sent to members.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");
const { TIP_SECTIONS } = require("./tips");

const fail = (msg) => { throw new ValidationError(msg); };
const str = (v, label, { min = 0, max = 200 } = {}) => {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") fail(`${label} must be text.`);
  const s = v.trim();
  if (s.length < min) fail(min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
};
const int = (v, label, { min, max }) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}.`); return n; };
// Prices to the cent (e.g. 19.95); checkout converts with cents().
const dollars = (v, label) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 20000 || Math.round(n * 100) !== Math.round(n * 100 * 1e6) / 1e6) fail(`${label} must be an amount from 0 to 20000, to the cent.`); return Math.round(n * 100) / 100; };
const url = (v, label) => { const s = str(v, label, { max: 500 }); if (s && !/^https:\/\/[^\s]+$/i.test(s)) fail(`${label} must be an https:// link.`); return s; };
const slug = (v, label) => { const s = str(v, label, { min: 1, max: 40 }); if (!/^[a-z0-9-]+$/.test(s)) fail(`${label} "${s}": lowercase letters, numbers and dashes only.`); return s; };
const oneOf = (v, list, label) => { if (!list.includes(v)) fail(`${label} must be one of: ${list.join(", ")}.`); return v; };
const list = (v, label, max, fn) => { if (!Array.isArray(v) || v.length > max) fail(`${label}: up to ${max}.`); const out = v.map(fn); const ids = out.map((x) => x.id).filter(Boolean); if (new Set(ids).size !== ids.length) fail(`${label}: ids must be unique.`); return out; };

const GOALS = ["upper", "lower", "full", "core", "mobility"];
const LOCS = ["home", "gym", "outdoor", "office"];
const LEVELS = ["beginner", "intermediate", "advanced", "elite"];
const PROGRAM_CATS = ["Hypertrophy", "Strength", "Anti-inflammatory", "Weight loss", "Mobility", "Rehabilitation", "Desk & posture", "Performance", "Sport Performance"];
const LECTURE_TOPICS = ["Health", "Wellness", "Hormones", "Inflammation", "Pain science", "Nutrition", "Sleep & recovery"];
const ACCESS = ["free", "member", "premium"];

const EXPERT_TIER = { id: "expert", name: "Expert Advice", price: 50, meetings: 0, meetingMinutes: 0, directMessages: true,
  perks: ["Everything in Membership", "Message Dr. Jared directly for expert advice", "Answers from Dr. Jared himself, not a bot", "Unlimited Sunny (MD Fit Intelligence)"] };

const day = (name, goal, length, extra = {}) => ({ name, goal, length, ...extra });
// Running / Marathon "Calf, foot & ankle" days: the workout generator filled these with squats and hip work (it picks by
// body region, and lower body includes hips), so they name the library's calf, foot and ankle videos instead.
// Doses are the library's default dosing; Dr. Jared to confirm.
const CALF_FOOT_ANKLE = [
  { ex: "Eccentric Calf Drops", sets: "8 slow (3-sec lowering)" }, { ex: "Toe Walk", sets: "30 sec" }, { ex: "Heel Walk", sets: "30 sec" },
  { ex: "Single Leg Balance", sets: "30 sec each leg" }, { ex: "Ankle Neuroglide", sets: "8 slow each side" }, { ex: "Jump Rope", sets: "30 sec" }
];
function defaultContent() {
  return {
    programs: [
      // ----- Dr. Jared's programs. Covered on the homepage and in the client app's Programs tab.
      { id: "hypertrophy-12", title: "PSG — State of Perpetual Growth", category: "Hypertrophy", level: "intermediate", location: "gym", weeks: 12, seed: 1001, access: "member",
        summary: "A continuous progression program for strength, size and mobility. 7-day cycle: upper, mobility, lower, mobility, upper, lower, then Sunday mobility if soreness is low (otherwise rest). Every strength day runs the same 50-40-30-20-10 movements at lighter weight; the heavy Long days are break cycles — rare and far apart.",
        notes: "Every upper/lower day uses the 50-40-30-20-10 rep scheme on the same movements at 30-40% less weight (minimum 20% less). Full body mobility sits between strength days; Sunday is the same mobility routine if soreness is low, otherwise rest. Long Workout Days are BREAK CYCLES — rare and far apart: Upper = Overhead Press 50-40-30-20-10 (no return), DB Bench and Lat Pull-Down 50-40-30-20-10-20-30-40-50; Lower = Bulgarian Split Squat and RDL 50-40-30-20-10 (no return), GHD/BOSU sit-ups to controlled failure. Only return to a Long day after a full day with no soreness or stiffness. Key principles: full range of motion, controlled tempo, deep stretches, mind-muscle connection, consistency over intensity. Nutrition: 40% protein, 30% fat, 30% carbs. Supplements: whey protein, creatine monohydrate, omega-3, vitamin D3+K2, magnesium. Cold exposure: ice baths 2-3 min, cold showers 2-5 min.",
        image: "assets/programs/hypertrophy-new.png", resources: ["psg-protocol"],
        days: [
          day("Upper Body — 50-40-30-20-10 (light)", "upper", 45, { rounds: 5, restEx: 45, restRound: 90, circuit: [
            { ex: "Overhead Press (DB)", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter than your break-cycle weight" },
            { ex: "Dumbbell Bench Press", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" },
            { ex: "Lat Pull-Down", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" }
          ] }),
          day("Full Body Mobility", "full", 30, { rounds: 5, restEx: 15, restRound: 60, circuit: [
            { ex: "TRX Body Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "10 reps each leg" },
            { ex: "Cossack Squat", sets: "10 reps each side" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ] }),
          day("Lower Body — 50-40-30-20-10 (light)", "lower", 45, { rounds: 5, restEx: 45, restRound: 90, circuit: [
            { ex: "Bulgarian Split Squat", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter than your break-cycle weight" },
            { ex: "Romanian Deadlift", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" },
            { ex: "GHD or BOSU Sit-Ups", sets: "Max controlled reps, light" }
          ] }),
          day("Full Body Mobility", "full", 30, { rounds: 5, restEx: 15, restRound: 60, circuit: [
            { ex: "TRX Body Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "10 reps each leg" },
            { ex: "Cossack Squat", sets: "10 reps each side" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ] }),
          day("Upper Body — 50-40-30-20-10 (light)", "upper", 45, { rounds: 5, restEx: 45, restRound: 90, circuit: [
            { ex: "Overhead Press (DB)", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter than your break-cycle weight" },
            { ex: "Dumbbell Bench Press", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" },
            { ex: "Lat Pull-Down", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" }
          ] }),
          day("Lower Body — 50-40-30-20-10 (light)", "lower", 45, { rounds: 5, restEx: 45, restRound: 90, circuit: [
            { ex: "Bulgarian Split Squat", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter than your break-cycle weight" },
            { ex: "Romanian Deadlift", sets: "50, 40, 30, 20, 10 reps - 30-40% lighter" },
            { ex: "GHD or BOSU Sit-Ups", sets: "Max controlled reps, light" }
          ] }),
          day("Sunday Mobility (if soreness is low)", "full", 30, { rounds: 5, restEx: 15, restRound: 60, circuit: [
            { ex: "TRX Body Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "10 reps each leg" },
            { ex: "Cossack Squat", sets: "10 reps each side" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ] })
        ] },
      { id: "dream-lean-12", title: "12-Week Dream Lean", category: "Weight loss", level: "intermediate", location: "gym", weeks: 12, seed: 1002, access: "member",
        summary: "STRONG · FUNCTIONAL · CONFIDENT. The complete system for a lean, toned and powerful you. 7-day training split with strength training 4-6 days per week, daily movement reset, health shots, ice bath protocol and acupressure mat recovery.",
        notes: "Daily Movement Reset (10-15 min): 90/90 Breathing, Couch Stretch, Thoracic Open Books, Glute Bridge Hold, Dead Bugs, Split Squat Hold, Wall Posture, Deep Squat Hold, Child's Pose with Reach. Take the MD Fit Health Shot daily on an empty stomach. Ice bath 2-4x/week (50-58°F, 2-5 min). Acupressure mat 10-20 min nightly. Nutrition: protein first (30-40g per meal), eat whole real foods, prioritize quality carbs around workouts, stay hydrated. Supplements: Magnesium Glycinate, Omega-3 Fish Oil, Vitamin D3 + K2, Creatine Monohydrate, Curcumin + Black Pepper Extract, Ashwagandha, Probiotic, Glycine. Sleep 7-9 hours. Focus on good form, progressive overload.",
        image: "assets/programs/dream-lean-new.png", resources: ["diet-health-shots", "bath-accu-mat"],
        days: [
          day("Lower Body — Glutes & Hamstrings", "lower", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Hip Thrusts", sets: "4 x 8-12" },
            { ex: "RDLs", sets: "4 x 8-12" },
            { ex: "Bulgarian Split Squats", sets: "3 x 10-12 each leg" },
            { ex: "Walking Lunges", sets: "3 x 12-16 steps" }
          ] }),
          day("Upper Body — Push & Pull", "upper", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Dumbbell Rows", sets: "4 x 10-12" },
            { ex: "Incline DB Press", sets: "4 x 10-12" },
            { ex: "Lat Pulldowns", sets: "4 x 10-12" },
            { ex: "Face Pulls", sets: "3 x 15-20" }
          ] }),
          day("Active Recovery & Mobility", "mobility", 60, { circuit: [
            { ex: "Zone 2 Cardio (Walk, Bike, Row)", sets: "30-45 minutes" },
            { ex: "Mobility Flow", sets: "10-15 minutes" },
            { ex: "Breath Work", sets: "5 minutes" },
            { ex: "Acupressure Mat", sets: "10-20 minutes" }
          ] }),
          day("Lower Body — Power & Glutes", "lower", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Sumo Deadlifts", sets: "4 x 8-10" },
            { ex: "Step-Ups", sets: "3 x 10-12 each leg" },
            { ex: "Cable Pull-Throughs", sets: "3 x 12-15" },
            { ex: "Glute Kickbacks", sets: "3 x 15-20 each leg" }
          ] }),
          day("Upper Body + Core", "upper", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Landmine Press", sets: "4 x 8-12" },
            { ex: "Seated Cable Row", sets: "4 x 10-12" },
            { ex: "Lateral Raises", sets: "3 x 12-15" },
            { ex: "Plank Variation", sets: "3 x 30-60 sec" }
          ] }),
          day("Full Body Conditioning", "full", 45, { rounds: 4, restEx: 30, restRound: 60, circuit: [
            { ex: "Sled Push", sets: "4 x 20-30 yards" },
            { ex: "Kettlebell Swings", sets: "3 x 15-20" },
            { ex: "Farmer Carries", sets: "4 x 30-45 sec" },
            { ex: "Med Ball Slams", sets: "3 x 12-15" }
          ] }),
          day("Rest & Recover", "mobility", 30, { circuit: [
            { ex: "Walk Outdoors", sets: "20-30 minutes" },
            { ex: "Stretch & Mobility", sets: "10-15 minutes" },
            { ex: "Sauna or Hot Bath", sets: "15-20 minutes" }
          ] })
        ] },
      { id: "shoulder-6", title: "6-Week Shoulder & Rotator Cuff Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 6, seed: 1003, access: "member",
        summary: "Progressive release and eccentric shoulder/rotator cuff system. The #1 Rule: Shoulders live in your pockets. Phase 1 (Weeks 1-2): Decompression, exploratory range and cuff control. Phase 2 (Weeks 3-4): End-range control and cervical rotation. Phase 3 (Weeks 5-6): Full cervical control and global integration.",
        notes: "Phase 1 (Weeks 1-2): Scalene Release (30-60 sec, 1-2 rounds), Eccentric Dumbbell Shrug Drop (10-20 reps, up to 2x daily, 15-25 lb), Rotator Cuff Internal/External Rotation at side (15-20 reps, 1-2 sets, very light band), Repeated Shoulder Drop Stretch (throughout the day), Farmer Carries (15-20 lb, 20-30 ft per lap, 10-20 laps). Phase 2 (Weeks 3-4): All prior movements + progressions with chin rotation, increased band tension, 3-5 sec holds, 12-15 reps x 2 sets. Phase 3 (Weeks 5-6): Three-Part Scalene Sequence (tilt, rotation, tuck), Rotator Cuff in Abduction (10-15 reps x 2 sets), Kneeling Straight-Arm Cable Pulldown (3x12-20), Bear Crawls (20-30 ft, 4-6 sets).",
        image: "assets/programs/shoulder-new.png",
        days: [day("Shoulder Protocol — Daily Routine", "upper", 20, { rounds: 2, restEx: 20, restRound: 60, circuit: [
          { ex: "Scalene Release", sets: "30-60 sec x 1-2 rounds each side" },
          { ex: "Eccentric Dumbbell Shrug Drop", sets: "10-20 reps x 1-2 sets (15-25 lb)" },
          { ex: "Rotator Cuff Int/Ext Rotation", sets: "15-20 reps x 1-2 sets (light band)" },
          { ex: "Farmer Carries", sets: "10-20 laps x 20-30 ft (15-20 lb)" }
        ] }), day("Shoulder Awareness & Mobility", "mobility", 15, { circuit: [
          { ex: "Repeated Shoulder Drop Stretch", sets: "Throughout the day" },
          { ex: "Shoulder Packing Drill", sets: "10 reps, hold 3-5 sec" }
        ] })] },
      { id: "hip-6", title: "6-Week Hip Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 6, seed: 1004, access: "member",
        summary: "Build tolerance, improve control, reduce irritation. Build strong, stable, pain-free hips through controlled movement, glute engagement and core stability. Daily exercises for all 6 weeks with weekly progressions.",
        notes: "Key principles: No Pain Rule (stay within pain-free range), Slow & Controlled (quality over quantity), Consistency (daily work builds lasting results), Glute Engagement (glutes on, shoulders down, engage core). Daily Basics — do every day all 6 weeks: Posture (shoulders down, chest tall, core lightly braced), Glute Engagement (keep glutes lightly engaged at all times), Core Bracing (brace before every rep), Breathing (exhale during effort, inhale through nose). Weekly progression: Wk 1 learn movement/control, Wk 2 improve control/stability, Wk 3 increase reps/hold time, Wk 4 increase range/endurance, Wk 5 build strength/stability, Wk 6 max control/full range/confidence. Pain is a signal, not a goal. Stop if symptoms travel farther down the leg.",
        image: "assets/programs/hip-new.png",
        days: [day("Hip Protocol — Daily Routine", "lower", 20, { rounds: 2, restEx: 20, circuit: [
          { ex: "Hip Dip (Eccentric Control)", sets: "2-3 x 6-10 each side" },
          { ex: "Side Plank (Modified)", sets: "1-2 x 3-5 each side, hold 3-5 sec" },
          { ex: "Knee Drive (Radiating Pain Only)", sets: "1-2 x 5-10 reps" }
        ] })] },
      { id: "low-back-6", title: "Back Stability Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 12, seed: 1005, access: "member",
        summary: "Foundation & Activation — the starting point for your hip and lower back protocol. Baseline phase with wall-supported hip/glute activation and pelvic floor work, progressing through 12 weeks of dynamic stability. Activate, Connect, Stabilize, Progress.",
        notes: "Baseline Phase: Wall-Supported Hip/Glute Activation (5-10 reps daily, hold 1-2 sec) and Pelvic Floor Activation (bladder & anal Kegel exercises after every urination). Week 1 — Dynamic Stability (Control the Basics): Posterior Pelvic Tilts, Heel Slides, Bent Knee Fall-Outs, Supine Marches, Bridge Holds, Standing Hip Hinge, Wall Squats (quarter depth), Farmer Carry. Continue daily: SI/pillow belt as needed, shoulders down, 10-20% glute engagement, 10-20% abdominal brace, neutral pelvis, walk 15-20 min. Mobility: Cat-Camel (10 gentle reps). Progress only when you can complete all prescribed movements with good control and without increased symptoms for at least 3 consecutive sessions. Muscle soreness is acceptable; joint pain, sharp pain, numbness, tingling or increasing radiating pain are not.",
        image: "assets/programs/low-back-new.png",
        days: [day("Back Stability — Daily Routine", "core", 20, { rounds: 2, restEx: 20, circuit: [
          { ex: "Posterior Pelvic Tilts", sets: "2 x 15" },
          { ex: "Heel Slides", sets: "2 x 10 each leg" },
          { ex: "Bent Knee Fall-Outs", sets: "2 x 10 each" },
          { ex: "Supine Marches", sets: "2 x 10" },
          { ex: "Bridge Holds", sets: "2 x 10 (5 sec hold)" },
          { ex: "Standing Hip Hinge", sets: "2 x 15" },
          { ex: "Wall Squats (Quarter Depth)", sets: "2 x 12" },
          { ex: "Farmer Carry", sets: "2 rounds (30-60 sec)" }
        ] }), day("Mobility & Activation", "mobility", 15, { circuit: [
          { ex: "Cat-Camel", sets: "10 gentle reps" },
          { ex: "Wall-Supported Hip/Glute Activation", sets: "5-10 reps (hold 1-2 sec)" },
          { ex: "Pelvic Floor Activation", sets: "5-10 reps each type" }
        ] })] },
      // ----- Week-by-week protocols written out from Dr. Jared's weekly sheets. The app shows each week from
      // /data/protocols/<id>.json on the website; the single day below is only a fallback for older app versions.
      { id: "knee-6", title: "6-Week Knee Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 6, seed: 1012, access: "member",
        summary: "Build tolerance, improve control, reduce irritation. Week 1: establish daily habits, activate the right muscles, and introduce gentle movement without pain. A new focus every week through week 6.",
        notes: "", image: "assets/programs/knee.png",
        days: [day("Knee Protocol — Daily Routine", "lower", 20, { rounds: 1 })] },
      { id: "plantar-4", title: "4-Week Plantar Fasciitis Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 4, seed: 1013, access: "member",
        summary: "Loosen the tight tissues, gently mobilize the foot and ankle, and start loading the calf with controlled eccentric drops, then build foot and calf strength week by week.",
        notes: "", image: "assets/programs/plantar.png",
        days: [day("Plantar Fasciitis — Daily Routine", "lower", 15, { rounds: 1 })] },
      { id: "bunion-4", title: "4-Week Bunion Correction Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 4, seed: 1024, access: "member",
        summary: "Realign, mobilize and strengthen the great toe over four weeks: toe spacers worn for longer each week, toe abduction taken from assisted to unassisted to banded, and calf and arch work alongside wider shoes.",
        notes: "", image: "assets/programs/bunion.png",
        days: [day("Bunion Correction \u2014 Daily Routine", "lower", 15, { rounds: 1 })] },
      { id: "tennis-elbow-4", title: "4-Week Elbow Epicondylitis Protocol: Wrist Flexors", category: "Rehabilitation", level: "beginner", location: "home", weeks: 4, seed: 1014, access: "member",
        summary: "A 4-week plan to reduce elbow epicondylitis pain and restore strength, built on slow eccentric work for the wrist flexors. Week 1: calm pain, start healing.",
        notes: "", image: "assets/programs/tennis-elbow.png",
        days: [day("Wrist Flexors — Daily Routine", "upper", 15, { rounds: 1 })] },
      { id: "golfers-elbow-4", title: "4-Week Elbow Epicondylitis Protocol: Wrist Extensors", category: "Rehabilitation", level: "beginner", location: "home", weeks: 4, seed: 1015, access: "member",
        summary: "A 4-week plan to reduce elbow epicondylitis pain and restore strength, built on slow eccentric work for the wrist extensors. Week 1: calm pain, start healing.",
        notes: "", image: "assets/programs/golfers-elbow.png",
        days: [day("Wrist Extensors — Daily Routine", "upper", 15, { rounds: 1 })] },
      { id: "posterior-chain-6", title: "6-Week Low Back, Mid-Back & Hip Flexor Protocol", category: "Rehabilitation", level: "beginner", location: "home", weeks: 6, seed: 1016, access: "member",
        summary: "A 6-week progressive eccentric, glute-driven and full-range system to restore mobility and reduce pain in the low back, mid-back, hips and pelvis. The same movements all 6 weeks, taken to greater length, stretch and control as you progress.",
        notes: "", image: "",
        days: [day("Posterior Chain — Daily Routine", "mobility", 20, { rounds: 1 })] },
      { id: "mobility-12", title: "12-Week Full Mobility System", category: "Mobility", level: "intermediate", location: "home", weeks: 12, seed: 1017, access: "member",
        summary: "A dual-track program with weekly integration: Track A (posterior chain eccentric protocol) and Track B (mobility conditioning circuit). Weeks 1-2 lean toward mobility; from week 3 the balance shifts toward strength.",
        notes: "", image: "", resources: ["mobility-diet-ratios"],
        days: [day("Mobility System — Track A", "mobility", 30, { rounds: 1 })] },
      { id: "mobility-ladder", title: "Mobility Ladder", category: "Mobility", level: "intermediate", location: "home", weeks: 5, seed: 1006, access: "member",
        summary: "Dr. Jared's mobility ladder. Same six movements each round. Get as many rounds as you can in under 30 minutes. When you can fit another round in under 30 minutes, add another round. When you can take levels of assistance away, take them away. Increase your depth, not your reps.",
        notes: "Week 1: once. Week 2: twice, about three days apart. Week 3: twice again. Weeks 4 and 5: three times a week. Do NOT add reps to any movement — keep the rep count the same every time. The focus is depth and holding your form: go deeper on the Cossack, less wall help on the pistol, fuller range on the squat. You will get a little stronger and your endurance may improve, but the real change is that the movements get easier as your mobility lets you do them, so your time naturally gets better. When you can fit another round in under 30 minutes, add a round. Form before everything.",
        image: "assets/programs/mobility-ladder-poster.png",
        // Sessions per week, week by week (the owner's ladder): the app paces the one session card by this instead of weeks × days
        perWeek: [1, 2, 2, 3, 3],
        days: [day("Mobility Ladder", "full", 30, {
          rounds: 5, restEx: 15, restRound: 60,
          circuit: [
            { ex: "TRX Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps (door frame / broom handle)" },
            { ex: "Cossack Squat", sets: "5 reps / side" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "5 reps / side (assisted)" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ]
        })] },
      { id: "anti-inflammatory", title: "Anti-Inflammatory Reset", category: "Anti-inflammatory", level: "beginner", location: "home", weeks: 4, seed: 1007, access: "member",
        summary: "Gentle full-body strength, mobility and daily walking to calm things down without flaring them up. 3 sessions a week for 4 weeks.",
        notes: "Walk 20-30 min a day at a pace you can still talk at. Keep every session at an effort of 5/10 or less. Omega-3s, protein, 7-9 hours of sleep.",
        image: "assets/programs/anti-inflammatory-new.png",
        days: [day("Strength & breath", "full", 30, { rounds: 2, restEx: 20, restRound: 60 }), day("Mobility flow", "mobility", 20), day("Core & spine", "core", 20, { rounds: 2 })] },
      { id: "golf", sport: "Golf", title: "6-Week Beginner Golf Protocol", category: "Sport Performance", level: "beginner", location: "home", weeks: 6, seed: 1008, access: "member",
        summary: "Improve mobility, build better movement and develop a stronger swing. 3 sessions a week for 6 weeks — mobility first, form always.",
        notes: "Do this three times a week on non-golf days. Each workout is 20–30 minutes. Focus on quality over speed — increase depth before adding reps.",
        image: "assets/programs/golf-new.png",
        days: [
          day("Hip Mobility Foundations", "lower", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "90/90 Hip Switch", sets: "2x10 each side" },
            { ex: "Couch Stretch w/ Glute Engage", sets: "2x30 sec each side" },
            { ex: "Standing Hip Dip", sets: "2x10 each side" },
            { ex: "TRX Squat", sets: "2x12" },
            { ex: "Golf Address Posture Hold", sets: "3x20 sec" },
            { ex: "Glute RDL", sets: "2x10" }] }),
          day("Thoracic Spine & Shoulders", "upper", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "Seated Thoracic Rotation", sets: "2x10 each side" },
            { ex: "Walkout", sets: "2x6" },
            { ex: "Open Book Rotation", sets: "2x10 each side" },
            { ex: "Front Crab Walk", sets: "2x20 ft" },
            { ex: "Golf Club Across-Chest Rot", sets: "2x10 each side" },
            { ex: "Scapular Retraction", sets: "2x12" }] }),
          day("Lower-Body Control", "lower", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "Single-Leg Glute Bridge", sets: "2x10 each side" },
            { ex: "Assisted Cossack Squat", sets: "2x8 each side" },
            { ex: "Ankle Rocking Mobility", sets: "2x10 each side" },
            { ex: "Side Crab Walk", sets: "2x20 ft" },
            { ex: "Golf Stance Weight Shift", sets: "2x10 each side" },
            { ex: "Supported Single-Leg RDL", sets: "2x8 each side" }] })] },
      { id: "pickleball", sport: "Pickleball", title: "Pickleball Beginner Protocol", category: "Sport Performance", level: "beginner", location: "home", weeks: 6, seed: 1009, access: "member",
        summary: "Move better, play longer and lower your injury risk. Mobility, stability, strength, power, endurance and court confidence — 3 sessions a week for 6 weeks.",
        notes: "Do this three times a week. Warm up 5–8 minutes before every workout. Glutes engaged at all times, shoulders down, control the movement. Quality over quantity.",
        image: "assets/programs/pickleball.png",
        days: [
          day("Foundation & Lower Body", "lower", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "Ankle Circles", sets: "2x20 each direction" },
            { ex: "Knee Circles", sets: "2x15 each direction" },
            { ex: "Glute Bridge", sets: "3x15" },
            { ex: "Split Squat", sets: "3x10 each side" },
            { ex: "Lateral Step Down", sets: "3x8 each side" },
            { ex: "Farmer Carry", sets: "3x40 ft each side" }] }),
          day("Upper Body, Core & Posture", "upper", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "Shoulder Set", sets: "2x20 retractions" },
            { ex: "Banded Row", sets: "3x15" },
            { ex: "Incline Push-Up", sets: "3x12" },
            { ex: "Dead Bug", sets: "3x10 each side" },
            { ex: "Side Plank", sets: "3x20 s each side" },
            { ex: "Pallof Press", sets: "3x12 each side" }] }),
          day("Movement & Court Readiness", "full", 30, { rounds: 2, restEx: 15, restRound: 45, circuit: [
            { ex: "Ankle Circles (Dynamic)", sets: "2x20 each direction" },
            { ex: "Knee Circles (Dynamic)", sets: "2x15 each direction" },
            { ex: "Lateral Lunge", sets: "3x10 each side" },
            { ex: "Forward/Backward Lunge", sets: "3x8 each side" },
            { ex: "Lateral Shuffle", sets: "4x20 ft each dir" },
            { ex: "Split Step + Shadow Volley", sets: "3x30 s" }] })] },
      { id: "running", sport: "Running", title: "Running Performance", category: "Sport Performance", level: "intermediate", location: "home", weeks: 6, seed: 1010, access: "member",
        summary: "Hip strength, calf and foot work, and single-leg stability to run faster with fewer injuries. 3 sessions a week to pair with your runs.",
        notes: "These are the strength and mobility days: do them on your easy-run days or on rest days. Your long run is your long run.",
        image: "assets/programs/running-new.png",
        days: [day("Hip & glute strength", "lower", 30, { rounds: 3, restEx: 20, restRound: 60 }), day("Calf, foot & ankle", "lower", 20, { rounds: 2, circuit: CALF_FOOT_ANKLE }), day("Mobility & core", "mobility", 20, { rounds: 2, circuit: [
          { ex: "Dead Bug", sets: "10 reps" }, { ex: "Dynamic Plank", sets: "10 reps" }, { ex: "Couch Stretch", sets: "30 sec each side" },
          { ex: "90/90 Hip Switch", sets: "8 slow each side" }, { ex: "Standing Hip CARs", sets: "8 slow each side" }, { ex: "Thoracic Open Book", sets: "30 sec each side" }] })] },
      { id: "marathon", sport: "Marathon", title: "Marathon Prep", category: "Sport Performance", level: "advanced", location: "home", weeks: 12, seed: 1011, access: "member",
        summary: "A 12-week strength-and-mobility block to carry you through marathon training without breaking down. 4 sessions a week built around your run calendar.",
        notes: "Pair with your running plan. Deload every 4 weeks: cut rounds in half the week before a long effort.",
        image: "assets/programs/marathon-new.png",
        days: [day("Hip & glute strength", "lower", 30, { rounds: 3, restEx: 20, restRound: 60 }), day("Core & spine", "core", 25, { rounds: 3 }), day("Calf, foot & ankle", "lower", 20, { rounds: 2, circuit: CALF_FOOT_ANKLE }), day("Mobility & recovery", "mobility", 25)] },
      // Sport levels written out week by week from Dr. Jared's sheets (/data/protocols/<id>.json); the one day below is a fallback for old app versions
      { id: "pickleball-intermediate", sport: "Pickleball", title: "Pickleball Intermediate Protocol", category: "Sport Performance", level: "intermediate", location: "gym", weeks: 6, seed: 1018, access: "member",
        summary: "Stability, strength, power, control and court confidence: build lower-body power, rotational control and court-ready movement. 3 workouts a week for 6 weeks.",
        notes: "", image: "assets/programs/pickleball.png",
        days: [day("Workout A", "lower", 45, { rounds: 1 })] },
      { id: "pickleball-advanced", sport: "Pickleball", title: "Pickleball Advanced Protocol", category: "Sport Performance", level: "advanced", location: "gym", weeks: 6, seed: 1019, access: "member",
        summary: "Power, speed, reaction, resilience and next-level performance. 3 workouts a week for 6 weeks.",
        notes: "", image: "assets/programs/pickleball.png",
        days: [day("Workout A", "lower", 60, { rounds: 1 })] },
      { id: "golf-intermediate", sport: "Golf", title: "6-Week Intermediate Golf Program", category: "Sport Performance", level: "intermediate", location: "gym", weeks: 6, seed: 1020, access: "member",
        summary: "Rotational strength, power and control to build on your beginner foundation and develop a stronger, more consistent swing.",
        notes: "", image: "assets/programs/golf-new.png",
        days: [day("Workout A", "mobility", 30, { rounds: 1 })] },
      { id: "golf-advanced", sport: "Golf", title: "6-Week Advanced Golf Program", category: "Sport Performance", level: "advanced", location: "gym", weeks: 6, seed: 1021, access: "member",
        summary: "Advanced power, speed and integrated movement for a faster, more efficient swing.",
        notes: "", image: "assets/programs/golf-new.png",
        days: [day("Workout A", "lower", 45, { rounds: 1 })] },
      { id: "ski-advanced", sport: "Ski", title: "Advanced Ski Program", category: "Sport Performance", level: "advanced", location: "gym", weeks: 8, seed: 1022, access: "member",
        summary: "An 8-week plan for power, single-leg dominance and reactive stability: stronger ankles, more control, less fatigue, bigger days on snow.",
        notes: "", image: "",
        days: [day("Workout A", "lower", 45, { rounds: 1 })] },
      { id: "marathon-extension", sport: "Marathon", title: "Marathon Contingency: 12-Week Extension", category: "Sport Performance", level: "advanced", location: "outdoor", weeks: 15, seed: 1023, access: "member",
        summary: "Weeks 9-20 plus the final 3-week taper: build endurance, maintain form, stay healthy and reach 26.2.",
        notes: "", image: "assets/programs/marathon-new.png",
        days: [day("Long run day: mobility & recovery", "mobility", 20, { rounds: 1 })] }
    ],

    lectures: [
      { id: "hormones-training", title: "Hormones, anti-cortisol & longevity", topic: "Hormones", minutes: 58, url: "https://drive.google.com/file/d/1Wb8QxpVp16J5w_WdLL9JUODKp8sDwtjn/view", downloadUrl: "", access: "member", summary: "Dr. Jared breaks down how hormones, cortisol and daily habits affect aging, recovery and performance." },
      { id: "cortisol-program", title: "The cortisol program", topic: "Hormones", minutes: 40, url: "https://drive.google.com/file/d/1FOLU6lNofptCTGShb1mNdVNPprkYNZD_/view", downloadUrl: "", access: "member", summary: "A full walkthrough of the anti-cortisol protocol: why it works, what to change, and how to start." },
      { id: "inflammation-101", title: "Inflammation: friend and foe", topic: "Inflammation", minutes: 0, url: "", downloadUrl: "", access: "member", summary: "What inflammation is for, why it lingers, and the daily habits that calm it." },
      { id: "pain-science", title: "Why it still hurts: referred pain explained", topic: "Pain science", minutes: 0, url: "", downloadUrl: "", access: "free", summary: "Why the pain you feel is often far from the muscle causing it." },
      { id: "wellness-basics", title: "The five wellness basics", topic: "Wellness", minutes: 0, url: "", downloadUrl: "", access: "free", summary: "Sleep, movement, food, stress and connection: where to start." }
    ],
    live: { title: "Monthly live Q&A with Dr. Jared", date: "", time: "18:00", minutes: 60, joinUrl: "", access: "member",
      notes: "Bring your questions: pain, programs, what to do next. Camera on or off, your choice. Please don't share private medical details in the group session.", recordings: [] },
    tiers: [
      // Owner (Nov 2026): a flat $19.95 membership, a $29.95 accountability membership that drops to $10 with 20 active days
      // (floor = the least you pay after credits), then the two 1-on-1 tiers.
      { id: "member", name: "Membership", price: 19.95, meetings: 0, meetingMinutes: 0, perks: ["Unlimited Sunny (MD Fit Intelligence)", "Build your own workouts and send challenges to anyone", "Every premade program", "Full lecture library", "Monthly live Q&A with Dr. Jared", "Progress tracking and workout comparisons"] },
      { id: "accountability", name: "Accountability Membership", price: 29.95, accountability: true, floor: 10, meetings: 0, meetingMinutes: 0, perks: ["Everything in Membership", "Unlimited Sunny (MD Fit Intelligence)", "$1 off for every day you log a workout or pain check-in", "Log 20 active days and that month is just $10"] },
      // Owner (Nov 2026): messaging Dr. Jared directly is part of Expert Advice and the 1-on-1 tiers (directMessages)
      EXPERT_TIER,
      { id: "premium", name: "Premium 1-on-1", price: 200, meetings: 2, meetingMinutes: 30, directMessages: true, perks: ["Everything in Membership", "2 scheduled 30-minute remote sessions with Dr. Jared every month", "Text Dr. Jared directly with questions", "Custom program built for you", "Guided website and app walkthrough"] },
      { id: "premium-plus", name: "Premium Plus", price: 349, meetings: 4, meetingMinutes: 30, directMessages: true, perks: ["Everything in Premium", "4 scheduled 30-minute remote sessions every month", "Priority scheduling"] }
    ],
    // Pain tracks: empty = use the built-in tracks transcribed from Dr. Jared's Drive (frontend/paintracks.js)
    tracks: [],
    // Each tip keeps its original poster (`image`, a Google Drive file id) and carries the poster's text as `sections`
    // (lib/tips.js) so the app can show a readable article. Photos for the article header live in the frontend.
    recommendations: [
      { id: "diet-health-shots", area: "Nutrition", title: "Diet & health shot protocol", body: "The Dream Lean food guidelines (what to eat, what to limit) and the daily health shot, made as a 1-liter batch for the week.", image: "1P-5bng8Pg3Yatz5jE-KOWDfTDBWgh5Hu", link: "", sections: TIP_SECTIONS["diet-health-shots"] },
      { id: "bath-accu-mat", area: "Recovery", title: "Ice bath, acupressure mat & progress photo protocol", body: "How to use the ice bath and acupressure mat, and how to take progress photos the same way every time so changes can be measured.", image: "1B0oS274__c5NPLssp7G_L3ZRoZzvwnnS", link: "", sections: TIP_SECTIONS["bath-accu-mat"] },
      { id: "fitness-erg", area: "Fitness", title: "Dream Lean: the complete system", body: "The whole Dream Lean plan on one page: daily movement reset, a 7-day strength program, ice bath and acupressure mat, the MD Fit health shot, nutrition and supplements.", image: "1sXFDNW1EMGcgW7SolVisACsZymIvj4hB", link: "", sections: TIP_SECTIONS["fitness-erg"] },
      { id: "mobility-diet-ratios", area: "Nutrition", title: "Full body mobility workout & macro ratios", body: "A 30-minute full body mobility circuit, plus the higher-protein, higher-fat macro split (40 / 30 / 30) with daily examples by body weight.", image: "1vdRtw2VUrov0HLopkZAtgVuKs_QOtwU9", link: "", sections: TIP_SECTIONS["mobility-diet-ratios"] },
      { id: "psg-protocol", area: "Fitness", title: "State of Perpetual Growth (PSG) program", body: "A continuous progression program for strength, size and mobility: rare high-volume \"break cycle\" days, lighter short days and a 30-minute mobility circuit.", image: "1Nigi9UOTm14KAzHS6hOb9KQKEOXVH-Xs", link: "", sections: TIP_SECTIONS["psg-protocol"] },
      { id: "weekly-tracking", area: "Wellness", title: "Dream Lean: start here & daily checklist", body: "Start here: what the 12-week Dream Lean program includes, what is measured, the rules, and the daily checklist to track each week.", image: "1v7JgO21TdrdsSOCba0Y9vvuO1mdpOgfL", link: "", sections: TIP_SECTIONS["weekly-tracking"] }
    ],
    events: [
      { id: "simc-nov-2026", title: "Sarasota Integrative Medicine Consortium", date: "2026-11-05", time: "6:00 PM", location: "Sarasota, FL", description: "Dr. Jared Caban attends the Sarasota Integrative Medicine Consortium meeting — networking with local integrative health practitioners.", link: "", free: true },
      { id: "nxf-nov-2026", title: "NXF Classic & Forge Wellness Festival", date: "2026-11-14", time: "11:00 AM – 6:00 PM", location: "Robarts Arena, 3000 Ringling Blvd, Sarasota, FL 34237", description: "Dr. Jared Caban will be at the inaugural NXF Classic & Forge Wellness Festival offering complimentary soft-tissue bodywork and movement assessments. Come say hello!", link: "", free: true },
      { id: "dimmitt-wellness-dec-2026", title: "Free Wellness Experience at Dimmitt Bentley SRQ", date: "2026-12-05", time: "8:00 AM – 2:00 PM", location: "Dimmitt Automotive Group (Bentley SRQ), 1518 State Street, Sarasota, FL", description: "Dr. Jared Caban will be giving a complimentary wellness talk and offering soft-tissue bodywork at this free wellness experience. Yoga, pilates, and other wellness offerings also available.", link: "", free: true },
      { id: "integrative-health-jan-2027", title: "Integrative Health Event — Dr. Caban Speaking", date: "2027-01-01", time: "TBA", location: "Dimmitt Automotive Group (Bentley SRQ), Sarasota, FL", description: "Dr. Jared Caban is a featured speaker at the Integrative Health Event. Exact date coming soon.", link: "", free: true }
    ]
  };
}

function programIn(p, i) {
  const L = `Program ${i + 1}`;
  if (!p || typeof p !== "object") fail(`${L} is missing.`);
  if (!Array.isArray(p.days) || !p.days.length || p.days.length > 7) fail(`${L}: 1 to 7 training days.`);
  return {
    id: slug(p.id, `${L} id`), title: str(p.title, `${L} title`, { min: 1, max: 80 }), category: oneOf(p.category, PROGRAM_CATS, `${L} category`),
    level: oneOf(p.level, LEVELS, `${L} level`), location: oneOf(p.location, LOCS, `${L} location`), weeks: int(p.weeks, `${L} weeks`, { min: 1, max: 52 }),
    seed: int(p.seed ?? 1, `${L} seed`, { min: 1, max: 999999 }), access: oneOf(p.access || "free", ACCESS, `${L} access`),
    summary: str(p.summary, `${L} summary`, { max: 400 }), notes: str(p.notes, `${L} notes`, { max: 1000 }),
    image: str(p.image || "", `${L} image`, { max: 500 }),
    // Optional week-by-week session count (one entry per week, 1-7); when set, the app paces sessions by it instead of weeks × days
    ...(Array.isArray(p.perWeek) && p.perWeek.length ? { perWeek: list(p.perWeek, `${L} sessions per week`, 52, (x, k) => int(x, `${L} week ${k + 1} sessions`, { min: 1, max: 7 })) } : {}),
    ...(p.sport ? { sport: str(p.sport, `${L} sport`, { min: 1, max: 30 }) } : {}),
    // Program resources: Health Tips (recommendation ids) that belong to this program, e.g. Dream Lean's diet sheet
    ...(Array.isArray(p.resources) && p.resources.length ? { resources: [...new Set(list(p.resources, `${L} resources`, 10, (x) => slug(x, `${L} resource`)))] } : {}),
    days: p.days.map((d, j) => ({
      name: str(d.name, `${L} day ${j + 1} name`, { min: 1, max: 40 }), goal: oneOf(d.goal, GOALS, `${L} day ${j + 1} focus`),
      length: oneOf(Number(d.length), [15, 20, 25, 30, 45, 60, 90], `${L} day ${j + 1} length`),
      ...(d.rounds !== undefined ? { rounds: int(d.rounds, "Rounds", { min: 1, max: 10 }) } : {}),
      ...(d.restEx !== undefined ? { restEx: int(d.restEx, "Rest between exercises", { min: 0, max: 180 }) } : {}),
      ...(d.restRound !== undefined ? { restRound: int(d.restRound, "Rest between rounds", { min: 0, max: 300 }) } : {}),
      ...(d.seedOffset !== undefined ? { seedOffset: int(d.seedOffset, "Seed offset", { min: 0, max: 9999 }) } : {}),
      ...(Array.isArray(d.circuit) ? { circuit: d.circuit.slice(0, 20).map((x, k) => ({
        ex: str(x.ex, `Day ${j + 1} exercise ${k + 1}`, { min: 1, max: 80 }),
        sets: str(x.sets || "", `Day ${j + 1} exercise ${k + 1} sets`, { max: 120 })
      })) } : {})
    }))
  };
}
const lectureIn = (l, i) => ({
  id: slug(l.id, `Lecture ${i + 1} id`), title: str(l.title, `Lecture ${i + 1} title`, { min: 1, max: 120 }), topic: oneOf(l.topic, LECTURE_TOPICS, `Lecture ${i + 1} topic`),
  minutes: int(l.minutes ?? 0, `Lecture ${i + 1} minutes`, { min: 0, max: 600 }), url: url(l.url, `Lecture ${i + 1} video link`),
  downloadUrl: url(l.downloadUrl, `Lecture ${i + 1} download link`), access: oneOf(l.access || "free", ACCESS, `Lecture ${i + 1} access`),
  summary: str(l.summary, `Lecture ${i + 1} summary`, { max: 500 })
});
const tierIn = (t, i) => ({
  id: slug(t.id, `Tier ${i + 1} id`), name: str(t.name, `Tier ${i + 1} name`, { min: 1, max: 60 }), price: dollars(t.price, `Tier ${i + 1} price`),
  meetings: int(t.meetings ?? 0, `Tier ${i + 1} meetings per month`, { min: 0, max: 31 }), meetingMinutes: int(t.meetingMinutes ?? 0, `Tier ${i + 1} meeting length`, { min: 0, max: 180 }),
  // Accountability credit ($1 off per active day, 20 days max); floor = the least the member pays that month
  ...(t.accountability ? { accountability: true, floor: dollars(t.floor ?? 0, `Tier ${i + 1} lowest price`) } : {}),
  // Members on this tier may message Dr. Jared directly (lib/messages.js)
  ...(t.directMessages !== undefined ? { directMessages: t.directMessages === true } : {}),
  perks: list(t.perks || [], `Tier ${i + 1} perks`, 10, (x, j) => str(x, `Perk ${j + 1}`, { min: 1, max: 120 }))
});
const recIn = (r, i) => ({
  id: slug(r.id, `Recommendation ${i + 1} id`), area: str(r.area, `Recommendation ${i + 1} area`, { min: 1, max: 40 }),
  title: str(r.title, `Recommendation ${i + 1} title`, { min: 1, max: 120 }), body: str(r.body, `Recommendation ${i + 1} text`, { min: 1, max: 2000 }),
  image: str(r.image || "", `Recommendation ${i + 1} image`, { max: 500 }),
  link: url(r.link, `Recommendation ${i + 1} link`),
  ...(r.sections !== undefined ? { sections: sectionsIn(r.sections, `Recommendation ${i + 1}`) } : {})
});
// A tip article (see lib/tips.js for the block types). Strict shape, plain text only: the app escapes everything.
const BLOCKS = ["text", "list", "groups", "table", "facts", "steps", "callout", "motto"];
const STYLES = ["bullet", "check", "cross", "box", "number"];
const TONES = ["important", "remember", "tip", "warning"];
const itemIn = (x, L) => {
  if (typeof x === "string") return str(x, L, { min: 1, max: 300 });
  if (!x || typeof x !== "object") fail(`${L} must be text.`);
  return { title: str(x.title, `${L} title`, { min: 1, max: 160 }), ...(x.detail ? { detail: str(x.detail, `${L} detail`, { max: 500 }) } : {}) };
};
const itemsIn = (v, L, max = 60) => { if (!Array.isArray(v) || v.length > max) fail(`${L}: up to ${max} items.`); return v.map((x, k) => itemIn(x, `${L} item ${k + 1}`)); };
function sectionsIn(v, label) {
  if (!Array.isArray(v) || v.length > 60) fail(`${label} article: up to 60 sections.`);
  return v.map((b, j) => {
    const L = `${label} section ${j + 1}`;
    if (!b || typeof b !== "object") fail(`${L} is missing.`);
    const o = { type: oneOf(b.type, BLOCKS, `${L} type`) };
    for (const [k, max] of [["heading", 160], ["title", 160], ["text", 2000], ["note", 600]]) if (b[k]) o[k] = str(b[k], `${L} ${k}`, { max });
    if (b.style) o.style = oneOf(b.style, STYLES, `${L} style`);
    if (b.tone) o.tone = oneOf(b.tone, TONES, `${L} tone`);
    if (b.items !== undefined) o.items = itemsIn(b.items, L);
    if (b.groups !== undefined) {
      if (!Array.isArray(b.groups) || b.groups.length > 12) fail(`${L}: up to 12 groups.`);
      o.groups = b.groups.map((g, k) => ({ title: str(g && g.title, `${L} group ${k + 1} title`, { max: 120 }),
        ...(g.note ? { note: str(g.note, `${L} group ${k + 1} note`, { max: 200 }) } : {}),
        ...(g.style ? { style: oneOf(g.style, STYLES, `${L} group ${k + 1} style`) } : {}),
        items: itemsIn(g.items || [], `${L} group ${k + 1}`) }));
    }
    if (b.columns !== undefined || b.rows !== undefined) {
      const cols = b.columns || [];
      if (!Array.isArray(cols) || cols.length > 8) fail(`${L}: up to 8 columns.`);
      if (!Array.isArray(b.rows) || b.rows.length > 60) fail(`${L}: up to 60 rows.`);
      o.columns = cols.map((c, k) => str(c, `${L} column ${k + 1}`, { max: 80 }));
      o.rows = b.rows.map((r, k) => { if (!Array.isArray(r) || r.length > 8) fail(`${L} row ${k + 1}: up to 8 cells.`); return r.map((c) => str(c, `${L} row ${k + 1}`, { max: 300 })); });
    }
    return o;
  });
}
const eventIn = (e, i) => ({
  id: slug(e.id, `Event ${i + 1} id`), title: str(e.title, `Event ${i + 1} title`, { min: 1, max: 120 }),
  date: str(e.date, `Event ${i + 1} date`, { min: 10, max: 10 }), time: str(e.time || "", `Event ${i + 1} time`, { max: 20 }),
  location: str(e.location || "", `Event ${i + 1} location`, { max: 200 }), description: str(e.description || "", `Event ${i + 1} description`, { max: 2000 }),
  link: url(e.link || "", `Event ${i + 1} link`), free: !!e.free
});
const driveId = (v, label) => {
  const s = str(v, label, { max: 300 });
  if (!s) return null;
  const m = s.match(/[-\w]{20,}/);
  if (!m) fail(`${label}: paste a Google Drive link or file id.`);
  return m[0];
};
const trackIn = (t, i) => {
  const L = `Track ${i + 1}`;
  if (!t || typeof t !== "object") fail(`${L} is missing.`);
  if (!Array.isArray(t.levels) || !t.levels.length || t.levels.length > 8) fail(`${L}: 1 to 8 levels.`);
  if (!Array.isArray(t.pts) || !t.pts.length || t.pts.length > 25) fail(`${L}: pick 1 to 25 muscles on the body map.`);
  return {
    id: slug(t.id, `${L} id`), title: str(t.title, `${L} title`, { min: 1, max: 120 }), region: str(t.region, `${L} region`, { min: 1, max: 40 }),
    img: list(t.img || [], `${L} images`, 6, (x, j) => driveId(x, `${L} image ${j + 1}`)).filter(Boolean),
    pts: t.pts.map((x) => slug(x, `${L} muscle`)), note: str(t.note, `${L} note`, { max: 300 }),
    levels: t.levels.map((l, j) => {
      if (!Array.isArray(l.videos) || !l.videos.length || l.videos.length > 15) fail(`${L} level ${j + 1}: 1 to 15 videos.`);
      return { title: str(l.title, `${L} level ${j + 1} title`, { min: 1, max: 100 }),
        videos: l.videos.map((v, k) => ({ name: str(v.name, `${L} video ${k + 1} name`, { min: 1, max: 100 }), id: driveId(v.id || "", `${L} video ${k + 1} link`), file: str(v.file || "", "File", { max: 100 }) })) };
    })
  };
};

function liveIn(b, prev) {
  const o = { ...prev };
  if (b.title !== undefined) o.title = str(b.title, "Live title", { min: 1, max: 120 });
  if (b.date !== undefined) { o.date = str(b.date, "Live date", { max: 10 }); if (o.date && !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) fail("Live date must be YYYY-MM-DD."); }
  if (b.time !== undefined) { o.time = str(b.time, "Live time", { max: 5 }); if (!/^\d{2}:\d{2}$/.test(o.time)) fail("Live time must be HH:MM."); }
  if (b.minutes !== undefined) o.minutes = int(b.minutes, "Live length", { min: 15, max: 240 });
  if (b.joinUrl !== undefined) o.joinUrl = url(b.joinUrl, "Join link");
  if (b.access !== undefined) o.access = oneOf(b.access, ACCESS, "Live access");
  if (b.notes !== undefined) o.notes = str(b.notes, "Live notes", { max: 1000 });
  if (b.recordings !== undefined) o.recordings = list(b.recordings, "Recordings", 60, (r, i) => ({ title: str(r.title, `Recording ${i + 1} title`, { min: 1, max: 120 }), date: str(r.date, "Date", { max: 10 }), url: url(r.url, `Recording ${i + 1} link`) }));
  return o;
}

// The programs members and Admin see: the saved list, or the built-in one. Shared with lib/clients (pin / assign
// checks) so a program shown in the app can always be saved or assigned.
// Saved tiers win, except that the old round prices ($20 / $30, Nov 2026) move to the owner's current $19.95 / $29.95
// without an admin having to re-save the content.
const OLD_PRICES = { member: 20, accountability: 30 };
// Tiers saved before Expert Advice existed (Nov 2026) get it, after Accountability, and a saved 1-on-1 tier (meetings)
// that never said whether it includes messaging does. An owner who later edits or removes Expert Advice keeps that
// (knownTiers records that it was offered).
function tiersOf(saved, d = defaultContent()) {
  if (!saved.tiers || !saved.tiers.length) return d.tiers;
  const out = saved.tiers.map((t) => {
    const x = OLD_PRICES[t.id] === t.price ? { ...t, price: (d.tiers.find((y) => y.id === t.id) || t).price } : { ...t };
    if (x.directMessages === undefined && x.meetings > 0) x.directMessages = true;
    return x;
  });
  const offered = new Set(saved.knownTiers || []);
  if (!out.some((t) => t.id === EXPERT_TIER.id) && !offered.has(EXPERT_TIER.id)) {
    const after = out.findIndex((t) => t.id === "accountability");
    out.splice(after >= 0 ? after + 1 : out.length, 0, { ...EXPERT_TIER, perks: [...EXPERT_TIER.perks] });
  }
  return out;
}

// What a viewer may open: 0 free, 1 member (any tier, or an active paid treatment plan), 2 premium (a tier with 1-on-1
// meetings, or an in-clinic patient: Dr. Jared's inpatient toggle opens the whole app). Shared with lib/guide.js.
const ACCESS_RANK = { free: 0, member: 1, premium: 2 };
function accessLevel(tiers, { membership = null, activePlan = false, inpatient = false } = {}) {
  if (inpatient) return 2;
  let lvl = 0;
  if (membership) { const t = (tiers || []).find((x) => x.id === membership.tier); lvl = t && t.meetings > 0 ? 2 : 1; }
  if (activePlan && lvl < 1) lvl = 1;
  return lvl;
}
function programsOf(saved, d = defaultContent()) {
  saved = saved || {};
  if (!saved.contentVersion || saved.contentVersion < 5) return d.programs;
  if (!Array.isArray(saved.programs)) return d.programs;
  // Admin-edited programs: still add built-in programs that are new since the last save (e.g. new protocols).
  // knownDefaults = built-in ids that existed when the admin last saved, so a program they removed stays removed.
  const known = new Set(saved.knownDefaults || saved.programs.map((p) => p.id));
  const have = new Set(saved.programs.map((p) => p.id));
  // A saved program without a poster takes the built-in one for the same id (posters added after the admin's last save)
  const art = new Map(d.programs.map((p) => [p.id, p.image]));
  return [...saved.programs.map((p) => (!p.image && art.get(p.id) ? { ...p, image: art.get(p.id) } : p)), ...d.programs.filter((p) => !known.has(p.id) && !have.has(p.id))];
}

// Health tips: stored tips (admin-saved before tip articles existed) get the built-in article and photo-ready text by id.
// A tip whose title / text still match the old built-in wording is moved to the corrected wording from the posters.
const OLD_TIP_TEXT = {
  "bath-accu-mat": ["Ice bath, acupressure mat & phototherapy protocol", "Cold exposure, acupressure and red-light therapy — how to use each tool and when to rotate them."],
  "fitness-erg": ["MD Fit fitness ErG protocol", "The energy-return-to-ground protocol: a structured approach to building functional strength from the ground up."],
  "mobility-diet-ratios": ["Mobility & diet ratios", "How your macronutrient ratios affect joint mobility, inflammation and tissue repair."],
  "psg-protocol": ["PSG protocol", "Dr. Jared's proprietary PSG recovery protocol for post-session recovery and inflammation management."],
  "weekly-tracking": ["Weekly tracking sheet", "Track your movement, sleep, nutrition and recovery scores each week to stay accountable."],
  "diet-health-shots": ["Diet & health shot protocol", "Dr. Jared's anti-inflammatory diet guide with daily health shot recipes for recovery and longevity."]
};
function recommendationsOf(saved, d = defaultContent()) {
  if (!saved || !Array.isArray(saved.recommendations)) return d.recommendations;
  const byId = new Map(d.recommendations.map((r) => [r.id, r]));
  return saved.recommendations.map((r) => {
    const def = byId.get(r.id);
    if (!def) return r;
    const old = OLD_TIP_TEXT[r.id] || [], out = { ...r };
    if (!Array.isArray(r.sections) || !r.sections.length) out.sections = def.sections;
    if (r.title === old[0]) out.title = def.title;
    if (r.body === old[1]) out.body = def.body;
    return out;
  });
}

function mountContent({ app, admin, store, me, clients, save, today, notify, activity, activePlan = () => false, isInpatient = (c) => !!(c && c.clientType === "inpatient") }) {
  // One-time refresh: when the admin hasn't customized programs yet, use the current defaults so the new
  // Dr. Jared programs ship live. Admin edits set contentVersion to opt out.
  const content = () => {
    const saved = store.read("content", {});
    const d = defaultContent();
    return { ...d, ...saved, programs: programsOf(saved, d), recommendations: recommendationsOf(saved, d), tiers: tiersOf(saved, d) };
  };
  const rank = ACCESS_RANK;
  // What a viewer may open (accessLevel above)
  const levelOf = (c, tiers) => {
    const m = c && c.membership && (!c.membership.until || c.membership.until >= today()) ? c.membership : null;
    return accessLevel(tiers, { membership: m, activePlan: activePlan(c), inpatient: isInpatient(c) });
  };
  const view = (c) => ({
    programs: c.programs.map((p) => ({ ...p, locked: false })),
    lectures: c.lectures.map((l) => ({ ...l, locked: false })),
    live: { ...c.live, locked: false },
    tiers: c.tiers, recommendations: c.recommendations, tracks: c.tracks, events: c.events || [], categories: PROGRAM_CATS, topics: LECTURE_TOPICS
  });

  app.get("/api/content", (req, res) => { res.set("Cache-Control", "no-cache"); res.json(view(content())); });
  me.get("/content", (req, res) => {
    const c = content(), lvl = levelOf(req.client, c.tiers);
    res.json({ ...view(c), access: ["free", "member", "premium"][lvl], membership: req.client.membership || null });
  });

  // Ask to join a tier (payments come later; Dr. Jared confirms and turns it on)
  me.post("/membership/request", (req, res) => {
    const c = content();
    const tier = c.tiers.find((t) => t.id === (req.body && req.body.tier));
    if (!tier) fail("Pick a membership.");
    const note = str(req.body.note, "Note", { max: 500 });
    const list = clients(); const cl = list.find((x) => x.id === req.client.id);
    // Review rewards were retired (owner, Nov 2026): a pasted code is ignored and no discount is attached
    const discount = null;
    cl.membershipRequest = { tier: tier.id, note, at: new Date().toISOString() };
    save(list);
    activity("membership_request", { email: cl.email, tier: tier.id, name: cl.name });
    notify.owner(`Membership request: ${tier.name} ($${tier.price}/mo)`, `${cl.name} <${cl.email}> ${cl.phone || ""}\nwants ${tier.name}.${discount ? `\nReview reward: ${discount.pct}% off the first month (code ${discount.code}), first month $${Math.round(tier.price * (100 - discount.pct)) / 100}.` : ""}\n${note || ""}\n\nTurn it on in Admin → Members.`);
    res.status(201).json({ ok: true, request: cl.membershipRequest });
  });

  // 1-on-1 remote meetings for premium tiers, limited per calendar month
  const month = () => today().slice(0, 7);
  const allowance = (cl, c) => { const t = c.tiers.find((x) => x.id === (cl.membership && cl.membership.tier)); return levelOf(cl, c.tiers) === 2 ? t : null; };
  me.get("/meetings", (req, res) => {
    const c = content(), t = allowance(req.client, c);
    const mine = req.client.meetings || [];
    res.json({ meetings: [...mine].reverse(), allowance: t ? t.meetings : 0, minutes: t ? t.meetingMinutes : 0, usedThisMonth: mine.filter((m) => m.month === month() && m.status !== "cancelled").length });
  });
  me.post("/meetings", (req, res) => {
    const c = content(), list = clients(), cl = list.find((x) => x.id === req.client.id), t = allowance(cl, c);
    if (!t) return res.status(403).json({ error: "1-on-1 meetings come with a Premium membership." });
    const used = (cl.meetings || []).filter((m) => m.month === month() && m.status !== "cancelled").length;
    if (used >= t.meetings) return res.status(409).json({ error: `You've used all ${t.meetings} of this month's sessions. They reset on the 1st.` });
    const b = req.body || {};
    const m = { id: crypto.randomBytes(6).toString("hex"), month: month(), topic: str(b.topic, "What you want to work on", { min: 3, max: 500 }),
      times: str(b.times, "Times that work for you", { min: 3, max: 300 }), status: "requested", when: "", link: "", minutes: t.meetingMinutes, createdAt: new Date().toISOString() };
    cl.meetings = [...(cl.meetings || []), m].slice(-200);
    save(list);
    activity("meeting_request", { email: cl.email, name: cl.name });
    notify.owner(`1-on-1 request from ${cl.name}`, `${cl.name} <${cl.email}> (${t.name})\n\nTopic: ${m.topic}\nTimes: ${m.times}\n\nSchedule it in Admin → Members.`);
    res.status(201).json(m);
  });

  // ---- Admin
  // The option lists ride along so an editing screen offers exactly what the server accepts
  admin.get("/content", (req, res) => res.json({ ...content(), options: { categories: PROGRAM_CATS, levels: LEVELS, locations: LOCS, goals: GOALS, access: ACCESS, topics: LECTURE_TOPICS } }));
  admin.put("/content", (req, res) => {
    const b = req.body || {}, c = content(), next = store.read("content", {});
    if (b.programs !== undefined) next.programs = list(b.programs, "Programs", 40, programIn);
    if (b.lectures !== undefined) next.lectures = list(b.lectures, "Lectures", 200, lectureIn);
    // knownTiers: the built-in tiers the owner has seen, so Expert Advice removed here stays removed (tiersOf)
    if (b.tiers !== undefined) { next.tiers = list(b.tiers, "Membership tiers", 8, tierIn); next.knownTiers = [EXPERT_TIER.id]; }
    if (b.recommendations !== undefined) next.recommendations = list(b.recommendations, "Recommendations", 100, recIn);
    if (b.live !== undefined) next.live = liveIn(b.live || {}, c.live);
    if (b.tracks !== undefined) next.tracks = list(b.tracks, "Pain tracks", 80, trackIn);
    if (b.events !== undefined) next.events = list(b.events, "Events", 50, eventIn);
    // knownDefaults: built-in programs that exist now, so a later new built-in is added but one removed here stays removed
    store.write("content", { ...next, contentVersion: 5, knownDefaults: defaultContent().programs.map((p) => p.id) });
    res.json(content());
  });
  admin.get("/members", (req, res) => {
    const c = content();
    res.json(clients().filter((x) => x.membership || x.membershipRequest || (x.meetings || []).length).map((x) => ({
      id: x.id, name: x.name, email: x.email, phone: x.phone, membership: x.membership || null, request: x.membershipRequest || null,
      tier: (c.tiers.find((t) => x.membership && t.id === x.membership.tier) || {}).name || "", meetings: [...(x.meetings || [])].reverse()
    })));
  });
  admin.put("/clients/:id/membership", (req, res) => {
    const list = clients(), cl = list.find((x) => x.id === req.params.id);
    if (!cl) return res.status(404).json({ error: "Client not found." });
    const b = req.body || {};
    if (!b.tier) { cl.membership = null; }
    else {
      if (!content().tiers.some((t) => t.id === b.tier)) fail("Unknown membership tier.");
      const until = str(b.until, "Paid through", { max: 10 });
      if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail("Paid through must be YYYY-MM-DD.");
      // Keep what else is on the membership (Stripe subscription id/status, first-month discount): without the
      // subscription id a later Stripe cancel can't end it and the accountability credit stops applying
      cl.membership = { ...(cl.membership || {}), tier: b.tier, since: (cl.membership && cl.membership.since) || today(), until };
      const rq = cl.membershipRequest;
      if (rq && rq.tier === b.tier) delete cl.membershipRequest;
    }
    save(list);
    res.json({ membership: cl.membership });
  });
  admin.patch("/clients/:id/meetings/:mid", (req, res) => {
    const list = clients(), cl = list.find((x) => x.id === req.params.id);
    const m = cl && (cl.meetings || []).find((x) => x.id === req.params.mid);
    if (!m) return res.status(404).json({ error: "Meeting not found." });
    const b = req.body || {};
    if (b.status !== undefined) m.status = oneOf(b.status, ["requested", "scheduled", "done", "cancelled"], "Status");
    if (b.when !== undefined) m.when = str(b.when, "When", { max: 80 });
    if (b.link !== undefined) m.link = url(b.link, "Meeting link");
    save(list);
    if (m.status === "scheduled" && m.when) { const push = app.get("push"); if (push) push.toClient(cl.id, { title: "Your 1-on-1 is scheduled", body: `${m.when}${m.link ? ". The link is in your account." : ""}`, route: "home" }); }
    if (m.status === "scheduled" && m.when) notify.client(cl.email, "Your 1-on-1 with Dr. Jared is scheduled", `Hi ${cl.name.split(" ")[0]},\n\nYour session is set for ${m.when}.${m.link ? `\nJoin here: ${m.link}` : ""}\n\nMD Fit`);
    res.json(m);
  });
}

module.exports = { mountContent, defaultContent, programsOf, recommendationsOf, tiersOf, accessLevel, ACCESS_RANK, EXPERT_TIER, PROGRAM_CATS, LECTURE_TOPICS };
