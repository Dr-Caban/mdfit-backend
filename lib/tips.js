// Health Tips articles: the text of Dr. Jared's protocol posters (Google Drive images), transcribed so the member
// app can show them as readable, native articles. The original poster stays on each recommendation as `image`.
//
// A tip's `sections` is a list of blocks. Every block may have `heading` (h2), `text` (a paragraph under the heading)
// and `note` (small print after it). Block types:
//   text     – heading + paragraph
//   list     – items (strings or { title, detail }), style: bullet | check | cross | box | number
//   groups   – side-by-side cards: groups: [{ title, note, style, items }]  (food lists, do / avoid, training days)
//   table    – columns: [..], rows: [[..]]                                    (ingredients, macros, rep schemes)
//   facts    – big-number tiles: items: [{ title, detail }]                   (2–3 min daily, 50–58°F)
//   steps    – numbered steps: items: [{ title, detail }]                     (movements, daily serving)
//   callout  – tone: important | remember | tip | warning, with text and optional check items
//   motto    – a closing line, set large in gold
const T = {};

// ---- Dream Lean page 17 + 18: Dietary restrictions & food guidelines / Health shot protocol
T["diet-health-shots"] = [
  { type: "text", heading: "The goal", text: "The purpose of Dream Lean is to reduce inflammation, improve digestion, optimize hormone function, support recovery, and improve body composition." },
  { type: "callout", tone: "tip", title: "Focus", text: "Focus on whole foods that are easy to digest, minimally processed, and support consistent energy." },
  { type: "groups", heading: "Priority protein sources", groups: [
    { title: "Lean meats", style: "bullet", items: ["Chicken breast", "Turkey breast", "Lean ground turkey", "Lean ground beef", "Bison", "Venison", "Pork tenderloin", "Top sirloin", "London broil", "Eye of round steak"] },
    { title: "Fish & seafood", style: "bullet", items: ["Salmon", "Tuna", "Mahi mahi", "Cod", "Halibut", "Grouper", "Shrimp", "Scallops", "Crab", "Lobster"] },
    { title: "Eggs", style: "bullet", items: ["Whole eggs", "Egg whites"] }
  ] },
  { type: "groups", heading: "Healthy fat sources", groups: [
    { title: "Preferred fats", style: "bullet", items: ["Avocados", "Olive oil", "Avocado oil", "Coconut oil", "Olives"] },
    { title: "Nut butters", style: "bullet", items: ["Peanut butter", "Cashew butter", "Almond butter", "Macadamia nut butter", "Sunflower seed butter"] },
    { title: "Nuts", style: "bullet", items: ["Almonds", "Cashews", "Macadamias", "Pecans", "Walnuts"] }
  ] },
  { type: "groups", heading: "Preferred carbohydrate sources", groups: [
    { title: "Non-fibrous fruits", style: "bullet", items: ["Bananas", "Melons", "Watermelon", "Cantaloupe", "Honeydew", "Mango", "Pineapple", "Papaya", "Peaches", "Nectarines", "Oranges", "Mandarin oranges", "Grapefruit", "Ripe pears", "Apples (if tolerated)"] },
    { title: "Other preferred carbs", style: "bullet", items: ["White rice", "Jasmine rice", "Basmati rice", "Potatoes", "Sweet potatoes", "Rice cakes", "Gluten-free oats (if tolerated)"] }
  ] },
  { type: "groups", heading: "Limit or avoid", groups: [
    { title: "Gluten sources", style: "cross", items: ["Wheat", "Barley", "Rye", "Most breads", "Traditional pasta", "Many processed snack foods"] },
    { title: "Dairy sources", note: "Especially if sensitive", style: "cross", items: ["Milk", "Ice cream", "Soft cheeses", "Cream sauces", "Whey products (if not tolerated)"] },
    { title: "Highly processed foods", style: "cross", items: ["Fast food", "Fried foods", "Packaged snack foods", "Sugary cereals", "Candy", "Soda", "Energy drinks", "Artificially flavored foods"] }
  ] },
  { type: "groups", heading: "Cruciferous vegetables to limit", text: "These foods are healthy but commonly create bloating, gas, and digestive discomfort in sensitive individuals.", groups: [
    { title: "Limit", style: "cross", items: ["Broccoli", "Broccolini", "Kale", "Brussels sprouts", "Cabbage", "Cauliflower", "Bok choy", "Collard greens", "Mustard greens", "Turnips", "Rutabaga", "Kohlrabi", "Radishes", "Arugula"] },
    { title: "Better tolerated alternatives", style: "check", items: ["Cucumbers", "Zucchini", "Yellow squash", "Carrots", "Bell peppers", "Lettuce", "Spinach", "Green beans", "Mushrooms"] }
  ] },
  { type: "list", heading: "Daily rules", style: "check", items: ["Protein at every meal", "Stay hydrated", "Eat whole foods", "Minimize processed foods", "Prioritize digestion over perfection", "Consistency beats intensity"] },
  { type: "motto", text: "Good food. Better habits. Best you." },

  { type: "text", heading: "Health shot protocol", text: "Daily health shot recipe, 1 liter batch preparation. Prepare once and refrigerate for the week." },
  { type: "table", heading: "Ingredients for 1 liter: base liquids", columns: ["Ingredient", "Amount"], rows: [["Filtered water", "500 mL"], ["Lemon juice", "350 mL"], ["Apple cider vinegar", "150 mL"]] },
  { type: "table", heading: "Functional ingredients", columns: ["Ingredient", "Amount"], rows: [["Turmeric powder", "8 tsp"], ["Black pepper", "2 tsp"], ["Habanero powder", "1 tsp"], ["Himalayan pink salt", "2 tsp"]] },
  { type: "callout", tone: "important", title: "Do not add the oil to the liter batch", text: "Olive oil will solidify and separate when refrigerated. Adding oil to the batch will make the health shot unappealing and difficult to mix. Instead:",
    items: ["Store the prepared liter without oil", "Add olive oil immediately before drinking", "Shake thoroughly before consuming"] },
  { type: "steps", heading: "Daily serving: every morning", items: [
    { title: "Pour", detail: "60 mL (2 oz) health shot mixture." },
    { title: "Then add", detail: "1 teaspoon extra virgin olive oil." },
    { title: "Shake or stir thoroughly." },
    { title: "Consume on an empty stomach." }
  ] },
  { type: "table", heading: "Optional adjustments", columns: ["If it's…", "Do this"], rows: [["Too strong?", "Add water."], ["Too spicy?", "Reduce habanero."], ["Too acidic?", "Reduce vinegar slightly and increase water."]] },
  { type: "list", heading: "Expected benefits", style: "check", items: ["Digestive support", "Improved hydration", "Improved electrolyte balance", "Anti-inflammatory support", "Increased morning alertness", "Improved consistency with healthy habits"] },
  { type: "list", heading: "Health shot rules", style: "check", items: ["Take daily", "Take before breakfast", "Shake before every serving", "Add olive oil immediately before drinking", "Track compliance throughout the study", "Consistency is more important than perfection"] },
  { type: "motto", text: "A small shot today creates a better tomorrow." }
];

