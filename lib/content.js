// Member content: premade programs, lectures, monthly live Q&A, membership tiers with 1-on-1 meetings, health recommendations.
// Everything is admin-editable; links to members-only content are only sent to members.
"use strict";
const crypto = require("crypto");
const { ValidationError } = require("./validate");

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

const day = (name, goal, length, extra = {}) => ({ name, goal, length, ...extra });
function defaultContent() {
  return {
    programs: [
      // ----- Dr. Jared's programs. Covered on the homepage and in the client app's Programs tab.
      { id: "hypertrophy-12", title: "PSG — State of Perpetual Growth", category: "Hypertrophy", level: "intermediate", location: "gym", weeks: 12, seed: 1001, access: "member",
        summary: "A continuous progression program for strength, size and mobility. 7-day repeating cycle: two upper-body days, two lower-body days, two full-body mobility days and one rest day. Long workout days are break cycles — rare and far apart. Quality over frequency.",
        notes: "Long Workout Days are BREAK CYCLES — rare and far apart. Short days: reduce weight by minimum 20%, ideally 30-40%. Key principles: full range of motion, controlled tempo, deep stretches, mind-muscle connection, consistency over intensity. Nutrition: 40% protein, 30% fat, 30% carbs. Supplements: whey protein, creatine monohydrate, omega-3, vitamin D3+K2, magnesium. Cold exposure: ice baths 2-3 min, cold showers 2-5 min.",
        image: "assets/programs/hypertrophy-new.png",
        days: [
          day("Upper Body — Long (Break Cycle)", "upper", 60, { rounds: 5, restEx: 60, restRound: 120, circuit: [
            { ex: "Overhead Press (DB)", sets: "50,40,30,20,10 reps (do NOT come back up)" },
            { ex: "Dumbbell Bench Press", sets: "50,40,30,20,10,20,30,40,50 reps" },
            { ex: "Lat Pull-Down", sets: "50,40,30,20,10,20,30,40,50 reps" }
          ] }),
          day("Lower Body — Long (Break Cycle)", "lower", 60, { rounds: 5, restEx: 60, restRound: 120, circuit: [
            { ex: "Bulgarian Split Squat", sets: "50,40,30,20,10 reps (do NOT come back up)" },
            { ex: "Romanian Deadlift", sets: "50,40,30,20,10 reps (do NOT come back up)" },
            { ex: "GHD or BOSU Sit-Ups", sets: "Max reps at heaviest controlled weight" }
          ] }),
          day("Full Body Mobility", "full", 30, { rounds: 5, restEx: 15, restRound: 60, circuit: [
            { ex: "TRX Body Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "10 reps each leg" },
            { ex: "Cossack Squat", sets: "10 reps each side" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ] }),
          day("Upper Body — Short", "upper", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Overhead Press (DB)", sets: "Light weight, 30-40% less" },
            { ex: "Dumbbell Bench Press", sets: "Light weight, 30-40% less" },
            { ex: "Lat Pull-Down", sets: "Light weight, 30-40% less" }
          ] }),
          day("Lower Body — Short", "lower", 45, { rounds: 4, restEx: 30, restRound: 90, circuit: [
            { ex: "Bulgarian Split Squat", sets: "Light weight, 30-40% less" },
            { ex: "Romanian Deadlift", sets: "Light weight, 30-40% less" },
            { ex: "GHD or BOSU Sit-Ups", sets: "Light weight, controlled" }
          ] }),
          day("Full Body Mobility", "full", 30, { rounds: 5, restEx: 15, restRound: 60, circuit: [
            { ex: "TRX Body Squat", sets: "10 reps" },
            { ex: "Pole Squat", sets: "10 reps" },
            { ex: "Burpee", sets: "10 reps" },
            { ex: "Pistol Squat", sets: "10 reps each leg" },
            { ex: "Cossack Squat", sets: "10 reps each side" },
            { ex: "Bear Crawl", sets: "4 reps x 20 ft" }
          ] }),
          day("Rest or Active Recovery", "mobility", 20)
        ] },
      { id: "dream-lean-12", title: "12-Week Dream Lean", category: "Weight loss", level: "intermediate", location: "gym", weeks: 12, seed: 1002, access: "member",
        summary: "STRONG · FUNCTIONAL · CONFIDENT. The complete system for a lean, toned and powerful you. 7-day training split with strength training 4-6 days per week, daily movement reset, health shots, ice bath protocol and acupressure mat recovery.",
        notes: "Daily Movement Reset (10-15 min): 90/90 Breathing, Couch Stretch, Thoracic Open Books, Glute Bridge Hold, Dead Bugs, Split Squat Hold, Wall Posture, Deep Squat Hold, Child's Pose with Reach. Take the MD Fit Health Shot daily on an empty stomach. Ice bath 2-4x/week (50-58°F, 2-5 min). Acupressure mat 10-20 min nightly. Nutrition: protein first (30-40g per meal), eat whole real foods, prioritize quality carbs around workouts, stay hydrated. Supplements: Magnesium Glycinate, Omega-3 Fish Oil, Vitamin D3 + K2, Creatine Monohydrate, Curcumin + Black Pepper Extract, Ashwagandha, Probiotic, Glycine. Sleep 7-9 hours. Focus on good form, progressive overload.",
        image: "assets/programs/dream-lean-new.png",
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
      { id: "mobility-ladder", title: "Mobility Ladder", category: "Mobility", level: "intermediate", location: "home", weeks: 5, seed: 1006, access: "member",
        summary: "Dr. Jared's mobility ladder. Same six movements each round. Get as many rounds as you can in under 30 minutes. When you can fit another round in under 30 minutes, add another round. When you can take levels of assistance away, take them away. Increase your depth, not your reps.",
        notes: "Do NOT add reps to any movement — keep the rep count the same every time. The progression is depth and removing assistance: go deeper on the Cossack, less wall help on the pistol, fuller range on the squat. When you can fit another round in under 30 minutes, add a round. Form before everything.",
        image: "assets/programs/mobility-ladder-new.png",
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
      { id: "golf", title: "Golf Performance", category: "Sport Performance", level: "beginner", location: "home", weeks: 6, seed: 1008, access: "member",
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
      { id: "pickleball", title: "Pickleball Performance", category: "Sport Performance", level: "beginner", location: "home", weeks: 6, seed: 1009, access: "member",
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
      { id: "running", title: "Running Performance", category: "Sport Performance", level: "intermediate", location: "home", weeks: 6, seed: 1010, access: "member",
        summary: "Hip strength, calf and foot work, and single-leg stability to run faster with fewer injuries. 3 sessions a week to pair with your runs.",
        notes: "These are the strength and mobility days: do them on your easy-run days or on rest days. Your long run is your long run.",
        image: "assets/programs/running-new.png",
        days: [day("Hip & glute strength", "lower", 30, { rounds: 3, restEx: 20, restRound: 60 }), day("Calf, foot & ankle", "lower", 20, { rounds: 2 }), day("Mobility & core", "mobility", 20)] },
      { id: "marathon", title: "Marathon Prep", category: "Sport Performance", level: "advanced", location: "home", weeks: 12, seed: 1011, access: "member",
        summary: "A 12-week strength-and-mobility block to carry you through marathon training without breaking down. 4 sessions a week built around your run calendar.",
        notes: "Pair with your running plan. Deload every 4 weeks: cut rounds in half the week before a long effort.",
        image: "assets/programs/marathon-new.png",
        days: [day("Hip & glute strength", "lower", 30, { rounds: 3, restEx: 20, restRound: 60 }), day("Core & spine", "core", 25, { rounds: 3 }), day("Calf, foot & ankle", "lower", 20, { rounds: 2 }), day("Mobility & recovery", "mobility", 25)] }
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
      { id: "member", name: "Accountability Membership", price: 19.95, meetings: 0, meetingMinutes: 0, perks: ["Every premade program", "Full lecture library", "Monthly live Q&A with Dr. Jared", "Progress tracking and workout comparisons", "Log 20 days of activity and your month is free"] },
      { id: "premium", name: "Premium 1-on-1", price: 200, meetings: 2, meetingMinutes: 30, perks: ["Everything in Member", "2 scheduled 30-minute remote sessions with Dr. Jared every month", "Text Dr. Jared directly with questions", "Custom program built for you", "Guided website and app walkthrough"] },
      { id: "premium-plus", name: "Premium Plus", price: 349, meetings: 4, meetingMinutes: 30, perks: ["Everything in Premium", "4 scheduled 30-minute remote sessions every month", "Priority scheduling"] }
    ],
    // Pain tracks: empty = use the built-in tracks transcribed from Dr. Jared's Drive (frontend/paintracks.js)
    tracks: [],
    recommendations: [
      { id: "diet-health-shots", area: "Nutrition", title: "Diet & health shot protocol", body: "Dr. Jared's anti-inflammatory diet guide with daily health shot recipes for recovery and longevity.", image: "1P-5bng8Pg3Yatz5jE-KOWDfTDBWgh5Hu", link: "" },
      { id: "bath-accu-mat", area: "Recovery", title: "Ice bath, acupressure mat & phototherapy protocol", body: "Cold exposure, acupressure and red-light therapy — how to use each tool and when to rotate them.", image: "1B0oS274__c5NPLssp7G_L3ZRoZzvwnnS", link: "" },
      { id: "fitness-erg", area: "Fitness", title: "MD Fit fitness ErG protocol", body: "The energy-return-to-ground protocol: a structured approach to building functional strength from the ground up.", image: "1sXFDNW1EMGcgW7SolVisACsZymIvj4hB", link: "" },
      { id: "mobility-diet-ratios", area: "Nutrition", title: "Mobility & diet ratios", body: "How your macronutrient ratios affect joint mobility, inflammation and tissue repair.", image: "1vdRtw2VUrov0HLopkZAtgVuKs_QOtwU9", link: "" },
      { id: "psg-protocol", area: "Recovery", title: "PSG protocol", body: "Dr. Jared's proprietary PSG recovery protocol for post-session recovery and inflammation management.", image: "1Nigi9UOTm14KAzHS6hOb9KQKEOXVH-Xs", link: "" },
      { id: "weekly-tracking", area: "Wellness", title: "Weekly tracking sheet", body: "Track your movement, sleep, nutrition and recovery scores each week to stay accountable.", image: "1v7JgO21TdrdsSOCba0Y9vvuO1mdpOgfL", link: "" }
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
    ...(p.sport ? { sport: str(p.sport, `${L} sport`, { min: 1, max: 30 }) } : {}),
    days: p.days.map((d, j) => ({
      name: str(d.name, `${L} day ${j + 1} name`, { min: 1, max: 40 }), goal: oneOf(d.goal, GOALS, `${L} day ${j + 1} focus`),
      length: oneOf(Number(d.length), [15, 20, 30, 45, 60, 90], `${L} day ${j + 1} length`),
      ...(d.rounds !== undefined ? { rounds: int(d.rounds, "Rounds", { min: 1, max: 10 }) } : {}),
      ...(d.restEx !== undefined ? { restEx: int(d.restEx, "Rest between exercises", { min: 0, max: 180 }) } : {}),
      ...(d.restRound !== undefined ? { restRound: int(d.restRound, "Rest between rounds", { min: 0, max: 300 }) } : {}),
      ...(d.seedOffset !== undefined ? { seedOffset: int(d.seedOffset, "Seed offset", { min: 0, max: 9999 }) } : {}),
      ...(Array.isArray(d.circuit) ? { circuit: d.circuit.slice(0, 20).map((x, k) => ({
        ex: str(x.ex, `Day ${j + 1} exercise ${k + 1}`, { min: 1, max: 80 }),
        sets: str(x.sets || "", `Day ${j + 1} exercise ${k + 1} sets`, { max: 40 })
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
  id: slug(t.id, `Tier ${i + 1} id`), name: str(t.name, `Tier ${i + 1} name`, { min: 1, max: 60 }), price: int(t.price, `Tier ${i + 1} price`, { min: 0, max: 20000 }),
  meetings: int(t.meetings ?? 0, `Tier ${i + 1} meetings per month`, { min: 0, max: 31 }), meetingMinutes: int(t.meetingMinutes ?? 0, `Tier ${i + 1} meeting length`, { min: 0, max: 180 }),
  perks: list(t.perks || [], `Tier ${i + 1} perks`, 10, (x, j) => str(x, `Perk ${j + 1}`, { min: 1, max: 120 }))
});
const recIn = (r, i) => ({
  id: slug(r.id, `Recommendation ${i + 1} id`), area: str(r.area, `Recommendation ${i + 1} area`, { min: 1, max: 40 }),
  title: str(r.title, `Recommendation ${i + 1} title`, { min: 1, max: 120 }), body: str(r.body, `Recommendation ${i + 1} text`, { min: 1, max: 2000 }),
  image: str(r.image || "", `Recommendation ${i + 1} image`, { max: 500 }),
  link: url(r.link, `Recommendation ${i + 1} link`)
});
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

function mountContent({ app, admin, store, me, clients, save, today, notify, activity }) {
  // One-time refresh: when the admin hasn't customized programs yet, use the current defaults so the new
  // Dr. Jared programs ship live. Admin edits set contentVersion to opt out.
  const content = () => {
    const saved = store.read("content", {});
    const d = defaultContent();
    if (!saved.contentVersion || saved.contentVersion < 5) {
      saved.programs = d.programs;
    }
    return { ...d, ...saved };
  };
  const rank = { free: 0, member: 1, premium: 2 };
  // What a viewer may open: free for everyone, member for any tier, premium for tiers with 1-on-1 meetings
  const levelOf = (c, tiers) => {
    const m = c && c.membership && (!c.membership.until || c.membership.until >= today()) ? c.membership : null;
    if (!m) return 0;
    const t = tiers.find((x) => x.id === m.tier);
    return t && t.meetings > 0 ? 2 : 1;
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
    // Review reward: a percentage off the first month
    let discount = null;
    const code = String(req.body.rewardCode || cl.reviewCode || "").trim().toUpperCase();
    if (code) {
      const fb = store.read("feedback", []).find((f) => f.rewardCode === code);
      if (!fb) { if (req.body.rewardCode) fail("That review code isn't valid."); }
      else if (fb.rewardUsedAt) { if (req.body.rewardCode) fail("That review code has already been used."); }
      else discount = { code, pct: fb.rewardPct ?? 30 };
    }
    cl.membershipRequest = { tier: tier.id, note, at: new Date().toISOString(), ...(discount ? { rewardCode: discount.code, discountPct: discount.pct } : {}) };
    save(list);
    activity("membership_request", { email: cl.email, tier: tier.id });
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
    activity("meeting_request", { email: cl.email });
    notify.owner(`1-on-1 request from ${cl.name}`, `${cl.name} <${cl.email}> (${t.name})\n\nTopic: ${m.topic}\nTimes: ${m.times}\n\nSchedule it in Admin → Members.`);
    res.status(201).json(m);
  });

  // ---- Admin
  admin.get("/content", (req, res) => res.json(content()));
  admin.put("/content", (req, res) => {
    const b = req.body || {}, c = content(), next = store.read("content", {});
    if (b.programs !== undefined) next.programs = list(b.programs, "Programs", 40, programIn);
    if (b.lectures !== undefined) next.lectures = list(b.lectures, "Lectures", 200, lectureIn);
    if (b.tiers !== undefined) next.tiers = list(b.tiers, "Membership tiers", 6, tierIn);
    if (b.recommendations !== undefined) next.recommendations = list(b.recommendations, "Recommendations", 100, recIn);
    if (b.live !== undefined) next.live = liveIn(b.live || {}, c.live);
    if (b.tracks !== undefined) next.tracks = list(b.tracks, "Pain tracks", 80, trackIn);
    if (b.events !== undefined) next.events = list(b.events, "Events", 50, eventIn);
    store.write("content", { ...next, contentVersion: 5 });
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
      cl.membership = { tier: b.tier, since: (cl.membership && cl.membership.since) || today(), until };
      const rq = cl.membershipRequest;
      if (rq && rq.rewardCode) {
        const fbl = store.read("feedback", []), fb = fbl.find((f) => f.rewardCode === rq.rewardCode);
        if (fb && !fb.rewardUsedAt) { fb.rewardUsedAt = new Date().toISOString(); store.write("feedback", fbl); }
        cl.membership.firstMonthDiscountPct = rq.discountPct;
      }
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
    if (m.status === "scheduled" && m.when) notify.client(cl.email, "Your 1-on-1 with Dr. Jared is scheduled", `Hi ${cl.name.split(" ")[0]},\n\nYour session is set for ${m.when}.${m.link ? `\nJoin here: ${m.link}` : ""}\n\nMD Fit`);
    res.json(m);
  });
}

module.exports = { mountContent, defaultContent, PROGRAM_CATS, LECTURE_TOPICS };
