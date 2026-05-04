/**
 * Unit 4: Basic Grammar — 6 lessons teaching fundamental Japanese grammar patterns.
 *
 * Primarily hand-written exercises (cloze + MC) since grammar needs carefully
 * crafted contexts. ContentSets used for vocabulary within grammar lessons.
 */

import type { Lesson } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { vocabSRS, patternSRS, cloze, mc } from "./phrase-helpers.ts";

// --- Content Sets ---

const masuVerbsContent: ContentSet = {
  items: [
    { term: "たべます", reading: "tabemasu", meaning: "eat (polite)" },
    { term: "のみます", reading: "nomimasu", meaning: "drink (polite)" },
    { term: "いきます", reading: "ikimasu", meaning: "go (polite)" },
    { term: "きます", reading: "kimasu", meaning: "come (polite)" },
    { term: "みます", reading: "mimasu", meaning: "see/watch (polite)" },
    { term: "ききます", reading: "kikimasu", meaning: "hear/ask (polite)" },
  ],
};

const iAdjectiveFormsContent: ContentSet = {
  items: [
    { term: "おおきくない", reading: "ookikunai", meaning: "not big" },
    { term: "ちいさくない", reading: "chiisakunai", meaning: "not small" },
    { term: "おおきかった", reading: "ookikatta", meaning: "was big" },
    { term: "あたらしくない", reading: "atarashikunai", meaning: "not new" },
    { term: "ふるくない", reading: "furukunai", meaning: "not old" },
    { term: "よくない", reading: "yokunai", meaning: "not good" },
  ],
};

const timeContent: ContentSet = {
  items: [
    { term: "いま", reading: "ima", meaning: "now" },
    { term: "きのう", reading: "kinou", meaning: "yesterday" },
    { term: "きょう", reading: "kyou", meaning: "today" },
    { term: "あした", reading: "ashita", meaning: "tomorrow" },
    { term: "あさ", reading: "asa", meaning: "morning" },
    { term: "よる", reading: "yoru", meaning: "night" },
  ],
};

// --- Lessons ---