// ---- Bath · Photo · Mat protocol (progress photos, acupressure mat, ice bath)
T["bath-accu-mat"] = [
  { type: "text", heading: "Consistency creates reliable data", text: "The purpose of Dream Lean is not simply to create change. The purpose is to accurately measure change. Small differences in clothing, lighting, camera angle, posture, and timing can make meaningful changes difficult to evaluate. Follow these standards exactly whenever possible." },

  { type: "list", heading: "Photo protocol: required photo sessions", style: "box", items: ["Baseline (Week 0)", "Week 4", "Week 8", "Week 12"] },
  { type: "list", heading: "Full body photos required", style: "bullet", items: ["Front view", "Side view (left OR right: choose one and use the same side every time)", "Back view"] },
  { type: "callout", tone: "important", title: "Important", text: "The entire body must be visible from head to feet in every photo." },
  { type: "groups", heading: "Clothing", note: "Black clothing often hides definition and makes comparison difficult.", groups: [
    { title: "Preferred", style: "check", items: ["Fitted athletic clothing", "Solid colors", "Sports bra / athletic top", "Shorts", "Same outfit each session"] },
    { title: "Avoid", style: "cross", items: ["Black clothing", "Baggy clothing", "Hoodies", "Loose shirts", "Clothing that hides body contours"] }
  ] },
  { type: "list", heading: "Camera setup", style: "check", items: ["Camera lens at chest height", "Use tripod whenever possible", "Same camera height every session", "Same camera settings every session", "Use timer or remote shutter"] },
  { type: "steps", heading: "Distance markers", text: "Place permanent tape markers on the floor.", items: [
    { title: "A · Participant position", detail: "Stand on floor marker A every session." },
    { title: "B · Camera position", detail: "Camera / tripod on floor marker B every session." }
  ] },
  { type: "facts", heading: "Recommended distances", items: [{ title: "8 feet", detail: "Between participant and camera" }, { title: "3 feet", detail: "Between participant and wall" }] },
  { type: "groups", heading: "Lighting", groups: [
    { title: "Preferred", style: "bullet", items: ["Natural lighting OR consistent indoor lighting"] },
    { title: "Always", style: "check", items: ["Same room", "Same location", "Same time of day"] },
    { title: "Avoid", style: "cross", items: ["Flash photography", "Shadows", "Mixed lighting", "Different rooms"] }
  ] },
  { type: "groups", heading: "Posture", note: "The goal is honest data. No posing. No flexing.", groups: [
    { title: "Do", style: "check", items: ["Stand naturally", "Relax shoulders", "Look straight ahead", "Arms relaxed at sides", "Feet shoulder width apart"] },
    { title: "Do not", style: "cross", items: ["Flex", "Suck in stomach", "Pose", "Twist", "Change posture intentionally"] }
  ] },

  { type: "facts", heading: "Acupressure mat protocol", text: "Focus: relaxation · recovery · stress reduction · body awareness.", items: [{ title: "20 minutes", detail: "Goal, daily" }] },
  { type: "callout", tone: "tip", title: "You can do 20 minutes in week 1", text: "If you are able to do 20 minutes right away, that is completely fine." },
  { type: "list", heading: "Week 1 starting point", style: "bullet", items: ["Soft surface", "Thin shirt", "5–20 minutes"], note: "If you are comfortable completing 20 minutes immediately, that is completely acceptable. The progression is designed for comfort, not restriction." },
  { type: "steps", heading: "Goal progression", items: [
    { title: "Stage 1", detail: "Soft surface · Thin shirt · Up to 20 minutes" },
    { title: "Stage 2", detail: "Hard surface OR no shirt · Up to 20 minutes" },
    { title: "Stage 3", detail: "Hard surface + no shirt · Up to 20 minutes" }
  ] },
  { type: "callout", tone: "remember", title: "The goal is not discomfort", text: "The goal is relaxation. Relax your body on every exhale and allow it to sink into the mat." },
  { type: "motto", text: "Listen to your body. Breathe. Relax. Reset." },

  { type: "facts", heading: "Ice bath protocol", items: [{ title: "2–3 minutes", detail: "Goal, daily" }, { title: "Cold enough", detail: "To create a meaningful adaptation while maintaining safety" }] },
  { type: "list", heading: "Ice bath rules", style: "check", items: ["Focus on slow nasal breathing", "Stay relaxed", "Control the urge to tense up", "Enter gradually", "Exit under control"] },
  { type: "list", heading: "Daily tracking rule", text: "Target: 2–3 minutes. If you exceed 3 minutes, record the exact exposure time. Examples:", style: "box", items: ["3:15", "4:00", "5:00", "6:00+", "Other"],
    note: "Tracking longer exposures will allow us to correlate ice exposure time with outcomes during analysis." },
  { type: "callout", tone: "remember", title: "Remember", text: "Cold is a tool. Breathing is your power. Discomfort is temporary. Results are permanent." },

  { type: "list", heading: "Study data quality checklist", style: "check", items: ["Same clothing", "Same lighting", "Same location", "Same camera height", "Same camera distance", "Full body visible (head to feet)", "Same side photographed (every time)", "Similar time of day"], note: "Consistent today. Comparable results tomorrow." },
  { type: "callout", tone: "tip", title: "Dream Lean reminder", text: "The more standardized your habits and measurements become, the more valuable your results become.", items: ["Consistency", "Compliance", "Accurate tracking", "Honest reporting"] }
];

