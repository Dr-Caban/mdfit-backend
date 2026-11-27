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
// - Emergencies, methods and plans, pills and overdoses, someone else in danger, and the indirect signs (a burden,
//   better without me, goodbye, giving things away) count too; slang, typos, letters typed with spaces, other
//   apostrophes and invisible spaces are read the same as plain words.
// - Some messages cannot be told from a crisis by words alone ("I won't be here tomorrow", "tonight's the night"):
//   those are left to the assistant (with AI answers on it is told to flag a crisis) and to people.
// - When in doubt it counts: a crisis answer to an ordinary sentence costs a moment, a missed crisis does not. The
//   answer offers the pain tool too, so "I hurt myself" said about an injury still gets help.

// ---- crisis words (start of the copy kept in mdfit-guide.js) ----
const CRISIS_WORDS = (() => {
  const A = "['’]?"; // the apostrophe a phone types counts like the plain one, and leaving it out too
  const EMERGENCY = new RegExp("\\b(911|emergency(?! contacts?\\b)|ca?n" + A + "t breathe?|cannot breathe?|can not breathe?|(struggling|hard|trouble|difficulty) (to breathe?|breathing)|hard time breathing|chest pains?|numb(ness)? in my (face|arms?)|my face is (numb|drooping)|face (is )?drooping|passed out|fainted|(?!(knees?|arch(es)?|ankles?|legs?|hips?|foot|feet|disc|disk)\\b)\\w+ collapsed(?! (arch|arches|disc|disk))|^collapsed|overdos\\w*|od(['’]e?d|ed)|severe bleeding|bleeding (a lot|heavily|badly)|won" + A + "t stop bleeding|(turning|turned) blue|lips are blue)\\b", "i");
  const EMERGENCY2 = new RegExp("\\b(" + [
    "(isn" + A + "t|is not|not|stopped|barely|quit) breathing\\b", "barely breathe", "can" + A + "t get (any )?air", "gasping for (air|breath)",
    "(pain|pressure|squeezing|crushing|heaviness) in (my|his|her) chest", "crushing chest", "chest (pressure|hurts|is hurting)",
    "chest\\b.{0,40}\\b(can" + A + "t (catch (my|his|her) )?breath|short(ness)? of breath)", "(short(ness)? of breath|can" + A + "t catch my breath)\\b.{0,40}\\bchest",
    "unconscious", "unresponsive", "(lost|losing) consciousness", "blacked out", "(going|about|gonna) to pass out", "passing out",
    "faint(ing|ed)\\b", "feel(ing)? faint", "(going|about|gonna) to faint",
    "won" + A + "t wake up", "not waking up", "can" + A + "t wake (him|her|them|my)", "going limp", "(turning|turned) (purple|grey|gray)",
    "(fell|collapsed|on the floor|on the ground) and (isn" + A + "t|is not|won" + A + "t|not) (moving|responding|respond|waking up|breathing)",
    "no pulse", "cardiac arrest", "needs? cpr", "doing cpr", "heart (stopped|has stopped|isn" + A + "t beating)",
    "(having|had|is having|in) an? seizure\\b(?! (last|in \\d|\\d|years?|months?|a (year|month|while)))", "seizures? (right now|now)", "seizing\\b(?! up)", "convuls\\w*", "anaphyla\\w*", "(having|having an?|bad|severe|serious) allergic reaction", "allergic reaction (help|now|right now)", "(use|used|using|give|need to use) (my |an |the |her |his )?epi ?pens?",
    "throat (is )?(closing|swelling)", "(tongue|lips|face|throat) (is |are )?(swelling|swollen)", "(stung|sting|bee|peanuts?|hives)\\b.{0,50}\\b(throat|tongue|breathe?|swallow)",
    "choking\\b(?! up)", "bleed(ing)? out", "blood everywhere", "gushing blood", "(coughing|throwing|vomiting|spitting) (up )?blood",
    "can" + A + "t stop (the )?bleeding", "bleeding (won" + A + "t|wont|will not|doesn" + A + "t|does not) stop", "bleeding and (it )?(won" + A + "t|wont|will not) stop", "keeps bleeding", "blood is (pouring|gushing|spurting)", "bleeding (through|out of) (the|my|his|her) (bandage|dressing|stitches|incision)", "bleeding from (my|his|her|the) head",
    "(chest (feels? |is |gets )?(getting )?(really |so |very )?(tightness|tight)\\b|tightness in (my|his|her) chest\\b)(?!,? (today |now |again |a bit )?(after|from|since|during|when|which|what|while|in a good way)\\b)",
    "tight chest\\b[^.?!]{0,30}\\b(dizz\\w*|sweat\\w*|short of breath|can" + A + "t breathe?|arm|jaw|nause\\w*|faint\\w*)", "chest (feels |is )?(so |really |very )?heavy\\b(?!,? (after|from|since|during|when)\\b)",
    "(drank|swallowed|ate|got into) (some |the |a bottle of |a cup of )?(bleach|poison|antifreeze|lye|drain cleaner|rat poison|cleaning products|cleaner|detergent pods?)", "mixed bleach (and|with) ammonia", "drinking (a bottle of|some|the) (bleach|poison|antifreeze|drain cleaner)", "(pills|meds) and bleach", "bleeding (really |so |very )?(bad|badly|everywhere)",
    "worst headache", "sudden (severe|bad|terrible|horrible) headache", "slurr(ed|ing)", "can" + A + "t (talk|speak) (right|properly|clearly)",
    "words (are )?coming out wrong", "(numb|weak|drooping|paralyzed) on one side", "(face|left arm|right arm) (is |went |just went |suddenly went |has gone )numb",
    "can" + A + "t feel (the |my )?(left|right) side", "can" + A + "t move (my|his|her) (legs|arms|body)\\b(?! after)",
    "hit (my|his|her|their) head\\b.{0,40}\\b(confused|making sense|throwing up|vomiting|passed out|blacked out)",
    "(blood sugar|sugar|glucose)\\b.{0,40}\\b(confused|can" + A + "t think|pass(ing)? out)",
    "narcan", "naloxone", "(gonna|going to|want to|wanna|about to|might|will|i" + A + "ll) od\\b",
    "i (think|feel like) i" + A + "m dying\\b(?! (laughing|after|from|of))", "(having|having an|in the middle of an?) asthma attack", "inhaler (isn" + A + "t|is not|not) (working|helping)",
    "(bottle|fifth) of (vodka|wine|whiskey|tequila|rum|gin|alcohol|liquor) and (took|swallowed|take)",
  ].join("|") + ")", "i");
  // a stroke or a heart attack, unless it is plainly a sports stroke or something that happened before
  const STROKE = /\b(stroke?|heart ?at+a?c?ks?|mini ?stroke|tia)\b/i;
  const STROKE_PAST = /\b(golf|swim|swimming|tennis|paddle|rowing|back|breast|free|freestyle|butterfly|kayak|putting|brush|pen) stroke\b|\b(after|history of|recovering from|recovery from|since|survived|survivor of)( a| my| his| her| the| two| 2)? (strokes?|heart attacks?)\b|\b(had|has had|have had)( a| my| his| her| the| two| 2)? (strokes?|heart attacks?)\b(?=.{0,80}\b(last (year|month|spring|summer|fall|winter)|years? ago|months? ago|in (19|20)\d\d|back in|before|rehab\w*|recover\w*|caregiver|can (i|she|he|they|we)|is it (ok|okay|safe)|safe (to|for)|now doing|it was|wants? to (exercise|start|get|work|do|walk|lift|move)|is doing (better|well)|since then|what (exercises|can|should)|cleared|cardiologist|sometimes|balance)\b)|\b(gave|give|giving|gives) me a heart attack\b|\bpost[- ]?stroke\b|\b(stroke|heart attack) (survivors?|patients?|rehab\w*|recovery|rate|count|length|technique|risks?|prevention|unit|ward|center|clinic|team|support group)\b|\bmy (last |first )?stroke (was|happened)\b|\b(cause|causes|prevent|prevents|risk of)( a)? (stroke|heart attack)\b/i;
  const STROKE_NOW = /\b(having|signs? of|symptoms? of|is having|might be having|think (i|it)( am|'m|’m| is|'s|’s)?|could be)( a)? (stroke|heart attack)\b|\bjust (had|having|suffered)( a)? (stroke|heart attack)\b|\b(stroke|heart attack) (just now|right now|\d+ ?(min\w*|hours?|hrs?) ago|an? (few )?(min\w*|hour) ago|symptoms)\b|\b(think|maybe|might|may|could|probably|pretty sure)\b[^.?!]{0,30}\b(had|have had)( a)? (stroke|heart attack)\b|\b(had|having)( a)? (stroke|heart attack)\b[^.?!]{0,40}\b(help|what (do|should) (i|we) do|can['’]?t (talk|speak|move|breathe)|isn['’]?t moving|not (moving|breathing|responding)|today|tonight|this (morning|afternoon|evening))\b|\b(stroke|heart attack),? i think\b|\b(stroke|heart attack)\b[^.?!]{0,40}\b(went numb|going numb|right now|just now|tonight|(suddenly|just) (can['’]?t|cannot|couldn['’]?t) (talk|speak|move|feel)|now (she|he|i|they) (can['’]?t|cannot) (talk|speak|move|feel))\b|\b(stroke|heart attack)\b[^.?!]{0,50}\b(help|ambulance|911|called|collapsed|unconscious|not responding|isn['’]?t (moving|responding|breathing))\b|\b(stroke|heart attack)\b[^.?!]{0,30}\b(while|during|at) (cardiac )?(rehab|recovering|recovery|pt|physical therapy|class|practice|the gym|a workout|the workout)\b|\b(stroke|heart attack) in the kitchen\b|\b(mini ?stroke|tia)\b/i;
  const CRISIS = new RegExp("\\b(su[ie]?[cs]id\\w*|sucid\\w*|kil+(ing)?,? ?(my|mi) ?s(el|le)f|self[- ]?harm\\w*|unalive|end my life|end(ing)? it all|" +
    "(want(ed)?|wanna|going|gonna|feel like|about|ready|thinking (about|of)) (to )?end(ing)? it(?=\\s*($|[.!?,;]|tonight\\b|now\\b|forever\\b|already\\b|fr\\b|rn\\b|lol\\b|tbh\\b|for good\\b))|" +
    "(want to|wanna|want 2)( just)? d ?i ?e\\b(?! (my|your|her|his|the) hair)|wish i (was|were|had) (dead|never been born)|wish i (wasn" + A + "t|was not|weren" + A + "t) alive|never (been )?born|" +
    "better off (dead|without me|if i (was|were) (dead|gone))|(i" + A + "d|i would) rather be dead|" +
    "(don" + A + "t|do not|dont) (want to|wanna) (live|be here|be alive|exist|wake up(?! (sore|stiff|early|late|tired|at \\d|before)))|no reason to live|(isn" + A + "t|not|is not) worth living|can" + A + "t go on|" +
    "(sleep and |to )?never wake up(?! (rested|refreshed|before|early|on time|without|feeling))|(stop|end) forever|nobody would miss me|no one would miss me|disappear forever|" +
    "jump off (a|the|that) (bridge|building|roof|cliff)|take all (my|the|of my) pills|took (too many|all (my|the|of my)|a (whole )?bottle of|a bunch of) pills)\\b", "i");
  const PRON = "(my|me|mi|him|her|them) ?-?s(el|le)(f+|ves)";
  const DRUG = "(pills|meds|medications?|tablets|tylenol|advil|ibuprofen|aleve|xanax|valium|oxy\\w*|percocet|vicodin|hydrocodone|fentanyl|painkillers|sleeping pills|insulin)";
  const CRISIS2 = new RegExp("\\b(" + [
    "un ?aliv\\w*", "sewer ?slides?", "su[ie1!]?d?[cs]id\\w*", "suici?al\\w*", "k[i1!]l+(ing|in" + A + ")?,? ?" + PRON + "\\b", "baker ?act\\w*",
    "(wa?n[at]?t?(s|ed)? (to|too|ta|2)|wan+a)( just| really| so bad to)? d ?(i ?e+|ei)\\b(?! (my|your|her|his|the) hair)",
    "(deserve to|should( just)?|hope i|wish i (could|would)( just)?|let me( just)?|ready to|might as well|i" + A + "d rather|i would rather) die\\b(?! (than|laughing|of laughter))",
    "(want|wanna|wish) (to )?be dead", "(i" + A + "d|i would|i" + A + "m|im|i am) (be )?better (off )?(dead|gone)", "feel like dying\\b(?! (after|from|of|laughing))",
    "(don" + A + "t|do not|dont) (even |really |actually |honestly )?(want to|wanna|wish to|feel like|deserve to) (live|living|be here|be alive|exist|do life)",
    "(don" + A + "t|do not|dont) (even |really |actually |honestly )(want to|wanna) wake up",
    "(tired|sick) of (being alive|living|life)\\b(?! with| in)", "(done|finished) (with (life|living|being alive)|living)\\b(?! (on|in|with|like a|off))",
    "nothing (left )?to live for", "no (point|reason) (in |to |of )?(living|live|life|being alive|going on)",
    "(what" + A + "s|whats|what is) the point (of|in) (living|life|being alive|going on|anything)",
    "life (isn" + A + "t|is not|ain" + A + "t|isnt) worth (it|anything)", "(i" + A + "m|im|i am) not worth (saving|anything|living)",
    "(nobody|no one) wants me (alive|around|here|to live)", "(want to|wanna|just) (stop|not) exist(ing)?", "wish i (didn" + A + "t|did not) exist",
    "(want to|wanna|wish i could) disappear(\\s*$|\\s*[.!?]| and never| for good| forever)", "disappear and never come back", "(going|go) away forever",
    "(want(ed)?|wanna|going|gonna|feel like|about|ready|thinking (about|of)) (to )?end(ing)? (things|everything)(?=\\s*($|[.!?,;]|tonight\\b|now\\b|forever\\b|already\\b|for good\\b))",
    "end(ing)? (my|her|his|their)s(el|le)(f|ves)", "end(ing)? (my|her|his|their) (own )?life", "tried to end it\\b(?! with)",
    "take (my|her|his|their) own life", "(try(ing)?|tried|going|gonna|want(ed)?|wanna|thinking (about|of)|plan(ning)?|about) to take (my|her|his|their) life\\b(?! back)",
    "(want|need|wish)( for)? (it all|everything|my life) to (end|be over|stop)", "want(ed)? it (all )?to be over",
    "can" + A + "t (keep )?(living|live|go on living) like this", "(give|gave|given|giving) up on (life|living)\\b",
    "(to|gonna|wanna|going to|about to|might|will|i" + A + "ll|thinking (about|of)) off " + PRON, "offing " + PRON,
    "(hang|hung|hanging|hanged|shoot|shot|shooting|drown|drowning|poison|poisoning|suffocate|electrocute|stab|gas)(ed)? " + PRON + "\\b", "noose", "(holding|have|got|has|grabbed) (a|my|the|his|her|my dad" + A + "s|a loaded) gun\\b[^.?!]{0,30}\\b(in (my|his|her) hand|right now|loaded|ready|use it|using it|on (me|myself|him|her)|myself)", "gun is loaded", "loaded gun",
    "((want|wanna|going|gonna|about|ready|plan(ning)?)( to)?|thinking (about|of)) (drink|drinking|swallow\\w*|eat|eating) (some |the |a bottle of |a cup of )?(bleach|poison|antifreeze|lye|drain cleaner|rat poison)",
    "soo?ci?de|sewer ?cide", "(have|got|holding|bought|has) a gun\\b.{0,40}\\b(use it|myself|on me|wants? to (end|die|use it|shoot|kill))",
    "(going to|gonna|want to|wanna|about to) jump(?=\\s*($|[.!?,;]|tonight\\b|now\\b|off (?!(the |a |my )?(box|step|bench|platform|stairs?|curb|plyo)\\b)))", "jump (out|from) (of )?(the|a|my|this) (window|balcony|roof|building|\\d+\\w* floor)", "(standing|sitting|i" + A + "m|i am|im) on (the|a|this) (bridge|ledge|roof|edge)\\b(?! (of|for) (the |my |a |this )?(pool|bed|couch|seat|chair|box|bench|step|stairs|mat|tub|sofa|table)\\b)(?! (fixing|cleaning|working|repairing|putting|shoveling|installing|doing|exercise|pose|stretch|position|hold)\\b)",
    "((want|wanna|going|gonna|ready) to )?stop (living|being alive)(?=\\s*($|[.!?,;]|forever\\b|now\\b))", "hate (my|this) life\\b.{0,40}\\bwant (out|to (go|leave|disappear|die))",
    "su[ie]?c[ie]?d(e|al)\\b", "bought a rope\\b(?! (for|to (climb|train)|attachment))", "(jaw|left arm)\\b.{0,30}\\b(hurts?|pain|numb)\\b.{0,30}\\bsweat\\w*", "(passive|active) si\\b(?! joints?)", "si (thoughts|ideation)",
    "(slit|slitting|slash|slashing|cut|cutting|open) (my|his|her) (wrists?|throat)", "(knife|blade|razor) (to|on|against) my (wrists?|throat|neck|arms?|skin)",
    "gun (to|in) (my|his|her) (head|mouth)", "blow (my|his|her) brains", "use it on " + PRON, "(load|loading|loaded) (my|a|the) gun",
    "jump(ing)? (off|from|in front of) (a|the|that|my) ?(bridge|building|roof|cliff|balcony|overpass|parking garage|train|car|bus|truck)", "jump off something",
    "(on|at) (the|a) (bridge|roof|ledge)\\b.{0,40}\\bjump\\b", "(throw|throwing) " + PRON + " (off|in front of|from|under)", "step(ping)? in front of (a|the) (bus|train|car|truck)",
    "(drive|driving|crash|crashing|run) (my|the) car (into|off) (a|the) (tree|wall|bridge|cliff|river|lake|ocean|pole|truck|traffic|water)", "crash(ing)? (my|the) car on purpose",
    "(drive|driving) off (a|the) (bridge|cliff|road|overpass)", "(hope|wish|want to|wanna)( that)? (a (car|truck|bus|train) hits me|i get hit by|to get hit by|get hit by)",
    "(took|swallowed|downed|(going to|gonna|want to|wanna|about to|plan(ning)? to) (take|swallow|down)) (all|every( one)?|my whole|the whole|a (whole |full )?(bottle|handful|bunch|pack|box|lot|ton)|too (many|much)|way too (many|much)|\\d{2,})( (of|in))?( (my|her|his|the|their))?( \\w+" + A + "s?){0,2} " + DRUG,
    "(took|take|taking|swallowed)\\b.{0,30}\\b" + DRUG + "\\b.{0,30}\\bon purpose", "everything in (my|the) medicine cabinet", "plan(ning)? (is )?to take (my|all my|the) " + DRUG,
    "(friend|roommate|brother|sister|son|daughter|mom|dad|mother|father|wife|husband|boyfriend|girlfriend|partner|kid|child|toddler|baby|grandson|granddaughter|grandma|grandpa|niece|nephew|uncle|aunt|cousin|neighbor) (just )?(took|swallowed|ate|got into) ((some |a lot of |a bunch of |\\w+ of |all (of )?)((my|her|his|their|the) )?(\\w+ ){0,2}|(my|the) (\\w+ ){0,2})?" + DRUG,
    "(saving|saved|stockpil\\w*|hoard\\w*) (up )?(my |the |her |his )?" + DRUG, "have (the|my) " + DRUG + " ready", "(going to|gonna|want to|wanna|about to|plan(ning)? to) mix (my )?" + DRUG + " with (alcohol|vodka|wine|whiskey|booze)",
    "how many " + DRUG + " (would|will|to|does it take to|it takes|does it take)", "lethal dose", "painless way to (go|die)",
    "(i" + A + "m|im|i am|i feel like) (just |such |only |nothing but )?a (burden|waste of (space|air))",
    "(better|happier|easier) (off )?without me", "(better|happier|easier) (off )?if i (was|were|wasn" + A + "t|weren" + A + "t) (dead|gone|here|around|alive)",
    "(nobody|no one) (would|will) (even )?(care|notice|miss me) if i (died|was gone|were gone|disappeared|wasn" + A + "t (here|around|alive))", "if i died (tomorrow|tonight|today)?,? (nobody|no one)",
    "(gave|giving|given) away (all )?(of )?my (stuff|things|belongings|possessions|dog|cat|pets?)",
    "this is (my )?goodbye", "goodbye (forever|world|everyone|cruel world)", "saying (my )?goodbyes", "texted (me )?goodbye", "goodbye (notes?|letters?)",
    "(wrote|writing|left|leaving) (a |my )?(suicide |goodbye )?(notes?|letters?) (for|to) (my )?(family|kids|wife|husband|mom|dad|parents|everyone)",
    "(won" + A + "t|will not|not going to|not gonna) be (here|around|alive) (much longer|for long|after tonight)\\b(?! (at|in|on) )",
    "(won" + A + "t|will not|not going to|not gonna) (make it through (the night|tonight)|be alive (tomorrow|by))", "don" + A + "t think i" + A + "ll (be alive|make it|be here) (tomorrow|through)",
    "if i" + A + "m still (alive|around|here)\\b(?! (in|at|for|by|on|after|when))", "won" + A + "t need (it|this|them) after tonight", "planning my (exit|death|suicide)",
    "(see|have) (a|any) future for (my|me)s(el|le)f", "no way out (except|but) ",
    "(after|since) my (suicide )?attempt (last|in) (year|month|week|spring|summer|fall|winter|\\d{4})", "psych(iatric)? (ward|hospital)",
    "(want to|wanna|wish i could|i) (go to sleep|fall asleep|sleep) forever", "(sleep|fall asleep|go to sleep) and (never|not) wake", "not wake up (tomorrow|again|ever)",
    "(hope|wish|pray) i (don" + A + "t|do not|never) wake up",
    "(punish(ing|ed)?|starv(e|ing|ed)) (my|me|him|her) ?s(el|le)f\\b", "(make|making|made) (my|me)s(el|le)f (throw up|sick|puke|vomit|bleed|purge)",
    "(bang|banging|hit|hitting|slam|slamming) my head (against|on|into) (the |a )?wall", "(until|till|til) (it|i|they|my (skin|arms?|wrists?|knuckles|thighs)) (bleeds?|bled)\\b", "bled (my|me)self",
    "self[- ]?(injur|inflict|mutilat)\\w*", "(cut|cutting|slic(e|ing)|carv(e|ing|ed)( into)?) (my|her|his) (wrists?|arms?|thighs?|skin)\\b(?! on (the|a|my) )",
    "relaps\\w* (and |on |into )?(cut|cutting|self)", "(started|start|been|keep|kept|back to) cutting again\\b(?! (for|to|before|after|weight|carbs|calories|season|phase|cycle))",
    "(so|and) i hurt my body", "deserve (pain|to (hurt|suffer|be in pain|be punished))", "stop eating (forever|for good|completely)", "(haven" + A + "t|not) eat(en)?\\b.{0,30}\\bon purpose",
  ].join("|") + ")", "i");
  const KMS = /(^\s*kms\s*[.!?]*\s*$|(['’]ll|\b(will|wanna|gonna|going to|want to|might|need to|should|about to)) kms\b)/i;
  const KMS_ANY = /\bkms\b/i;
  const KM_DIST = /(\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|half|few|many|more|less|extra|couple|several|those|these|the|of|total|daily))\s*kms\b|\bkms\s*(or|per|vs|is|are|an hour|a (day|week)|\/)/i;
  const VERB = "(hurt(s|ed|ing)?|cut(s|ting)?|harm(s|ed|ing)?|burn(s|ed|t|ing)?|hit(s|ting)?|punch(es|ed|ing)?|scratch(es|ed|ing)?)";
  const SELF = new RegExp("\\b" + VERB + " " + PRON + "\\b", "i");
  const ON_PURPOSE = new RegExp("\\b(on purpose|intentional(ly)?|deliberate(ly)?|urges?|again and again|punish\\w*|feel something|feel pain|(no ?one|nobody) (knows|sees|finds out|notices|will (know|see|notice|find out))|so (no ?one|nobody)|hate (my|me)s(el|le)f|hate my body|i deserve|can" + A + "t stop|cant stop|to cope|(until|till) (it|i) (bleed|bled)|felt (good|better|nice|right|like relief)|(it|that) (helped|helps)|helps me|calm (me )?down|relief|release|numb the pain|to feel (the |some )?pain|wanted it to hurt|(liked|like|love|enjoy\\w*) (it|the pain|how it)|do it again|every night|when (i" + A + "m|im|i am|i feel|i get) (sad|upset|angry|mad|low|depressed|alone|lonely|anxious|stressed|overwhelmed|empty)|can" + A + "t tell (anyone|anybody|my)|cant tell (anyone|anybody|my)|(no ?one|nobody) (noticed|can know|knows)|(so|to) (i|we) (could|can) feel (it|something|anything)|again (last night|tonight)|(that )?i (saved|stashed|hid)( (it|them|away))?|(keep|kept|been) (cutting|burning|scratching) (my|me) ?s(el|le)f)\\b", "i");
  // intent close before the words (up to four words between)
  const INTENT = new RegExp("\\b(want(ed)?|wanna|gonna|going to|imma|i" + A + "ll|will|might|could|need(ed)? to|feel like|thinking (about|of)|thought (about|of)|plan(ning|ned)?|try(ing)?|tried|scared|afraid|worried|about to|how (can|do|could|would) i)\\b(\\W+\\w+){0,4}?\\W+" + VERB + " " + PRON + "\\b", "i");
  // an accident: the activity comes right after the words
  const ACCIDENT = new RegExp("\\b" + VERB + " " + PRON + "( in the (face|head|eye|nose|mouth|shin|knee))?( again| today| yesterday| this (morning|week|weekend)| last (night|week))?( badly)? (lifting|squatting|deadlifting|benching|pressing|running|jogging|sprinting|playing|skiing|snowboarding|hiking|gardening|pulling weeds|walking|moving|picking|carrying|bending|reaching|stretching|twisting|jumping|climbing|cycling|biking|riding|swimming|surfing|skating|dancing|rowing|throwing|training|golfing|shoveling|cleaning|working out|exercising|shaving|cooking|chopping|slicing|opening|chasing|mowing|vacuuming|sneezing|coughing|getting (in|out|up|off|into|on)|doing (squats|deadlifts|lunges|burpees|push-?ups|pull-?ups|sit-?ups|crunches|planks?|yoga|pilates|that|this|it|the|my|an?|some)\\b|at (the gym|pilates|yoga|practice|work|crossfit|the park)\\b|on (the|a|my|some) (paper|(squat |barbell |power )?rack|box(?! ?cutter)|cardboard|treadmill|stairs|bike|court|field|ice|trail|track|machine|elliptical|rower|bench|glass|knife|can|edge|lid|blade|bottle|fence|nail|stove|oven|pan|grill|iron)\\b|in the (gym|pool|yard|garden)\\b|with (a|the|my) (kettlebell|barbell|bar|dumbbell|weight|plate|band|door|ball)\\b|during (practice|my workout|the workout|a workout|the game|a game|training|class|the run)\\b|while (lifting|running|playing|training|working out|exercising|walking|moving|cleaning|cooking|shaving|making)\\b|with (a|the) (knife|razor|glass|scissors) while (cooking|making|shaving|chopping|slicing|cutting|opening|cleaning|washing)\\b|falling|slipping|tripping|in (a|an|the) (car |bike )?(accident|crash|fall)\\b|by (falling|slipping|tripping|accident)\\b|on (paper|cardboard)\\b|accidentally)", "i");
  const SAFE_Q = new RegExp("^\\s*(did i " + VERB + " " + PRON + "\\b|(will|would|could|can|do|does|should|might) i " + VERB + " " + PRON + "\\b(.*\\b(if|when) i (run|lift|squat|do|try|keep|train|work out|exercise|stretch|jump|play|go|use|bend|carry|swim|bike|walk|hold|push|pull|press)\\b|.*\\b(by (doing|lifting|running|squatting|stretching|training|exercising|working out|overdoing|pushing)|doing|lifting|running|squatting|exercis\\w*|working out)\\b| (with|on) (this|that|the|a|my) (?!pills?\\b|meds?\\b|medications?\\b|knife|knives|razor|blade|gun|rope|lighter)\\w+))", "i");
  const SAFE_NEG = new RegExp("\\b(don['’]?t|do not|didn['’]?t|did not) want to " + VERB + " " + PRON + " (doing|lifting|running|squatting|(while|when) (i['’]?m |i )?(lifting|running|squatting|training|working out|exercising|doing|lift|run|squat|train|work out|exercise|do|play|playing|stretch|stretching)|on (the|a)|at (the|a)|in (the|a)|during)\\b|\\b(how (do|can|could|should) i|how to|ways to|tips to) (avoid|prevent) (hurt|harm|cut|injur)(ing|ting)? " + PRON + "\\b(?! ?(tonight|again|anymore|when i['’]?m (sad|upset|alone|angry|depressed|low)))|\\b(squat|lift|run|train|exercis|work out|stretch|play|jump|bend|carry|do (this|that|it|them|these))\\w*( \\w+){0,3} without (hurting|injuring|harming) " + PRON + "\\b", "i");
  // an accident told the other way round: "I fell and hurt myself"
  const ACCIDENT_BEFORE = new RegExp("\\b(fell|slipped|tripped|crashed|stumbled)( down| over| off \\w+)? and (hurt|cut) " + PRON + "\\b", "i");
  const self = (t) => SELF.test(t) && (ON_PURPOSE.test(t) || (!SAFE_Q.test(t) && !SAFE_NEG.test(t) && (INTENT.test(t) || !(ACCIDENT.test(t) || ACCIDENT_BEFORE.test(t)))));
  const kms = (t) => KMS.test(t) || (KMS_ANY.test(t) && !KM_DIST.test(t));
  const isCrisis1 = (t) => { t = t.replace(SPORT, " "); return CRISIS.test(t) || CRISIS2.test(t) || kms(t) || self(t); };
  const SPORT = /\b(did|doing|ran|run|running|do) suicides\b|\bsuicides? (sprints?|drills?|runs?|shuttles?)\b|\b(breathe?|breathing) through (my|the) nose\b/gi;
  const NOT_EMERGENCY = /\b(not|isn['’]?t|non)[- ](an? )?emergency\b/gi;
  const isEmergency1 = (t) => { const u = t.replace(SPORT, " ").replace(NOT_EMERGENCY, " "); return EMERGENCY.test(u) || EMERGENCY2.test(u) || (STROKE.test(u) && (STROKE_NOW.test(u) || !STROKE_PAST.test(u))); };
  const clean = (t) => String(t || "").replace(/[‘`´ʼʹ′]/g, "'").replace(/[​‌⁠﻿]/g, " ").replace(/­/g, "").normalize("NFKC").replace(/\s+/g, " ");
  const SPACED = /\b(?:[a-z][ .]){2,}[a-z]\b/gi;
  const GLUED = /kms|kil+mys|suicid|unaliv|wan(t|na)(to)?d(ie|ei)(?!t)|endmylife|hurtmys|cutmys/i;
  const collapse = (s) => s.replace(SPACED, (m) => m.replace(/[ .]/g, ""));
  const spaced = (s) => (s.match(SPACED) || []).some((m) => GLUED.test(m.replace(/[ .]/g, "")));
  const both = (f, glued) => (t) => { const s = clean(t); if (f(s)) return true; const c = collapse(s); return (c !== s && f(c)) || (glued && spaced(s)); };
  const isCrisis = both(isCrisis1, true);
  const isEmergency = both(isEmergency1, false);
  const isUrgent = (t) => isEmergency(t) || isCrisis(t);
  return { isUrgent, isCrisis };
})();
// ---- crisis words (end of the copy kept in mdfit-guide.js) ----

module.exports = CRISIS_WORDS;
