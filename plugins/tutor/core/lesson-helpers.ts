import type {
  ContentItem,
  Exercise,
  IntroItem,
  LessonSRSItem,
} from "./lesson-types.ts";

export function vocabSRS(items: ContentItem[], tags: string): LessonSRSItem[] {
  return items.map((item) => ({
    front: item.term,
    back: item.meaning,
    reading: item.reading,
    tags,
  }));
}

export function introItems(items: ContentItem[]): IntroItem[] {
  return items.map((item) => ({
    word: item.term,
    reading: item.reading,
    meaning: item.meaning,
  }));
}

export function cloze(
  prompt: string,
  answer: string,
  hint?: string,
  explanation?: string,
  accept?: string[],
): Exercise {
  return {
    type: "cloze",
    prompt,
    answer,
    ...(hint && { hint }),
    ...(explanation && { explanation }),
    ...(accept && { accept }),
  };
}

export function mc(
  prompt: string,
  answer: string,
  distractors: string[],
  explanation?: string,
): Exercise {
  return {
    type: "multiple_choice",
    prompt,
    answer,
    distractors,
    ...(explanation && { explanation }),
  };
}