// ---- Dream Lean one-page overview (training, recovery, nutrition)
T["fitness-erg"] = [
  { type: "text", heading: "Strong · Functional · Confident", text: "The complete system for a lean, toned & powerful you." },
  { type: "list", heading: "The six pillars", style: "check", items: ["Hormone optimization (BHRT)", "Strength training & movement", "Stress management & recovery", "Ice baths & acupressure mat", "Clean nutrition & health shots", "Mindset, sleep & confidence"],
    note: "Your best starts here: consistency, discipline, self-love, transformation." },
  { type: "table", heading: "The MD Fit health shot", text: "Take daily on an empty stomach.", columns: ["Ingredient", "Amount"], rows: [
    ["White apple cider vinegar", "2 tbsp"], ["Turmeric powder", "1 tsp"], ["Black pepper", "1/8 tsp"], ["Habanero powder", "1/8 tsp"],
    ["Himalayan pink salt", "Pinch"], ["Lemon juice", "1 tbsp"], ["Moroccan extra virgin olive oil", "1 tbsp"]
  ] },
  { type: "list", style: "check", items: ["Reduces inflammation", "Supports digestion", "Balances blood sugar", "Boosts metabolism", "Supports detoxification", "Enhances energy & immunity"] },
  { type: "steps", heading: "Daily movement reset (10–15 minutes)", note: "This routine improves posture, core activation, hip mobility & glute function.", items: [
    { title: "90/90 breathing", detail: "3 rounds · 5 deep breaths" },
    { title: "Couch stretch", detail: "2 × 30–45 sec each side" },
    { title: "Thoracic open books", detail: "10 reps each side" },
    { title: "Glute bridge hold", detail: "3 × 30 sec" },
    { title: "Dead bugs", detail: "3 × 10–12 each side" },
    { title: "Split squat hold", detail: "2 × 30 sec each side" },
    { title: "Wall posture", detail: "2 minutes" },
    { title: "Deep squat hold", detail: "1 minute" },
    { title: "Child's pose with reach", detail: "1 minute" }
  ] },
  { type: "groups", heading: "Strength training program: 4–6 days per week", note: "Focus on good form · Progressive overload · Strength is the foundation of a lean, toned & resilient body.", groups: [
    { title: "Day 1 · Lower body", note: "Glutes & hamstrings", style: "bullet", items: [{ title: "Hip thrusts", detail: "4 × 8–12" }, { title: "RDLs", detail: "4 × 8–12" }, { title: "Bulgarian split squats", detail: "3 × 10–12 each leg" }, { title: "Walking lunges", detail: "3 × 12–16 steps" }] },
    { title: "Day 2 · Upper body", note: "Push & pull", style: "bullet", items: [{ title: "Dumbbell rows", detail: "4 × 10–12" }, { title: "Incline DB press", detail: "4 × 10–12" }, { title: "Lat pulldowns", detail: "4 × 10–12" }, { title: "Face pulls", detail: "3 × 15–20" }] },
    { title: "Day 3 · Active recovery & mobility", style: "bullet", items: [{ title: "Zone 2 cardio", detail: "30–45 minutes (walk, bike, row)" }, { title: "Mobility flow", detail: "10–15 minutes" }, { title: "Breath work", detail: "5 minutes" }, { title: "Acupressure mat", detail: "10–20 minutes" }] },
    { title: "Day 4 · Lower body", note: "Power & glutes", style: "bullet", items: [{ title: "Sumo deadlifts", detail: "4 × 8–10" }, { title: "Step-ups", detail: "3 × 10–12 each leg" }, { title: "Cable pull-throughs", detail: "3 × 12–15" }, { title: "Glute kickbacks", detail: "3 × 15–20 each leg" }] },
    { title: "Day 5 · Upper body + core", style: "bullet", items: [{ title: "Landmine press", detail: "4 × 8–12" }, { title: "Seated cable row", detail: "4 × 10–12" }, { title: "Lateral raises", detail: "3 × 12–15" }, { title: "Plank variation", detail: "3 × 30–60 sec" }] },
    { title: "Day 6 · Full body conditioning", style: "bullet", items: [{ title: "Sled push", detail: "4 × 20–30 yards" }, { title: "Kettlebell swings", detail: "3 × 15–20" }, { title: "Farmer carries", detail: "4 × 30–45 sec" }, { title: "Med ball slams", detail: "3 × 12–15" }] },
    { title: "Day 7 · Rest & recover", style: "bullet", items: ["Walk outdoors", "Stretch & mobility", "Sauna or hot bath", "Early night sleep"] }
  ] },
  { type: "facts", heading: "Ice bath protocol", items: [{ title: "2–4×", detail: "Per week" }, { title: "50–58°F", detail: "Water temperature" }, { title: "2–5 min", detail: "Per session" }] },
  { type: "list", style: "check", items: ["Reduces inflammation", "Improves recovery", "Builds mental resilience", "Balances nervous system"], note: "Focus on slow nasal breathing." },
  { type: "facts", heading: "Acupressure mat", items: [{ title: "10–20 min", detail: "Nightly" }] },
  { type: "list", style: "check", items: ["Reduces stress & tension", "Improves sleep", "Activates relaxation response", "Enhances body awareness"] },
  { type: "motto", text: "Breathe. Relax. Reset." },
  { type: "list", heading: "Nutrition simplified", style: "check", items: ["Protein first: 30–40 g per meal", "Eat whole, real foods", "Prioritize quality carbs around workouts", "Stay hydrated", "Avoid processed foods & excess sugar", "Listen to your body"] },
  { type: "list", heading: "Supplement support", style: "check", items: [
    { title: "Magnesium glycinate", detail: "Sleep & recovery" }, { title: "Omega-3 fish oil", detail: "Inflammation support" },
    { title: "Vitamin D3 + K2", detail: "Hormone & immune support" }, { title: "Creatine monohydrate", detail: "Strength & muscle support" },
    { title: "Curcumin + black pepper extract", detail: "Anti-inflammatory" }, { title: "Ashwagandha", detail: "Stress & cortisol balance" },
    { title: "Probiotic", detail: "Gut health" }, { title: "Glycine", detail: "Sleep quality" }
  ] },
  { type: "list", heading: "Bioidentical hormone replacement (BHRT)", style: "check", items: ["Restores hormonal balance", "Improves energy, mood & sleep", "Supports lean muscle & metabolism", "Enhances recovery & body composition", "Improves libido & overall well-being"], note: "Balance your hormones. Transform your life." },
  { type: "list", heading: "Every day", style: "check", items: ["Sleep 7–9 hours: priority", "Stay hydrated: drink your water", "Manage stress daily", "You are worth it"] },
  { type: "motto", text: "Be patient. Be consistent. Trust the process." }
];

