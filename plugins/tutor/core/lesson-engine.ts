/**
 * Lesson engine — core logic for presenting lessons, scoring exercises, and managing progression.
 *
 * This runs in the worker process. Slash commands and button handlers call into this.
 * All lesson flow is handled via Discord interactions — no Claude roundtrip needed.
 */

import type { LessonDB } from "./lesson-db.ts";
import type { Lesson, Exercise, ExerciseResult, Unit } from "./lesson-types.ts";
import { getSRS } from "./srs-instance.ts";

const MASTERY_THRESHOLD = 0.8; // 80% to pass

/** Registered lesson data per module */
const lessonRegistries = new Map<string, { lessons: Map<string, Lesson>; units: Unit[] }>();

/** Register all lessons for a module */
export function registerLessons(module: string, lessons: Lesson[], units: Unit[]) {
  const map = new Map<string, Lesson>();
  for (const l of lessons) map.set(l.id, l);
  lessonRegistries.set(module, { lessons: map, units });
}

/** Get a lesson by ID */
export function getLesson(module: string, lessonId: string): Lesson | undefined {
  return lessonRegistries.get(module)?.lessons.get(lessonId);
}

/** Get all lessons for a module */
export function getAllLessons(module: string): Lesson[] {
  const reg = lessonRegistries.get(module);
  if (!reg) return [];
  return [...reg.lessons.values()];
}

/** Get units for a module */
export function getUnits(module: string): Unit[] {
  return lessonRegistries.get(module)?.units ?? [];
}

/** Initialize lesson progress for a user — ensures all rows exist with correct lock state */
export function initUserProgress(db: LessonDB, userId: string, module: string) {
  const lessons = getAllLessons(module);
  if (lessons.length === 0) return;

  for (const lesson of lessons) {
    db.ensureLesson(userId, module, lesson.id);
  }

  // First lesson with no prereqs should be available
  for (const lesson of lessons) {
    if (lesson.prerequisites.length === 0) {
      const progress = db.getProgress(userId, module, lesson.id);
      if (progress?.status === "locked") {
        db.setStatus(userId, module, lesson.id, "available");
      }
    }
  }
}

/** Get the next available lesson for a user */
export function getNextLesson(db: LessonDB, userId: string, module: string): Lesson | null {
  initUserProgress(db, userId, module);
  const lessons = getAllLessons(module);

  // First check for in-progress lessons
  for (const lesson of lessons) {
    const progress = db.getProgress(userId, module, lesson.id);
    if (progress?.status === "in_progress") return lesson;
  }

  // Then find first available
  for (const lesson of lessons) {
    const progress = db.getProgress(userId, module, lesson.id);
    if (progress?.status === "available") return lesson;
  }

  return null; // all completed or locked
}

/** Start a lesson — sets status and returns the lesson data */
export function startLesson(
  db: LessonDB,
  userId: string,
  module: string,
  lessonId: string
): { lesson: Lesson; resumeAt: number } | null {
  const lesson = getLesson(module, lessonId);
  if (!lesson) return null;

  initUserProgress(db, userId, module);
  const progress = db.getProgress(userId, module, lessonId);
  if (!progress) return null;

  // Allow starting if available or in_progress (resume)
  if (progress.status === "locked") return null;
  if (progress.status === "completed") {
    // Re-do: reset to in_progress
    db.startLesson(userId, module, lessonId);
    return { lesson, resumeAt: 0 };
  }

  if (progress.status === "in_progress") {
    // Resume from where they left off
    return { lesson, resumeAt: progress.currentExercise };
  }

  // Available — start fresh
  db.startLesson(userId, module, lessonId);
  return { lesson, resumeAt: 0 };
}

