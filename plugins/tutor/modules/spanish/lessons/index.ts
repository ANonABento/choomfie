/**
 * Spanish lesson registry — A1 foundations organized into pronunciation, grammar, and vocabulary.
 */

import type { Lesson, Unit } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { spanishA1ByTerms, spanishA1Vocab } from "../data/a1-vocab.ts";
import { cloze, introItems, mc, vocabSRS } from "./helpers.ts";

function content(terms: string[]): ContentSet {
  return { items: spanishA1ByTerms(terms), productionLabel: "Spanish" };
}

function vocabularyLesson(
  id: string,
  title: string,
  prerequisites: string[],
  terms: string[],
  introduction: string,
  skill: string,
): Lesson {
  const lessonContent = content(terms);
  return {
    id,
    unit: "vocabulary",
    unitIndex: 3,
    title,
    prerequisites,
    introduction: {
      text: introduction,
      items: introItems(lessonContent.items),
    },
    exercises: [
      ...generateExercises(lessonContent, "recognition"),
      ...generateExercises(lessonContent, "production").slice(0, 3),
      ...generateExercises({ items: lessonContent.items.slice(0, 5) }, "matching"),
    ],
    srsItems: vocabSRS(lessonContent.items, `spanish_a1_${skill}`),
    skillsTaught: [`spanish_a1_${skill}`],
  };
}

const greetingContent = content(["hola", "adiós", "por favor", "gracias", "perdón"]);
const vowelContent: ContentSet = {
  items: [
    { term: "a", reading: "/a/", meaning: "open a as in casa" },
    { term: "e", reading: "/e/", meaning: "clear e as in mesa" },
    { term: "i", reading: "/i/", meaning: "clear i as in si" },
    { term: "o", reading: "/o/", meaning: "clear o as in no" },
    { term: "u", reading: "/u/", meaning: "clear u as in tu" },
  ],
};
const spellingSoundContent: ContentSet = {
  items: [
    { term: "que", reading: "/ke/", meaning: "qu makes k before e" },
    { term: "ciudad", reading: "/sju.dad/", meaning: "c before i sounds like s in Latin America" },
    { term: "chico", reading: "/tʃi.ko/", meaning: "ch sounds like English ch" },
    { term: "llamo", reading: "/ja.mo/", meaning: "ll sounds like y in many dialects" },
    { term: "jugar", reading: "/xu.gar/", meaning: "j is a strong h-like sound" },
  ],
};