// ---- State of Perpetual Growth: full body mobility workout + macros
T["mobility-diet-ratios"] = [
  { type: "list", heading: "Full body mobility workout", style: "bullet", items: [
    { title: "How it works", detail: "Complete as many rounds as possible in 30 minutes. Move with control. Focus on depth, mobility and full range of motion." },
    { title: "10 movements = 1 round", detail: "Perform each movement in order. Complete all 10 movements, then start the next round." },
    { title: "Goal", detail: "As many quality rounds as possible in 30 minutes. Unbroken when possible. Keep transitions fast." }
  ] },
  { type: "steps", heading: "The movements", items: [
    { title: "TRX body squat: 10 reps", detail: "Sit hips back and down. Keep chest up. Full depth." },
    { title: "Pole squat: 10 reps", detail: "Hold pole overhead with both hands. Use for balance and mobility. Achieve full depth." },
    { title: "Burpee: 10 reps", detail: "Squat → hands down → kick back → push up → jump up. Move fluidly." },
    { title: "Pistol squat (each leg): 10 reps", detail: "Use support if needed. Go as deep as you can with control." },
    { title: "Cossack squat (each side): 10 reps", detail: "Shift hips side to side. Keep chest up. Go deep." },
    { title: "Bear crawl: 4 reps (each rep = 20 ft)", detail: "Hands slightly wider than shoulders. Knees hover 1–2 inches off ground. Move forward." }
  ] },
  { type: "callout", tone: "warning", title: "Disclaimer: only the muscle soreness is good pain", text: "Joint pain and/or sharp stabbing pain is not good pain. Stop, assess and modify if you experience joint pain." },
  { type: "list", heading: "Quality over quantity", style: "check", items: ["Full range of motion", "Control every rep", "Breathe and move with intention"] },

  { type: "facts", heading: "Fuel your growth: higher protein & fat approach", text: "Macro breakdown, by calories.", items: [
    { title: "40% protein", detail: "Builds & repairs muscle tissue" }, { title: "30% fat", detail: "Supports hormones, joints & recovery" }, { title: "30% carbs", detail: "Fuels performance, replenishes glycogen" }
  ] },
  { type: "table", heading: "Daily macro examples", columns: ["Body weight", "Calories (approx.)", "Protein 40%", "Fat 30%", "Carbs 30%"], rows: [
    ["150 lbs", "2,400", "240 g", "80 g", "180 g"], ["175 lbs", "2,800", "280 g", "93 g", "210 g"], ["200 lbs", "3,200", "320 g", "107 g", "240 g"],
    ["225 lbs", "3,600", "360 g", "120 g", "270 g"], ["250 lbs", "4,000", "400 g", "133 g", "300 g"]
  ] },
  { type: "groups", heading: "Where it comes from", groups: [
    { title: "Protein (40%)", style: "bullet", items: ["Chicken", "Lean beef", "Turkey", "Salmon", "Eggs", "Greek yogurt", "Whey protein"] },
    { title: "Fat (30%)", style: "bullet", items: ["Avocado", "Nuts", "Olive oil", "Almonds", "Nut butter", "Fatty fish", "Whole eggs"] },
    { title: "Carbs (30%)", style: "bullet", items: ["Brown rice", "Oats", "Sweet potatoes", "Fruit", "Quinoa", "Whole grain bread"] }
  ] },
  { type: "groups", heading: "Suggestions to maximize results", groups: [
    { title: "Nutrition & hydration", style: "check", items: ["Eat 4–5 balanced meals per day", "Prioritize whole, nutrient-dense foods", "Hydrate: ½ your body weight (oz)", "Adjust portions based on results"] },
    { title: "Supplement support", note: "Optional", style: "bullet", items: ["Whey protein", "Creatine monohydrate", "Omega-3 (fish oil)", "Vitamin D3 + K2", "Magnesium"] },
    { title: "Cold exposure", style: "bullet", items: ["Ice baths: 2–3 min", "Cold showers: 2–5 min", "Great for recovery, inflammation & mindset"] },
    { title: "Cool down", note: "After long break workouts only", style: "bullet", items: ["5–10 minutes on bike or rower", "Easy pace", "Promotes recovery & reduces soreness"] }
  ] },
  { type: "motto", text: "Move better. Fuel better. Grow forever." }
];

