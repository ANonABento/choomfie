/**
 * Lesson slash commands + button handlers.
 *
 * All lesson flow is handled via Discord interactions — no Claude roundtrip.
 * /lesson → start/continue a lesson
 * /progress → show learning progress
 * Buttons handle exercise answers (recognition, MC, navigation).
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { registerCommand, registerButtonHandler } from "@choomfie/shared";
import { getLessonDB } from "./core/lesson-db-instance.ts";
import { getActiveModule } from "./core/session.ts";
import {
  getNextLesson,
  startLesson,
  scoreExercise,
  completeLesson,
  getProgressData,
} from "./core/lesson-engine.ts";
import {
  type ContentSet,
  type ExerciseMode,
  type Exercise,
  type PracticeMode,
  type Lesson,
  isButtonExercise,
  isTypingExercise,
} from "./core/lesson-types.ts";
import { generateExercises } from "./core/exercise-generator.ts";
import { updateFromLessonCompletion } from "./core/learner-profile.ts";
import { shuffle } from "./core/random.ts";
import { renderChartPrompt } from "./core/chart.ts";

// --- Active lesson sessions (in-memory, keyed by userId) ---

type AnswerOptionsByToken = Map<string, string>;
type AnswerOptionsByExercise = Map<number, AnswerOptionsByToken>;

export interface ActiveLessonSession {
  userId: string;
  module: string;
  lessonId: string;
  exerciseIndex: number;
  lesson: Lesson;
  exercises?: Exercise[];
  selectedMode?: PracticeMode;
  awaitingModeSelection?: boolean;
  answerOptionsByExercise: AnswerOptionsByExercise;
}

const activeSessions = new Map<string, ActiveLessonSession>();

// --- Helpers ---

function buildIntroEmbed(lesson: Lesson): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2) // blurple
    .setTitle(`📖 Lesson ${lesson.id}: ${lesson.title}`)
    .setDescription(lesson.introduction.text);

  if (lesson.introduction.items && lesson.introduction.items.length > 0) {
    const lines = lesson.introduction.items.map((item) => {
      if (item.char) {
        // Kana lesson
        let line = `**${item.char}** → **${item.reading}**`;
        if (item.mnemonic) line += ` — ${item.mnemonic}`;
        if (item.audioHint) line += ` *(${item.audioHint})*`;
        return line;
      } else if (item.word) {
        // Word/phrase lesson
        let line = `**${item.word}** (${item.reading})`;
        if (item.meaning) line += ` — ${item.meaning}`;
        return line;
      }
      return "";
    });
    embed.addFields({ name: "New Material", value: lines.join("\n") });
  }

  const exerciseCount = lessonSupportsModePicker(lesson)
    ? 0
    : expandExercisesForSession(lesson.exercises).length;
  embed.setFooter({ text: `${exerciseCount} exercises · 80% to pass` });
  return embed;
}

function buildExerciseEmbed(
  lesson: Lesson,
  exerciseIndex: number,
  exercise: Exercise,
  totalExercises = lesson.exercises.length
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c) // yellow
    .setTitle(`Exercise ${exerciseIndex + 1}/${totalExercises}`)
    .setDescription(exercise.prompt);

  if (exercise.hint) {
    embed.setFooter({ text: `💡 Hint: ${exercise.hint}` });
  }

  return embed;
}

export function buildAnswerCustomId(
  lessonId: string,
  exerciseIndex: number,
  optionToken: string
): string {
  return `lesson:answer:${lessonId}:${exerciseIndex}:${optionToken}`;
}

export function buildChartCustomId(
  lessonId: string,
  exerciseIndex: number,
  chartBlankIndex: number,
  optionToken: string
): string {
  return `lesson:chart:${lessonId}:${exerciseIndex}:${chartBlankIndex}:${optionToken}`;
}

export function buildButtonOptions(exercise: Exercise): string[] {
  if (!isButtonExercise(exercise.type)) return [];
  const distractors = [...new Set(exercise.distractors ?? [])].filter(
    (option) => option !== exercise.answer
  );
  const selectedDistractors = shuffle(distractors).slice(0, 4);
  return shuffle([exercise.answer, ...selectedDistractors]);
}

function buttonLabel(answer: string): string {
  return answer.length > 80 ? `${answer.slice(0, 77)}...` : answer;
}

function parseExerciseIndex(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function setActiveLessonSession(
  userId: string,
  module: string,
  lessonId: string,
  lesson: Lesson,
  exerciseIndex: number
): ActiveLessonSession {
  const supportsModePicker = lessonSupportsModePicker(lesson);
  const session: ActiveLessonSession = {
    userId,
    module,
    lessonId,
    exerciseIndex: supportsModePicker ? 0 : exerciseIndex,
    lesson,
    exercises: supportsModePicker
      ? []
      : expandExercisesForSession(lesson.exercises),
    awaitingModeSelection: supportsModePicker,
    answerOptionsByExercise: new Map(),
  };
  activeSessions.set(userId, session);
  return session;
}

export function expandExercisesForSession(exercises: Exercise[]): Exercise[] {
  return exercises.flatMap((exercise) => {
    if (exercise.type !== "chart" || !exercise.chart) return [exercise];

    return exercise.chart.blanks.map((blank, chartBlankIndex) => ({
      ...exercise,
      prompt: renderChartPrompt(exercise.chart!, {
        currentBlankIndex: chartBlankIndex,
      }),
      answer: blank.answer,
      distractors: exercise.distractors?.filter((option) => option !== blank.answer),
      chartBlankIndex,
    }));
  });
}

export function lessonSupportsModePicker(lesson: Lesson): boolean {
  return Boolean(
    lesson.contentSets?.some((set) => set.items.length > 0) &&
      lesson.selectableModes &&
      lesson.selectableModes.length > 0
  );
}

export function buildModePickerComponents(
  lesson: Lesson
): ActionRowBuilder<ButtonBuilder>[] {
  if (!lessonSupportsModePicker(lesson)) return [];

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const mode of (lesson.selectableModes ?? []).slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`lesson:mode:${lesson.id}:${mode}`)
        .setLabel(mode.charAt(0).toUpperCase() + mode.slice(1))
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return [row];
}

export function setSessionMode(
  session: ActiveLessonSession,
  mode: PracticeMode
): void {
  const contentSets = session.lesson.contentSets ?? [];

  session.exercises = contentSets.flatMap((contentSet) =>
    getExerciseModesForContentSet(contentSet, mode).flatMap((exerciseMode) =>
      generateExercises(contentSet, exerciseMode)
    )
  );
  session.exerciseIndex = 0;
  session.selectedMode = mode;
  session.awaitingModeSelection = false;
  session.answerOptionsByExercise.clear();
}

function getExerciseModesForContentSet(
  contentSet: ContentSet,
  selectedMode: PracticeMode
): ExerciseMode[] {
  const allowedModes = contentSet.modes ?? ["recognition", "production", "matching"];
  if (selectedMode === "mixed") return [...allowedModes];
  return allowedModes.includes(selectedMode) ? [selectedMode] : [];
}

function getOrCreateAnswerOptions(
  exercise: Exercise,
  exerciseIndex: number,
  session: ActiveLessonSession
): AnswerOptionsByToken {
  const existing = session.answerOptionsByExercise.get(exerciseIndex);
  if (existing) return existing;

  const answersByToken: AnswerOptionsByToken = new Map();
  buildButtonOptions(exercise).forEach((option, index) => {
    answersByToken.set(String(index), option);
  });
  session.answerOptionsByExercise.set(exerciseIndex, answersByToken);
  return answersByToken;
}

export function buildExerciseButtons(
  exercise: Exercise,
  lessonId: string,
  exerciseIndex: number,
  session: ActiveLessonSession
): ActionRowBuilder<ButtonBuilder>[] {
  if (isButtonExercise(exercise.type)) {
    const answersByToken = getOrCreateAnswerOptions(exercise, exerciseIndex, session);
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const [token, option] of answersByToken) {
      const customId =
        exercise.type === "chart"
          ? buildChartCustomId(
              lessonId,
              exerciseIndex,
              exercise.chartBlankIndex ?? 0,
              token
            )
          : buildAnswerCustomId(lessonId, exerciseIndex, token);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(buttonLabel(option))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    return [row];
  }

  // Production/cloze — no buttons, user types answer
  session.answerOptionsByExercise.delete(exerciseIndex);
  return [];
}

export function buildResultEmbed(
  correct: boolean,
  feedback: string,
  correctSoFar: number,
  total: number
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(correct ? 0x57f287 : 0xed4245)
    .setDescription(feedback)
    .setFooter({ text: `Score: ${correctSoFar}/${total}` });
}

export function buildSummaryEmbed(
  lesson: Lesson,
  score: number,
  passed: boolean,
  totalCorrect: number,
  totalExercises: number
): EmbedBuilder {
  const pct = Math.round(score * 100);
  const bar = buildProgressBar(score, 15);

  const embed = new EmbedBuilder()
    .setTitle(passed ? "🎉 Lesson Complete!" : "📝 Keep Practicing!")
    .setColor(passed ? 0x57f287 : 0xfee75c)
    .setDescription(
      passed
        ? `**${lesson.title}** — ${pct}% (${totalCorrect}/${totalExercises})\n${bar}\n\nGreat work! Next lesson unlocked.`
        : `**${lesson.title}** — ${pct}% (${totalCorrect}/${totalExercises})\n${bar}\n\nYou need 80% to advance. Try again!`
    );

  if (passed && lesson.srsItems && lesson.srsItems.length > 0) {
    embed.addFields({
      name: "📚 Added to SRS",
      value: `${lesson.srsItems.length} items added to your review deck`,
    });
  }

  return embed;
}

export function buildLessonCompletionComponents(
  passed: boolean,
  lessonId: string
): ActionRowBuilder<ButtonBuilder>[] {
  const customId = passed ? "lesson:next" : `lesson:retry:${lessonId}`;
  const label = passed ? "Next Lesson →" : "Try Again";
  const style = passed ? ButtonStyle.Success : ButtonStyle.Primary;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
    ),
  ];
}

function buildLessonStartComponents(lessonId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`lesson:start:${lessonId}`)
        .setLabel("Start Exercises →")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildProgressBar(ratio: number, length: number): string {
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  return `[${"\u2588".repeat(filled)}${"\u2500".repeat(empty)}] ${Math.round(ratio * 100)}%`;
}

// --- Send next exercise or summary ---

async function sendNextExercise(
  interaction: ButtonInteraction,
  session: ActiveLessonSession,
  editMessage: boolean = false
) {
  const db = getLessonDB();
  if (!db) return;

  const { lesson, exerciseIndex, userId, module, lessonId } = session;
  const exercises = session.exercises ?? expandExercisesForSession(lesson.exercises);

  if (session.awaitingModeSelection) {
    const intro = buildIntroEmbed(lesson);
    await interaction.update({
      embeds: [intro],
      components: buildModePickerComponents(lesson),
    });
    return;
  }

  // All exercises done?
  if (exerciseIndex >= exercises.length) {
    const result = completeLesson(db, userId, module, lessonId);
    clearActiveSession(userId);

    // Update learner profile
    updateFromLessonCompletion(db, userId, module);

    const summary = buildSummaryEmbed(lesson, result.score, result.passed, result.totalCorrect, result.totalExercises);
    const components = buildLessonCompletionComponents(result.passed, lessonId);

    if (editMessage) {
      await interaction.update({ embeds: [summary], components });
    } else {
      await interaction.followUp({ embeds: [summary], components });
    }
    return;
  }

  const exercise = exercises[exerciseIndex];
  const embed = buildExerciseEmbed(lesson, exerciseIndex, exercise, exercises.length);
  const buttons = buildExerciseButtons(exercise, lessonId, exerciseIndex, session);

  const requiresTypedAnswer = buttons.length === 0;
  if (requiresTypedAnswer) {
    embed.setFooter({
      text: `Type your answer below${exercise.hint ? ` · 💡 ${exercise.hint}` : ""}`,
    });
  }

  if (editMessage) {
    await interaction.update({ embeds: [embed], components: buttons });
  } else {
    await interaction.followUp({ embeds: [embed], components: buttons });
  }
}

// --- Slash Commands ---

registerCommand("lesson", {
  data: new SlashCommandBuilder()
    .setName("lesson")
    .setDescription("Start or continue your active tutor lesson")
    .toJSON(),
  handler: async (interaction, _ctx) => {
    const db = getLessonDB();
    if (!db) {
      await interaction.reply({
        content: "Tutor plugin not initialized.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userId = interaction.user.id;
    const module = getActiveModule(userId);

    // Check for active session
    const existing = activeSessions.get(userId);
    if (existing) {
      // Resume
      const exercises = existing.exercises ?? expandExercisesForSession(existing.lesson.exercises);
      const exercise = exercises[existing.exerciseIndex];
      if (!exercise) {
        clearActiveSession(userId);
      } else {
        const embed = buildExerciseEmbed(
          existing.lesson,
          existing.exerciseIndex,
          exercise,
          exercises.length
        );
        const buttons = buildExerciseButtons(
          exercise,
          existing.lessonId,
          existing.exerciseIndex,
          existing
        );
        await interaction.reply({ embeds: [embed], components: buttons });
        return;
      }
    }

    const next = getNextLesson(db, userId, module);
    if (!next) {
      await interaction.reply({
        content: "🎉 You've completed all available lessons! More coming soon.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = startLesson(db, userId, module, next.id);
    if (!result) {
      await interaction.reply({
        content: "Could not start lesson.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Create active session
    setActiveLessonSession(userId, module, next.id, result.lesson, result.resumeAt);

    // Show intro
    const intro = buildIntroEmbed(result.lesson);
    await interaction.reply({
      embeds: [intro],
      components: buildLessonStartComponents(next.id),
    });
  },
});

registerCommand("progress", {
  data: new SlashCommandBuilder()
    .setName("progress")
    .setDescription("Show your learning progress")
    .toJSON(),
  handler: async (interaction) => {
    const db = getLessonDB();
    if (!db) {
      await interaction.reply({
        content: "Tutor plugin not initialized.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userId = interaction.user.id;
    const module = getActiveModule(userId);
    const data = getProgressData(db, userId, module);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📚 ${module.charAt(0).toUpperCase() + module.slice(1)} — Progress`);

    if (data.units.length === 0) {
      embed.setDescription("No lessons available yet.");
    } else {
      const lines = data.units.map((u) => {
        if (u.status === "locked") {
          return `${u.unit.icon} **${u.unit.name}**  [🔒 locked]`;
        }
        const bar = buildProgressBar(u.total > 0 ? u.completed / u.total : 0, 15);
        const check = u.status === "completed" ? "  ✓" : "";
        return `${u.unit.icon} **${u.unit.name}**  ${bar}${check}`;
      });
      embed.setDescription(lines.join("\n"));
    }

    embed.setFooter({
      text: `📖 ${data.totalCompleted}/${data.totalLessons} lessons completed`,
    });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
});

// --- Button Handlers ---

registerButtonHandler("lesson", async (interaction, parts, _ctx) => {
  const action = parts[1];
  const userId = interaction.user.id;
  const db = getLessonDB();
  if (!db) return;

  if (action === "start") {
    // Start exercises from intro screen
    const lessonId = parts[2];
    const session = activeSessions.get(userId);
    if (!lessonId || !session || session.lessonId !== lessonId) {
      await interaction.reply({
        content: "Session expired or no longer active. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await sendNextExercise(interaction, session, true);
    return;
  }

  if (action === "mode") {
    const lessonId = parts[2];
    const mode = parts[3] as PracticeMode | undefined;
    const session = activeSessions.get(userId);
    if (!lessonId || !mode || !session || session.lessonId !== lessonId) {
      await interaction.reply({
        content: "Session expired or no longer active. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!session.lesson.selectableModes?.includes(mode)) {
      await interaction.reply({
        content: "That lesson mode is not available. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    setSessionMode(session, mode);
    await sendNextExercise(interaction, session, true);
    return;
  }

  if (action === "answer" || action === "chart") {
    // Button answer for recognition/MC exercises
    const lessonId = parts[2];
    const exerciseIndex = parseExerciseIndex(parts[3]);
    const answerToken = action === "chart" ? parts[5] : parts[4];

    if (!lessonId || exerciseIndex === null || answerToken === undefined) {
      await interaction.reply({
        content: "That lesson button is invalid. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = activeSessions.get(userId);
    if (!session || session.lessonId !== lessonId) {
      await interaction.reply({
        content: "Session expired. Use `/lesson` to start again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (session.exerciseIndex !== exerciseIndex) {
      await interaction.reply({
        content: "That exercise is no longer active. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const exercises = session.exercises ?? expandExercisesForSession(session.lesson.exercises);
    const exercise = exercises[exerciseIndex];
    if (!exercise) {
      await interaction.reply({
        content: "That exercise is no longer available. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userAnswer = session.answerOptionsByExercise.get(exerciseIndex)?.get(answerToken);
    if (userAnswer === undefined) {
      await interaction.reply({
        content: "That answer option expired. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = scoreExercise(exercise, userAnswer, exerciseIndex);

    // Save to DB
    db.saveExerciseResult(userId, session.module, lessonId, exerciseIndex, {
      index: exerciseIndex,
      correct: result.correct,
      userAnswer,
    });

    // Count correct so far (progress already includes the just-saved result)
    const progress = db.getProgress(userId, session.module, lessonId);
    const correctSoFar = progress?.exerciseResults.filter((r) => r.correct).length ?? 0;

    // Move to next exercise
    session.exerciseIndex = exerciseIndex + 1;
    session.answerOptionsByExercise.delete(exerciseIndex);

    // Show result briefly then move on
    const resultEmbed = buildResultEmbed(
      result.correct,
      result.feedback,
      correctSoFar,
      exercises.length
    );

    const continueButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`lesson:continue:${lessonId}`)
        .setLabel("Continue →")
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.update({ embeds: [resultEmbed], components: [continueButton] });
    return;
  }

  if (action === "continue") {
    const lessonId = parts[2];
    const session = activeSessions.get(userId);
    if (!lessonId || !session || session.lessonId !== lessonId) {
      await interaction.reply({
        content: "Session expired or no longer active. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await sendNextExercise(interaction, session, true);
    return;
  }

  if (action === "next") {
    // Start next available lesson
    const module = getActiveModule(userId);
    const next = getNextLesson(db, userId, module);
    if (!next) {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("🎉 All lessons complete!")
            .setDescription("You've finished all available lessons. More coming soon!"),
        ],
        components: [],
      });
      return;
    }

    const result = startLesson(db, userId, module, next.id);
    if (!result) {
      await interaction.reply({
        content: "Could not start the next lesson. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    setActiveLessonSession(userId, module, next.id, result.lesson, result.resumeAt);

    const intro = buildIntroEmbed(result.lesson);
    await interaction.update({
      embeds: [intro],
      components: buildLessonStartComponents(next.id),
    });
    return;
  }

  if (action === "retry") {
    const lessonId = parts[2];
    const module = getActiveModule(userId);
    if (!lessonId) {
      await interaction.reply({
        content: "That lesson retry button is invalid. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = startLesson(db, userId, module, lessonId);
    if (!result) {
      await interaction.reply({
        content: "That lesson is not available to retry. Use `/lesson` to continue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    setActiveLessonSession(userId, module, lessonId, result.lesson, 0);

    const intro = buildIntroEmbed(result.lesson);
    await interaction.update({
      embeds: [intro],
      components: buildLessonStartComponents(lessonId),
    });
    return;
  }
});

// --- Handle typed answers for production/cloze exercises ---

/**
 * Called from plugin.onMessage when user has an active lesson session
 * and the current exercise requires typing.
 */
