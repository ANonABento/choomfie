/**
 * pipeline_run / pipeline_status / pipeline_stop: run a configured local tool
 * (lib/pipelines) for a chat. One path for every brain: Claude in a daemon
 * session and Waymond over the remote endpoint call the same tools, get the
 * same queue, and their results are posted to the chat the same way.
 *
 * Owner only, checked in code (`callerIsOwner`).
 */

import { join } from "node:path";
import { callerIsOwner } from "../caller.ts";
import { buildArgv, PipelineError } from "../pipelines/args.ts";
import { jobLine } from "../pipelines/announce.ts";
import { pipelineRunner } from "../pipelines/index.ts";
import type { Job } from "../pipelines/runner.ts";
import { pruneByAge, resolveThreadFiles, type FileSpec } from "../pipelines/thread-files.ts";
import type { AppContext, ToolDef } from "../types.ts";
import { err, text } from "../types.ts";

/** A command that ends within this answers inline; a longer one becomes a background job. */
export const INLINE_MS = 20_000;
const MAX_RESULT_CHARS = 6000;
const OWNER_ONLY = "pipeline tools are owner only, and the latest message in this chat isn't from the owner.";

function details(job: Job, runner: ReturnType<typeof pipelineRunner>): string {
  const lines = [jobLine(job), `job: ${job.id}`];
  if (job.result) {
    const json = JSON.stringify(job.result, null, 1);
    lines.push("result:", json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}…` : json);
  }
  if (job.state === "failed" || (job.state === "done" && !job.result)) {
    const tail = runner.logTail(job, 1500).trim();
    if (tail) lines.push("log (end):", tail);
  }
  return lines.join("\n");
}

function pipelineFor(ctx: AppContext, name: unknown) {
  const all = ctx.config.getPipelines();
  const p = all.get(String(name ?? ""));
  if (!p) throw new PipelineError(`no pipeline "${String(name ?? "")}" (configured: ${[...all.keys()].join(", ") || "none"})`);
  return p;
}

export const pipelineTools: ToolDef[] = [
  {
    definition: {
      name: "pipeline_run",
      description:
        "Owner only. Run a configured local pipeline on this machine. args is the argument list, never a shell string, starting with an allowed subcommand, e.g. [\"next\", \"aiko\"]. Commands that end within 20 s answer here with their JSON result; longer ones run as a background job (one at a time per pipeline): when it ends, its pictures and next step are posted in chat_id and noted on your next message. Pictures the result shows are posted to the chat for you. To hand pictures from the chat to the command, pass files (\"last_reply\": the images in the brain's latest reply here; \"last_mine\": the user's latest; or message ids) and write {files} in args where their folder goes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pipeline: { type: "string", description: "Pipeline name" },
          args: { type: "array", items: { type: "string" }, description: 'Arguments, e.g. ["next", "aiko"] or ["deliver", "aiko", "<request>", "--from", "{files}"]' },
          chat_id: { type: "string", description: "The chat this is for: results and pictures are posted there." },
          files: {
            description: '"last_reply", "last_mine", or a list of message ids whose images to hand over (replaces {files} in args)',
            anyOf: [{ type: "string", enum: ["last_reply", "last_mine"] }, { type: "array", items: { type: "string" } }],
          },
        },
        required: ["pipeline", "args", "chat_id"],
      },
    },
    handler: async (args, ctx, caller = { via: "local" }) => {
      if (!callerIsOwner(caller, args)) return err(OWNER_ONLY);
      const chatId = String(args.chat_id ?? "");
      if (!chatId) return err("chat_id is required");
      try {
        const p = pipelineFor(ctx, args.pipeline);
        const runner = pipelineRunner(ctx);
        const id = runner.newId(p.name);
        let filesDir: string | undefined;
        if (args.files !== undefined) {
          const base = join(ctx.DATA_DIR, "pipeline-files");
          pruneByAge(base);
          filesDir = join(base, id);
          resolveThreadFiles(ctx.DATA_DIR, chatId, args.files as FileSpec, filesDir);
        }
        const argv = buildArgv(p, args.args, filesDir);
        const job = runner.start(p, argv, (args.args as string[]).slice(), chatId, id);
        if (await runner.wait(job, INLINE_MS)) return text(details(job, runner));
        const ahead = runner.list().filter((j) => j.pipeline === p.name && j.state === "running" && j !== job);
        return text(
          `${job.id} ${job.state === "queued" && ahead.length ? `is queued behind ${ahead[0].id}` : "is running in the background"}. ` +
            `When it ends, its result and pictures are posted in this chat and noted on your next message here. ` +
            `Don't poll; pipeline_status ${job.id} if the user asks.`
        );
      } catch (e) {
        if (e instanceof PipelineError) return err(e.message);
        throw e;
      }
    },
  },
  {
    definition: {
      name: "pipeline_status",
      description: "Owner only. A pipeline job's state, result and log end (job_id), or the recent jobs and the configured pipelines.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat you're answering in." },
          job_id: { type: "string", description: "A job id from pipeline_run (omit for the list)" },
        },
        required: ["chat_id"],
      },
    },
    handler: async (args, ctx, caller = { via: "local" }) => {
      if (!callerIsOwner(caller, args)) return err(OWNER_ONLY);
      const runner = pipelineRunner(ctx);
      if (args.job_id) {
        const job = runner.get(String(args.job_id));
        if (!job) return err(`no job ${String(args.job_id)} (jobs are forgotten on restart)`);
        const log = job.state === "running" ? runner.logTail(job, 1500).trim() : "";
        return text(details(job, runner) + (log ? `\nlog (end):\n${log}` : ""));
      }
      const jobs = runner.list().slice(0, 10);
      const names = [...ctx.config.getPipelines().keys()];
      return text(
        [`pipelines: ${names.join(", ") || "none configured"}`, ...(jobs.length ? jobs.map((j) => `${j.id}: ${jobLine(j)}`) : ["no jobs yet"])].join("\n")
      );
    },
  },
  {
    definition: {
      name: "pipeline_stop",
      description: "Owner only. Stop a queued or running pipeline job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat you're answering in." },
          job_id: { type: "string" },
        },
        required: ["chat_id", "job_id"],
      },
    },
    handler: async (args, ctx, caller = { via: "local" }) => {
      if (!callerIsOwner(caller, args)) return err(OWNER_ONLY);
      const id = String(args.job_id ?? "");
      return pipelineRunner(ctx).stop(id) ? text(`stopping ${id}`) : err(`${id} isn't queued or running`);
    },
  },
];

/**
 * The tools as this config needs them: none when no pipeline is configured
 * (their schemas are resident in every session), else with the configured
 * names listed, so the brain knows what it can run.
 */
export function pipelineToolsFor(ctx: AppContext): ToolDef[] {
  const names = [...(ctx.config?.getPipelines().keys() ?? [])];
  if (!names.length) return [];
  return pipelineTools.map((t) => {
    if (t.definition.name !== "pipeline_run") return t;
    const schema = t.definition.inputSchema as { properties: Record<string, object> };
    return {
      ...t,
      definition: {
        ...t.definition,
        description: t.definition.description.replace("a configured local pipeline", `a configured local pipeline (${names.join(", ")})`),
        inputSchema: { ...schema, properties: { ...schema.properties, pipeline: { type: "string", enum: names } } },
      },
    };
  });
}