// ---- State of Perpetual Growth: continuous progression program
T["psg-protocol"] = [
  { type: "text", heading: "A continuous progression program", text: "For strength, size & mobility." },
  { type: "table", heading: "1. Upper body: long workout day (break cycle)", text: "Extremely high volume. Go for depth, stretch & control.", columns: ["Exercise (in order)", "Targets", "Rep scheme"], rows: [
    ["A. Overhead press (dumbbells)", "Shoulders, traps, triceps", "50, 40, 30, 20, 10 (do NOT come back up)"],
    ["B. Dumbbell bench press", "Chest, shoulders, triceps", "50, 40, 30, 20, 10, 20, 30, 40, 50 (back down to 50)"],
    ["C. Lat pull-down", "Lats, biceps, upper back", "50, 40, 30, 20, 10, 20, 30, 40, 50 (back down to 50)"]
  ] },
  { type: "list", style: "bullet", items: ["Use a light weight for the first set of 50. Increase weight each set until your heaviest weight at 10 reps.", "For exercises B & C, reverse the pyramid back down to 50 reps, decreasing weight each set.", "Focus on full range of motion, deep stretch and perfect control.", "Rest as needed, but keep form strict."] },
  { type: "table", heading: "2. Lower body: long workout day (break cycle)", text: "Extremely high volume. Go for depth, stretch & control.", columns: ["Exercise (in order)", "Targets", "Rep scheme"], rows: [
    ["A. Bulgarian split squat", "Quads, glutes, hamstrings", "50, 40, 30, 20, 10 (do NOT come back up)"],
    ["B. Romanian deadlift", "Hamstrings, glutes, lower back", "50, 40, 30, 20, 10 (do NOT come back up)"],
    ["C. Core: GHD sit-ups or BOSU sit-ups", "Abs, core stability", "As many reps as you can control at heaviest weight"]
  ] },
  { type: "list", style: "bullet", items: ["Use a light weight for the first set of 50. Increase weight each set until your heaviest weight at 10 reps.", "Deep stretch, full range, controlled tempo.", "Core: go to failure with perfect form."] },
  { type: "steps", heading: "3. Full body mobility day (2× per week)", text: "Complete as many rounds as possible in 30 minutes.", items: [
    { title: "TRX body squat" }, { title: "Pole squat" }, { title: "Burpee" }, { title: "Pistol squat", detail: "Each leg" }, { title: "Cossack squat", detail: "Each side" }, { title: "Bear crawl" }
  ], note: "Rules: perform exercises 1–6 in order. That is 1 round. Immediately start the next round. Goal: as many quality rounds as possible in 30 minutes. Move with control. Focus on mobility, stability & full range of motion." },
  { type: "callout", tone: "tip", title: "Tip", text: "These days are for movement quality and conditioning. Go unbroken and keep transitions fast." },
  { type: "table", heading: "Weekly flow (repeat cycle)", columns: ["Day", "Workout", "Details"], rows: [
    ["Day 1", "Upper body long workout", "Full high-volume routine (see #1). Heavy weight. Break cycle."],
    ["Day 2", "Lower body long workout", "Full high-volume routine (see #2). Heavy weight. Break cycle."],
    ["Day 3", "Full body mobility day", "30-minute mobility circuit (see #3)."],
    ["Day 4", "Upper body short workout", "Same exercises (see #1). Much lighter weight. ~40 minutes."],
    ["Day 5", "Lower body short workout", "Same exercises (see #2). Much lighter weight. ~40 minutes."],
    ["Day 6", "Full body mobility day", "30-minute mobility circuit (see #3)."],
    ["Day 7", "Rest or active recovery", "Listen to your body. Rest when needed."]
  ] },
  { type: "callout", tone: "important", title: "When to repeat long workouts", text: "Do NOT return to Long Workout Days until you have a FULL DAY with no soreness or stiffness in the muscles worked. This may take weeks or even months. When you are completely recovered and performing at your best again, repeat Long Workout Days (Days 1 & 2) with the same weights OR increase the weight slightly if you feel ready." },
  { type: "callout", tone: "warning", title: "This is critical", text: "Long Workout Days are BREAK CYCLES: they should be rare and far apart. Overdoing them will stall your progress. Quality over frequency." },
  { type: "callout", tone: "tip", title: "Weight for short workout days", text: "When switching to the shorter upper / lower days (Days 4 & 5), reduce the weight used on Long Workout Days by a MINIMUM of 20%, ideally 30–40%. Example: if you used 15 lb dumbbells for the first set of 50 on overhead press, use 9–12 lb dumbbells for your shorter days." },
  { type: "groups", groups: [
    { title: "Key principles", style: "bullet", items: ["Full range of motion", "Controlled tempo", "Deep stretches", "Mind-muscle connection", "Consistency over intensity"] },
    { title: "Tips", style: "check", items: ["Hydrate and fuel your body", "Sleep 7–9 hours", "Stretch daily", "Track your progress", "Listen to your body"] }
  ] },
  { type: "callout", tone: "important", title: "Important", text: "This program is demanding. Use rest days if needed. Pain ≠ progress. Train smart. Recover smarter." },
  { type: "motto", text: "Stay disciplined. Stay patient. Stay in the State of Perpetual Growth." }
];