export function handleTypedAnswer(
  userId: string,
  text: string
): { result: ReturnType<typeof scoreExercise>; session: ActiveLessonSession } | null {
  const session = activeSessions.get(userId);
  if (!session) return null;

  const exercises = session.exercises ?? expandExercisesForSession(session.lesson.exercises);
  const exercise = exercises[session.exerciseIndex];
  if (!exercise) return null;

  if (!isTypingExercise(exercise.type)) return null;

  const db = getLessonDB();
  if (!db) return null;

  const result = scoreExercise(exercise, text, session.exerciseIndex);

  db.saveExerciseResult(userId, session.module, session.lessonId, session.exerciseIndex, {
    index: session.exerciseIndex,
    correct: result.correct,
    userAnswer: text,
  });

  session.exerciseIndex++;
  return { result, session };
}

/** Check if a user has an active typing exercise */
export function hasActiveTypingExercise(userId: string): boolean {
  const session = activeSessions.get(userId);
  if (!session) return false;
  const exercises = session.exercises ?? expandExercisesForSession(session.lesson.exercises);
  const exercise = exercises[session.exerciseIndex];
  if (!exercise) return false;
  return isTypingExercise(exercise.type);
}

/** Get active session for a user */
export function getActiveSession(userId: string): ActiveLessonSession | undefined {
  return activeSessions.get(userId);
}

/** Clear active session for a user */
export function clearActiveSession(userId: string): void {
  activeSessions.delete(userId);
}
