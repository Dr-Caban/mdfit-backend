// Words that mean an emergency or a crisis. A message that has them is answered in the app (call or text 988, 911, the
// clinic, and the pain tool beside them), never sent to the assistant and never counted. The app checks the same words
// first: mdfit-frontend/mdfit-guide.js holds a copy of everything between the two "crisis words" lines below. Change
// both together, and keep the copy free of regex lookbehind (older iPhones cannot read it).
//
// How it decides, in plain words:
// - An emergency (chest pain, can't breathe, overdose, ...) or words that only mean a crisis (suicide, kill myself,
//   want to die, don't want to live, ...) count wherever they are in the message.
// - "hurt myself", "cut myself" and "harm myself" count, unless the message is plainly about an accident: the activity
//   comes right after the words ("I hurt myself lifting", "I cut myself shaving") with no intent anywhere near them, or
//   it is a question about exercise ("will I hurt myself if I run"). Intent ("want to", "I'll", "might", "need to",
//   "scared", "trying", "on purpose", "urge") always counts, whatever else the message says.
// - When in doubt it counts: a crisis answer to an ordinary sentence costs a moment, a missed crisis does not. The
//   answer offers the pain tool too, so "I hurt myself" said about an injury still gets help.

// ---- crisis words (start of the copy kept in mdfit-guide.js) ----
const CRISIS_WORDS = (() => {
  const A = "['’]?"; // the apostrophe a phone types counts like the plain one, and leaving it out too
  const EMERGENCY = new RegExp("\\b(911|emergency(?! contacts?\\b)|can" + A + "t breathe|cannot breathe|(struggling|hard|trouble|difficulty) (to breathe|breathing)|hard time breathing|chest pains?|numb(ness)? in my (face|arms?)|my face is (numb|drooping)|face (is )?drooping|passed out|fainted|collapsed|overdos\\w*|od" + A + "d|severe bleeding|bleeding (a lot|heavily|badly)|won" + A + "t stop bleeding|(turning|turned) blue|lips are blue)\\b", "i");
  // a stroke or a heart attack, unless it is plainly a sports stroke or something that happened before
  const STROKE = /\b(stroke|heart attacks?)\b/i;
  const STROKE_PAST = /\b(golf|swim|swimming|tennis|paddle|rowing|back|breast|free|putting|brush|pen) stroke\b|\b(after|had|has had|have had|history of|recovering from|recovery from|since|survived|survivor of)( a| my| his| her| the| two| 2)? (strokes?|heart attacks?)\b|\b(gave|give|giving|gives) me a heart attack\b/i;
  const STROKE_NOW = /\b(having|signs? of|symptoms? of|is having|might be having|think (i|it)( am|'m|’m| is|'s|’s)?|could be)( a)? (stroke|heart attack)\b/i;
  const CRISIS = new RegExp("\\b(su[ie]?[cs]id\\w*|sucid\\w*|kil+(ing)?,? ?(my|mi) ?s(el|le)f|self[- ]?harm\\w*|unalive|end my life|end(ing)? it all|" +
    "(want(ed)?|wanna|going|gonna|feel like|about|ready|thinking (about|of)) (to )?end(ing)? it(?=\\s*($|[.!?,;]|tonight\\b|now\\b|forever\\b|already\\b))|" +
    "(want to|wanna|want 2)( just)? d ?i ?e\\b(?! (my|your|her|his|the) hair)|wish i (was|were|had) (dead|never been born)|wish i (wasn" + A + "t|was not|weren" + A + "t) alive|never (been )?born|" +
    "better off (dead|without me|if i (was|were) (dead|gone))|(i" + A + "d|i would) rather be dead|" +
    "(don" + A + "t|do not|dont) (want to|wanna) (live|be here|be alive|exist|wake up)|no reason to live|(isn" + A + "t|not|is not) worth living|can" + A + "t go on|" +
    "(sleep and )?never wake up|(stop|end) forever|nobody would miss me|no one would miss me|disappear forever|" +
    "jump off (a|the|that) (bridge|building|roof|cliff)|take all (my|the|of my) pills|took (too many|all (my|the|of my)|a (whole )?bottle of|a bunch of) pills)\\b", "i");
  const KMS = /(^\s*kms\s*[.!?]*\s*$|(['’]ll|\b(will|wanna|gonna|going to|want to|might|need to|should|about to)) kms\b)/i;
  const SELF = /\b(hurt(ing)?|cut(ting)?|harm(ing)?) my ?s(el|le)f\b/i;
  const ON_PURPOSE = /\b(on purpose|intentional(ly)?|deliberate(ly)?|urges?|again and again)\b/i;
  // intent close before the words (up to four words between)
  const INTENT = new RegExp("\\b(want(ed)?|wanna|gonna|going to|imma|i" + A + "ll|will|might|could|need(ed)? to|feel like|thinking (about|of)|thought (about|of)|plan(ning|ned)?|try(ing)?|tried|scared|afraid|worried|about to|how (can|do|could|would) i)\\b(\\W+\\w+){0,4}?\\W+(hurt(ing)?|cut(ting)?|harm(ing)?) my ?s(el|le)f\\b", "i");
  // an accident: the activity comes right after the words
  const ACCIDENT = /\b(hurt(ing)?|cut(ting)?) my ?s(el|le)f( again| today| yesterday| this (morning|week|weekend)| last (night|week))?( badly)? (lifting|squatting|deadlifting|benching|pressing|running|jogging|sprinting|playing|skiing|snowboarding|hiking|gardening|pulling weeds|walking|moving|picking|carrying|bending|reaching|stretching|twisting|jumping|climbing|cycling|biking|riding|swimming|surfing|skating|dancing|rowing|throwing|training|golfing|shoveling|cleaning|working out|exercising|shaving|cooking|chopping|slicing|doing (squats|deadlifts|lunges|burpees|push-?ups|pull-?ups|sit-?ups|crunches|planks?|yoga|pilates|that|this|it|the|my|an?|some)\b|at (the gym|pilates|yoga|practice|work|crossfit|the park)\b|on (the|a|my) (treadmill|stairs|bike|court|field|ice|trail|track|machine|elliptical|rower|bench|glass|knife|can|edge|lid|blade|bottle|fence|nail)\b|in the (gym|pool|yard|garden)\b|during (practice|my workout|the workout|a workout|the game|a game|training|class|the run)\b|while (lifting|running|playing|training|working out|exercising|walking|moving|cleaning|cooking|shaving|making)\b|with (a|the) (knife|razor|glass|scissors) while\b|falling|slipping|tripping|in (a|an|the) (car |bike )?(accident|crash|fall)\b|by (falling|slipping|tripping|accident)\b|accidentally)/i;
  // A question about exercise ("will I hurt myself if I run", "did I hurt myself?"), or wanting not to get hurt doing
  // it ("I don't want to hurt myself doing this", "how do I avoid hurting myself", "without hurting myself"). These
  // are let off even though they hold words like "will" or "want". "help me stop hurting myself" is not one of them.
  const SAFE_Q = /^\s*(did i (hurt|cut|harm) my ?s(el|le)f\b|(will|would|could|can|do|does|should|might) i (hurt|cut|harm) my ?s(el|le)f\b(.*\b(if|when|by|doing|lifting|running|squatting|exercis\w*|working out)\b| (with|on) (this|that|the|a|my) \w+))/i;
  const SAFE_NEG = /\b(don['’]?t|do not|didn['’]?t|did not) want to (hurt|harm|cut) my ?s(el|le)f (doing|while|when|lifting|running|squatting|on (the|a)|at (the|a)|in (the|a)|during)\b|\b(how (do|can|could|should) i|how to|ways to|tips to) (avoid|prevent) (hurt|harm|cut|injur)(ing|ting)? my ?s(el|le)f\b|\bwithout (hurting|injuring|harming) my ?s(el|le)f\b/i;
  // an accident told the other way round: "I fell and hurt myself"
  const ACCIDENT_BEFORE = /\b(fell|slipped|tripped|crashed|stumbled)( down| over| off \w+)? and (hurt|cut) my ?s(el|le)f\b/i;
  const self = (t) => SELF.test(t) && (ON_PURPOSE.test(t) || (!SAFE_Q.test(t) && !SAFE_NEG.test(t) && (INTENT.test(t) || !(ACCIDENT.test(t) || ACCIDENT_BEFORE.test(t)))));
  const isCrisis = (t) => CRISIS.test(t) || KMS.test(t) || self(t);
  const isEmergency = (t) => EMERGENCY.test(t) || (STROKE.test(t) && (STROKE_NOW.test(t) || !STROKE_PAST.test(t)));
  const isUrgent = (t) => { const s = String(t || "").replace(/\s+/g, " "); return isEmergency(s) || isCrisis(s); };
  return { isUrgent, isCrisis: (t) => isCrisis(String(t || "").replace(/\s+/g, " ")) };
})();
// ---- crisis words (end of the copy kept in mdfit-guide.js) ----

module.exports = CRISIS_WORDS;