// ---- Dream Lean 12-week program: start here + daily checklist
T["weekly-tracking"] = [
  { type: "text", heading: "Welcome", text: "Congratulations and thank you for volunteering to participate in the Dream Lean Pilot Study. The purpose of this study is to evaluate the effects of a structured lifestyle intervention focused on improving body composition, strength, posture, energy, mobility, recovery, and overall health." },
  { type: "list", heading: "Over the next 12 weeks you will follow", style: "check", items: ["Strength training", "Mobility training", "Daily movement reset", "Daily health shot", "Daily ice bath", "Daily acupressure mat", "Nutritional guidelines", "Postural awareness", "Weekly accountability", "Periodic assessments"] },
  { type: "groups", groups: [
    { title: "Participants will complete", style: "check", items: ["Baseline assessment", "Week 4 assessment", "Week 8 assessment", "Week 12 final assessment"] },
    { title: "Measurements include", style: "check", items: ["SECA body composition scan", "Circumference measurements", "Progress photos", "Postural assessment", "Dream Lean score", "Energy and recovery tracking"] }
  ] },
  { type: "callout", tone: "tip", title: "The goal is not perfection. The goal is consistency.", text: "We are not trying to create the hardest program possible. We are trying to create a system that can be followed consistently and measured objectively." },
  { type: "list", heading: "Study rules", style: "check", items: ["Follow the prescribed program.", "Track your compliance honestly.", "Attend scheduled assessments.", "Maintain similar clothing for all photos and measurements.", "Communicate questions promptly.", "Trust the process."] },
  { type: "callout", tone: "remember", title: "Welcome to Dream Lean", text: "We are excited to support you on this 12-week journey. You are capable of amazing things! (Dr. Jared Caban, MD Fit)" },
  { type: "motto", text: "Your future self is worth the work." },

  { type: "table", heading: "Daily checklist: daily non-negotiables", text: "Small habits. Big results. Check off each habit every day, Monday to Sunday.", columns: ["Habit", "Target"], rows: [
    ["Health shot", ""], ["Protein goal met", "100–120 g"], ["Strength training*", "Per plan"], ["Daily movement reset", "5–10 min"], ["Ice bath", "2–3× per week"],
    ["Acupressure mat", "10–20 min"], ["Walking goal met", "8k–12k steps"], ["Postural awareness", "All day"], ["Sleep goal met", "7–9 hours"]
  ], note: "*If scheduled that day." },
  { type: "list", heading: "Daily postural reminders", text: "Throughout the day.", style: "box", items: ["Chin tucked", "Shoulders down", "Light abdominal tension", "Light glute engagement", "Nasal breathing", "Tall posture"] },
  { type: "list", heading: "Weekly compliance score", text: "Fill in at the end of each week.", style: "bullet", items: ["Total opportunities", "Completed", "Compliance %"] },
  { type: "callout", tone: "remember", title: "Focus on progress, not perfection", text: "Consistency wins: small daily actions lead to massive results." },
  { type: "motto", text: "You've got this!" }
];

module.exports = { TIP_SECTIONS: T };
