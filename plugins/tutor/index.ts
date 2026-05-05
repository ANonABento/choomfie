/**
 * Tutor plugin — modular teaching harness.
 *
 * Generalizes the language-learning plugin to support any teachable subject.
 * Japanese is the first module; more can be added by implementing TutorModule.
 *
 * Phase 2: Structured lesson system with mastery-gated progression.
 * Lessons are driven by Discord interactions (/lesson + buttons) — no Claude roundtrip.
 */

import type { Plugin } from "@choomfie/shared";
import { errorMessage } from "@choomfie/shared";
import { SRSManager } from "./core/srs.ts";
import { setSRS, getSRS } from "./core/srs-instance.ts";
import { LessonDB } from "./core/lesson-db.ts";
import { setLessonDB, getLessonDB } from "./core/lesson-db-instance.ts";
import { registerLessons, completeLesson } from "./core/lesson-engine.ts";
import { getAllTutorTools } from "./tools/index.ts";
import { listModules } from "./modules/index.ts";
import { japaneseLessons, japaneseUnits } from "./modules/japanese/lessons/index.ts";
import { chineseLessons, chineseUnits } from "./modules/chinese/lessons/index.ts";
import { koreanLessons, koreanUnits } from "./modules/korean/lessons/index.ts";

import {
  buildExerciseButtons,
  buildLessonCompletionComponents,
  buildResultEmbed,
  buildSummaryEmbed,
  clearActiveSession,
  hasActiveTypingExercise,
  handleTypedAnswer,
} from "./lesson-interactions.ts";
import { getActiveModule } from "./core/session.ts";
import { EmbedBuilder } from "discord.js";
import { updateFromLessonCompletion } from "./core/learner-profile.ts";

// SRS reminder state (cleaned up in destroy)
let srsReminderTimeout: ReturnType<typeof setTimeout> | null = null;
let srsReminderInterval: ReturnType<typeof setInterval> | null = null;

