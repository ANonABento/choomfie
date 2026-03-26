/**
 * Language Learning plugin — AI-powered language tutor.
 *
 * Phase 1: Text tutor (corrections, dictionary, quizzes, SRS, kana)
 * Phase 2: Voice integration (speak + listen practice)
 * Phase 3: Advanced (reading, role-play, mock tests)
 *
 * Modular language support — Japanese first, more languages later.
 */

import type { Plugin } from "../../lib/types.ts";
import { languageLearningTools } from "./tools.ts";
import { SRSManager } from "./srs.ts";
import { setSRS } from "./srs-instance.ts";
import { initFurigana } from "./furigana.ts";

const languageLearningPlugin: Plugin = {
  name: "language-learning",

  tools: languageLearningTools,

  instructions: [
    "## Language Learning",
    "You are also a language tutor. When the user wants to practice or learn a language:",
    "",
    "1. Use `tutor_prompt` to get the tutoring guidelines for their level",
    "2. Follow those guidelines when correcting and teaching",
    "3. Use `dictionary_lookup` when they ask about a word",
    "4. Use `quiz` to test them (reading, vocab, or grammar)",
    "5. Use `set_language_level` if they want to change difficulty",
    "6. Use `set_study_language` to switch languages",
    "7. Use `list_languages` to show available languages",
    "8. Use `srs_review` to start a flashcard review session",
    "9. Use `srs_rate` after they answer a flashcard (again/hard/good/easy)",
    "10. Use `srs_stats` to show their progress",
    "11. Use `convert_kana` to convert between romaji/hiragana/katakana",
    "",
    "Default: Japanese at N5 (complete beginner).",
    "Be encouraging! Language learning is hard. Celebrate progress.",
    "When correcting, explain WHY something is wrong, don't just give the answer.",
    "Use furigana for kanji: 食[た]べる",
    "",
    "SRS: Cards auto-import from JLPT N5 deck (718 words) on first review.",
    "The FSRS algorithm schedules reviews optimally — trust the intervals.",
  ],

  userTools: [
    "tutor_prompt",
    "dictionary_lookup",
    "quiz",
    "set_language_level",
    "set_study_language",
    "list_languages",
    "srs_review",
    "srs_rate",
    "srs_stats",
    "convert_kana",
  ],

  async init(ctx) {
    // Initialize SRS database
    const srs = new SRSManager(`${ctx.DATA_DIR}/srs.db`);
    setSRS(srs);
    console.error("Language learning: SRS initialized");

    // Initialize furigana engine (async, loads kuromoji dictionary)
    try {
      await initFurigana();
    } catch (e) {
      console.error(`Language learning: furigana init failed (non-critical): ${e}`);
    }
  },

  async destroy() {
    const { getSRS } = await import("./srs-instance.ts");
    const srs = getSRS();
    if (srs) {
      srs.close();
      setSRS(null);
    }
  },
};

export default languageLearningPlugin;