export const grammarLessons: Lesson[] = [
  // --- 4.1: XはYです ---
  {
    id: "4.1",
    unit: "grammar",
    unitIndex: 4,
    title: "XはYです (X is Y)",
    prerequisites: ["3.8"],
    introduction: {
      text: "The most fundamental Japanese sentence pattern! は (pronounced 'wa' as a particle) marks the topic, and です means 'is/am/are'. わたしはがくせいです = 'I am a student'. This pattern works for identifying or describing anything.",
      items: [
        { word: "は", reading: "wa", meaning: "topic marker particle", explanation: "Marks the topic of the sentence. Written は but pronounced 'wa' when used as a particle." },
        { word: "です", reading: "desu", meaning: "is/am/are (polite)", explanation: "The polite copula — attaches to nouns and na-adjectives to make polite statements." },
        { word: "がくせい", reading: "gakusei", meaning: "student" },
        { word: "せんせい", reading: "sensei", meaning: "teacher" },
        { word: "にほんじん", reading: "nihonjin", meaning: "Japanese person" },
      ],
    },
    exercises: [
      cloze(
        "わたし___がくせいです",
        "は",
        "Which particle marks the topic?",
        "は (pronounced 'wa') is the topic marker. It tells the listener what you're talking about.",
        ["wa"],
      ),
      cloze(
        "これ___ほんです",
        "は",
        "Which particle goes here?",
        "これは ('this is...') — は marks これ (this) as the topic.",
        ["wa"],
      ),
      mc(
        "What does 'わたしはがくせいです' mean?",
        "I am a student",
        ["I have a student", "The student is me", "I like students"],
        "わたし = I, は = topic marker, がくせい = student, です = am. Literally: 'As for me, (I) am a student.'",
      ),
      mc(
        "What does 'たなかさんはせんせいです' mean?",
        "Tanaka is a teacher",
        ["Tanaka has a teacher", "The teacher is coming", "Tanaka likes teachers"],
        "たなかさん = Mr./Ms. Tanaka, は = topic marker, せんせい = teacher, です = is.",
      ),
      cloze(
        "やまださんはにほんじん___",
        "です",
        "How do you end a polite statement?",
        "です makes the sentence polite. やまださんはにほんじんです = 'Yamada is Japanese.'",
      ),
      {
        type: "production" as const,
        prompt: "Type the particle は (topic marker)",
        answer: "は",
        accept: ["wa"],
        explanation: "は is written with the hiragana は but pronounced 'wa' when used as a particle.",
      },
      mc(
        "How is the particle は pronounced?",
        "wa",
        ["ha", "he", "wo"],
        "Although written は (ha), when used as a topic marker particle, it's pronounced 'wa'. This is one of the few irregular readings in Japanese.",
      ),
      cloze(
        "これ___ペン___",
        "は",
        "Fill in the first blank (topic marker)",
        "これはペンです = 'This is a pen.' は marks the topic.",
        ["wa"],
      ),
      mc(
        "Which sentence means 'This is water'?",
        "これはみずです",
        ["これはみずだ", "みずはこれです", "これをみずです"],
        "これ = this, は = topic marker, みず = water, です = is.",
      ),
      {
        type: "sentence_build" as const,
        prompt: "Arrange to say 'I am a student': わたし / です / は / がくせい",
        answer: "わたしはがくせいです",
        accept: ["わたし は がくせい です"],
      },
      mc(
        "What is the difference between は and が?",
        "は marks the topic, が marks the subject (for now, just use は)",
        ["They are the same", "は is polite, が is casual", "は is for questions only"],
        "は marks what you're talking about (topic). が marks the subject doing the action. For basic 'X is Y' sentences, use は.",
      ),
    ],
    srsItems: patternSRS([
      { front: "XはYです", back: "X is Y (polite)" },
      { front: "がくせい", back: "student" },
      { front: "せんせい", back: "teacher" },
      { front: "にほんじん", back: "Japanese person" },
    ], "grammar_wa_desu"),
    skillsTaught: ["grammar_wa_desu"],
    furiganaLevel: "partial",
  },

  // --- 4.2: Question Sentences (か) ---
  {
    id: "4.2",
    unit: "grammar",
    unitIndex: 4,
    title: "Questions with か",
    prerequisites: ["4.1"],
    introduction: {
      text: "Making questions in Japanese is easy — just add か at the end! No word order change needed. わたしはがくせいです (I am a student) → わたしはがくせいですか (Am I a student? / Are you a student?). In casual speech, you can drop か and just raise your intonation.",
      items: [
        { word: "か", reading: "ka", meaning: "question particle", explanation: "Added to the end of a sentence to make it a question. Like a spoken question mark." },
        { word: "はい", reading: "hai", meaning: "yes" },
        { word: "いいえ", reading: "iie", meaning: "no" },
        { word: "なに/なん", reading: "nani/nan", meaning: "what", explanation: "なに before particles, なん before です and counters." },
        { word: "だれ", reading: "dare", meaning: "who" },
      ],
    },
    exercises: [
      cloze(
        "がくせいです___",
        "か",
        "How do you turn a statement into a question?",
        "Adding か to the end of です turns a statement into a question.",
      ),
      mc(
        "What does 'これはほんですか' mean?",
        "Is this a book?",
        ["This is a book", "This is not a book", "Where is the book?"],
        "これはほんです ('This is a book') + か (question) = 'Is this a book?'",
      ),
      mc(
        "How do you answer 'yes' in Japanese?",
        "はい",
        ["いいえ", "です", "か"],
        "はい = yes, いいえ = no.",
      ),
      cloze(
        "たなかさんはせんせいです___。はい、せんせいです。",
        "か",
        "This is a question expecting a yes/no answer",
        "Adding か makes it a question: 'Is Tanaka a teacher?' — 'Yes, (they are) a teacher.'",
      ),
      mc(
        "What does 'これはなんですか' mean?",
        "What is this?",
        ["Is this something?", "This is what", "Where is this?"],
        "これ = this, は = topic, なん = what, です = is, か = question. 'What is this?'",
      ),
      cloze(
        "___はだれですか",
        "あのひと",
        "Who is that person?",
        "あのひとはだれですか = 'Who is that person?' だれ = who.",
      ),
      {
        type: "production" as const,
        prompt: 'Type the question particle',
        answer: "か",
        accept: ["ka"],
        explanation: "か turns any statement into a question.",
      },
      mc(
        "In casual speech, how can you ask a question without か?",
        "Raise your intonation at the end",
        ["Add ね instead", "Reverse the word order", "Add よ at the end"],
        "In casual Japanese, rising intonation alone can indicate a question, just like in English.",
      ),
      {
        type: "sentence_build" as const,
        prompt: "Arrange to ask 'Is this water?': みず / か / は / です / これ",
        answer: "これはみずですか",
        accept: ["これ は みず です か"],
      },
      mc(
        "What is the correct response to 'にほんじんですか' if you are not Japanese?",
        "いいえ、にほんじんじゃないです",
        ["はい、にほんじんです", "にほんじんですか", "いいえ、にほんじんです"],
        "いいえ = no, にほんじんじゃないです = 'am not Japanese'. じゃない is the negative of です.",
      ),
      cloze(
        "___ですか。ほんです。",
        "なん",
        "What question word asks 'what'?",
        "なんですか = 'What is it?' なん is used before です.",
        ["なに"],
      ),
    ],
    srsItems: patternSRS([
      { front: "Xですか", back: "Is it X? (question)" },
      { front: "はい", back: "yes" },
      { front: "いいえ", back: "no" },
      { front: "なに/なん", back: "what" },
      { front: "だれ", back: "who" },
    ], "grammar_ka"),
    skillsTaught: ["grammar_ka"],
    furiganaLevel: "partial",
  },

  // --- 4.3: Basic Particles ---
  {
    id: "4.3",
    unit: "grammar",
    unitIndex: 4,
    title: "Particles: を、に、で、へ",
    prerequisites: ["4.2"],
    introduction: {
      text: "Particles are small words that mark the role of each word in a sentence. They're the glue of Japanese grammar. を marks the direct object, に marks destination/time, で marks location of action/means, and へ marks direction.",
      items: [
        { word: "を", reading: "wo/o", meaning: "object marker", explanation: "Marks what receives the action. みずをのむ = 'drink water'. Pronounced 'o' in speech." },
        { word: "に", reading: "ni", meaning: "destination/time marker", explanation: "Marks destination (がっこうにいく = go to school) or specific time (さんじにいく = go at 3)." },
        { word: "で", reading: "de", meaning: "location/means marker", explanation: "Marks where an action happens (がっこうでたべる = eat at school) or means (バスでいく = go by bus)." },
        { word: "へ", reading: "e", meaning: "direction marker", explanation: "Similar to に for direction. にほんへいく = go toward Japan. Pronounced 'e' as a particle." },
        { word: "がっこう", reading: "gakkou", meaning: "school" },
      ],
    },
    exercises: [
      cloze(
        "みず___のむ",
        "を",
        "Which particle marks what you drink?",
        "を marks the direct object — the thing receiving the action. みずをのむ = 'drink water'.",
        ["o", "wo"],
      ),
      cloze(
        "がっこう___いく",
        "に",
        "Which particle marks where you're going?",
        "に marks the destination. がっこうにいく = 'go to school'.",
        ["へ", "e"],
      ),
      cloze(
        "がっこう___たべる",
        "で",
        "Which particle marks where an action takes place?",
        "で marks the location where something happens. がっこうでたべる = 'eat at school'.",
      ),
      mc(
        "What does 'ほんをみる' mean?",
        "to look at/read a book",
        ["to go to the book", "to be a book", "to be at the book"],
        "ほん = book, を = object marker, みる = to see/look at.",
      ),
      mc(
        "Which particle would you use in 'eat _at_ school'?",
        "で (location of action)",
        ["を (object)", "に (destination)", "へ (direction)"],
        "で marks where an action happens. がっこうでたべる = 'eat at school'.",
      ),
      cloze(
        "にほん___いく",
        "へ",
        "Going toward Japan — which directional particle?",
        "へ (pronounced 'e') marks direction. にほんへいく = 'go toward Japan'. に also works here.",
        ["に", "e", "ni"],
      ),
      mc(
        "How is the particle を pronounced?",
        "o",
        ["wo", "wa", "we"],
        "Although written を, in modern Japanese it's pronounced 'o' (same as お).",
      ),
      mc(
        "How is the particle へ pronounced when used as a particle?",
        "e",
        ["he", "ha", "ho"],
        "へ is normally 'he' but as a particle it's pronounced 'e'. Similar to は being 'wa' as a particle.",
      ),
      {
        type: "sentence_build" as const,
        prompt: "Arrange: 'I drink water' — わたし / みず / のむ / を / は",
        answer: "わたしはみずをのむ",
        accept: ["わたし は みず を のむ"],
      },
      cloze(
        "バス___いく",
        "で",
        "Going by bus — which particle for means/method?",
        "で also marks the means by which something is done. バスでいく = 'go by bus'.",
      ),
      mc(
        "Which sentence means 'eat at school'?",
        "がっこうでたべる",
        ["がっこうにたべる", "がっこうをたべる", "がっこうへたべる"],
        "で marks the location of an action. がっこうでたべる = 'eat at school'.",
      ),
    ],
    srsItems: patternSRS([
      { front: "Xをverb", back: "verb X (object marker)" },
      { front: "Xにいく", back: "go to X (destination)" },
      { front: "Xでverb", back: "verb at/by X (location/means)" },
      { front: "Xへいく", back: "go toward X (direction)" },
      { front: "がっこう", back: "school" },
    ], "grammar_particles"),
    skillsTaught: ["grammar_particles"],
    furiganaLevel: "partial",
  },

  // --- 4.4: Verb ます form ---
  {
    id: "4.4",
    unit: "grammar",
    unitIndex: 4,
    title: "Polite Verbs: ます form",
    prerequisites: ["4.3"],
    introduction: {
      text: "The ます form makes verbs polite. In Unit 3 you learned dictionary forms (たべる, のむ). Now let's learn the polite versions. For -る verbs: drop る, add ます (たべる → たべます). For -う verbs: change the last sound to -i, add ます (のむ → のみます). Negative: ません. Past: ました.",
      items: [
        { word: "たべます", reading: "tabemasu", meaning: "eat (polite)", explanation: "たべる → たべます. Drop る, add ます." },
        { word: "のみます", reading: "nomimasu", meaning: "drink (polite)", explanation: "のむ → のみます. む→み, add ます." },
        { word: "いきます", reading: "ikimasu", meaning: "go (polite)", explanation: "いく → いきます. く→き, add ます." },
        { word: "きます", reading: "kimasu", meaning: "come (polite)", explanation: "くる → きます. Irregular verb!" },
        { word: "みます", reading: "mimasu", meaning: "see (polite)", explanation: "みる → みます. Drop る, add ます." },
        { word: "ません", reading: "masen", meaning: "negative polite ending", explanation: "Replace ます with ません for negation. たべます → たべません." },
      ],
    },
    exercises: [
      ...generateExercises(masuVerbsContent, "recognition"),
      cloze(
        "たべ___",
        "ます",
        "Make たべる polite",
        "Drop る from たべる and add ます → たべます (eat, polite).",
      ),
      cloze(
        "のみ___",
        "ます",
        "Make のむ polite",
        "Change む to み and add ます → のみます (drink, polite).",
      ),
      mc(
        "What is the polite form of いく (to go)?",
        "いきます",
        ["いくます", "います", "いかます"],
        "いく → いきます. The く changes to き before adding ます.",
      ),
      mc(
        "How do you say 'I don't eat' politely?",
        "たべません",
        ["たべます", "たべました", "たべないます"],
        "Replace ます with ません for negation: たべます → たべません.",
      ),
      cloze(
        "きのうがっこうにいき___",
        "ました",
        "Past tense polite",
        "ました is the past tense of ます. いきました = 'went' (polite).",
      ),
      mc(
        "What is the polite past of のむ?",
        "のみました",
        ["のみます", "のみません", "のむました"],
        "のみ + ました = のみました (drank, polite past).",
      ),
      mc(
        "くる (to come) is irregular. What is its ます form?",
        "きます",
        ["くります", "くるます", "こます"],
        "くる → きます is irregular — just memorize it! The other irregular verb is する → します.",
      ),
      {
        type: "production" as const,
        prompt: 'Type the polite form of **たべる** (to eat)',
        answer: "たべます",
        accept: ["tabemasu"],
      },
      {
        type: "production" as const,
        prompt: 'Type the polite negative of **いく** (to go)',
        answer: "いきません",
        accept: ["ikimasen"],
      },
    ],
    srsItems: [
      ...vocabSRS(masuVerbsContent.items, "masu_form"),
      ...patternSRS([
        { front: "ます", back: "polite verb ending (present/future)" },
        { front: "ません", back: "polite verb ending (negative)" },
        { front: "ました", back: "polite verb ending (past)" },
      ], "masu_form"),
    ],
    skillsTaught: ["grammar_masu"],
    furiganaLevel: "partial",
  },

  // --- 4.5: い-Adjectives ---
  {
    id: "4.5",
    unit: "grammar",
    unitIndex: 4,
    title: "い-Adjective Conjugation",
    prerequisites: ["4.4"],
    introduction: {
      text: "い-adjectives conjugate by changing the final い. Negative: drop い, add くない (おおきい → おおきくない). Past: drop い, add かった (おおきい → おおきかった). Exception: いい (good) → よくない / よかった — it uses the old form よい.",
      items: [
        { word: "おおきくない", reading: "ookikunai", meaning: "not big", explanation: "おおきい → drop い → おおき + くない" },
        { word: "おおきかった", reading: "ookikatta", meaning: "was big", explanation: "おおきい → drop い → おおき + かった" },
        { word: "よくない", reading: "yokunai", meaning: "not good", explanation: "いい is irregular! Uses old form よい → よ + くない" },
        { word: "よかった", reading: "yokatta", meaning: "was good", explanation: "いい → よい → よ + かった. 'That was good!'" },
      ],
    },
    exercises: [
      ...generateExercises(iAdjectiveFormsContent, "recognition").slice(0, 4),
      cloze(
        "おおき___",
        "くない",
        "Make おおきい negative",
        "Drop い from おおきい and add くない → おおきくない (not big).",
      ),
      cloze(
        "ちいさ___",
        "かった",
        "Make ちいさい past tense",
        "Drop い from ちいさい and add かった → ちいさかった (was small).",
      ),
      mc(
        "What is the negative of いい (good)?",
        "よくない",
        ["いくない", "いいくない", "いくなくない"],
        "いい is irregular — its negative uses the old form よい: よ + くない = よくない.",
      ),
      mc(
        "What does よかった mean?",
        "was good / that's great",
        ["not good", "will be good", "very good"],
        "よかった is the past tense of いい. It's one of the most common expressions — 'That was good!' / 'Thank goodness!'",
      ),
      cloze(
        "あたらし___",
        "くない",
        "Make あたらしい negative",
        "Drop い, add くない: あたらしい → あたらしくない (not new).",
      ),
      mc(
        "How do you say 'was old' (past tense of ふるい)?",
        "ふるかった",
        ["ふるいかった", "ふるくかった", "ふるだった"],
        "ふるい → drop い → ふる + かった = ふるかった.",
      ),
      {
        type: "production" as const,
        prompt: 'Type the negative of **おおきい** (big)',
        answer: "おおきくない",
        accept: ["ookikunai"],
      },
      {
        type: "production" as const,
        prompt: 'Type the past tense of **いい** (good)',
        answer: "よかった",
        accept: ["yokatta"],
      },
      mc(
        "What pattern do い-adjective negatives follow?",
        "Drop い, add くない",
        ["Add ない after い", "Change い to く", "Add じゃない"],
        "For い-adjectives: drop the final い, then add くない. This is different from nouns, which use じゃない.",
      ),
      mc(
        "Which is correct for 'was not big'?",
        "おおきくなかった",
        ["おおきくないった", "おおきかったない", "おおきいなかった"],
        "Negative past: drop い, add くなかった. おおきい → おおきくなかった.",
      ),
    ],
    srsItems: [
      ...vocabSRS(iAdjectiveFormsContent.items, "i_adjective_conjugation"),
      ...patternSRS([
        { front: "い → くない", back: "い-adjective negative" },
        { front: "い → かった", back: "い-adjective past" },
        { front: "い → くなかった", back: "い-adjective negative past" },
        { front: "よかった", back: "was good (irregular past of いい)" },
      ], "i_adjective_conjugation"),
    ],
    skillsTaught: ["grammar_i_adjectives"],
    furiganaLevel: "partial",
  },

  // --- 4.6: Time Expressions ---
  {
    id: "4.6",
    unit: "grammar",
    unitIndex: 4,
    title: "Time Expressions",
    prerequisites: ["4.5"],
    introduction: {
      text: "Time words tell when something happens. In Japanese, time expressions usually come near the beginning of the sentence, before the main action. きのうがっこうにいきました = 'Yesterday I went to school.' Some time words use に (specific times/dates), but relative times like きのう, きょう, あした do not.",
      items: timeContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(timeContent, "recognition"),
      ...generateExercises(timeContent, "production").slice(0, 3),
      mc(
        "What does 'きのうほんをよみました' mean?",
        "Yesterday I read a book",
        ["Today I read a book", "Tomorrow I will read a book", "I am reading a book now"],
        "きのう = yesterday, ほん = book, を = object, よみました = read (past polite).",
      ),
      cloze(
        "___がっこうにいきます",
        "あした",
        "Tomorrow I will go to school",
        "あした (tomorrow) goes at the beginning. あしたがっこうにいきます = 'Tomorrow I will go to school.'",
      ),
      mc(
        "Which sentence correctly says 'I eat in the morning'?",
        "あさたべます",
        ["あさにたべます", "たべますあさ", "あさをたべます"],
        "Relative time words (あさ, よる, きのう, etc.) don't need に. あさたべます = 'I eat in the morning.'",
      ),
      cloze(
        "___みずをのみます",
        "いま",
        "I will drink water now",
        "いま (now) goes at the start. いまみずをのみます = 'I will drink water now.'",
      ),
      mc(
        "Where do time expressions usually go in a Japanese sentence?",
        "Near the beginning, before the action",
        ["At the end, after the verb", "Right before the particle", "After です"],
        "Time expressions typically come early in the sentence: きのう + がっこうに + いきました.",
      ),
    ],
    srsItems: vocabSRS(timeContent.items, "time_expressions"),
    skillsTaught: ["grammar_time"],
    furiganaLevel: "partial",
  },
];