const SRS_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000;
const SRS_MIN_DUE = 5;
const SRS_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const tutorPlugin: Plugin = {
  name: "tutor",

  tools: getAllTutorTools(),

  instructions: [
    "## Tutor",
    "You are also a tutor. When the user wants to learn or practice a subject:",
    "",
    "**Structured Lessons (recommended for beginners):**",
    "- Tell beginners to use `/lesson` to start structured lessons for their active module",
    "- Japanese lessons cover hiragana → katakana → phrases → grammar",
    "- Chinese lessons cover tones → hanzi → HSK 1 vocabulary",
    "- Korean lessons cover Hangul → particles/grammar → A1 vocabulary",
    "- Use `lesson_status` to check their progress and suggest what to study next",
    "- Lessons are button-driven and instant — no need for you to be in the loop",
    "",
    "**Other tools:**",
    "1. Use `tutor_prompt` to get the tutoring guidelines for their level",
    "2. Follow those guidelines when teaching and correcting",
    "3. Use `dictionary_lookup` when they ask about a word or term",
    "4. Use `quiz` to test them",
    "5. Use `set_level` to change difficulty",
    "6. Use `switch_module` to change subjects",
    "7. Use `list_modules` to show available subjects",
    "8. Use `srs_review` to start a flashcard review session",
    "9. Use `srs_rate` after they answer a flashcard (again/hard/good/easy)",
    "10. Use `srs_stats` to show their progress",
    "11. Use `srs_reminders` when they ask to check, enable, or disable SRS reminders",
    "12. Module-specific tools (e.g. `convert_kana` for Japanese) are also available",
    "",
    "**Learning flow:** Lessons (learn new material) → SRS (retain it) → Conversation (use it naturally)",
    "",
    "Default: Japanese at N5 (complete beginner).",
    "Be encouraging! Learning is hard. Celebrate progress.",
    "When correcting, explain WHY something is wrong, don't just give the answer.",
    "For Japanese: use furigana for kanji: 食[た]べる",
    "",
    "SRS: Cards auto-import from JLPT N5 deck (718 words) on first review.",
    "Lesson completion also adds items to SRS automatically.",
    "The FSRS algorithm schedules reviews optimally — trust the intervals.",
  ],

  userTools: [
    "tutor_prompt",
    "dictionary_lookup",
    "quiz",
    "set_level",
    "switch_module",
    "list_modules",
    "srs_review",
    "srs_rate",
    "srs_stats",
    "srs_reminders",
    "lesson_status",
    "convert_kana",
    "convert_pinyin",
    "stroke_info",
    "convert_hanzi",
    "convert_hangul",
    "random_word",
  ],

  async onMessage(message) {
    // Handle typed answers for production/cloze exercises
    if (message.author.bot) return;
    const userId = message.author.id;

    if (!hasActiveTypingExercise(userId)) return;

    const result = handleTypedAnswer(userId, message.content);
    if (!result) return;

    const { result: exerciseResult, session } = result;

    // Get correct count from DB
    const db = getLessonDB();
    if (!db) return;
    const progress = db.getProgress(userId, session.module, session.lessonId);
    const correctSoFar = progress?.exerciseResults.filter((r) => r.correct).length ?? 0;

    const resultEmbed = buildResultEmbed(
      exerciseResult.correct,
      exerciseResult.feedback,
      correctSoFar,
      session.exercises.length
    );

    // Check if lesson is done
    if (session.exerciseIndex >= session.exercises.length) {
      const completion = completeLesson(db, userId, session.module, session.lessonId, session.lesson);

      // Update learner profile
      updateFromLessonCompletion(db, userId, session.module);
      clearActiveSession(userId);

      const summaryEmbed = buildSummaryEmbed(
        session.lesson,
        completion.score,
        completion.passed,
        completion.totalCorrect,
        completion.totalExercises
      );
      const components = buildLessonCompletionComponents(
        completion.passed,
        session.lessonId
      );

      await message.reply({ embeds: [resultEmbed, summaryEmbed], components });
      return;
    }

    // Show next exercise
    const nextExercise = session.exercises[session.exerciseIndex];
    const exerciseEmbed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle(`Exercise ${session.exerciseIndex + 1}/${session.exercises.length}`)
      .setDescription(nextExercise.prompt);

    const components = buildExerciseButtons(
      nextExercise,
      session.lessonId,
      session.exerciseIndex,
      session
    );

    if (components.length === 0) {
      exerciseEmbed.setFooter({
        text: `Type your answer below${nextExercise.hint ? ` · 💡 ${nextExercise.hint}` : ""}`,
      });
    }

    await message.reply({ embeds: [resultEmbed, exerciseEmbed], components });
  },

  async init(ctx) {
    // Initialize SRS
    const srs = new SRSManager(`${ctx.DATA_DIR}/srs.db`);
    setSRS(srs);
    console.error("Tutor: SRS initialized");

    // Initialize lesson DB (same directory, separate file)
    const lessonDb = new LessonDB(`${ctx.DATA_DIR}/lessons.db`);
    setLessonDB(lessonDb);
    console.error("Tutor: Lesson DB initialized");

    // Register lesson data
    registerLessons("japanese", japaneseLessons, japaneseUnits);
    console.error(`Tutor: registered ${japaneseLessons.length} Japanese lessons`);
    registerLessons("chinese", chineseLessons, chineseUnits);
    console.error(`Tutor: registered ${chineseLessons.length} Chinese lessons`);
    registerLessons("korean", koreanLessons, koreanUnits);
    console.error(`Tutor: registered ${koreanLessons.length} Korean lessons`);

    // Initialize all modules
    for (const mod of listModules()) {
      if (mod.init) {
        try {
          await mod.init();
          console.error(`Tutor: module "${mod.name}" initialized`);
        } catch (e: unknown) {
          console.error(
            `Tutor: module "${mod.name}" init failed (non-critical): ${errorMessage(e)}`
          );
        }
      }
    }

    if (!ctx.discord) {
      console.error("Tutor: Discord unavailable, SRS reminder timer disabled");
      return;
    }

    // SRS study reminders — check every 4 hours
    const checkSrsReminders = async () => {
      const srs = getSRS();
      if (!srs) return;
      if (!ctx.discord?.users?.fetch) return;

      const dueCounts = srs.getDueCountByUser();
      for (const [userId, count] of dueCounts) {
        if (count < SRS_MIN_DUE) continue;
        const module = getActiveModule(userId);
        const reminderSettings = lessonDb.getSrsReminderSettings(userId, module);
        if (!reminderSettings.enabled) continue;

        // Don't remind more than once per 24h
        const lastReminded = reminderSettings.lastRemindedAt;
        if (Date.now() - lastReminded < SRS_REMINDER_COOLDOWN_MS) continue;

        // Send DM reminder
        try {
          const user = await ctx.discord.users.fetch(userId);
          await user.send(
            `📚 You have **${count} SRS cards** due for review! Keep your streak going.\nUse \`/srs_review\` or ask me to start a review session.`
          );
          const remindedAt = Date.now();
          lessonDb.recordSrsReminderSent(userId, module, remindedAt);
          console.error(`Tutor: sent SRS reminder to ${userId} (${count} due cards)`);
        } catch {
          // User not reachable via DM
        }
      }
    };

    // Run initial check after 1 minute (let Discord connect first), then every 4 hours
    srsReminderTimeout = setTimeout(checkSrsReminders, 60_000);
    srsReminderInterval = setInterval(checkSrsReminders, SRS_REMINDER_INTERVAL_MS);
  },

  async destroy() {
    // Clean up SRS reminder timers
    if (srsReminderTimeout) clearTimeout(srsReminderTimeout);
    if (srsReminderInterval) clearInterval(srsReminderInterval);
    srsReminderTimeout = null;
    srsReminderInterval = null;

    // Destroy all modules
    for (const mod of listModules()) {
      if (mod.destroy) {
        try { await mod.destroy(); } catch (e: unknown) {
          console.error(`Tutor: module destroy failed: ${errorMessage(e)}`);
        }
      }
    }

    // Close lesson DB
    const lessonDb = getLessonDB();
    if (lessonDb) {
      lessonDb.close();
      setLessonDB(null);
    }

    // Close SRS
    const srs = getSRS();
    if (srs) {
      srs.close();
      setSRS(null);
    }
  },
};

export default tutorPlugin;
