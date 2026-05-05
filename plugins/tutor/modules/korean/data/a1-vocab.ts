import type { ContentItem } from "../../../core/lesson-types.ts";

export const koreanA1Vocab: ContentItem[] = [
  // Greetings and courtesy expressions
  { term: "안녕하세요", reading: "annyeonghaseyo", meaning: "hello (polite)" },
  { term: "안녕히 가세요", reading: "annyeonghi gaseyo", meaning: "goodbye (to someone leaving)" },
  { term: "안녕히 계세요", reading: "annyeonghi gyeseyo", meaning: "goodbye (to someone staying)" },
  { term: "감사합니다", reading: "gamsahamnida", meaning: "thank you (formal)" },
  { term: "감사해요", reading: "gamsahaeyo", meaning: "thank you (polite)" },
  { term: "죄송합니다", reading: "joesonghamnida", meaning: "I'm sorry (formal)" },
  { term: "괜찮아요", reading: "gwaenchanayo", meaning: "it's okay; no problem" },
  { term: "네", reading: "ne", meaning: "yes" },
  { term: "아니요", reading: "aniyo", meaning: "no" },
  { term: "이름이 뭐예요", reading: "ireumi mwoyeyo", meaning: "what is your name?" },
  { term: "반갑습니다", reading: "bangapseumnida", meaning: "nice to meet you" },

  // Pronouns and people
  { term: "저", reading: "jeo", meaning: "I; me (humble)" },
  { term: "나", reading: "na", meaning: "I; me (informal)" },
  { term: "우리", reading: "uri", meaning: "we; our" },
  { term: "당신", reading: "dangsin", meaning: "you (formal)" },
  { term: "사람", reading: "saram", meaning: "person" },
  { term: "친구", reading: "chingu", meaning: "friend" },
  { term: "선생님", reading: "seonsaengnim", meaning: "teacher" },
  { term: "학생", reading: "haksaeng", meaning: "student" },

  // Family
  { term: "가족", reading: "gajok", meaning: "family" },
  { term: "아버지", reading: "abeoji", meaning: "father" },
  { term: "어머니", reading: "eomeoni", meaning: "mother" },
  { term: "형", reading: "hyeong", meaning: "older brother (male speaker)" },
  { term: "언니", reading: "eonni", meaning: "older sister (female speaker)" },
  { term: "동생", reading: "dongsaeng", meaning: "younger sibling" },

  // Numbers — Sino-Korean
  { term: "일", reading: "il", meaning: "one (Sino-Korean)" },
  { term: "이", reading: "i", meaning: "two (Sino-Korean)" },
  { term: "삼", reading: "sam", meaning: "three (Sino-Korean)" },
  { term: "사", reading: "sa", meaning: "four (Sino-Korean)" },
  { term: "오", reading: "o", meaning: "five (Sino-Korean)" },
  { term: "육", reading: "yuk", meaning: "six (Sino-Korean)" },
  { term: "칠", reading: "chil", meaning: "seven (Sino-Korean)" },
  { term: "팔", reading: "pal", meaning: "eight (Sino-Korean)" },
  { term: "구", reading: "gu", meaning: "nine (Sino-Korean)" },
  { term: "십", reading: "sip", meaning: "ten (Sino-Korean)" },
  { term: "백", reading: "baek", meaning: "hundred (Sino-Korean)" },

  // Numbers — Native Korean
  { term: "하나", reading: "hana", meaning: "one (native Korean)" },
  { term: "둘", reading: "dul", meaning: "two (native Korean)" },
  { term: "셋", reading: "set", meaning: "three (native Korean)" },
  { term: "넷", reading: "net", meaning: "four (native Korean)" },
  { term: "다섯", reading: "daseot", meaning: "five (native Korean)" },

  // Food and drink
  { term: "밥", reading: "bap", meaning: "rice; meal" },
  { term: "물", reading: "mul", meaning: "water" },
  { term: "커피", reading: "keopi", meaning: "coffee" },
  { term: "빵", reading: "ppang", meaning: "bread" },
  { term: "먹다", reading: "meokda", meaning: "to eat" },
  { term: "마시다", reading: "masida", meaning: "to drink" },

  // Places
  { term: "한국", reading: "hanguk", meaning: "Korea" },
  { term: "학교", reading: "hakgyo", meaning: "school" },
  { term: "집", reading: "jip", meaning: "house; home" },
  { term: "식당", reading: "sikdang", meaning: "restaurant" },
  { term: "병원", reading: "byeongwon", meaning: "hospital" },

  // Time
  { term: "오늘", reading: "oneul", meaning: "today" },
  { term: "내일", reading: "naeil", meaning: "tomorrow" },
  { term: "어제", reading: "eoje", meaning: "yesterday" },
  { term: "지금", reading: "jigeum", meaning: "now" },
  { term: "시간", reading: "sigan", meaning: "time; hour" },

  // Weather
  { term: "날씨", reading: "nalssi", meaning: "weather" },
  { term: "비", reading: "bi", meaning: "rain" },
  { term: "눈", reading: "nun", meaning: "snow" },
  { term: "바람", reading: "baram", meaning: "wind" },
  { term: "덥다", reading: "deopda", meaning: "to be hot" },
  { term: "춥다", reading: "chupda", meaning: "to be cold" },

  // Common verbs and adjectives
  { term: "이다", reading: "ida", meaning: "to be (copula)" },
  { term: "있다", reading: "itda", meaning: "to have; to exist" },
  { term: "없다", reading: "eopda", meaning: "to not have; to not exist" },
  { term: "가다", reading: "gada", meaning: "to go" },
  { term: "오다", reading: "oda", meaning: "to come" },
  { term: "하다", reading: "hada", meaning: "to do" },
  { term: "좋다", reading: "jota", meaning: "to be good; to like" },
  { term: "크다", reading: "keuda", meaning: "to be big" },
  { term: "작다", reading: "jakda", meaning: "to be small" },
  { term: "많다", reading: "manta", meaning: "to be many; much" },
];

export function koreanByTerms(terms: string[]): ContentItem[] {
  const map = new Map(koreanA1Vocab.map((item) => [item.term, item]));
  return terms.map((term) => {
    const item = map.get(term);
    if (!item) throw new Error(`Korean vocab term not found: "${term}"`);
    return item;
  });
}