/** Score a single exercise answer */
export function scoreExercise(
  exercise: Exercise,
  userAnswer: string,
  exerciseIndex: number = 0
): ExerciseResult & { feedback: string } {
  const normalized = userAnswer.trim().toLowerCase();
  const expected = exercise.answer.trim().toLowerCase();

  // Check main answer + alternatives
  const allAccepted = [expected, ...(exercise.accept ?? []).map((a) => a.trim().toLowerCase())];
  const correct = allAccepted.includes(normalized);

  let feedback: string;
  if (correct) {
    feedback = "✅ Correct!";
  } else if (exercise.explanation) {
    feedback = `❌ ${exercise.explanation}`;
  } else {
    feedback = `❌ The answer is **${exercise.answer}**`;
  }

  return { index: exerciseIndex, correct, userAnswer, feedback };
}

/** Complete a lesson — calculate score, unlock next lessons, add SRS items */
export function completeLesson(
  db: LessonDB,
  userId: string,
  module: string,
  lessonId: string,
  activeLesson?: Lesson
): { score: number; passed: boolean; totalCorrect: number; totalExercises: number } {
  const lesson = activeLesson ?? getLesson(module, lessonId);
  if (!lesson) return { score: 0, passed: false, totalCorrect: 0, totalExercises: 0 };

  const progress = db.getProgress(userId, module, lessonId);
  if (!progress) return { score: 0, passed: false, totalCorrect: 0, totalExercises: 0 };

  // When exercises are generated from contentSets (via mode selection), the lesson's
  // static exercises array may not reflect the actual count attempted. Use the larger
  // of the two to account for dynamically generated exercises.
  const totalExercises = Math.max(lesson.exercises.length, progress.exerciseResults.length);
  const totalCorrect = progress.exerciseResults.filter((r) => r.correct).length;
  const score = totalExercises > 0 ? totalCorrect / totalExercises : 0;
  const passed = score >= MASTERY_THRESHOLD;

  if (passed) {
    db.completeLesson(userId, module, lessonId, score);

    // Unlock lessons whose prereqs are now all met
    const allLessons = getAllLessons(module);
    for (const next of allLessons) {
      if (!next.prerequisites.includes(lessonId)) continue;
      const allPrereqsMet = next.prerequisites.every((prereqId) => {
        const p = db.getProgress(userId, module, prereqId);
        return p?.status === "completed";
      });
      if (allPrereqsMet) {
        const nextProgress = db.getProgress(userId, module, next.id);
        if (nextProgress?.status === "locked") {
          db.setStatus(userId, module, next.id, "available");
        }
      }
    }

    // Add SRS items
    if (lesson.srsItems && lesson.srsItems.length > 0) {
      const srs = getSRS();
      if (srs) {
        const deck = `lesson-${module}`;
        const cards = lesson.srsItems.map((item) => ({
          front: item.front,
          back: item.back,
          reading: item.reading ?? "",
          tags: item.tags ?? `lesson:${lessonId}`,
        }));
        srs.importDeck(userId, deck, cards);
      }
    }
  } else {
    // Failed — mark as available so they can retry
    db.setStatus(userId, module, lessonId, "available");
  }

  return { score, passed, totalCorrect, totalExercises };
}

/** Build progress data for display */
export function getProgressData(
  db: LessonDB,
  userId: string,
  module: string
): {
  units: Array<{
    unit: Unit;
    completed: number;
    total: number;
    status: "completed" | "in_progress" | "locked";
  }>;
  totalCompleted: number;
  totalLessons: number;
} {
  initUserProgress(db, userId, module);
  const units = getUnits(module);
  let totalCompleted = 0;
  let totalLessons = 0;

  const unitData = units.map((unit) => {
    let completed = 0;
    const total = unit.lessonIds.length;
    totalLessons += total;

    let hasInProgress = false;
    let hasAvailable = false;

    for (const lid of unit.lessonIds) {
      const progress = db.getProgress(userId, module, lid);
      if (progress?.status === "completed") {
        completed++;
        totalCompleted++;
      } else if (progress?.status === "in_progress") {
        hasInProgress = true;
      } else if (progress?.status === "available") {
        hasAvailable = true;
      }
    }

    const status: "completed" | "in_progress" | "locked" =
      completed === total
        ? "completed"
        : hasInProgress || hasAvailable || completed > 0
          ? "in_progress"
          : "locked";

    return { unit, completed, total, status };
  });

  return { units: unitData, totalCompleted, totalLessons };
}
