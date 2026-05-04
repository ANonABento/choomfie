/**
 * Lesson MCP tools — allows Claude to check/report lesson status.
 *
 * Note: The actual lesson flow is handled via Discord interactions (/lesson command + buttons).
 * These tools let Claude know about the user's progress and suggest lessons.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err } from "@choomfie/shared";
import { getLessonDB } from "../core/lesson-db-instance.ts";
import { getActiveModule } from "../core/session.ts";
import { getProgressData, getNextLesson } from "../core/lesson-engine.ts";

export const lessonTools: ToolDef[] = [
  {
    definition: {
      name: "lesson_status",
      description:
        "Show the user's lesson progress — completed lessons, current unit, next available lesson. " +
        "Use this when the user asks about their learning progress or what to study next. " +
        "Actual lessons are done via the /lesson slash command (button-driven, instant).",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
        },
        required: ["user_id"],
      },
    },
    handler: async (args) => {
      const db = getLessonDB();
      if (!db) return err("Lesson system not initialized");

      const userId = args.user_id as string;
      const module = getActiveModule(userId);
      const data = getProgressData(db, userId, module);

      const lines: string[] = [];
      lines.push(`**${module.charAt(0).toUpperCase() + module.slice(1)} Progress**\n`);

      for (const u of data.units) {
        const pct = u.total > 0 ? Math.round((u.completed / u.total) * 100) : 0;
        if (u.status === "locked") {
          lines.push(`${u.unit.icon} ${u.unit.name} — 🔒 locked`);
        } else if (u.status === "completed") {
          lines.push(`${u.unit.icon} ${u.unit.name} — ✅ complete (${u.completed}/${u.total})`);
        } else {
          lines.push(`${u.unit.icon} ${u.unit.name} — ${pct}% (${u.completed}/${u.total})`);
        }
      }

      lines.push(`\n📖 ${data.totalCompleted}/${data.totalLessons} lessons completed`);

      const next = getNextLesson(db, userId, module);
      if (next) {
        lines.push(`\n**Next:** Lesson ${next.id} — ${next.title}`);
        lines.push(`Tell the user to type \`/lesson\` to start!`);
      } else {
        lines.push(`\nAll available lessons completed! 🎉`);
      }

      return text(lines.join("\n"));
    },
  },
];
