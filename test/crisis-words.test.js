// The words that stop a message before it reaches the assistant and give the emergency or crisis answer instead.
// The app checks the same words first (mdfit-frontend/mdfit-guide.js); a sentence here must be judged the same there.
// When in doubt a message counts: a crisis answer to an ordinary sentence costs a moment, a missed crisis does not.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isUrgent, isCrisis } = require("../lib/guide-ai");

// Every one of these is a crisis or an emergency.
const URGENT = [
  // not wanting to live, wanting to die
  "I want to kill myself", "i want to kill myself", "I WANT TO KILL MYSELF", "I'm going to kill myself", "im gonna kill myself", "I'm thinking of killing myself",
  "I keep thinking about killing myself", "I have thought about killing myself", "I've thought of killing myself", "I might kill myself", "I could kill myself tonight",
  "I'm planning to kill myself", "trying to kill myself", "I tried to kill myself", "I tried killing myself", "I'm about to kill myself", "I will kill myself", "I'll kill myself",
  "I want to kill my self", "I want to unalive myself", "kms",
  "I'm suicidal", "SUICIDAL thoughts", "I attempted suicide", "I feel suicidal", "thinking about suicide",
  "I want to end my life", "I'm going to end it all", "I'll end it all tonight", "I give up, I want to end it all", "I feel like ending it", "I want to end it",
  "I want to die", "I WANT TO DIE", "i wanna die", "I just want to die", "god I want to die", "Sometimes I wish I was dead", "I wish I were dead", "I wish I wasn't alive",
  "everyone would be better off dead", "they'd be better off if I was dead", "I'd be better off dead", "they would be better off without me",
  "I don't want to live", "I don’t want to live anymore", "I DON'T WANT TO LIVE", "I dont want to be alive", "I don't want to be here anymore", "I don’t want to be here anymore",
  "I don't want to live in this world", "I DON'T WANT TO LIVE IN THIS WORLD", "I don't want to live in pain anymore", "I don't want to live like this", "I do not want to live like this",
  "I do not want to live at all", "I don't want to be alive in this body", "I don't want to be here at all", "I don't want to live in this body anymore",
  "I don't want to be here in this world", "I don't want to live in a world without her", "I don't want to be alive in the morning", "I don't want to be here near anyone",
  "I don’t want to be alive at this point", "I do not want to be alive in this world",
  // harming oneself
  "I want to hurt myself", "I WANT TO HURT MYSELF", "I'm going to hurt myself", "im gonna hurt myself", "I wanna hurt myself", "gonna hurt myself tonight",
  "I feel like hurting myself", "I feel like I want to hurt myself", "I need to hurt myself", "I will hurt myself", "I'll hurt myself", "I could hurt myself",
  "I have been hurting myself on purpose", "I hurt myself on purpose", "I hurt myself last night on purpose", "I've been hurting myself", "I keep hurting myself on purpose",
  "I'm scared I'll hurt myself", "I am afraid I will hurt myself", "I might hurt myself tonight", "I think I might hurt myself", "I hurt myself when I'm sad",
  "I have urges to hurt myself", "I have the urge to hurt myself", "planning to hurt myself", "I tried to hurt myself", "I'm about to hurt myself", "i want to hurt my self",
  "I'm thinking about hurting myself", "thought about hurting myself", "I hurt myself intentionally", "I hurt myself deliberately", "I want to hurt myself again",
  "I'm going to hurt myself badly", "going to hurt myself on purpose", "trying to hurt myself",
  "I'm cutting myself", "I cut myself", "I want to harm myself", "I might harm myself", "I keep harming myself", "i'm going to harm myself", "Ive been thinking of harming myself",
  "I self harm", "self-harming again", "I have been self harming", "SELF HARM", "self-harm",
  // a medical emergency
  "I took too many pills, overdose", "I think I overdosed", "it was an overdose", "I can't breathe", "I can’t breathe", "I CANT BREATHE", "I cannot breathe",
  "having a hard time breathing", "trouble breathing", "trouble breathing since last night", "difficulty breathing", "I'm struggling to breathe", "it is hard to breathe",
  "chest pain", "CHEST PAINS", "I am having chest pains", "heart attack", "I think it is a heart attack", "I have had two heart attacks", "signs of a stroke",
  "sudden numbness in my face", "numb in my arm", "I passed out", "she fainted", "severe bleeding", "call 911", "this is an emergency",
];

// Ordinary sentences, injuries above all: pain help, never the crisis answer.
const ORDINARY = [
  "I hurt myself lifting yesterday", "I might hurt myself doing that", "I keep hurting myself in the gym", "I hurt myself playing golf", "I think I hurt myself on the treadmill",
  "I hurt myself again on the stairs", "I'm afraid I'll hurt myself if I squat", "How do I avoid hurting myself", "I don't want to hurt myself doing this exercise",
  "will I hurt myself if I run", "I hurt myself skiing", "I am trying not to hurt myself", "I'm scared of hurting myself again", "I hurt myself carrying groceries",
  "did I hurt myself? my shoulder clicks", "I want to try to hurt myself less", "I hurt myself bending over", "I hurt myself doing deadlifts", "I'm about to hurt myself laughing",
  "I cut myself shaving", "I cut myself cooking",
  "my back is killing me", "oh god my stomach is killing me", "dying to try the new program", "I am dying to try the new program", "this workout is killer",
  "I want to live healthier", "I want to diet", "I wanna diet", "I want to diet and lose weight", "my legs are dying", "I'm dead tired", "I almost died laughing", "I want to kill it at the gym",
  "breathing exercises for stress", "I have trouble sleeping", "it is hard to stretch my hip", "this stretch is hard", "my knee hurts", "where are the programs",
  "I'm going to try harder", "I keep hurting my knee", "hurt my back", "I hurt my shoulder", "kill the pain", "I think I strained my hamstring", "I got hurt at work",
  "I'm going to hurt tomorrow", "I'm going to be sore", "I want to hurt my opponent on the court", "I'm trying to harm-proof my knee", "the harm in stretching",
  "I want to strengthen myself", "I want to push myself", "I'm going to push myself harder", "I'm thinking about hiring a trainer", "I want to stretch myself",
  "I'm planning to train myself", "I want to end my membership", "end the workout early",
];

// Counted on purpose although they may be ordinary: the words cannot tell these from a crisis, so they lean to safety.
const CAUTIOUS = ["I don't want to live in Florida", "I don't want to be here at the gym", "I don't want to live with this pain", "I hurt myself twice this week"];

test("crisis words: every crisis and emergency sentence counts, in any case, with the phone's apostrophe", () => {
  for (const t of URGENT) {
    assert.equal(isUrgent(t), true, t);
    assert.equal(isUrgent(t.toUpperCase()), true, t.toUpperCase());
    assert.equal(isUrgent(t.toLowerCase()), true, t.toLowerCase());
  }
});

test("crisis words: ordinary sentences and injuries do not count", () => {
  for (const t of ORDINARY) assert.equal(isUrgent(t), false, t);
});

test("crisis words: sentences the words cannot tell apart lean to safety", () => {
  for (const t of CAUTIOUS) assert.equal(isUrgent(t), true, t);
});

test("crisis words: a crisis is told from a medical emergency, so the app can offer the crisis line", () => {
  for (const t of ["I want to die", "I want to hurt myself", "I self harm", "I don't want to be here anymore", "kms"]) assert.equal(isCrisis(t), true, t);
  for (const t of ["chest pain", "I can't breathe", "she fainted", "call 911", "I hurt myself lifting yesterday"]) assert.equal(isCrisis(t), false, t);
});