export const spanishLessons: Lesson[] = [
  {
    id: "1.1",
    unit: "pronunciation",
    unitIndex: 1,
    title: "Spanish Vowel Sounds",
    prerequisites: [],
    introduction: {
      text: "Spanish A1 pronunciation starts with five stable vowel sounds. They stay short and clear, which makes basic words easier to read aloud.",
      items: introItems(vowelContent.items),
    },
    exercises: [
      ...generateExercises(vowelContent, "recognition"),
      mc("Which Spanish vowel is pronounced /i/?", "i", ["e", "a", "u"]),
      mc("Which word has the /o/ vowel?", "no", ["sí", "tú", "de"]),
      cloze("Type the Spanish vowel in **casa** that sounds /a/.", "a"),
      cloze("Type the Spanish vowel in **mesa** that sounds /e/.", "e"),
    ],
    srsItems: [],
    skillsTaught: ["spanish_vowels"],
  },
  {
    id: "1.2",
    unit: "pronunciation",
    unitIndex: 1,
    title: "Silent H and Core Greetings",
    prerequisites: ["1.1"],
    introduction: {
      text: "The letter h is silent in Spanish. Practice common greetings and polite words with simple, predictable pronunciation.",
      items: introItems(greetingContent.items),
    },
    exercises: [
      ...generateExercises(greetingContent, "recognition"),
      cloze("Type the Spanish for **hello**.", "hola", "The h is silent.", undefined, ["ola"]),
      mc("Which word begins with a silent h?", "hola", ["gracias", "adiós", "perdón"]),
      mc("What does **gracias** mean?", "thank you", ["please", "goodbye", "sorry"]),
      cloze("Type the Spanish for **please**.", "por favor"),
    ],
    srsItems: [],
    skillsTaught: ["silent_h", "basic_greetings"],
  },
  {
    id: "1.3",
    unit: "pronunciation",
    unitIndex: 1,
    title: "Spelling to Sound",
    prerequisites: ["1.2"],
    introduction: {
      text: "Spanish spelling is regular. Learn a few high-value sound rules before building vocabulary: qu, c before e/i, ch, ll, and j.",
      items: introItems(spellingSoundContent.items),
    },
    exercises: [
      ...generateExercises(spellingSoundContent, "recognition"),
      mc("In Latin American Spanish, c before e or i usually sounds like:", "s", ["k", "ch", "r"]),
      mc("Which spelling gives the /tʃ/ sound?", "ch", ["qu", "ll", "j"]),
      cloze("Type the two-letter spelling that makes /k/ before e in **que**.", "qu"),
      cloze("Type the letter that is silent in **hola**.", "h"),
    ],
    srsItems: [],
    skillsTaught: ["spanish_spelling_sound"],
  },
  {
    id: "2.1",
    unit: "grammar",
    unitIndex: 2,
    title: "Subject Pronouns and Ser",
    prerequisites: ["1.3"],
    introduction: {
      text: "Use subject pronouns with ser for identity: yo soy, tú eres, él/ella es, nosotros somos. Spanish often drops the pronoun when the verb is clear.",
      items: introItems(content(["yo", "tú", "usted", "él", "ella", "nosotros", "nosotras"]).items),
    },
    exercises: [
      mc("Choose the Spanish for **I am**.", "yo soy", ["yo eres", "tu soy", "ella somos"]),
      mc("Choose the Spanish for **you are** with informal tú.", "tú eres", ["tú es", "usted eres", "yo soy"]),
      cloze("Complete: **Ella ___ estudiante.**", "es", undefined, undefined, ["ella es"]),
      cloze("Complete: **Nosotros ___ amigos.**", "somos"),
      mc("Which verb is used for identity?", "ser", ["estar", "tener", "ir"]),
    ],
    srsItems: [],
    skillsTaught: ["spanish_ser_pronouns"],
  },
  {
    id: "2.2",
    unit: "grammar",
    unitIndex: 2,
    title: "Estar, Location, and State",
    prerequisites: ["2.1"],
    introduction: {
      text: "Use estar for location and temporary state: estoy aquí, la escuela está allí, estoy bien. Keep ser for identity.",
      items: introItems(content(["estar", "aquí", "allí", "bien", "mal", "casa", "escuela"]).items),
    },
    exercises: [
      mc("Choose the Spanish for **I am here**.", "Estoy aquí.", ["Soy aquí.", "Tengo aquí.", "Voy aquí."]),
      mc("Which verb fits location?", "estar", ["ser", "tener", "hacer"]),
      cloze("Complete: **La escuela ___ allí.**", "está", undefined, undefined, ["esta"]),
      cloze("Complete: **Estoy ___.** for **fine**.", "bien"),
      mc("Which sentence uses ser correctly?", "Soy estudiante.", ["Estoy estudiante.", "Tengo estudiante.", "Voy estudiante."]),
    ],
    srsItems: [],
    skillsTaught: ["spanish_estar_location"],
  },
  {
    id: "2.3",
    unit: "grammar",
    unitIndex: 2,
    title: "Questions and Basic Word Order",
    prerequisites: ["2.2"],
    introduction: {
      text: "Spanish A1 questions use question words like que, quien, donde, cuando, como, and cuanto. Basic statements often follow subject + verb + extra information.",
      items: introItems(content(["qué", "quién", "dónde", "cuándo", "cómo", "cuánto"]).items),
    },
    exercises: [
      ...generateExercises(content(["qué", "quién", "dónde", "cuándo", "cómo", "cuánto"]), "recognition"),
      mc("Which word asks **where**?", "dónde", ["cuándo", "quién", "cuánto"]),
      mc("Which word asks **who**?", "quién", ["qué", "cómo", "dónde"]),
      cloze("Type the Spanish question word for **what**.", "qué", undefined, undefined, ["que"]),
      cloze("Complete: **¿___ estás?** for **How are you?**", "cómo", undefined, undefined, ["como"]),
    ],
    srsItems: [],
    skillsTaught: ["spanish_questions"],
  },
  vocabularyLesson(
    "3.1",
    "Greetings and Time",
    ["2.3"],
    ["hola", "adiós", "por favor", "gracias", "perdón", "sí", "no", "bien", "mal", "hoy", "mañana", "ayer", "ahora", "siempre", "nunca"],
    "Begin A1 vocabulary with greetings, polite words, and high-frequency time words for short conversations.",
    "greetings_time",
  ),
  vocabularyLesson(
    "3.2",
    "Pronouns and Questions",
    ["3.1"],
    ["yo", "tú", "usted", "él", "ella", "nosotros", "nosotras", "ellos", "ellas", "qué", "quién", "dónde", "cuándo", "cómo", "cuánto"],
    "Pronouns and question words let students introduce people and ask for basic information.",
    "pronouns_questions",
  ),
  vocabularyLesson(
    "3.3",
    "Numbers 0-10",
    ["3.2"],
    ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"],
    "Numbers support ages, prices, dates, phone numbers, and simple quantities.",
    "numbers",
  ),
  vocabularyLesson(
    "3.4",
    "People and Family",
    ["3.3"],
    ["persona", "hombre", "mujer", "niño", "niña", "amigo", "amiga", "familia", "madre", "padre", "hermano", "hermana", "profesor", "profesora", "estudiante"],
    "People and family words make basic introductions and classroom exchanges possible.",
    "people_family",
  ),
  vocabularyLesson(
    "3.5",
    "Places",
    ["3.4"],
    ["casa", "escuela", "clase", "ciudad", "país", "calle", "tienda", "trabajo", "restaurante", "baño"],
    "Place words combine with estar, ir, and basic questions about where things are.",
    "places",
  ),
  vocabularyLesson(
    "3.6",
    "Food and Drink",
    ["3.5"],
    ["agua", "café", "té", "leche", "pan", "arroz", "pollo", "pescado", "carne", "fruta", "manzana", "verdura"],
    "Food and drink vocabulary supports ordering, preferences, and simple daily routines.",
    "food_drink",
  ),
  vocabularyLesson(
    "3.7",
    "Objects and Transport",
    ["3.6"],
    ["mesa", "silla", "libro", "cuaderno", "teléfono", "computadora", "dinero", "coche", "tren", "autobús"],
    "Everyday objects and transport words are useful in classrooms, homes, and travel contexts.",
    "objects_transport",
  ),
  vocabularyLesson(
    "3.8",
    "Common Verbs",
    ["3.7"],
    ["ser", "estar", "tener", "hacer", "ir", "venir", "vivir", "hablar", "comer", "beber", "leer", "escribir", "comprar", "ver", "escuchar", "querer"],
    "Core verbs let students form simple sentences about identity, location, possession, movement, and daily actions.",
    "verbs",
  ),
  vocabularyLesson(
    "3.9",
    "Descriptions",
    ["3.8"],
    ["grande", "pequeño", "bueno", "malo", "nuevo", "viejo", "bonito", "fácil", "difícil", "caliente", "frío", "rápido", "lento", "mucho", "poco"],
    "Adjectives and quantity words help describe people, things, temperatures, speed, and amounts.",
    "descriptions",
  ),
  vocabularyLesson(
    "3.10",
    "Location and Connectors",
    ["3.9"],
    ["aquí", "allí", "con", "sin", "en", "de", "para", "porque"],
    "Small location and connector words turn vocabulary into useful A1 sentences.",
    "connectors",
  ),
  {
    id: "3.11",
    unit: "vocabulary",
    unitIndex: 3,
    title: "A1 Vocabulary Review",
    prerequisites: ["3.10"],
    introduction: {
      text: "This final A1 lesson mixes common words from the full Spanish vocabulary set for recognition, matching, and production practice.",
    },
    exercises: [
      ...generateExercises(content(["hola", "gracias", "familia", "escuela", "agua"]), "recognition"),
      ...generateExercises(content(["ser", "estar", "tener", "hablar", "comer"]), "matching"),
      ...generateExercises(content(["grande", "pequeño", "fácil", "difícil", "rápido"]), "matching"),
      cloze("Type the Spanish for **I**.", "yo"),
      cloze("Type the Spanish for **to speak**.", "hablar"),
      mc("Which word means **because**?", "porque", ["para", "sin", "aquí"]),
      mc("Which word means **where**?", "dónde", ["cuándo", "quién", "cuánto"]),
    ],
    srsItems: [],
    skillsTaught: ["spanish_a1_review"],
  },
];

export const spanishUnits: Unit[] = [
  {
    index: 1,
    id: "pronunciation",
    name: "Pronunciation",
    icon: "🔊",
    lessonIds: spanishLessons.filter((lesson) => lesson.unit === "pronunciation").map((lesson) => lesson.id),
  },
  {
    index: 2,
    id: "grammar",
    name: "A1 Grammar",
    icon: "🧩",
    lessonIds: spanishLessons.filter((lesson) => lesson.unit === "grammar").map((lesson) => lesson.id),
  },
  {
    index: 3,
    id: "vocabulary",
    name: "A1 Vocabulary",
    icon: "📘",
    lessonIds: spanishLessons.filter((lesson) => lesson.unit === "vocabulary").map((lesson) => lesson.id),
  },
];

export const spanishA1VocabularyItems = spanishA1Vocab;
